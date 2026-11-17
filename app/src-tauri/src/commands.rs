// 全部 #[tauri::command]:文章 / 翻译会话 / Provider / 偏好 / 用量
use crate::db::{ArticleRow, BlockRow, ProviderRow};
use crate::keychain;
use crate::providers;
use crate::translate::{self, AppState, StreamEvent, TranslateRequest};
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::ipc::Channel;
use tauri::State;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- 文章 ----------

#[derive(Serialize)]
pub struct ArticleDetail {
    pub article: ArticleRow,
    pub blocks: Vec<BlockRow>,
}

#[tauri::command]
pub fn list_articles(state: State<AppState>, query: Option<String>) -> Result<Vec<ArticleRow>, String> {
    state.db.list_articles(query.as_deref().unwrap_or("")).map_err(err)
}

#[tauri::command]
pub fn get_article(state: State<AppState>, id: i64) -> Result<ArticleDetail, String> {
    let (article, blocks) = state.db.get_article(id).map_err(err)?;
    Ok(ArticleDetail { article, blocks })
}

#[tauri::command]
pub fn pin_article(state: State<AppState>, id: i64, pinned: bool) -> Result<(), String> {
    state.db.set_pinned(id, pinned).map_err(err)
}

#[tauri::command]
pub fn delete_article(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.delete_article(id).map_err(err)
}

// ---------- 翻译会话 ----------

#[tauri::command]
pub fn translate(
    app: tauri::AppHandle,
    state: State<AppState>,
    request: TranslateRequest,
    on_event: Channel<StreamEvent>,
) -> Result<u64, String> {
    let session = state.counter.fetch_add(1, Ordering::SeqCst) + 1;
    state.active.store(session, Ordering::SeqCst); // 新会话直接顶替旧会话
    tauri::async_runtime::spawn(translate::run(app, request, on_event, session));
    Ok(session)
}

#[tauri::command]
pub fn cancel_translate(state: State<AppState>, session: u64) -> Result<(), String> {
    if state.active.load(Ordering::SeqCst) == session {
        state.active.store(0, Ordering::SeqCst);
    }
    Ok(())
}

// ---------- Provider ----------

#[derive(Deserialize)]
pub struct ProviderInput {
    pub id: Option<i64>,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub extra: Option<String>,
}

#[tauri::command]
pub async fn provider_save(state: State<'_, AppState>, input: ProviderInput) -> Result<ProviderRow, String> {
    let db = state.db.clone();
    // SQLite 写 + 后续读放线程池;同步命令会跑在主线程卡 UI
    tauri::async_runtime::spawn_blocking(move || {
        // extra 未传 = 保留原值(v0.3:旧版每次存 "{}",把 thinking_unsupported 等标记冲掉)
        let extra = match (&input.extra, input.id) {
            (Some(e), id) => {
                if let Some(id) = id {
                    providers::thinking::clear_unsupported(id); // 思考控制可能变了,重新探测
                }
                e.clone()
            }
            (None, Some(id)) => db.get_provider(id).map(|r| r.extra).unwrap_or_else(|_| "{}".into()),
            (None, None) => "{}".into(),
        };
        let id = db
            .upsert_provider(input.id, &input.name, &input.kind, &input.base_url, &input.model, &extra)
            .map_err(err)?;
        db.get_provider(id).map_err(err)
    })
    .await
    .map_err(|e| err(e))?
}

#[tauri::command]
pub async fn provider_delete(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let db = state.db.clone();
    // Keychain 清 key 可能阻塞/触发系统授权,勿占主线程
    tauri::async_runtime::spawn_blocking(move || {
        keychain::set_key(id, "").map_err(err)?; // 顺带清 Keychain
        db.delete_provider(id).map_err(err)
    })
    .await
    .map_err(|e| err(e))?
}

#[tauri::command]
pub async fn provider_set_key(_state: State<'_, AppState>, id: i64, key: String) -> Result<(), String> {
    // Keychain 写是最重的一个:Security 框架调用会卡主线程导致整窗冻结/闪动
    tauri::async_runtime::spawn_blocking(move || keychain::set_key(id, &key).map_err(err))
        .await
        .map_err(|e| err(e))?
}

#[tauri::command]
pub async fn provider_set_active(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || db.set_active_provider(id).map_err(err))
        .await
        .map_err(|e| err(e))?
}

#[tauri::command]
pub async fn provider_list(state: State<'_, AppState>) -> Result<Vec<ProviderRow>, String> {
    // Keychain 读可能触发系统授权(阻塞),放 spawn_blocking,勿卡主线程
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || db.list_providers(&|id: i64| keychain::has_key(id)))
        .await
        .map_err(|e| err(e))?
        .map_err(err)
}

#[derive(Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    /// ok | no_key | auth | model | network | other(§2.3.3 错误分类)
    pub kind: String,
    pub message: String,
}

impl TestResult {
    fn fail(kind: &str, message: impl Into<String>) -> Self {
        TestResult { ok: false, latency_ms: 0, kind: kind.into(), message: message.into() }
    }
}

/// 把连通失败归类为用户能看懂的四类
fn classify_error(e: &anyhow::Error) -> TestResult {
    let raw = format!("{e:#}");
    let low = raw.to_ascii_lowercase();
    let short: String = raw.chars().take(160).collect();
    if let Some(re) = e.downcast_ref::<reqwest::Error>() {
        if re.is_connect() || re.is_timeout() || re.is_request() {
            return TestResult::fail("network", format!("无法连接:检查地址、网络或代理({short})"));
        }
    }
    if low.contains("error sending request") || low.contains("dns") || low.contains("connection refused") || low.contains("timed out") {
        return TestResult::fail("network", format!("无法连接:检查地址、网络或代理({short})"));
    }
    if low.starts_with("http 401") || low.starts_with("http 403") || low.contains("invalid api key") || low.contains("incorrect api key") || low.contains("authentication") {
        return TestResult::fail("auth", "密钥无效或无权限(401/403)");
    }
    let model_words = ["model_not_found", "model not found", "does not exist", "no such model", "not found the model", "unknown model", "invalid model", "模型不存在"];
    if model_words.iter().any(|w| low.contains(w)) || (low.starts_with("http 404") && low.contains("model")) {
        return TestResult::fail("model", "模型不存在:换一个模型名或从列表里选");
    }
    if low.starts_with("http 404") {
        return TestResult::fail("network", "地址不对(404):检查 Base URL 是否需要带 /v1");
    }
    TestResult::fail("other", short)
}

/// 设置页表单当前值(未保存也能测 / 拉模型)
#[derive(Deserialize)]
pub struct ProviderForm {
    pub id: Option<i64>,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    /// 新输入的密钥;空 = 用已存钥匙串的
    pub key: Option<String>,
    pub extra: Option<String>,
}

fn form_provider(form: &ProviderForm) -> Result<(Box<dyn providers::Provider>, bool), String> {
    let stored_key = form.id.and_then(keychain::effective_key);
    let key = form.key.clone().filter(|k| !k.trim().is_empty()).map(|k| k.trim().to_string()).or(stored_key);
    let has_key = key.is_some();
    let row = ProviderRow {
        id: form.id.unwrap_or(-1),
        name: String::new(),
        kind: form.kind.clone(),
        base_url: form.base_url.trim().to_string(),
        model: form.model.trim().to_string(),
        extra: form.extra.clone().unwrap_or_else(|| "{}".into()),
        is_active: false,
        has_key,
    };
    Ok((providers::build_with_key(&row, key).map_err(err)?, has_key))
}

/// 用表单当前值测试连通(§2.3.3)
#[tauri::command]
pub async fn provider_test_form(form: ProviderForm) -> Result<TestResult, String> {
    if form.base_url.trim().is_empty() {
        return Ok(TestResult::fail("network", "请填写地址"));
    }
    if form.model.trim().is_empty() {
        return Ok(TestResult::fail("model", "请填写模型"));
    }
    let (provider, has_key) = tauri::async_runtime::spawn_blocking(move || form_provider(&form).map(|p| (p, form.kind.clone())))
        .await
        .map_err(err)?
        .map(|((p, k), kind)| (p, k || kind == "ollama"))?;
    if !has_key {
        return Ok(TestResult::fail("no_key", "缺少 API 密钥"));
    }
    match provider.test_conn().await {
        Ok(ms) => Ok(TestResult { ok: true, latency_ms: ms, kind: "ok".into(), message: format!("已连通 · {ms} ms") }),
        Err(e) => Ok(classify_error(&e)),
    }
}

/// 拉取可用模型(§2.3.4:OpenAI 兼容 /models,Ollama /api/tags)
#[tauri::command]
pub async fn provider_models(form: ProviderForm) -> Result<Vec<String>, String> {
    let (provider, _) = tauri::async_runtime::spawn_blocking(move || form_provider(&form)).await.map_err(err)??;
    provider.list_models().await.map_err(|e| classify_error(&e).message)
}

/// 已存密钥的尾号提示「····9a1e」;前端永不拿完整密钥(§2.3.8)
#[tauri::command]
pub async fn provider_key_hint(id: i64) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        keychain::effective_key(id).map(|k| {
            let tail: String = k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            format!("····{tail}")
        })
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn provider_test(state: State<'_, AppState>, id: i64) -> Result<TestResult, String> {
    let row = state.db.get_provider(id).map_err(err)?;
    let provider = providers::build(&row).map_err(err)?;
    let has_key = {
        let id2 = id;
        tauri::async_runtime::spawn_blocking(move || keychain::has_key(id2))
            .await
            .map_err(err)?
    };
    if row.kind == "openai_compatible" && !has_key {
        return Ok(TestResult::fail("no_key", "缺少 API 密钥"));
    }
    match provider.test_conn().await {
        Ok(ms) => Ok(TestResult { ok: true, latency_ms: ms, kind: "ok".into(), message: format!("已连通 · {ms} ms") }),
        Err(e) => Ok(classify_error(&e)),
    }
}

// ---------- 偏好 ----------

const PREFS_KEY: &str = "prefs";

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct PrefsStored {
    pub hotkey: Option<String>,
    pub paste_auto: Option<bool>,
    pub blur_hide: Option<bool>,
    pub pin_default: Option<bool>,
    pub direction: Option<String>,
    pub dict_fallback: Option<bool>,
    pub price_per_mtok: Option<f64>, // 每 1M tokens 人民币
    pub custom_prompt: Option<String>, // 翻译风格 prompt;空串 = 用默认
    pub theme_mode: Option<String>,    // v0.3:外观三态 system | light | dark(替代 localStorage v3-dark)
    pub quick_scale: Option<f64>,      // v0.3 §2.5.6:快捷窗译文缩放 0.8–1.5(⌘± / ⌘0)
    pub main_scale: Option<f64>,       // 主窗译文缩放
    pub density: Option<String>,       // compact | standard | loose
}

#[derive(Serialize, Clone)]
pub struct PrefsEffective {
    pub hotkey: String,
    pub paste_auto: bool,
    pub blur_hide: bool,
    pub pin_default: bool,
    pub direction: String,
    pub dict_fallback: bool,
    pub price_per_mtok: f64,
    pub custom_prompt: Option<String>, // None = 用内置默认 prompt
    pub theme_mode: String,
    pub quick_scale: f64,
    pub main_scale: f64,
    pub density: String,
}

pub fn load_prefs(db: &crate::db::Db) -> Result<PrefsStored, String> {
    match db.get_state(PREFS_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).map_err(err),
        Ok(None) => Ok(PrefsStored::default()),
        Err(e) => Err(err(e)),
    }
}

fn clamp_scale(v: Option<f64>) -> f64 {
    let v = v.unwrap_or(1.0);
    if v.is_finite() { (v * 10.0).round() / 10.0 } else { 1.0 }.clamp(0.8, 1.5)
}

pub fn effective_prefs(p: &PrefsStored) -> PrefsEffective {
    PrefsEffective {
        hotkey: p.hotkey.clone().unwrap_or_else(|| "Alt+T".into()),
        paste_auto: p.paste_auto.unwrap_or(true),
        blur_hide: p.blur_hide.unwrap_or(false),
        pin_default: p.pin_default.unwrap_or(true),
        direction: p.direction.clone().unwrap_or_else(|| "en2zh".into()),
        dict_fallback: p.dict_fallback.unwrap_or(true),
        price_per_mtok: p.price_per_mtok.unwrap_or(0.0),
        // trim 后为空视作未设置(用内置默认 prompt)
        custom_prompt: p
            .custom_prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        theme_mode: match p.theme_mode.as_deref() {
            Some(m @ ("light" | "dark")) => m.to_string(),
            _ => "system".into(),
        },
        quick_scale: clamp_scale(p.quick_scale),
        main_scale: clamp_scale(p.main_scale),
        density: match p.density.as_deref() {
            Some(d @ ("compact" | "loose")) => d.to_string(),
            _ => "standard".into(),
        },
    }
}

#[tauri::command]
pub fn get_prefs(state: State<AppState>) -> Result<PrefsEffective, String> {
    let stored = load_prefs(&state.db)?;
    Ok(effective_prefs(&stored))
}

#[tauri::command]
pub fn set_prefs(app: tauri::AppHandle, state: State<AppState>, update: PrefsStored) -> Result<PrefsEffective, String> {
    apply_prefs_update(&app, &state, update)
}

/// 合并偏好更新 → 副作用(热键重注册 / 外观)→ 落库 → 广播 `prefs-changed`(三窗同步;Rust 侧菜单改外观也走这里)
pub fn apply_prefs_update(app: &tauri::AppHandle, state: &AppState, update: PrefsStored) -> Result<PrefsEffective, String> {
    use tauri::Emitter;
    let old = load_prefs(&state.db)?;
    let mut stored = old.clone();
    if let Some(v) = &update.hotkey {
        stored.hotkey = Some(v.clone());
    }
    if update.paste_auto.is_some() {
        stored.paste_auto = update.paste_auto;
    }
    if update.blur_hide.is_some() {
        stored.blur_hide = update.blur_hide;
    }
    if update.pin_default.is_some() {
        stored.pin_default = update.pin_default;
    }
    if let Some(v) = &update.direction {
        stored.direction = Some(v.clone());
    }
    if let Some(v) = &update.custom_prompt {
        stored.custom_prompt = Some(v.clone());
    }
    if update.dict_fallback.is_some() {
        stored.dict_fallback = update.dict_fallback;
        let _ = state
            .db
            .set_state("dict_fallback", if update.dict_fallback.unwrap() { "1" } else { "0" });
    }
    if update.price_per_mtok.is_some() {
        stored.price_per_mtok = update.price_per_mtok;
    }
    if let Some(v) = &update.theme_mode {
        stored.theme_mode = Some(v.clone());
    }
    if update.quick_scale.is_some() {
        stored.quick_scale = update.quick_scale;
    }
    if update.main_scale.is_some() {
        stored.main_scale = update.main_scale;
    }
    if let Some(v) = &update.density {
        stored.density = Some(v.clone());
    }
    // 热键变更:Rust 侧重注册
    let new_hotkey = effective_prefs(&stored).hotkey;
    let old_hotkey = effective_prefs(&old).hotkey;
    if new_hotkey != old_hotkey {
        crate::reregister_hotkey(app, &old_hotkey, &new_hotkey).map_err(err)?;
    }
    state
        .db
        .set_state(PREFS_KEY, &serde_json::to_string(&stored).map_err(err)?)
        .map_err(err)?;
    let eff = effective_prefs(&stored);
    if eff.theme_mode != effective_prefs(&old).theme_mode {
        crate::native::apply_theme_mode(app, &eff.theme_mode);
    }
    let _ = app.emit("prefs-changed", eff.clone());
    Ok(eff)
}


// ---------- 词典查词(工单 13 链路) ----------

#[tauri::command]
pub async fn lookup_word(state: State<'_, AppState>, word: String) -> Result<crate::dict::DictCard, String> {
    crate::dict::lookup(&state.db, &word).await.map_err(err)
}

// ---------- 生词本 ----------

#[tauri::command]
pub fn vocab_add(
    state: State<AppState>,
    word: String,
    phonetic: String,
    definition: String,
    source: String,
    sentence: Option<String>,
    article_id: Option<i64>,
) -> Result<i64, String> {
    state
        .db
        .add_vocab(&word, &phonetic, &definition, &source, sentence.as_deref(), article_id)
        .map_err(err)
}

#[tauri::command]
pub fn vocab_list(state: State<AppState>) -> Result<Vec<crate::db::VocabEntryRow>, String> {
    state.db.vocab_list().map_err(err)
}

#[tauri::command]
pub fn vocab_examples(state: State<AppState>, id: i64) -> Result<Vec<String>, String> {
    state.db.vocab_examples(id).map_err(err)
}

#[tauri::command]
pub fn vocab_delete(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.delete_vocab(id).map_err(err)
}

// ---------- 术语库 ----------

#[tauri::command]
pub fn glossary_list(state: State<AppState>) -> Result<Vec<crate::db::GlossaryRow>, String> {
    state.db.glossary_all().map_err(err)
}

#[tauri::command]
pub fn glossary_add(state: State<AppState>, term: String, translation: String) -> Result<(), String> {
    state.db.upsert_glossary(&term, &translation).map_err(err)
}

#[tauri::command]
pub fn glossary_set_enabled(state: State<AppState>, id: i64, enabled: bool) -> Result<(), String> {
    state.db.set_glossary_enabled(id, enabled).map_err(err)
}

#[tauri::command]
pub fn glossary_delete(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.delete_glossary(id).map_err(err)
}

// ---------- 用量 ----------

#[derive(Serialize)]
pub struct UsageSummary {
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[tauri::command]
pub fn usage_summary(state: State<AppState>) -> Result<UsageSummary, String> {
    let (requests, prompt_tokens, completion_tokens) = state.db.usage_summary().map_err(err)?;
    Ok(UsageSummary { requests, prompt_tokens, completion_tokens })
}

/// 用量页(§2.6.7):本月汇总 + 最近 20 次请求 + 各模型首字中位数(最近 20 次)
#[derive(Serialize)]
pub struct UsageReport {
    pub month_requests: i64,
    pub month_prompt: i64,
    pub month_completion: i64,
    pub month_reasoning: i64,
    pub models: Vec<ModelStat>,
    pub recent: Vec<crate::db::UsageRow>,
}

#[derive(Serialize)]
pub struct ModelStat {
    pub model: String,
    pub samples: usize,
    pub ttft_median_ms: Option<i64>,
    pub total_median_ms: i64,
}

fn median(mut v: Vec<i64>) -> Option<i64> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    let n = v.len();
    Some(if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2 })
}

/// month_start:本地时区本月 1 日 0 点的 unix 秒(前端算)
#[tauri::command]
pub async fn usage_report(state: State<'_, AppState>, month_start: i64) -> Result<UsageReport, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (month_requests, month_prompt, month_completion, month_reasoning) = db.usage_since(month_start).map_err(err)?;
        let pool = db.usage_recent(400).map_err(err)?;
        let mut order: Vec<String> = Vec::new();
        let mut by: std::collections::HashMap<String, Vec<&crate::db::UsageRow>> = Default::default();
        for r in &pool {
            let key = if r.model.is_empty() { "(未知)".to_string() } else { r.model.clone() };
            let e = by.entry(key.clone()).or_default();
            if e.is_empty() {
                order.push(key);
            }
            if e.len() < 20 {
                e.push(r);
            }
        }
        let models = order
            .into_iter()
            .map(|m| {
                let rows = &by[&m];
                ModelStat {
                    samples: rows.len(),
                    ttft_median_ms: median(rows.iter().filter_map(|r| r.ttft_ms).collect()),
                    total_median_ms: median(rows.iter().map(|r| r.latency_ms).collect()).unwrap_or(0),
                    model: m,
                }
            })
            .collect();
        let recent = pool.into_iter().take(20).collect();
        Ok(UsageReport { month_requests, month_prompt, month_completion, month_reasoning, models, recent })
    })
    .await
    .map_err(err)?
}

// ---------- 热键状态 ----------

/// 当前热键注册状态(注册失败时设置页标红;状态变化另有 `hotkey-status` 事件)
#[tauri::command]
pub fn hotkey_status(state: State<crate::HotkeyState>) -> crate::HotkeyStatus {
    state.0.lock().unwrap().clone()
}

// ---------- 原生观感(v0.3 §2.7) ----------

/// 系统强调色 hex;非 macOS / 读取失败 → None(前端回落 #0a7aff / #0a84ff)
#[tauri::command]
pub fn get_accent() -> Option<String> {
    crate::native::current_accent()
}

/// 打开独立设置窗口(async:Windows 上同步命令里建窗会死锁)
#[tauri::command]
pub async fn open_settings(app: tauri::AppHandle, section: Option<String>) -> Result<(), String> {
    crate::native::show_settings(&app, section.as_deref());
    Ok(())
}

/// 设置页预览:当前思考设置实际会附加到请求体的字段(JSON;空串 = 不附加)
#[tauri::command]
pub fn thinking_preview(form: ProviderForm) -> String {
    providers::thinking::param_for(i64::MIN, &form.kind, &form.base_url, &form.model, form.extra.as_deref().unwrap_or("{}"))
        .map(|m| serde_json::Value::Object(m).to_string())
        .unwrap_or_default()
}

/// 单块重译(「格式可能有误」一键重译):清空该块译文回到待译,前端随后发起续译
#[tauri::command]
pub fn reset_block(state: State<AppState>, article_id: i64, idx: usize) -> Result<(), String> {
    state.db.reset_block(article_id, idx).map_err(err)
}
