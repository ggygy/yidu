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
pub fn provider_save(state: State<AppState>, input: ProviderInput) -> Result<ProviderRow, String> {
    let id = state
        .db
        .upsert_provider(
            input.id,
            &input.name,
            &input.kind,
            &input.base_url,
            &input.model,
            input.extra.as_deref().unwrap_or("{}"),
        )
        .map_err(err)?;
    state.db.get_provider(id).map_err(err)
}

#[tauri::command]
pub fn provider_delete(state: State<AppState>, id: i64) -> Result<(), String> {
    keychain::set_key(id, "").map_err(err)?; // 顺带清 Keychain
    state.db.delete_provider(id).map_err(err)
}

#[tauri::command]
pub fn provider_set_key(state: State<AppState>, id: i64, key: String) -> Result<(), String> {
    let _ = state;
    keychain::set_key(id, &key).map_err(err)
}

#[tauri::command]
pub fn provider_set_active(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.set_active_provider(id).map_err(err)
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
    pub message: String,
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
        return Ok(TestResult { ok: false, latency_ms: 0, message: "尚未配置 API Key".into() });
    }
    match provider.test_conn().await {
        Ok(ms) => Ok(TestResult { ok: true, latency_ms: ms, message: format!("✓ {ms} ms") }),
        Err(e) => Ok(TestResult { ok: false, latency_ms: 0, message: e.to_string() }),
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
}

pub fn load_prefs(db: &crate::db::Db) -> Result<PrefsStored, String> {
    match db.get_state(PREFS_KEY) {
        Ok(Some(json)) => serde_json::from_str(&json).map_err(err),
        Ok(None) => Ok(PrefsStored::default()),
        Err(e) => Err(err(e)),
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
    }
}

#[tauri::command]
pub fn get_prefs(state: State<AppState>) -> Result<PrefsEffective, String> {
    let stored = load_prefs(&state.db)?;
    Ok(effective_prefs(&stored))
}

#[tauri::command]
pub fn set_prefs(app: tauri::AppHandle, state: State<AppState>, update: PrefsStored) -> Result<PrefsEffective, String> {
    let mut stored = load_prefs(&state.db)?;
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
    if update.dict_fallback.is_some() {
        stored.dict_fallback = update.dict_fallback;
        let _ = state
            .db
            .set_state("dict_fallback", if update.dict_fallback.unwrap() { "1" } else { "0" });
    }
    if update.price_per_mtok.is_some() {
        stored.price_per_mtok = update.price_per_mtok;
    }
    // 热键变更:Rust 侧重注册
    let new_hotkey = effective_prefs(&stored).hotkey;
    let old_hotkey = effective_prefs(&load_prefs(&state.db)?).hotkey;
    if new_hotkey != old_hotkey {
        crate::reregister_hotkey(&app, &old_hotkey, &new_hotkey).map_err(err)?;
    }
    state
        .db
        .set_state(PREFS_KEY, &serde_json::to_string(&stored).map_err(err)?)
        .map_err(err)?;
    Ok(effective_prefs(&stored))
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
