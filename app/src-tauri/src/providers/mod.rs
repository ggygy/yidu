// Provider 层全在 Rust(工单 04):trait + OpenAiCompatible / Ollama 两实现。
// 回调式流接口:on_payload 逐载荷回调,is_cancelled 每网络块检查,实现内聚 SSE/NDJSON 差异。

pub mod ollama;
pub mod openai;
pub mod thinking;

use crate::db::ProviderRow;
use crate::sse::SsePayload;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use std::sync::Arc;
use std::time::Duration;

/// 取消旗标:task 侧构造 Arc<AtomicU64 比对> 的闭包传入
pub type CancelCheck = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Debug, Default)]
pub struct StreamStats {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    /// 思考 token(`usage.completion_tokens_details.reasoning_tokens`;Ollama 无)
    pub reasoning_tokens: i64,
    pub finish_reason: Option<String>,
    /// 计时埋点(§2.6.8,均为相对请求发出的毫秒):响应头 / 首字节 / 首 reasoning / 首正文
    pub headers_ms: Option<i64>,
    pub first_byte_ms: Option<i64>,
    pub first_reasoning_ms: Option<i64>,
    pub first_content_ms: Option<i64>,
    /// 本次请求探明「关思考字段不被支持」并已去字段重试 → 调用方写回 providers.extra
    pub thinking_unsupported: bool,
}

/// 流式请求计时器:send 前创建,载荷到达时打点
pub struct Timing {
    t0: std::time::Instant,
}

impl Timing {
    pub fn start() -> Self {
        Timing { t0: std::time::Instant::now() }
    }
    pub fn ms(&self) -> i64 {
        self.t0.elapsed().as_millis() as i64
    }
    /// 首次打点(已有值不覆盖)
    pub fn mark(&self, slot: &mut Option<i64>) {
        if slot.is_none() {
            *slot = Some(self.ms());
        }
    }
    /// 按载荷类型打点首 reasoning / 首正文
    pub fn observe(&self, p: &SsePayload, stats: &mut StreamStats) {
        match p {
            SsePayload::Delta(_) => self.mark(&mut stats.first_content_ms),
            SsePayload::Reasoning(_) => self.mark(&mut stats.first_reasoning_ms),
            _ => {}
        }
    }
}

#[async_trait]
pub trait Provider: Send + Sync {
    /// 流式对话:全部载荷(SsePayload)推入 tx;返回聚合统计。
    /// tx 断开(前端取消)或 cancel() 为真时应尽快收尾返回。
    async fn stream_chat(
        &self,
        system: &str,
        user: &str,
        tx: tokio::sync::mpsc::UnboundedSender<SsePayload>,
        cancel: CancelCheck,
    ) -> Result<StreamStats>;
    /// 1-token 连通测试,返回延迟毫秒
    async fn test_conn(&self) -> Result<u64>;
    /// 可用模型列表(OpenAI 兼容 GET /models;Ollama GET /api/tags)
    async fn list_models(&self) -> Result<Vec<String>>;
}

pub fn shared_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .gzip(true)
            .build()
            .expect("构建 reqwest client 失败")
    })
}

/// 按配置构建 Provider;key 优先 dev 环境变量,否则 Keychain(不落库)
pub fn build(row: &ProviderRow) -> Result<Box<dyn Provider>> {
    build_with_key(row, crate::keychain::effective_key(row.id))
}

/// 用指定密钥构建(设置页「测试」用表单当前值,未保存的密钥也能测)
pub fn build_with_key(row: &ProviderRow, key: Option<String>) -> Result<Box<dyn Provider>> {
    match row.kind.as_str() {
        "openai_compatible" => Ok(Box::new(openai::OpenAiCompatible {
            base_url: row.base_url.clone(),
            model: row.model.clone(),
            api_key: key.unwrap_or_default(),
            thinking: thinking::param_for(row.id, &row.kind, &row.base_url, &row.model, &row.extra),
            provider_id: row.id,
        })),
        "ollama" => Ok(Box::new(ollama::Ollama {
            base_url: row.base_url.clone(),
            model: row.model.clone(),
            extra: row.extra.clone(),
            thinking: thinking::param_for(row.id, &row.kind, &row.base_url, &row.model, &row.extra),
            provider_id: row.id,
        })),
        other => Err(anyhow!("未知 provider 类型:{other}")),
    }
}

/// 流式 POST + 关思考兜底(§2.6.1/§2.6.4):
/// - 流式请求加 `Accept-Encoding: identity`,消除中间层因压缩攒包;
/// - body 注入 thinking 字段;400 且错误体提及该字段 → 先试降级值(reasoning_effort none→low),
///   再去字段重试一次,并标记该 provider 不支持(stats.thinking_unsupported)。
/// 返回成功响应;headers_ms 已打点。
pub async fn send_stream_with_thinking(
    url: &str,
    bearer: Option<&str>,
    mut body: serde_json::Value,
    thinking_param: Option<thinking::ThinkingParam>,
    provider_id: i64,
    timing: &Timing,
    stats: &mut StreamStats,
) -> Result<reqwest::Response> {
    let mut param = thinking_param;
    if let Some((field, value)) = &param {
        body[field.as_str()] = value.clone();
    }
    // 最多 3 次:原值 → 降级值 → 去字段
    for _ in 0..3 {
        let mut req = shared_client()
            .post(url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .json(&body);
        if let Some(k) = bearer {
            req = req.bearer_auth(k);
        }
        let resp = req.send().await?;
        let status = resp.status();
        if status.is_success() {
            timing.mark(&mut stats.headers_ms);
            return Ok(resp);
        }
        let text = resp.text().await.unwrap_or_default();
        let Some((field, value)) = param.clone() else {
            return Err(anyhow!("HTTP {status}: {text}"));
        };
        if !thinking::error_mentions(&field, status.as_u16(), &text) {
            return Err(anyhow!("HTTP {status}: {text}"));
        }
        if let Some(fb) = thinking::fallback_value(&field, &value) {
            body[field.as_str()] = fb.clone();
            param = Some((field, fb));
            continue;
        }
        if let Some(obj) = body.as_object_mut() {
            obj.remove(&field);
        }
        param = None;
        thinking::mark_unsupported(provider_id);
        stats.thinking_unsupported = true;
    }
    Err(anyhow!("请求多次失败(关思考字段兜底已用尽)"))
}

/// 取字节缓冲里完整 UTF-8 前缀,残缺尾序列留存(多字节字符跨 chunk 分裂保护)
pub fn take_complete_utf8(buf: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) => e.valid_up_to(),
    };
    let s = String::from_utf8_lossy(&buf[..valid]).into_owned();
    buf.drain(..valid);
    s
}

/// Base URL 归一化:去尾斜杠;已指到 chat/completions 则不重复拼接
pub fn models_url(base_url: &str) -> String {
    let b = base_url.trim_end_matches('/');
    let b = b.strip_suffix("/chat/completions").unwrap_or(b);
    format!("{b}/models")
}

pub fn chat_url(base_url: &str) -> String {
    let b = base_url.trim_end_matches('/');
    if b.ends_with("/chat/completions") {
        b.to_string()
    } else {
        format!("{b}/chat/completions")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_normalization() {
        assert_eq!(chat_url("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
        assert_eq!(chat_url("https://api.deepseek.com/"), "https://api.deepseek.com/chat/completions");
        assert_eq!(
            chat_url("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn utf8_chunking_handles_split_char() {
        let mut buf = vec![0xe4, 0xbd]; // "你" 的前两字节
        assert_eq!(take_complete_utf8(&mut buf), "");
        buf.push(0xa0); // 补全第三字节
        assert_eq!(take_complete_utf8(&mut buf), "你");
        assert!(buf.is_empty());
    }
}
