// 翻译管线(工单 06 五段式):解析 → 组批 → 流式翻译 → 校验修复 → 逐块上屏
// 断点续译:只译 trans_status != done 的块;取消保留已完成块。
use crate::batch;
use crate::blocks::{self, Block, BlockKind};
use crate::db::{ArticleRow, BlockRow, Db, ProviderRow, UsageRecord};
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
    /// 带上 article 行:主窗直接据此建文档,不再重拉(v0.2 重拉期间早到的 block/partial 被丢)
    Created { article_id: i64, article: ArticleRow, blocks: Vec<BlockRow> },
    /// format_warn:结构签名不一致(自动重译一次后仍不一致)时的说明,空 = 正常
    Block { idx: usize, text: String, terms: String, format_warn: String },
    Partial { idx: usize, text: String },
    Usage { prompt_tokens: i64, completion_tokens: i64, reasoning_tokens: i64, cached_tokens: i64 },
    /// 阶段(§2.6.5):conn 连接 / think 思考 / gen 生成
    Phase { phase: String },
    /// 思考进度(思考关不掉时;≥100ms 节流):累计字数 + 末尾约 200 字。思考文本绝不进译文
    Thinking { chars: usize, tail: String },
    /// 会话结束明细(§2.6.6;口径见 §2.6.8,均相对会话开始)
    Metrics(SessionMetrics),
    Done { article_id: i64 },
    Error { message: String },
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct SessionMetrics {
    /// 首个正文 token(TTFT)
    pub ttft_ms: Option<i64>,
    /// 首个完整块
    pub first_block_ms: Option<i64>,
    /// 首个思考 token(有思考时)
    pub first_reasoning_ms: Option<i64>,
    /// 最后一个正文 token
    pub last_content_ms: Option<i64>,
    pub total_ms: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub reasoning_tokens: i64,
    pub cached_tokens: i64,
    pub requests: i64,
    pub batches: i64,
    pub blocks: i64,
    pub model: String,
    pub cancelled: bool,
}

/// 会话内计量(BatchCtx 经 &self 共享)
struct SessionMeter {
    t0: Instant,
    m: SessionMetrics,
    phase: &'static str,
    think_chars: usize,
    think_tail: String,
    last_think_emit: Option<Instant>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TranslateRequest {
    /// "auto" | "md" | "plain"(§2.2.5;缺省 auto:按 md 语法密度判定)
    #[serde(default)]
    pub format: Option<String>,
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
            // 纯文本粘贴:段内单换行保留为硬换行、行首 md 记号转义(§2.2.5)
            let plain = match req.format.as_deref() {
                Some("plain") => true,
                Some("md") => false,
                _ => !blocks::looks_like_markdown(&req.text),
            };
            let text = if plain { blocks::plain_to_markdown(&req.text) } else { req.text.clone() };
            let parsed = blocks::split_blocks(&text);
            if parsed.is_empty() {
                return Err(anyhow!("没有可翻译的内容"));
            }
            let title = blocks::derive_title(&text);
            // 纯文本文章记为 kind=plain:翻译时允许模型还原明显结构、复制时去掉 md 转义
            let kind = if plain { "plain" } else { req.kind.as_str() };
            db.create_article_with_blocks(&title, kind, &req.direction, &parsed)?
        }
    };
    let (article, all_blocks) = db.get_article(article_id)?;
    let title = article.title.clone();
    let _ = channel.send(StreamEvent::Created { article_id, article, blocks: all_blocks.clone() });

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
    let eff_prefs = crate::commands::effective_prefs(&stored);
    let custom_prompt = eff_prefs.custom_prompt.clone();
    // 批次策略:缓存优先 = 连续对话、串行;速度优先 = 独立请求、并发(默认 3;Ollama 本地单卡恒 1)
    let cache_mode = eff_prefs.batch_mode == "cache";
    let concurrency = if prov_row.kind == "ollama" || cache_mode { 1 } else { eff_prefs.concurrency.clamp(1, 3) as usize };
    let plain = db.get_article(article_id).map(|(a, _)| a.kind == "plain").unwrap_or(false);
    let mut system = prompt::system_prompt(&from, &to, &terms, custom_prompt.as_deref());
    if plain {
        system.push_str("\n\n");
        system.push_str(prompt::plain_text_rule());
    }

    let block_vec: Vec<Block> = all_blocks
        .iter()
        .map(|b| Block {
            kind: BlockKind::from_str(&b.kind),
            src: b.src.clone(),
            hash: String::new(),
            sep: b.sep.clone(),
            group: b.group,
        })
        .collect();
    let batches = batch::make_batches(&block_vec, &pending, &req.direction);
    let meter = std::sync::Mutex::new(SessionMeter {
        t0: Instant::now(),
        m: SessionMetrics {
            model: prov_row.model.clone(),
            batches: batches.len() as i64,
            blocks: pending.len() as i64,
            ..Default::default()
        },
        phase: "conn",
        think_chars: 0,
        think_tail: String::new(),
        last_think_emit: None,
    });
    let _ = channel.send(StreamEvent::Phase { phase: "conn".into() });

    let ctx = BatchCtx {
        meter: &meter,
        convo: cache_mode.then(|| std::sync::Mutex::new(Convo { history: Vec::new(), chars: 0 })),
        provider_row: prov_row,
        db: &db,
        article_id,
        title,
        system,
        plain,
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

    // 跨批上下文:上批末 1~2 块。首批单独先发(压首块时间),其译文作下一批上下文;
    // 并发时后续批的译文还没出来,改用前一批末 1~2 块的原文作上下文。
    let items_of = |b: &Vec<(usize, &Block)>| -> Vec<(usize, String)> { b.iter().map(|(gi, blk)| (*gi, blk.src.clone())).collect() };
    let tail2 = |v: Vec<String>| -> String { v.into_iter().rev().take(2).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n\n") };
    let mut prev = String::new();
    let mut rest = batches.iter();
    if let Some(first) = rest.next() {
        let texts = ctx.translate_batch(&items_of(first), &prev, 0).await?;
        prev = tail2(texts.into_iter().map(|(_, t)| t).collect());
    }
    let rest: Vec<&Vec<(usize, &Block)>> = rest.collect();
    if concurrency <= 1 {
        for b in rest {
            if ctx.cancelled() {
                break;
            }
            let texts = ctx.translate_batch(&items_of(b), &prev, 0).await?;
            if !texts.is_empty() {
                prev = tail2(texts.into_iter().map(|(_, t)| t).collect());
            }
        }
    } else if !rest.is_empty() && !ctx.cancelled() {
        use futures_util::stream::{self, StreamExt};
        let jobs: Vec<(Vec<(usize, String)>, String)> = rest
            .iter()
            .enumerate()
            .map(|(k, b)| {
                let ctx_text = if k == 0 { prev.clone() } else { tail2(rest[k - 1].iter().map(|(_, blk)| blk.src.clone()).collect()) };
                (items_of(b), ctx_text)
            })
            .collect();
        let mut futs = Vec::with_capacity(jobs.len());
        for (items, p) in &jobs {
            futs.push(ctx.translate_batch(items, p, 0));
        }
        let mut running = stream::iter(futs).buffer_unordered(concurrency);
        while let Some(r) = running.next().await {
            r?;
            if ctx.cancelled() {
                break;
            }
        }
    }

    db.touch_article(article_id)?;
    let _ = app.emit("library-changed", ());
    {
        let mut g = meter.lock().unwrap();
        g.m.total_ms = g.t0.elapsed().as_millis() as i64;
        g.m.cancelled = ctx.cancelled();
        let _ = channel.send(StreamEvent::Metrics(g.m.clone()));
    }
    let _ = channel.send(StreamEvent::Done { article_id });
    Ok(())
}

/// 连续对话模式(「缓存优先」):整篇文章作为一段对话,每批 = 一轮 user / assistant;
/// 前面的轮次原样保留 → 每次请求的前缀都与上一次相同 → 服务商前缀缓存几乎全部命中。
struct Convo {
    history: Vec<(String, String)>,
    chars: usize,
}

/// 历史超过这么多字符(约 8k tokens)就重开一段对话(缓存重建一次)
const CONVO_MAX_CHARS: usize = 24_000;

struct BatchCtx<'a> {
    meter: &'a std::sync::Mutex<SessionMeter>,
    /// Some = 缓存优先(连续对话,串行);None = 速度优先(独立请求,可并发)
    convo: Option<std::sync::Mutex<Convo>>,
    provider_row: ProviderRow,
    db: &'a Db,
    article_id: i64,
    title: String,
    system: String,
    /// 纯文本文章:结构签名只比 URL 与行内码(允许模型还原列表 / 标题)
    plain: bool,
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

    /// 有正文但解析出的块比预期少:把原始输出打到终端并存 app_state(诊断协议不符)
    fn log_unparsed(&self, out: &[Tagged], raw: &str, expected: usize) {
        if out.len() >= expected || raw.trim().is_empty() {
            return;
        }
        if expected == 1 && out.len() == 1 {
            return;
        }
        let head: String = raw.chars().take(1200).collect();
        eprintln!("[译读] 期望 {expected} 块,只解析出 {} 块。原始输出开头:\n{head}\n[译读] ---- 原始输出结束 ----", out.len());
        let _ = self.db.set_state("debug_last_unparsed", raw);
    }

    /// 一次 HTTP 请求结束:写 usage_log(含计时埋点)并推 usage 事件
    fn record_usage(&self, stats: &StreamStats, elapsed_ms: i64, items: &[(usize, String)], first_block_ms: Option<i64>) {
        if stats.thinking_unsupported {
            let _ = self.db.mark_provider_thinking_unsupported(self.provider_row.id);
        }
        let _ = self.db.insert_usage(&UsageRecord {
            provider_id: self.provider_row.id,
            article_id: Some(self.article_id),
            kind: "translate".into(),
            prompt_tokens: stats.prompt_tokens,
            completion_tokens: stats.completion_tokens,
            latency_ms: elapsed_ms,
            ttft_ms: stats.first_content_ms,
            first_block_ms,
            first_byte_ms: stats.first_byte_ms,
            reasoning_tokens: stats.reasoning_tokens,
            cached_tokens: stats.cached_tokens,
            batch_blocks: items.len() as i64,
            batch_chars: items.iter().map(|(_, s)| s.chars().count() as i64).sum(),
            model: self.provider_row.model.clone(),
        });
        {
            let mut g = self.meter.lock().unwrap();
            g.m.prompt_tokens += stats.prompt_tokens;
            g.m.completion_tokens += stats.completion_tokens;
            g.m.reasoning_tokens += stats.reasoning_tokens;
            g.m.cached_tokens += stats.cached_tokens;
            g.m.requests += 1;
        }
        if stats.prompt_tokens > 0 || stats.completion_tokens > 0 {
            let _ = self.channel.send(StreamEvent::Usage {
                prompt_tokens: stats.prompt_tokens,
                completion_tokens: stats.completion_tokens,
                reasoning_tokens: stats.reasoning_tokens,
                cached_tokens: stats.cached_tokens,
            });
        }
    }

    /// 单次请求:流式上屏(partial 打字机 + 完成块即写库即推送),返回 (完整块, raw, 统计)
    async fn request(&self, items: &[(usize, String)], prev: &str) -> Result<(Vec<Tagged>, String, StreamStats)> {
        self.request_with_note(items, prev, None).await
    }

    fn structure_diff(&self, src: &str, out: &str) -> Vec<String> {
        if self.plain {
            validate::structure_diff_relaxed(src, out)
        } else {
            validate::structure_diff(src, out)
        }
    }

    /// 当前对话历史(速度优先模式恒空)
    fn history(&self) -> Vec<(String, String)> {
        self.convo.as_ref().map(|c| c.lock().unwrap().history.clone()).unwrap_or_default()
    }

    /// 本批的 user 消息:对话首轮带标题与参考上下文;后续轮次上文已在历史里,只放待译片段
    fn batch_user(&self, items: &[(usize, String)], prev: &str, first_turn: bool) -> String {
        let sources: Vec<&str> = items.iter().map(|(_, s)| s.as_str()).collect();
        if first_turn {
            prompt::user_msg(&self.title, if prev.is_empty() { None } else { Some(prev) }, &sources)
        } else {
            prompt::continue_msg(&sources)
        }
    }

    /// 一批完成:把(user, 规范化的 assistant 输出)追加进对话;超长则清空,下批重开
    fn append_turn(&self, user: String, blocks: &[Tagged]) {
        let Some(c) = &self.convo else { return };
        let mut sorted: Vec<&Tagged> = blocks.iter().collect();
        sorted.sort_by_key(|t| t.id);
        let assistant: String = sorted
            .iter()
            .map(|t| format!("<t id=\"{}\">{}</t>", t.id, prompt::escape_protocol(&t.text)))
            .collect::<Vec<_>>()
            .join("\n");
        let mut g = c.lock().unwrap();
        g.chars += user.chars().count() + assistant.chars().count();
        g.history.push((user, assistant));
        if g.chars > CONVO_MAX_CHARS {
            g.history.clear();
            g.chars = 0;
        }
    }

    /// note:结构签名不一致时附在用户消息末尾的修正说明(§2.2.4 带差异说明重译)
    async fn request_with_note(&self, items: &[(usize, String)], prev: &str, note: Option<&str>) -> Result<(Vec<Tagged>, String, StreamStats)> {
        let history = self.history();
        let mut user = self.batch_user(items, prev, history.is_empty());
        if let Some(n) = note {
            user.push_str(&format!(
                "\nYour previous translation of these segments broke the Markdown structure. Keep the structure identical to the source this time:\n{n}\n"
            ));
        }
        let provider = providers::build(&self.provider_row)?;
        let system = self.system.clone();
        let cancel = self.cancel.clone();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let t0 = Instant::now();
        let mut handle = tauri::async_runtime::spawn(async move {
            provider.stream_chat(&system, &history, &user, tx, cancel).await
        });

        let mut machine = TagStateMachine::new();
        let mut raw = String::new();
        let mut out: Vec<Tagged> = Vec::new();
        let mut first_block_ms: Option<i64> = None;
        loop {
            let step = tokio::select! {
                m = rx.recv() => match m {
                    Some(p) => Step::Payload(p),
                    None => Step::Closed,
                },
                res = &mut handle => Step::ProviderDone(res.map_err(|e| anyhow!("provider 任务异常: {e}")).and_then(|r| r)),
            };
            match step {
                Step::Payload(p) => process_payload(self, p, items, &mut machine, &mut raw, &mut out, &t0, &mut first_block_ms),
                Step::Closed => {
                    // tx 断开 = provider 已结束,join 立即就绪
                    let stats = handle
                        .await
                        .map_err(|e| anyhow!("provider 任务异常: {e}"))??;
                    while let Ok(p) = rx.try_recv() {
                        process_payload(self, p, items, &mut machine, &mut raw, &mut out, &t0, &mut first_block_ms);
                    }
                    self.record_usage(&stats, t0.elapsed().as_millis() as i64, items, first_block_ms);
                    self.log_unparsed(&out, &raw, items.len());
                    let (out, raw) = single_fallback(out, raw, items.len());
                    return Ok((out, raw, stats));
                }
                Step::ProviderDone(Ok(stats)) => {
                    // provider 已结束:收干通道内残留载荷再返回
                    while let Ok(p) = rx.try_recv() {
                        process_payload(self, p, items, &mut machine, &mut raw, &mut out, &t0, &mut first_block_ms);
                    }
                    self.record_usage(&stats, t0.elapsed().as_millis() as i64, items, first_block_ms);
                    self.log_unparsed(&out, &raw, items.len());
                    let (out, raw) = single_fallback(out, raw, items.len());
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

        // 多块请求一块都没解析出来(模型换了输出格式):重发整批多半同样失败 → 直接逐块单发
        if blocks.is_empty() && items.len() > 1 && !raw.trim().is_empty() && !self.cancelled() {
            eprintln!("[译读] {} 块的批次一块都没解析出,改为逐块单发", items.len());
            for (k, item) in items.iter().enumerate() {
                if self.cancelled() {
                    break;
                }
                if let Ok((single, _, _)) = self.request(std::slice::from_ref(item), prev).await {
                    if let Some(t) = single.into_iter().next() {
                        blocks.push(Tagged { id: k as u32 + 1, text: t.text });
                    }
                }
            }
            raw = blocks.iter().map(|b| format!("<t id=\"{}\">{}</t>", b.id, b.text)).collect();
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
                    .filter_map(|id| items.get((*id as usize).wrapping_sub(1)).cloned())
                    .collect();
                if !sub.is_empty() {
                    if let Ok((extra, _, _)) = self.request(&sub, prev).await {
                        // 子请求里重新编号 1..n:映射回本批 id(v0.2 起此处误用子请求 id)
                        for t in extra {
                            let Some(&id) = missing.get((t.id as usize).wrapping_sub(1)) else { continue };
                            if !blocks.iter().any(|b| b.id == id) {
                                blocks.push(Tagged { id, text: t.text });
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
                    let Some(item) = items.get((id as usize).wrapping_sub(1)) else { continue };
                    if let Ok((single, _, _)) = self.request(std::slice::from_ref(item), prev).await {
                        if let Some(t) = single.into_iter().next() {
                            blocks.push(Tagged { id, text: t.text }); // 单发请求 id 恒为 1,映射回本批 id
                        }
                    }
                }
                blocks.sort_by_key(|b| b.id);
                continue;
            }
        }

        // 结构签名(§2.2.4):不一致 → 带差异说明自动重译这些块一次 → 仍不一致保留译文并标「格式可能有误」
        let mut warns: std::collections::HashMap<u32, String> = Default::default();
        if !self.cancelled() {
            let src_of = |id: u32| items.get((id as usize).wrapping_sub(1)).map(|(_, s)| s.as_str());
            let bad: Vec<(u32, Vec<String>)> = blocks
                .iter()
                .filter_map(|t| {
                    let d = self.structure_diff(src_of(t.id)?, &t.text);
                    (!d.is_empty()).then_some((t.id, d))
                })
                .collect();
            if !bad.is_empty() {
                let sub: Vec<(usize, String)> = bad.iter().filter_map(|(id, _)| items.get((*id as usize).wrapping_sub(1)).cloned()).collect();
                let note: String = bad
                    .iter()
                    .enumerate()
                    .map(|(k, (_, d))| format!("- segment {}: {}", k + 1, d.join("; ")))
                    .collect::<Vec<_>>()
                    .join("\n");
                let retry = self.request_with_note(&sub, prev, Some(&note)).await.ok().map(|(r, _, _)| r).unwrap_or_default();
                for (k, (id, d0)) in bad.iter().enumerate() {
                    let src = src_of(*id).unwrap_or("");
                    match retry.iter().find(|r| r.id == k as u32 + 1) {
                        Some(r) => {
                            let d1 = self.structure_diff(src, &r.text);
                            if let Some(b) = blocks.iter_mut().find(|b| b.id == *id) {
                                b.text = r.text.clone();
                            }
                            if !d1.is_empty() {
                                warns.insert(*id, validate::diff_summary_zh(&d1));
                            }
                        }
                        None => {
                            warns.insert(*id, validate::diff_summary_zh(d0));
                        }
                    }
                }
            }
        }

        // 终值落库 + 推送(流式期间已推过的按 idx 覆盖)
        let mut result = Vec::new();
        for t in &blocks {
            let Some((gi, _)) = items.get((t.id as usize).wrapping_sub(1)) else { continue };
            let warn = warns.get(&t.id).cloned().unwrap_or_default();
            let _ = self.db.update_block_warn(self.article_id, *gi, &warn);
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
            let _ = self.channel.send(StreamEvent::Block { idx: *gi, text: text.clone(), terms: terms_json, format_warn: warn });
            result.push((*gi, text));
        }
        // 连续对话:本批作为一轮写入历史(只记顶层批;length 减半的子批不入历史)
        if depth == 0 && self.convo.is_some() && !blocks.is_empty() {
            let first_turn = self.history().is_empty();
            let user = self.batch_user(items, prev, first_turn);
            self.append_turn(user, &blocks);
        }

        // 梯度走完仍有缺失 → 报错但继续后面的批
        let done_ids: std::collections::HashSet<u32> = blocks.iter().map(|b| b.id).collect();
        let still_missing: Vec<u32> = expected.iter().copied().filter(|id| !done_ids.contains(id)).collect();
        if !still_missing.is_empty() && !self.cancelled() {
            let _ = self.channel.send(StreamEvent::Error {
                message: format!("本批 {} 块经修复仍未完成,已保留待译状态", still_missing.len()),
            });
        }
        Ok(result)
    }
}

/// 单块请求但回复里没有任何标签:整段回复(去掉零散标签)就是译文;补成标准 raw 以过校验
fn single_fallback(out: Vec<Tagged>, raw: String, expected: usize) -> (Vec<Tagged>, String) {
    if expected != 1 || !out.is_empty() || raw.trim().is_empty() {
        return (out, raw);
    }
    static TAG: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let tag = TAG.get_or_init(|| regex::Regex::new(r#"<\s*/?\s*[ts](\s+id\s*=[^>]*)?\s*>"#).unwrap());
    let text = prompt::unescape_protocol(tag.replace_all(&raw, "").trim());
    if text.is_empty() {
        return (out, raw);
    }
    let fixed = format!("<t id=\"1\">{text}</t>");
    (vec![Tagged { id: 1, text }], fixed)
}

fn process_payload(
    ctx: &BatchCtx<'_>,
    p: SsePayload,
    items: &[(usize, String)],
    machine: &mut TagStateMachine,
    raw: &mut String,
    out: &mut Vec<Tagged>,
    t0: &Instant,
    first_block_ms: &mut Option<i64>,
) {
    // Reasoning 不进状态机与 raw(思考文本绝不进译文):只计时 + 节流推思考进度
    let d = match p {
        SsePayload::Reasoning(r) => {
            let mut g = ctx.meter.lock().unwrap();
            let now_ms = g.t0.elapsed().as_millis() as i64;
            g.m.first_reasoning_ms.get_or_insert(now_ms);
            g.think_chars += r.chars().count();
            g.think_tail.push_str(&r);
            let n = g.think_tail.chars().count();
            if n > 400 {
                g.think_tail = g.think_tail.chars().skip(n - 200).collect();
            }
            if g.phase != "think" {
                g.phase = "think";
                let _ = ctx.channel.send(StreamEvent::Phase { phase: "think".into() });
            }
            let due = g.last_think_emit.map_or(true, |t| t.elapsed().as_millis() >= 100);
            if due {
                g.last_think_emit = Some(Instant::now());
                let tail: String = {
                    let n = g.think_tail.chars().count();
                    g.think_tail.chars().skip(n.saturating_sub(200)).collect()
                };
                let _ = ctx.channel.send(StreamEvent::Thinking { chars: g.think_chars, tail });
            }
            return;
        }
        SsePayload::Delta(d) => d,
        _ => return,
    };
    {
        let mut g = ctx.meter.lock().unwrap();
        let now_ms = g.t0.elapsed().as_millis() as i64;
        g.m.ttft_ms.get_or_insert(now_ms);
        g.m.last_content_ms = Some(now_ms);
        if g.phase != "gen" {
            if g.phase == "think" && g.think_chars > 0 {
                // 收尾推一次完整的思考字数
                let n = g.think_tail.chars().count();
                let tail: String = g.think_tail.chars().skip(n.saturating_sub(200)).collect();
                let _ = ctx.channel.send(StreamEvent::Thinking { chars: g.think_chars, tail });
            }
            g.phase = "gen";
            let _ = ctx.channel.send(StreamEvent::Phase { phase: "gen".into() });
        }
    }
    raw.push_str(&d);
    for t in machine.feed(&d) {
        // 协议转义还原(§2.2.6):发送前把源文里的 <s / </s / <t / </t 转成 &lt;…
        let t = Tagged { id: t.id, text: prompt::unescape_protocol(&t.text) };
        let Some((gi, _)) = items.get((t.id as usize).wrapping_sub(1)) else { continue };
        if first_block_ms.is_none() {
            *first_block_ms = Some(t0.elapsed().as_millis() as i64);
        }
        {
            let mut g = ctx.meter.lock().unwrap();
            let now_ms = g.t0.elapsed().as_millis() as i64;
            g.m.first_block_ms.get_or_insert(now_ms);
        }
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
        let _ = ctx.channel.send(StreamEvent::Block { idx: *gi, text, terms: terms_json, format_warn: String::new() });
        out.push(Tagged { id: t.id, text: t.text.clone() });
    }
    if let Some((id, text)) = machine.partial() {
        if let Some((gi, _)) = items.get((id as usize).wrapping_sub(1)) {
            let _ = ctx.channel.send(StreamEvent::Partial { idx: *gi, text: prompt::unescape_protocol(&text) });
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
