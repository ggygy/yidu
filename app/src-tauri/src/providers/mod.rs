// Provider 层全在 Rust(工单 04):trait + OpenAiCompatible / Ollama 两实现。
// 回调式流接口:on_payload 逐载荷回调,is_cancelled 每网络块检查,实现内聚 SSE/NDJSON 差异。

pub mod ollama;
pub mod openai;

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
    pub finish_reason: Option<String>,
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
    let key = crate::keychain::effective_key(row.id);
    match row.kind.as_str() {
        "openai_compatible" => Ok(Box::new(openai::OpenAiCompatible {
            base_url: row.base_url.clone(),
            model: row.model.clone(),
            api_key: key.unwrap_or_default(),
        })),
        "ollama" => Ok(Box::new(ollama::Ollama {
            base_url: row.base_url.clone(),
            model: row.model.clone(),
            extra: row.extra.clone(),
        })),
        other => Err(anyhow!("未知 provider 类型:{other}")),
    }
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
