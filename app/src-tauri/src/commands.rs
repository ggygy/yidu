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

/// 「存入文章库」:热键触发的临时翻译转正
#[tauri::command]
pub fn article_keep(app: tauri::AppHandle, state: State<AppState>, id: i64) -> Result<(), String> {
    use tauri::Emitter;
    state.db.keep_article(id).map_err(err)?;
    let _ = app.emit("library-changed", ());
    Ok(())
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
    tauri::async_runtime::spawn(translate::run(app, request, translate::EventSink::channel(on_event), session));
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
    pub concurrency: Option<u8>,       // 并发批次 1–3(§2.6.3;Ollama 恒 1)
    pub cached_price_per_mtok: Option<f64>, // 缓存命中输入的单价(¥/1M);未填 = 按普通单价算
    pub batch_mode: Option<String>,    // speed(独立请求、可并发)| cache(连续对话、串行,前缀缓存命中高)
    pub native_lang: Option<String>,   // v0.3 §2.1:母语(自动方向:源 = 母语 → 译第二语言,否则 → 译母语)
    pub second_lang: Option<String>,   // 第二语言
    // v0.4:划词 / 截图 / 替换热键(空串 = 停用)与 OCR 引擎
    pub hotkey_selection: Option<String>,
    pub hotkey_screenshot: Option<String>,
    pub hotkey_replace: Option<String>,
    pub ocr_engine: Option<String>,    // system(本机识别)| model(多模态模型转写)
    pub ocr_provider_id: Option<i64>,  // model 引擎用哪个 provider;None / 已删 = 当前激活的
    pub ocr_model: Option<String>,     // model 引擎的模型名;空 = 该 provider 自己的模型
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
    pub concurrency: u8,
    pub cached_price_per_mtok: Option<f64>,
    pub batch_mode: String,
    pub native_lang: String,
    pub second_lang: String,
    pub hotkey_selection: String,
    pub hotkey_screenshot: String,
    pub hotkey_replace: String,
    pub ocr_engine: String,
    pub ocr_provider_id: Option<i64>,
    pub ocr_model: String,
}

/// 四个全局热键动作 → 当前组合键(顺序同 `crate::HOTKEY_ACTIONS`)
pub fn hotkeys_of(p: &PrefsEffective) -> [(&'static str, String); 4] {
    [
        ("quick", p.hotkey.clone()),
        ("selection", p.hotkey_selection.clone()),
        ("screenshot", p.hotkey_screenshot.clone()),
        ("replace", p.hotkey_replace.clone()),
    ]
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

/// 语言代码(内置 8 语或 "~自定义名");含 "2"(会截断 direction 编码)或空则用默认
fn lang_or(v: &Option<String>, def: &str) -> String {
    match v.as_deref().map(str::trim) {
        Some(c) if !c.is_empty() && !c.contains('2') && c != "?" => c.to_string(),
        _ => def.to_string(),
    }
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
        concurrency: p.concurrency.unwrap_or(3).clamp(1, 3),
        cached_price_per_mtok: p.cached_price_per_mtok.filter(|v| v.is_finite() && *v > 0.0),
        batch_mode: if p.batch_mode.as_deref() == Some("speed") { "speed".into() } else { "cache".into() },
        native_lang: lang_or(&p.native_lang, "zh"),
        second_lang: {
            let native = lang_or(&p.native_lang, "zh");
            let s = lang_or(&p.second_lang, if native == "en" { "zh" } else { "en" });
            if s == native { if native == "en" { "zh".into() } else { "en".into() } } else { s }
        },
        hotkey_selection: p.hotkey_selection.clone().unwrap_or_else(|| "Alt+D".into()).trim().to_string(),
        hotkey_screenshot: p.hotkey_screenshot.clone().unwrap_or_else(|| "Alt+S".into()).trim().to_string(),
        hotkey_replace: p.hotkey_replace.clone().unwrap_or_else(|| "Alt+R".into()).trim().to_string(),
        ocr_engine: if p.ocr_engine.as_deref() == Some("model") { "model".into() } else { "system".into() },
        ocr_provider_id: p.ocr_provider_id,
        ocr_model: p.ocr_model.as_deref().map(str::trim).unwrap_or("").to_string(),
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
    if update.concurrency.is_some() {
        stored.concurrency = update.concurrency;
    }
    if let Some(v) = &update.native_lang {
        stored.native_lang = Some(v.clone());
    }
    if let Some(v) = &update.second_lang {
        stored.second_lang = Some(v.clone());
    }
    if let Some(v) = &update.batch_mode {
        stored.batch_mode = Some(v.clone());
    }
    if update.cached_price_per_mtok.is_some() {
        stored.cached_price_per_mtok = update.cached_price_per_mtok;
    }
    if let Some(v) = &update.hotkey_selection {
        stored.hotkey_selection = Some(v.clone());
    }
    if let Some(v) = &update.hotkey_screenshot {
        stored.hotkey_screenshot = Some(v.clone());
    }
    if let Some(v) = &update.hotkey_replace {
        stored.hotkey_replace = Some(v.clone());
    }
    if let Some(v) = &update.ocr_engine {
        stored.ocr_engine = Some(v.clone());
    }
    if update.ocr_provider_id.is_some() {
        // 约定:≤ 0 = 清除(跟随当前激活的 provider)
        stored.ocr_provider_id = update.ocr_provider_id.filter(|id| *id > 0);
    }
    if let Some(v) = &update.ocr_model {
        stored.ocr_model = Some(v.clone());
    }
    // 热键变更:Rust 侧重注册(任一失败即整体不落库,偏好保持旧值)
    let new_keys = hotkeys_of(&effective_prefs(&stored));
    let old_keys = hotkeys_of(&effective_prefs(&old));
    for ((action, new_key), (_, old_key)) in new_keys.iter().zip(old_keys.iter()) {
        if new_key != old_key {
            crate::reregister_hotkey(app, action, old_key, new_key).map_err(err)?;
        }
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

/// 生词本删除后托盘的待复习数可能变了
fn after_vocab_change(app: &tauri::AppHandle) {
    crate::refresh_tray(app);
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
pub fn vocab_delete(app: tauri::AppHandle, state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.delete_vocab(id).map_err(err)?;
    after_vocab_change(&app);
    Ok(())
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
    pub month_cached: i64,
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
        let (month_requests, month_prompt, month_completion, month_reasoning, month_cached) = db.usage_since(month_start).map_err(err)?;
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
        Ok(UsageReport { month_requests, month_prompt, month_completion, month_reasoning, month_cached, models, recent })
    })
    .await
    .map_err(err)?
}

// ---------- 热键状态 ----------

/// 当前热键注册状态(注册失败时设置页标红;状态变化另有 `hotkey-status` 事件)
#[tauri::command]
pub fn hotkey_status(state: State<crate::HotkeyState>) -> crate::HotkeyMap {
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

/// 快捷窗一键缩小为悬浮图标(翻译在后台照常进行)
#[tauri::command]
pub async fn quick_minimize(app: tauri::AppHandle) -> Result<(), String> {
    let a = app.clone();
    app.run_on_main_thread(move || crate::native::minimize_quick(&a)).map_err(err)
}

/// 点悬浮图标:展开回快捷窗
#[tauri::command]
pub async fn quick_expand(app: tauri::AppHandle) -> Result<(), String> {
    let a = app.clone();
    app.run_on_main_thread(move || crate::native::expand_quick(&a)).map_err(err)
}

// ---------- v0.4:OCR / 系统权限 / 划词替换 ----------

/// 图片 → 文字。前端以 Uint8Array 作 invoke 第二参(raw body,无 base64 膨胀);
/// 引擎按偏好(本机 / 多模态模型,模型失败回落本机)。识别不到文字 → text 为空串
#[tauri::command]
pub async fn ocr_image(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<crate::flow::OcrOutput, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("ocr_image 需要图片原始字节(Uint8Array)".into()),
    };
    let mime = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    crate::flow::recognize(&app, bytes, mime).await.map_err(err)
}

#[tauri::command]
pub fn permission_status() -> crate::permissions::PermissionStatus {
    crate::permissions::status()
}

/// 触发系统授权框并打开对应的系统设置面板(kind:accessibility | screen)
#[tauri::command]
pub async fn permission_request(kind: String) -> Result<crate::permissions::PermissionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::permissions::request(&kind);
        crate::permissions::status()
    })
    .await
    .map_err(err)
}

/// 划词替换(⌥R)后半段:快捷窗 webview 判定方向后回调。译完确认前台仍是原应用 → 粘贴覆盖选区;
/// 已切走 → 译文留在剪贴板并报错(不往别的应用里乱贴)
#[tauri::command]
pub async fn replace_translate(app: tauri::AppHandle, state: State<'_, AppState>, text: String, direction: String, front: i64) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let session = state.counter.fetch_add(1, Ordering::SeqCst) + 1;
    state.active.store(session, Ordering::SeqCst);
    crate::tray_busy(&app, true);
    let translated = translate::translate_to_text(&app, text, direction, session).await;
    crate::tray_busy(&app, false);
    let translated = translated.map_err(err)?;
    if translated.trim().is_empty() {
        return Err("译文为空".into());
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if crate::selection::frontmost() != front {
            let _ = app2.clipboard().write_text(translated);
            return Err("前台应用已切换,没有替换;译文已复制到剪贴板".to_string());
        }
        crate::selection::paste_over_selection(&app2, &translated).map_err(err)
    })
    .await
    .map_err(err)?
}

// ---------- v0.6:生词复习(SM-2 变体,srs.rs) ----------

/// 此刻可复习的张数(生词本按钮 / 托盘菜单)
#[tauri::command]
pub fn review_count(state: State<AppState>) -> Result<i64, String> {
    state.db.review_count(crate::db::now()).map_err(err)
}

/// 复习队列(到期旧词在前,新词受每 24h 上限约束)
#[tauri::command]
pub fn review_due(state: State<AppState>, limit: Option<i64>) -> Result<Vec<crate::db::ReviewCard>, String> {
    state.db.review_due(crate::db::now(), limit.unwrap_or(200).clamp(1, 500)).map_err(err)
}

#[derive(Serialize)]
pub struct ReviewResult {
    pub due_at: i64,
    pub interval_days: f64,
    /// 评分后还剩多少张可复习
    pub remaining: i64,
}

#[tauri::command]
pub fn review_grade(app: tauri::AppHandle, state: State<AppState>, entry_id: i64, grade: crate::srs::Grade) -> Result<ReviewResult, String> {
    let now = crate::db::now();
    let next = state.db.review_grade(entry_id, grade, now).map_err(err)?;
    let remaining = state.db.review_count(now).map_err(err)?;
    crate::refresh_tray(&app);
    Ok(ReviewResult { due_at: next.due_at, interval_days: next.interval_days, remaining })
}
