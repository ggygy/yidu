// 免费词典查词链(工单 13 实测定案):有道 jsonapi → dictionaryapi.dev → Provider 兜底。
// 缓存策略:payload 存归一化卡片(1~3KB);正常命中永不过期;source:"miss" 负缓存 24h。
// 任何一级网络错误都视为该级 miss,直落下一级,不向用户抛词典网络错误。
use crate::db::{Db, ProviderRow};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Semaphore;

pub const SCHEMA_VERSION: u32 = 1;
const MISS_TTL_SECS: i64 = 24 * 3600;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Sense {
    pub pos: String,
    pub gloss: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Example {
    pub en: String,
    pub zh: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct DictCard {
    pub schema_version: u32,
    pub source: String, // youdao | dictapi | model | miss
    pub phonetic_us: String,
    pub phonetic_uk: String,
    pub senses: Vec<Sense>,
    pub web_trans: Vec<String>,
    pub examples: Vec<Example>,
    pub audio: String,
}

impl DictCard {
    fn miss() -> Self {
        DictCard { schema_version: SCHEMA_VERSION, source: "miss".into(), ..Default::default() }
    }
    fn is_miss(&self) -> bool {
        self.source == "miss"
    }
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3)) // 黑洞路由保护,离线秒级落 Provider
            .timeout(Duration::from_secs(8))
            .gzip(true) // 有道 614KB → 1.7KB,必开
            .user_agent("yidu/0.1")
            .build()
            .expect("dict client")
    })
}

fn gate() -> &'static Semaphore {
    static S: OnceLock<Semaphore> = OnceLock::new();
    S.get_or_init(|| Semaphore::new(4)) // 并发限流,不做爬虫式压力
}

/// as_str 兼容:有道的 l.i 字段可能是 string 或数组
fn val_strings(v: &serde_json::Value) -> Vec<String> {
    match v {
        serde_json::Value::String(s) => vec![s.clone()],
        serde_json::Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => vec![],
    }
}

// ---------- 有道 jsonapi ----------

async fn youdao(word: &str) -> Result<Option<DictCard>> {
    let _permit = gate().acquire().await?;
    let resp = client()
        .get("https://dict.youdao.com/jsonapi")
        .query(&[("q", word)])
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let v: serde_json::Value = resp.json().await?;
    Ok(parse_youdao(&v, word))
}

fn parse_youdao(v: &serde_json::Value, word: &str) -> Option<DictCard> {
    let mut card = DictCard { schema_version: SCHEMA_VERSION, source: "youdao".into(), ..Default::default() };
    // 音标 + 双语言义
    if let Some(ec) = v.pointer("/ec/word/0") {
        card.phonetic_us = ec.get("usphone").and_then(|x| x.as_str()).unwrap_or("").to_string();
        card.phonetic_uk = ec.get("ukphone").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if let Some(trs) = ec.get("trs").and_then(|t| t.as_array()) {
            for tr in trs.iter().take(8) {
                // 义项串内嵌词性:"v. 携带,拿走;…"
                let items = val_strings(&tr["tr"]["l"]["i"]);
                for it in items {
                    let (pos, gloss) = split_pos(&it);
                    if !gloss.is_empty() {
                        card.senses.push(Sense { pos: pos.to_string(), gloss: gloss.to_string() });
                    }
                }
            }
        }
    }
    // 网络释义(生僻词回落)
    if let Some(list) = v.pointer("/web_trans/web-translation/0/trans").and_then(|t| t.as_array()) {
        for t in list.iter().take(5) {
            if let Some(s) = t.get("value").and_then(|x| x.as_str()) {
                if !s.is_empty() {
                    card.web_trans.push(s.to_string());
                }
            }
        }
    }
    // 双语例句
    if let Some(pairs) = v.pointer("/blng_sents_part/sentence-pair").and_then(|p| p.as_array()) {
        for p in pairs.iter().take(4) {
            let en = p.get("sentence").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let zh = p.get("sentence-translation").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if !en.is_empty() {
                card.examples.push(Example { en, zh });
            }
        }
    }
    if card.senses.is_empty() && card.web_trans.is_empty() {
        return None; // 未收录(149B 空壳 / isHasSimpleDict=0)
    }
    card.audio = format!("https://dict.youdao.com/dictvoice?type=0&audio={word}");
    Some(card)
}

/// "v. 携带" → ("v", "携带");无词性前缀则 ("", 原文)
fn split_pos(s: &str) -> (&str, &str) {
    let t = s.trim();
    for pos in ["v.", "n.", "adj.", "adv.", "vt.", "vi.", "prep.", "conj.", "pron.", "interj.", "num.", "art."] {
        if let Some(rest) = t.strip_prefix(pos) {
            return (pos.trim_end_matches('.'), rest.trim());
        }
    }
    ("", t)
}

// ---------- dictionaryapi.dev ----------

async fn dictapi(word: &str) -> Result<Option<DictCard>> {
    let _permit = gate().acquire().await?;
    let resp = client()
        .get(format!("https://api.dictionaryapi.dev/api/v2/entries/en/{word}"))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(None); // 404 = 未收录
    }
    let v: serde_json::Value = resp.json().await?;
    Ok(parse_dictapi(&v))
}

fn parse_dictapi(v: &serde_json::Value) -> Option<DictCard> {
    let first = v.as_array()?.first()?;
    let word = first.get("word").and_then(|x| x.as_str())?;
    let mut card = DictCard { schema_version: SCHEMA_VERSION, source: "dictapi".into(), ..Default::default() };
    card.phonetic_us = first.get("phonetic").and_then(|x| x.as_str()).unwrap_or("").trim_matches('/').to_string();
    if let Some(phs) = first.get("phonetics").and_then(|p| p.as_array()) {
        for p in phs {
            let t = p.get("text").and_then(|x| x.as_str()).unwrap_or("").trim_matches('/');
            if !t.is_empty() && card.phonetic_us.is_empty() {
                card.phonetic_us = t.to_string();
            }
            if let Some(a) = p.get("audio").and_then(|x| x.as_str()) {
                if !a.is_empty() && card.audio.is_empty() {
                    card.audio = a.to_string();
                }
            }
        }
    }
    if card.audio.is_empty() {
        card.audio = format!("https://dict.youdao.com/dictvoice?type=0&audio={word}");
    }
    if let Some(ms) = first.get("meanings").and_then(|m| m.as_array()) {
        for m in ms.iter().take(6) {
            let pos = m.get("partOfSpeech").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if let Some(defs) = m.get("definitions").and_then(|d| d.as_array()) {
                for d in defs.iter().take(2) {
                    let gloss = d.get("definition").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if !gloss.is_empty() {
                        card.senses.push(Sense { pos: pos.clone(), gloss });
                    }
                    if let Some(ex) = d.get("example").and_then(|x| x.as_str()) {
                        if card.examples.len() < 4 && !ex.is_empty() {
                            card.examples.push(Example { en: ex.to_string(), zh: String::new() });
                        }
                    }
                }
            }
        }
    }
    if card.senses.is_empty() {
        return None;
    }
    Some(card)
}

// ---------- Provider 兜底 ----------

async fn provider_fallback(word: &str, row: &ProviderRow) -> Result<Option<DictCard>> {
    let provider = crate::providers::build(row)?;
    let system = "你是英汉词典。用户给一个英文单词,你输出一个 JSON 对象(不要输出其他任何文字):\
                  {\"phonetic_us\":\"美式音标\",\"phonetic_uk\":\"英式音标\",\
                  \"senses\":[{\"pos\":\"词性缩写\",\"gloss\":\"中文释义\"}](最多4条),\
                  \"examples\":[{\"en\":\"英文例句\",\"zh\":\"中文翻译\"}](最多2条)}";
    let user = word.to_string();
    // 非流式:收集全部 delta 拼接
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = tauri::async_runtime::spawn(async move {
        provider.stream_chat(system, &[], &user, tx, std::sync::Arc::new(|| false)).await
    });
    let mut raw = String::new();
    while let Some(p) = rx.recv().await {
        if let crate::sse::SsePayload::Delta(d) = p {
            raw.push_str(&d);
        }
    }
    let _ = handle.await?;
    let json = extract_json(&raw);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
        let mut card = DictCard { schema_version: SCHEMA_VERSION, source: "model".into(), ..Default::default() };
        card.phonetic_us = v.get("phonetic_us").and_then(|x| x.as_str()).unwrap_or("").trim_matches('/').to_string();
        card.phonetic_uk = v.get("phonetic_uk").and_then(|x| x.as_str()).unwrap_or("").trim_matches('/').to_string();
        if let Some(ss) = v.get("senses").and_then(|x| x.as_array()) {
            for s in ss.iter().take(4) {
                card.senses.push(Sense {
                    pos: s.get("pos").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    gloss: s.get("gloss").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                });
            }
        }
        if let Some(es) = v.get("examples").and_then(|x| x.as_array()) {
            for e in es.iter().take(2) {
                card.examples.push(Example {
                    en: e.get("en").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    zh: e.get("zh").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                });
            }
        }
        if !card.senses.is_empty() {
            card.audio = format!("https://dict.youdao.com/dictvoice?type=0&audio={word}");
            return Ok(Some(card));
        }
    }
    Ok(None)
}

/// 宽松提取:模型可能包裹 ```json 围栏或前后缀
fn extract_json(raw: &str) -> String {
    let s = raw.trim();
    let s = s.strip_prefix("```json").or_else(|| s.strip_prefix("```")).unwrap_or(s);
    let s = s.strip_suffix("```").unwrap_or(s);
    let start = s.find('{').unwrap_or(0);
    let end = s.rfind('}').map(|i| i + 1).unwrap_or(s.len());
    s[start..end].to_string()
}

// ---------- 真链路集成测试(显式跑:cargo test -- --ignored) ----------

#[cfg(test)]
mod integration {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    fn test_db() -> Db {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, AtomicOrdering::SeqCst);
        let dir = std::env::temp_dir().join(format!("yidu-dict-test-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::open_path(&dir.join("t.db")).unwrap()
    }

    /// 真网络:有道主接口(工单 13 实测过的词)
    #[tokio::test]
    #[ignore = "需要网络,显式跑"]
    async fn real_youdao_hit() {
        let card = lookup(&test_db(), "hydration").await.unwrap();
        assert_ne!(card.source, "miss", "hydration 应被有道/词典命中,得到 {:?}", card.source);
        assert!(!card.senses.is_empty() || !card.web_trans.is_empty());
        // 二次查询应命中缓存(来源不变)
        let again = lookup(&test_db(), "hydration").await.unwrap();
        assert_eq!(card.source, again.source);
    }

    /// 真网络:生僻词 webview → 有道 web_trans 回落
    #[tokio::test]
    #[ignore = "需要网络,显式跑"]
    async fn real_webview_web_trans() {
        let card = lookup(&test_db(), "webview").await.unwrap();
        assert!(
            card.source == "youdao" || card.source == "dictapi" || card.source == "model",
            "webview 应命中某级(实际 {})", card.source
        );
    }
}

// ---------- 链路编排 ----------

pub async fn lookup(db: &Db, word: &str) -> Result<DictCard> {
    let word = word.trim().to_lowercase();
    if word.is_empty() {
        return Ok(DictCard::miss());
    }
    // 1. 缓存
    if let Ok(Some(payload)) = db.get_dict(&word) {
        if let Ok(card) = serde_json::from_str::<DictCard>(&payload) {
            if card.schema_version == SCHEMA_VERSION {
                if !card.is_miss() {
                    return Ok(card);
                }
                if let Ok(Some(t)) = db.dict_fetched_at(&word) {
                    if crate::db::now() - t < MISS_TTL_SECS {
                        return Ok(card);
                    }
                }
            }
        }
    }
    // 2/3. 免费词典
    if let Ok(Some(card)) = youdao(&word).await {
        let _ = db.set_dict(&word, &card);
        return Ok(card);
    }
    if let Ok(Some(card)) = dictapi(&word).await {
        let _ = db.set_dict(&word, &card);
        return Ok(card);
    }
    // 4. Provider 兜底(可关)
    let prefs_fallback = db
        .get_state("dict_fallback")
        .ok()
        .flatten()
        .map(|v| v != "0")
        .unwrap_or(true);
    if prefs_fallback {
        if let Ok(Some(row)) = db.active_provider() {
            if let Ok(Some(card)) = provider_fallback(&word, &row).await {
                let _ = db.set_dict(&word, &card);
                return Ok(card);
            }
        }
    }
    // 5. 未收录(负缓存 24h)
    let miss = DictCard::miss();
    let _ = db.set_dict(&word, &miss);
    Ok(miss)
}

// ---------- 单测:解析器 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youdao_full_hit() {
        let v: serde_json::Value = serde_json::json!({
            "ec": {"word": [{"usphone": "teɪk", "ukphone": "teɪk",
                "trs": [{"tr": {"l": {"i": ["v. 拿,携带", "n. 收入"]}}}],
                "wfs": []}]},
            "web_trans": {"web-translation": [{"trans": [{"value": "采取"}]}]},
            "blng_sents_part": {"sentence-pair": [
                {"sentence": "Take it.", "sentence-translation": "拿着它。"}
            ]}
        });
        let card = parse_youdao(&v, "take").unwrap();
        assert_eq!(card.source, "youdao");
        assert_eq!(card.phonetic_us, "teɪk");
        assert_eq!(card.senses.len(), 2);
        assert_eq!(card.senses[0].pos, "v");
        assert_eq!(card.web_trans, vec!["采取".to_string()]);
        assert_eq!(card.examples[0].zh, "拿着它。");
    }

    #[test]
    fn youdao_web_only() {
        let v: serde_json::Value = serde_json::json!({
            "web_trans": {"web-translation": [{"trans": [{"value": "网络视图"}]}]},
            "meta": {"isHasSimpleDict": "0"}
        });
        let card = parse_youdao(&v, "webview").unwrap();
        assert!(card.senses.is_empty());
        assert_eq!(card.web_trans, vec!["网络视图".to_string()]);
    }

    #[test]
    fn youdao_miss_shell() {
        let v: serde_json::Value = serde_json::json!({"input": "zzxqv", "meta": {"isHasSimpleDict": "0"}});
        assert!(parse_youdao(&v, "zzxqv").is_none());
    }

    #[test]
    fn dictapi_parse() {
        let v: serde_json::Value = serde_json::json!([{
            "word": "hello", "phonetic": "/həˈləʊ/",
            "phonetics": [{"text": "/həˈləʊ/", "audio": ""}],
            "meanings": [{"partOfSpeech": "interjection",
                "definitions": [{"definition": "used as a greeting", "example": "Hello there!"}]}]
        }]);
        let card = parse_dictapi(&v).unwrap();
        assert_eq!(card.source, "dictapi");
        assert_eq!(card.phonetic_us, "həˈləʊ");
        assert_eq!(card.senses[0].pos, "interjection");
        assert_eq!(card.examples[0].en, "Hello there!");
    }

    #[test]
    fn pos_splitting() {
        assert_eq!(split_pos("v. 携带,拿走"), ("v", "携带,拿走"));
        assert_eq!(split_pos("只是释义"), ("", "只是释义"));
    }

    #[test]
    fn json_extraction_tolerates_fences() {
        assert_eq!(extract_json("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(extract_json("前缀 {\"a\":1} 后缀"), "{\"a\":1}");
    }
}
