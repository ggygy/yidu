// 思考控制(v0.3 §2.6.1 + §2.3.9):两个维度
// - 级别 thinking_mode:auto(已知服务商关闭,其他不干预)/ off / low / medium / high / default(不干预,模型默认)
// - 字段格式 thinking_format:auto(按 host 推断;未知 host 用 OpenAI 式 reasoning_effort)/ openai / deepseek / qwen / ollama / custom
// 请求体注入若干字段;400/422 且错误体提及其中字段 → 先降级(reasoning_effort none→minimal→low),
// 仍不认则去掉全部字段重试一次,并把该 provider 标记为「不支持」。
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// 需注入的顶层字段(一个或多个,如 Qwen 的 enable_thinking + thinking_budget)
pub type ThinkingParam = Map<String, Value>;

fn host_of(base_url: &str) -> String {
    let s = base_url.trim();
    let s = s.split("://").nth(1).unwrap_or(s);
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host); // 去 userinfo
    host.split(':').next().unwrap_or("").to_ascii_lowercase()
}

fn host_is(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// OpenAI 推理模型:o1/o3/o4…、gpt-5*(非 -chat)
fn is_openai_reasoning_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    let mut cs = m.chars();
    let o_series = cs.next() == Some('o') && cs.next().is_some_and(|c| c.is_ascii_digit());
    let gpt5 = m.starts_with("gpt-5") && !m.contains("-chat");
    o_series || gpt5
}

/// 进程内已探明不支持的 provider(写回 extra 之前/之外的兜底,避免同会话反复 400)
fn unsupported_set() -> &'static Mutex<HashSet<i64>> {
    static SET: OnceLock<Mutex<HashSet<i64>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn mark_unsupported(provider_id: i64) {
    unsupported_set().lock().unwrap().insert(provider_id);
}

/// 设置里改了思考控制:清进程内「不支持」标记,下一次请求重新探测
pub fn clear_unsupported(provider_id: i64) {
    unsupported_set().lock().unwrap().remove(&provider_id);
}

fn known_unsupported(provider_id: i64) -> bool {
    unsupported_set().lock().unwrap().contains(&provider_id)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Off,
    Low,
    Medium,
    High,
}

/// 由 host / kind 推断的字段格式;None = 未知 host
fn detect_format(kind: &str, base_url: &str, model: &str) -> Option<&'static str> {
    if kind == "ollama" {
        return Some("ollama");
    }
    let host = host_of(base_url);
    if host_is(&host, "deepseek.com") || host_is(&host, "bigmodel.cn") || host_is(&host, "z.ai") {
        return Some("deepseek");
    }
    if host_is(&host, "dashscope.aliyuncs.com") || host_is(&host, "dashscope-intl.aliyuncs.com") {
        return Some("qwen");
    }
    if host_is(&host, "openai.com") {
        return Some(if is_openai_reasoning_model(model) { "openai" } else { "none" });
    }
    None
}

fn one(k: &str, v: Value) -> ThinkingParam {
    let mut m = Map::new();
    m.insert(k.to_string(), v);
    m
}

/// 按格式把级别翻译成请求字段
fn fields_for(format: &str, level: Level, model: &str) -> Option<ThinkingParam> {
    let effort = match level {
        Level::Off => "none",
        Level::Low => "low",
        Level::Medium => "medium",
        Level::High => "high",
    };
    match format {
        "openai" => Some(one("reasoning_effort", json!(effort))),
        // DeepSeek / 智谱:只有开关,没有强度
        "deepseek" => Some(one("thinking", json!({ "type": if level == Level::Off { "disabled" } else { "enabled" } }))),
        // 百炼 Qwen:开关 + 思考预算(tokens)
        "qwen" => {
            let mut m = one("enable_thinking", json!(level != Level::Off));
            let budget = match level {
                Level::Off => None,
                Level::Low => Some(1024),
                Level::Medium => Some(4096),
                Level::High => Some(16384),
            };
            if let Some(b) = budget {
                m.insert("thinking_budget".into(), json!(b));
            }
            Some(m)
        }
        "ollama" => {
            // gpt-oss 只认 low/medium/high(关不掉,最低 low);其他模型布尔
            if model.to_ascii_lowercase().contains("gpt-oss") {
                Some(one("think", json!(if level == Level::Off { "low" } else { effort })))
            } else {
                Some(one("think", json!(level != Level::Off)))
            }
        }
        _ => None,
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|s| s.as_str())
}

/// 旧版 extra(thinking_control 单选)→ (mode, format)
fn legacy(v: &Value) -> (Option<&'static str>, Option<String>) {
    match str_of(v, "thinking_control") {
        Some("none") => (Some("default"), None),
        Some(f @ ("deepseek" | "qwen" | "openai" | "ollama")) => (Some("off"), Some(f.to_string())),
        Some("custom") => (Some("off"), Some("custom".into())),
        _ => (None, None),
    }
}

/// 决定注入什么。kind = providers.kind("openai_compatible" | "ollama")
pub fn param_for(provider_id: i64, kind: &str, base_url: &str, model: &str, extra: &str) -> Option<ThinkingParam> {
    let ex = serde_json::from_str::<Value>(extra).unwrap_or(Value::Null);
    let (lmode, lformat) = legacy(&ex);
    let mode = str_of(&ex, "thinking_mode").or(lmode).unwrap_or("auto");
    let format = str_of(&ex, "thinking_format").map(str::to_string).or(lformat).unwrap_or_else(|| "auto".into());

    let level = match mode {
        "default" => return None,
        "off" => Level::Off,
        "low" => Level::Low,
        "medium" => Level::Medium,
        "high" => Level::High,
        _ => {
            // 自动:只对已知服务商关思考;未知 host 不干预(且已探明不支持就不再试)
            if ex.get("thinking_unsupported").and_then(|b| b.as_bool()) == Some(true) || known_unsupported(provider_id) {
                return None;
            }
            let f = if format == "auto" { detect_format(kind, base_url, model)? } else { format.as_str() };
            return fields_for(f, Level::Off, model);
        }
    };
    // 用户显式选了级别:不受「已探明不支持」影响(改设置后自会重新探测)
    if format == "custom" {
        let raw = str_of(&ex, "thinking_custom").unwrap_or("");
        return serde_json::from_str::<Value>(raw).ok().and_then(|v| v.as_object().cloned()).filter(|m| !m.is_empty());
    }
    let f = if format == "auto" { detect_format(kind, base_url, model).unwrap_or("openai") } else { format.as_str() };
    fields_for(f, level, model)
}

/// 400 错误体是否在抱怨这些字段(决定是否降级 / 去字段重试)
pub fn error_mentions(param: &ThinkingParam, status: u16, body: &str) -> bool {
    if status != 400 && status != 422 {
        return false;
    }
    let b = body.to_ascii_lowercase();
    param.keys().any(|field| match field.as_str() {
        // Ollama:`"xxx" does not support thinking`
        "think" | "thinking" | "enable_thinking" | "thinking_budget" => b.contains("think"),
        "reasoning_effort" => b.contains("reasoning_effort") || b.contains("reasoning effort") || b.contains("reasoning"),
        other => b.contains(&other.to_ascii_lowercase()),
    })
}

/// 降级:reasoning_effort none → minimal → low(老型号 / 网关不认 none)
pub fn fallback(param: &ThinkingParam) -> Option<ThinkingParam> {
    let next = match param.get("reasoning_effort")?.as_str()? {
        "none" => "minimal",
        "minimal" => "low",
        _ => return None,
    };
    let mut p = param.clone();
    p.insert("reasoning_effort".into(), json!(next));
    Some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pairs: &[(&str, Value)]) -> Option<ThinkingParam> {
        let mut m = Map::new();
        for (k, v) in pairs {
            m.insert(k.to_string(), v.clone());
        }
        Some(m)
    }

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://api.deepseek.com/v1"), "api.deepseek.com");
        assert_eq!(host_of("http://user:pw@Open.BigModel.cn:443/api/paas/v4/"), "open.bigmodel.cn");
        assert_eq!(host_of("localhost:11434"), "localhost");
    }

    #[test]
    fn auto_mode_whitelist() {
        assert_eq!(param_for(1, "openai_compatible", "https://api.deepseek.com", "deepseek-flash", "{}"), p(&[("thinking", json!({"type":"disabled"}))]));
        assert_eq!(param_for(1, "openai_compatible", "https://open.bigmodel.cn/api/paas/v4", "glm-4.5-flash", "{}"), p(&[("thinking", json!({"type":"disabled"}))]));
        assert_eq!(param_for(1, "openai_compatible", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-8b", "{}"), p(&[("enable_thinking", json!(false))]));
        assert_eq!(param_for(1, "openai_compatible", "https://api.openai.com/v1", "gpt-5.1", "{}"), p(&[("reasoning_effort", json!("none"))]));
        assert_eq!(param_for(1, "openai_compatible", "https://api.openai.com/v1", "gpt-4o", "{}"), None);
        assert_eq!(param_for(1, "openai_compatible", "https://ada.example.com/v1", "x", "{}"), None);
        assert_eq!(param_for(1, "openai_compatible", "https://notdeepseek.com", "x", "{}"), None);
        assert_eq!(param_for(1, "ollama", "http://localhost:11434", "qwen3:4b", "{}"), p(&[("think", json!(false))]));
        assert_eq!(param_for(1, "ollama", "http://localhost:11434", "gpt-oss:20b", "{}"), p(&[("think", json!("low"))]));
    }

    #[test]
    fn explicit_level_on_unknown_host_uses_openai_format() {
        let ada = "http://ada.example.com/coding-plan/v1/chat/completions";
        assert_eq!(param_for(7, "openai_compatible", ada, "auto", r#"{"thinking_mode":"off"}"#), p(&[("reasoning_effort", json!("none"))]));
        assert_eq!(param_for(7, "openai_compatible", ada, "auto", r#"{"thinking_mode":"high"}"#), p(&[("reasoning_effort", json!("high"))]));
        assert_eq!(param_for(7, "openai_compatible", ada, "auto", r#"{"thinking_mode":"default"}"#), None);
        assert_eq!(
            param_for(7, "openai_compatible", ada, "auto", r#"{"thinking_mode":"off","thinking_format":"deepseek"}"#),
            p(&[("thinking", json!({"type":"disabled"}))])
        );
        assert_eq!(
            param_for(7, "openai_compatible", ada, "q", r#"{"thinking_mode":"medium","thinking_format":"qwen"}"#),
            p(&[("enable_thinking", json!(true)), ("thinking_budget", json!(4096))])
        );
        assert_eq!(
            param_for(7, "openai_compatible", ada, "q", r#"{"thinking_mode":"off","thinking_format":"custom","thinking_custom":"{\"think\": false, \"x\": 1}"}"#),
            p(&[("think", json!(false)), ("x", json!(1))])
        );
        assert_eq!(param_for(7, "openai_compatible", ada, "q", r#"{"thinking_mode":"low","thinking_unsupported":true}"#), p(&[("reasoning_effort", json!("low"))]));
        assert_eq!(param_for(7, "openai_compatible", "https://api.deepseek.com", "q", r#"{"thinking_unsupported":true}"#), None);
    }

    #[test]
    fn legacy_control_values() {
        assert_eq!(param_for(8, "openai_compatible", "https://x.example", "m", r#"{"thinking_control":"none"}"#), None);
        assert_eq!(param_for(8, "openai_compatible", "https://x.example", "m", r#"{"thinking_control":"deepseek"}"#), p(&[("thinking", json!({"type":"disabled"}))]));
    }

    #[test]
    fn levels_per_format() {
        let ex = |m: &str, f: &str| format!(r#"{{"thinking_mode":"{m}","thinking_format":"{f}"}}"#);
        assert_eq!(param_for(9, "openai_compatible", "https://x", "m", &ex("high", "deepseek")), p(&[("thinking", json!({"type":"enabled"}))]));
        assert_eq!(param_for(9, "ollama", "http://localhost:11434", "qwen3", &ex("low", "auto")), p(&[("think", json!(true))]));
        assert_eq!(param_for(9, "ollama", "http://localhost:11434", "gpt-oss:20b", &ex("high", "auto")), p(&[("think", json!("high"))]));
    }

    #[test]
    fn error_detection_and_fallback() {
        let rp = p(&[("reasoning_effort", json!("none"))]).unwrap();
        assert!(error_mentions(&rp, 400, r#"{"error":{"message":"Unsupported value: 'reasoning_effort' does not support 'none'"}}"#));
        assert!(!error_mentions(&rp, 401, "reasoning_effort"));
        assert!(!error_mentions(&rp, 400, "model not found"));
        let tp = p(&[("think", json!(false))]).unwrap();
        assert!(error_mentions(&tp, 400, r#"{"error":"\"llama3\" does not support thinking"}"#));
        assert_eq!(fallback(&rp).unwrap().get("reasoning_effort"), Some(&json!("minimal")));
        assert_eq!(fallback(&fallback(&rp).unwrap()).unwrap().get("reasoning_effort"), Some(&json!("low")));
        assert!(fallback(&tp).is_none());
    }
}
