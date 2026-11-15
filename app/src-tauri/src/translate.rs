// 翻译管线(工单 06 五段式):解析 → 组批 → 流式翻译 → 校验修复 → 逐块上屏
// 断点续译:只译 trans_status != done 的块;取消保留已完成块。
use crate::batch;
use crate::blocks::{self, Block, BlockKind};
use crate::db::{BlockRow, Db, ProviderRow};
use crate::prompt;
use crate::providers::{self, CancelCheck, StreamStats};
use crate::sse::{SsePayload, TagStateMachine, Tagged};
use crate::validate::{self, BatchOutput, Issue};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::mpsc;

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Created { article_id: i64, blocks: Vec<BlockRow> },
    Block { idx: usize, text: String, terms: String },
    Partial { idx: usize, text: String },
    Usage { prompt_tokens: i64, completion_tokens: i64 },
    Done { article_id: i64 },
    Error { message: String },
}

#[derive(Debug, Clone, Deserialize)]
pub struct TranslateRequest {
    pub text: String,
    pub article_id: Option<i64>,
    pub direction: String,
    pub kind: String,
}

pub struct AppState {
    pub db: Arc<Db>,
    pub active: Arc<std::sync::atomic::AtomicU64>,
    pub counter: std::sync::atomic::AtomicU64,
}

fn kind_from_str(s: &str) -> BlockKind {
    match s {
        "heading" => BlockKind::Heading,
        "list" => BlockKind::List,
        "code" => BlockKind::Code,
        "table" => BlockKind::Table,
        _ => BlockKind::Paragraph,
    }
}

pub async fn run(app: tauri::AppHandle, req: TranslateRequest, channel: Channel<StreamEvent>, session: u64) {
    if let Err(e) = run_inner(&app, &req, &channel, session).await {
        let _ = channel.send(StreamEvent::Error { message: e.to_string() });
    }
}

async fn run_inner(app: &tauri::AppHandle, req: &TranslateRequest, channel: &Channel<StreamEvent>, session: u64) -> Result<()> {
    let state = app.state::<AppState>();
    let db = state.db.clone();
    let cancelled: CancelCheck = {
        let active = state.active.clone();
        Arc::new(move || active.load(Ordering::SeqCst) != session)
    };

    // Provider(全局唯一 active)
    let prov_row = db
        .active_provider()?
        .ok_or_else(|| anyhow!("尚未配置翻译 Provider:请打开设置完成配置并激活"))?;
    {
        // Keychain 读可能触发系统授权,放 blocking 线程,勿占 async worker
        let pid = prov_row.id;
        let has_key = tauri::async_runtime::spawn_blocking(move || crate::keychain::has_key(pid))
            .await
            .map_err(|e| anyhow!("keychain 任务异常: {e}"))?;
        if prov_row.kind == "openai_compatible" && !has_key {
            return Err(anyhow!("Provider「{}」尚未配置 API Key:请打开设置填入", prov_row.name));
        }
    }
    providers::build(&prov_row)?;
    let terms = db.glossary_terms()?;

    // 文章:续译已有 or 新建入库(快捷窗翻译自动入库,工单 08)
    let article_id = match req.article_id {
        Some(id) => id,
        None => {
            let parsed = blocks::split_blocks(&req.text);
            if parsed.is_empty() {
                return Err(anyhow!("没有可翻译的内容"));
            }
            let title = blocks::derive_title(&req.text);
            let rows: Vec<(String, String, String)> = parsed
                .iter()
                .map(|b| (b.kind.as_str().to_string(), b.src.clone(), b.hash.clone()))
                .collect();
            db.create_article_with_blocks(&title, &req.kind, &req.direction, &rows)?
        }
    };
    let (article, all_blocks) = db.get_article(article_id)?;
    let _ = channel.send(StreamEvent::Created { article_id, blocks: all_blocks.clone() });

    // 待译块(非 done;code 建库时已是 done)
    let pending: Vec<usize> = all_blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.status != "done")
        .map(|(i, _)| i)
        .collect();
    if pending.is_empty() {
        let _ = channel.send(StreamEvent::Done { article_id });
        return Ok(());
    }

    let (from, to) = prompt::direction_parts(&req.direction);
    let stored = crate::commands::load_prefs(&db).map_err(|e| anyhow!(e))?;
    let custom_prompt = crate::commands::effective_prefs(&stored).custom_prompt;
    let system = prompt::system_prompt(&from, &to, &terms, custom_prompt.as_deref());

    let block_vec: Vec<Block> = all_blocks
        .iter()
        .map(|b| Block {
            kind: kind_from_str(&b.kind),
            src: b.src.clone(),
            hash: String::new(),
        })
        .collect();
    let batches = batch::make_batches(&block_vec, &pending, &req.direction);

    let ctx = BatchCtx {
        provider_row: prov_row,
        db: &db,
        article_id,
        title: article.title,
        system,
        channel,
        cancel: cancelled,
        term_rules: terms
            .iter()
            .filter_map(|(t, tr)| {
                regex::Regex::new(&format!(r"(?i)\b{}\b", regex::escape(t)))
                    .ok()
                    .map(|re| (re, t.clone(), tr.clone()))
            })
            .collect(),
    };

    let mut prev = String::new(); // 跨批上下文:上批末 1~2 块已译文
    for b in &batches {
        if ctx.cancelled() {
            break;
        }
        let items: Vec<(usize, String)> = b.iter().map(|(gi, blk)| (*gi, blk.src.clone())).collect();
        let texts = ctx.translate_batch(&items, &prev, 0).await?;
        if !texts.is_empty() {
            let tail: Vec<String> = texts.iter().rev().take(2).map(|(_, t)| t.clone()).collect::<Vec<_>>().into_iter().rev().collect();
            prev = tail.join("\n\n");
        }
    }

    db.touch_article(article_id)?;
    let _ = app.emit("library-changed", ());
    let _ = channel.send(StreamEvent::Done { article_id });
    Ok(())
}

struct BatchCtx<'a> {
    provider_row: ProviderRow,
    db: &'a Db,
    article_id: i64,
    title: String,
    system: String,
    channel: &'a Channel<StreamEvent>,
    cancel: CancelCheck,
    /// 译后自动替换规则(工单 06:程序校验替换 + chip 标记)
    term_rules: Vec<(regex::Regex, String, String)>,
}

/// 术语替换:全词、大小写不敏感;代码 span/围栏(`…`、``…``、```…```)内不替换
/// (协议要求代码原样保留);返回替换后文本与命中列表(同术语跨段去重)
fn apply_terms(text: &str, rules: &[(regex::Regex, String, String)]) -> (String, Vec<(String, String)>) {
    let mut out = String::with_capacity(text.len());
    let mut hits: Vec<(String, String)> = Vec::new();
    for (seg, is_code) in split_code_spans(text) {
        if is_code {
            out.push_str(&seg);
            continue;
        }
        let mut t = seg;
        for (re, from, to) in rules {
            if re.is_match(&t) {
                t = re.replace_all(&t, to.as_str()).to_string();
                if !hits.contains(&(from.clone(), to.clone())) {
                    hits.push((from.clone(), to.clone()));
                }
            }
        }
        out.push_str(&t);
    }
    (out, hits)
}

/// 按反引号把文本切成 [(片段, 是否代码)]:n 个反引号开、恰好 n 个反引号闭;
/// n≥3 的围栏同样被覆盖;未闭合的反引号按普通文本处理
fn split_code_spans(text: &str) -> Vec<(String, bool)> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut plain = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '`' {
            plain.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i] == '`' {
            i += 1;
        }
        let n = i - start;
        // 找「恰好 n 个」反引号的闭合运行(更长运行如 n+2 不算,继续扫)
        let mut run = 0usize;
        let mut close = None;
        let mut j = i;
        while j < chars.len() {
            if chars[j] == '`' {
                run += 1;
                if run == n && (j + 1 >= chars.len() || chars[j + 1] != '`') {
                    close = Some(j);
                    break;
                }
            } else {
                run = 0;
            }
            j += 1;
        }
        match close {
            Some(c) => {
                if !plain.is_empty() {
                    out.push((std::mem::take(&mut plain), false));
                }
                out.push((chars[start..=c].iter().collect(), true));
                i = c + 1;
            }
            None => plain.extend(chars[start..i].iter()),
        }
    }
    if !plain.is_empty() {
        out.push((plain, false));
    }
    out
}

enum Step {
    Payload(SsePayload),
    Closed,
    ProviderDone(Result<StreamStats>),
}

impl BatchCtx<'_> {
    fn cancelled(&self) -> bool {
        (self.cancel)()
    }

    fn record_usage(&self, stats: &StreamStats, elapsed_ms: i64) {
        let _ = self.db.insert_usage(
            self.provider_row.id,
            Some(self.article_id),
            "translate",
            stats.prompt_tokens,
            stats.completion_tokens,
            elapsed_ms,
        );
        if stats.prompt_tokens > 0 || stats.completion_tokens > 0 {
            let _ = self.channel.send(StreamEvent::Usage {
                prompt_tokens: stats.prompt_tokens,
                completion_tokens: stats.completion_tokens,
            });
        }
    }

    /// 单次请求:流式上屏(partial 打字机 + 完成块即写库即推送),返回 (完整块, raw, 统计)
    async fn request(&self, items: &[(usize, String)], prev: &str) -> Result<(Vec<Tagged>, String, StreamStats)> {
        let sources: Vec<&str> = items.iter().map(|(_, s)| s.as_str()).collect();
        let user = prompt::user_msg(&self.title, if prev.is_empty() { None } else { Some(prev) }, &sources);
        let provider = providers::build(&self.provider_row)?;
        let system = self.system.clone();
        let cancel = self.cancel.clone();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let t0 = Instant::now();
        let mut handle = tauri::async_runtime::spawn(async move {
            provider.stream_chat(&system, &user, tx, cancel).await
        });

        let mut machine = TagStateMachine::new();
        let mut raw = String::new();
        let mut out: Vec<Tagged> = Vec::new();
        loop {
            let step = tokio::select! {
                m = rx.recv() => match m {
                    Some(p) => Step::Payload(p),
                    None => Step::Closed,
                },
                res = &mut handle => Step::ProviderDone(res.map_err(|e| anyhow!("provider 任务异常: {e}")).and_then(|r| r)),
            };
            match step {
                Step::Payload(p) => process_payload(self, p, items, &mut machine, &mut raw, &mut out),
                Step::Closed => {
                    // tx 断开 = provider 已结束,join 立即就绪
                    let stats = handle
                        .await
                        .map_err(|e| anyhow!("provider 任务异常: {e}"))??;
                    while let Ok(p) = rx.try_recv() {
                        process_payload(self, p, items, &mut machine, &mut raw, &mut out);
                    }
                    self.record_usage(&stats, t0.elapsed().as_millis() as i64);
                    return Ok((out, raw, stats));
                }
                Step::ProviderDone(Ok(stats)) => {
                    // provider 已结束:收干通道内残留载荷再返回
                    while let Ok(p) = rx.try_recv() {
                        process_payload(self, p, items, &mut machine, &mut raw, &mut out);
                    }
                    self.record_usage(&stats, t0.elapsed().as_millis() as i64);
                    return Ok((out, raw, stats));
                }
                Step::ProviderDone(Err(e)) => return Err(e),
            }
        }
    }

    /// 一批(含四级修复梯度 + length 减半):返回 (全局 idx, 译文) 列表。
    /// 递归(length 减半)async fn 需要 boxing。
    fn translate_batch<'a>(
        &'a self,
        items: &'a [(usize, String)],
        prev: &'a str,
        depth: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<(usize, String)>>> + Send + 'a>> {
        Box::pin(self.translate_batch_inner(items, prev, depth))
    }

    async fn translate_batch_inner(&self, items: &[(usize, String)], prev: &str, depth: usize) -> Result<Vec<(usize, String)>> {
        let expected: Vec<u32> = (1..=items.len() as u32).collect();
        let (mut blocks, mut raw, stats) = self.request(items, prev).await?;

        // finish_reason=length → 该批减半重试(递归,深度封顶)
        if stats.finish_reason.as_deref() == Some("length") && items.len() > 1 && depth < 2 && !self.cancelled() {
            let mid = items.len() / 2;
            let mut all = self.translate_batch(&items[..mid], prev, depth + 1).await?;
            all.extend(self.translate_batch(&items[mid..], prev, depth + 1).await?);
            return Ok(all);
        }

        let sources: Vec<&str> = items.iter().map(|(_, s)| s.as_str()).collect();
        for round in 0..4 {
            if self.cancelled() {
                break;
            }
            let issues = validate::validate(
                &expected,
                &BatchOutput { blocks: blocks.clone(), raw: raw.clone() },
                &sources,
            );
            if issues.is_empty() {
                break;
            }
            let missing: Vec<u32> = match issues.iter().find(|i| matches!(i, Issue::MissingBlocks(_))) {
                Some(Issue::MissingBlocks(m)) => m.clone(),
                _ => vec![],
            };
            // L1:id 对齐补救(块数对但 id 错乱)
            if blocks.len() == expected.len() {
                if let Some(fixed) = validate::realign_by_position(&blocks, &expected) {
                    blocks = fixed;
                    continue;
                }
            }
            // L2:缺块单发
            if !missing.is_empty() && round < 2 {
                let sub: Vec<(usize, String)> = missing
                    .iter()
                    .filter_map(|id| items.get(*id as usize - 1).cloned())
                    .collect();
                if !sub.is_empty() {
                    if let Ok((extra, _, _)) = self.request(&sub, prev).await {
                        for t in extra {
                            if !blocks.iter().any(|b| b.id == t.id) {
                                blocks.push(t);
                            }
                        }
                        blocks.sort_by_key(|b| b.id);
                        continue;
                    }
                }
            }
            // L3:整批重试一次
            if round == 2 {
                let (retry_blocks, retry_raw, _) = self.request(items, prev).await?;
                blocks = retry_blocks;
                raw = retry_raw;
                continue;
            }
            // L4:逐块串行
            if round == 3 {
                let got: Vec<u32> = blocks.iter().map(|b| b.id).collect();
                for id in expected.iter().copied().filter(|id| !got.contains(id)) {
                    if self.cancelled() {
                        break;
                    }
                    let Some(item) = items.get(id as usize - 1) else { continue };
                    if let Ok((single, _, _)) = self.request(std::slice::from_ref(item), prev).await {
                        if let Some(t) = single.into_iter().next() {
                            blocks.push(t);
                        }
                    }
                }
                blocks.sort_by_key(|b| b.id);
                continue;
            }
        }

        // 终值落库 + 推送(流式期间已推过的按 idx 覆盖)
        let mut result = Vec::new();
        for t in &blocks {
            let Some((gi, _)) = items.get(t.id as usize - 1) else { continue };
            let (text, hits) = apply_terms(&t.text, &self.term_rules);
            let terms_json = if hits.is_empty() {
                String::new()
            } else {
                serde_json::to_string(&hits).unwrap_or_default()
            };
            let _ = self.db.update_block(self.article_id, *gi, &text, "done");
            if !terms_json.is_empty() {
                let _ = self.db.update_block_terms(self.article_id, *gi, &terms_json);
            }
            let _ = self.channel.send(StreamEvent::Block { idx: *gi, text: text.clone(), terms: terms_json });
            result.push((*gi, text));
        }
        // 梯度走完仍有缺失 → 报错但继续后面的批
        let done_ids: std::collections::HashSet<u32> = blocks.iter().map(|b| b.id).collect();
        let still_missing: Vec<u32> = expected.iter().copied().filter(|id| !done_ids.contains(id)).collect();
        if !still_missing.is_empty() {
            let _ = self.channel.send(StreamEvent::Error {
                message: format!("本批 {} 块经修复仍未完成,已保留待译状态", still_missing.len()),
            });
        }
        Ok(result)
    }
}

fn process_payload(
    ctx: &BatchCtx<'_>,
    p: SsePayload,
    items: &[(usize, String)],
    machine: &mut TagStateMachine,
    raw: &mut String,
    out: &mut Vec<Tagged>,
) {
    let SsePayload::Delta(d) = p else { return };
    raw.push_str(&d);
    for t in machine.feed(&d) {
        let Some((gi, _)) = items.get(t.id as usize - 1) else { continue };
        let (text, hits) = apply_terms(&t.text, &ctx.term_rules);
        let terms_json = if hits.is_empty() {
            String::new()
        } else {
            serde_json::to_string(&hits).unwrap_or_default()
        };
        let _ = ctx.db.update_block(ctx.article_id, *gi, &text, "done");
        if !terms_json.is_empty() {
            let _ = ctx.db.update_block_terms(ctx.article_id, *gi, &terms_json);
        }
        let _ = ctx.channel.send(StreamEvent::Block { idx: *gi, text, terms: terms_json });
        out.push(Tagged { id: t.id, text: t.text.clone() });
    }
    if let Some((id, text)) = machine.partial() {
        if let Some((gi, _)) = items.get(id as usize - 1) {
            let _ = ctx.channel.send(StreamEvent::Partial { idx: *gi, text });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(pairs: &[(&str, &str)]) -> Vec<(regex::Regex, String, String)> {
        pairs
            .iter()
            .map(|(t, tr)| (regex::Regex::new(&format!(r"(?i)\b{}\b", regex::escape(t))).unwrap(), t.to_string(), tr.to_string()))
            .collect()
    }

    #[test]
    fn term_replace_whole_word_case_insensitive() {
        let r = rules(&[("hydration", "水合")]);
        let (out, hits) = apply_terms("webview 的水合延迟。Hydration of the webview is deferred.", &r);
        assert_eq!(hits.len(), 1);
        assert_eq!(out, "webview 的水合延迟。水合 of the webview is deferred.");
    }

    #[test]
    fn term_replace_no_false_positive_on_substring() {
        let r = rules(&[("web", "网页")]);
        // webview 不应被 web 规则误伤(全词匹配,子串不命中)
        let (out, hits) = apply_terms("the webview runs", &r);
        assert!(hits.is_empty());
        assert_eq!(out, "the webview runs");
    }

    #[test]
    fn term_replace_multiple_rules() {
        let r = rules(&[("hydration", "水合"), ("webview", "webview")]);
        let (_, hits) = apply_terms("hydration in webview", &r);
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn term_replace_skips_inline_code_span() {
        let r = rules(&[("rust", "铁锈语言")]);
        let (out, hits) = apply_terms("输入 `rust` 后,rust 继续运行", &r);
        // 代码 span 内原样保留,span 外正常替换
        assert!(out.contains("`rust`"));
        assert!(out.contains("铁锈语言 继续运行"));
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn term_replace_skips_fenced_code_block() {
        let r = rules(&[("cargo", "货舱")]);
        let text = "前缀 cargo。\n```\ncargo build\ncargo test\n```\n后缀 cargo。";
        let (out, hits) = apply_terms(text, &r);
        assert!(out.contains("```\ncargo build\ncargo test\n```"));
        assert!(out.contains("前缀 货舱。"));
        assert!(out.contains("后缀 货舱。"));
        assert_eq!(hits.len(), 1); // 同术语跨段去重
    }

    #[test]
    fn term_replace_unclosed_backtick_is_plain() {
        let r = rules(&[("rust", "铁锈语言")]);
        let (out, _) = apply_terms("未闭合 `rust 依然替换", &r);
        assert_eq!(out, "未闭合 `铁锈语言 依然替换");
    }
}
