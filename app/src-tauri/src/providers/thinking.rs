// 关思考(v0.3 §2.6.1):按 host 白名单注入请求字段;其他 host 不注入(§2.3 思考控制下拉在 M3)。
// 注入后 400 且错误体提及该字段 → 调用方去字段重试一次,并把该 provider 标记为「不支持」。
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// 需注入的字段:(顶层字段名, 值)
pub type ThinkingParam = (&'static str, Value);

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

/// extra JSON 里是否已标「不支持」(或用户显式选择不注入)
fn disabled_by_extra(extra: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(extra) else { return false };
    v.get("thinking_unsupported").and_then(|b| b.as_bool()) == Some(true)
        || v.get("thinking_control").and_then(|s| s.as_str()) == Some("none")
}

/// 进程内已探明不支持的 provider(写回 extra 之前/之外的兜底,避免同会话反复 400)
fn unsupported_set() -> &'static Mutex<HashSet<i64>> {
    static SET: OnceLock<Mutex<HashSet<i64>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn mark_unsupported(provider_id: i64) {
    unsupported_set().lock().unwrap().insert(provider_id);
}

fn known_unsupported(provider_id: i64) -> bool {
    unsupported_set().lock().unwrap().contains(&provider_id)
}

/// 决定注入什么。kind = providers.kind("openai_compatible" | "ollama")
pub fn param_for(provider_id: i64, kind: &str, base_url: &str, model: &str, extra: &str) -> Option<ThinkingParam> {
    if disabled_by_extra(extra) || known_unsupported(provider_id) {
        return None;
    }
    if kind == "ollama" {
        // gpt-oss 只认 low/medium/high,布尔被忽略
        return Some(if model.to_ascii_lowercase().contains("gpt-oss") {
            ("think", json!("low"))
        } else {
            ("think", json!(false))
        });
    }
    let host = host_of(base_url);
    if host_is(&host, "deepseek.com") || host_is(&host, "bigmodel.cn") || host_is(&host, "z.ai") {
        return Some(("thinking", json!({ "type": "disabled" })));
    }
    if host_is(&host, "dashscope.aliyuncs.com") || host_is(&host, "dashscope-intl.aliyuncs.com") {
        return Some(("enable_thinking", json!(false)));
    }
    if host_is(&host, "openai.com") && is_openai_reasoning_model(model) {
        return Some(("reasoning_effort", json!("none")));
    }
    None
}

/// 400 错误体是否在抱怨该字段(决定是否去字段重试)
pub fn error_mentions(field: &str, status: u16, body: &str) -> bool {
    if status != 400 && status != 422 {
        return false;
    }
    let b = body.to_ascii_lowercase();
    match field {
        // Ollama:`"xxx" does not support thinking`
        "think" => b.contains("think"),
        "reasoning_effort" => b.contains("reasoning_effort") || b.contains("reasoning effort"),
        "enable_thinking" => b.contains("enable_thinking") || b.contains("thinking"),
        "thinking" => b.contains("thinking"),
        other => b.contains(other),
    }
}

/// reasoning_effort 的 "none" 被拒时的降级值(老型号不认 none)
pub fn fallback_value(field: &str, value: &Value) -> Option<Value> {
    if field == "reasoning_effort" && value == &json!("none") {
        Some(json!("low"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_parsing() {
        assert_eq!(host_of("https://api.deepseek.com/v1"), "api.deepseek.com");
        assert_eq!(host_of("http://user:pw@Open.BigModel.cn:443/api/paas/v4/"), "open.bigmodel.cn");
        assert_eq!(host_of("localhost:11434"), "localhost");
    }

    #[test]
    fn whitelist_injection() {
        assert_eq!(
            param_for(1, "openai_compatible", "https://api.deepseek.com", "deepseek-flash", "{}"),
            Some(("thinking", json!({"type":"disabled"})))
        );
        assert_eq!(
            param_for(1, "openai_compatible", "https://open.bigmodel.cn/api/paas/v4", "glm-4.5-flash", "{}").map(|p| p.0),
            Some("thinking")
        );
        assert_eq!(
            param_for(1, "openai_compatible", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3-8b", "{}"),
            Some(("enable_thinking", json!(false)))
        );
        assert_eq!(
            param_for(1, "openai_compatible", "https://api.openai.com/v1", "gpt-5.1", "{}"),
            Some(("reasoning_effort", json!("none")))
        );
        // 非推理模型 / 未知 host:不注入
        assert_eq!(param_for(1, "openai_compatible", "https://api.openai.com/v1", "gpt-4o", "{}"), None);
        assert_eq!(param_for(1, "openai_compatible", "https://api.openai.com/v1", "gpt-5-chat-latest", "{}"), None);
        assert_eq!(param_for(1, "openai_compatible", "https://ada.example.com/v1", "x", "{}"), None);
        // 仿冒域名不命中
        assert_eq!(param_for(1, "openai_compatible", "https://notdeepseek.com", "x", "{}"), None);
        // Ollama
        assert_eq!(param_for(1, "ollama", "http://localhost:11434", "qwen3:4b", "{}"), Some(("think", json!(false))));
        assert_eq!(param_for(1, "ollama", "http://localhost:11434", "gpt-oss:20b", "{}"), Some(("think", json!("low"))));
    }

    #[test]
    fn unsupported_flag_disables() {
        assert_eq!(
            param_for(1, "openai_compatible", "https://api.deepseek.com", "m", r#"{"thinking_unsupported":true}"#),
            None
        );
        mark_unsupported(424242);
        assert_eq!(param_for(424242, "openai_compatible", "https://api.deepseek.com", "m", "{}"), None);
    }

    #[test]
    fn error_detection() {
        assert!(error_mentions("thinking", 400, r#"{"error":{"message":"thinking type disabled not supported"}}"#));
        assert!(!error_mentions("thinking", 401, "thinking"));
        assert!(!error_mentions("reasoning_effort", 400, "model not found"));
        assert!(error_mentions("think", 400, r#"{"error":"\"llama3\" does not support thinking"}"#));
    }
}
