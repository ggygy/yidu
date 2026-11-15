// OpenAI 兼容实现(DeepSeek / GLM / OpenAI / 任意兼容端点)
// 请求体与 proto/scripts/protocol-test.mjs 实测一致:stream + include_usage + temperature 1.0
use super::{chat_url, shared_client, CancelCheck, StreamStats};
use crate::sse::{SseParser, SsePayload};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;

pub struct OpenAiCompatible {
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

fn request_body(model: &str, system: &str, user: &str, stream: bool, max_tokens: Option<i64>) -> Value {
    let mut body = json!({
        "model": model,
        "stream": stream,
        "temperature": 1.0,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    if stream {
        body["stream_options"] = json!({ "include_usage": true });
    }
    if let Some(mt) = max_tokens {
        body["max_tokens"] = json!(mt);
    }
    body
}

#[async_trait]
impl super::Provider for OpenAiCompatible {
    async fn stream_chat(
        &self,
        system: &str,
        user: &str,
        tx: UnboundedSender<SsePayload>,
        cancel: CancelCheck,
    ) -> Result<StreamStats> {
        let resp = shared_client()
            .post(chat_url(&self.base_url))
            .bearer_auth(&self.api_key)
            .json(&request_body(&self.model, system, user, true, None))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("HTTP {status}: {body}"));
        }
        let mut stats = StreamStats::default();
        let mut sse = SseParser::new();
        let mut utf8buf: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel() {
                return Ok(stats); // 取消:已收到的统计照常返回
            }
            let chunk = chunk?;
            utf8buf.extend_from_slice(&chunk);
            let text = super::take_complete_utf8(&mut utf8buf);
            for payload in sse.feed(&text) {
                match &payload {
                    SsePayload::Usage { prompt_tokens, completion_tokens } => {
                        stats.prompt_tokens = *prompt_tokens;
                        stats.completion_tokens = *completion_tokens;
                    }
                    SsePayload::Finish(reason) => {
                        stats.finish_reason = Some(reason.clone());
                    }
                    _ => {}
                }
                if tx.send(payload).is_err() {
                    return Ok(stats); // 接收端已关闭
                }
            }
        }
        if !utf8buf.is_empty() {
            let text = String::from_utf8_lossy(&utf8buf).into_owned();
            for payload in sse.feed(&text) {
                let _ = tx.send(payload);
            }
        }
        Ok(stats)
    }

    async fn test_conn(&self) -> Result<u64> {
        let t0 = Instant::now();
        let resp = shared_client()
            .post(chat_url(&self.base_url))
            .bearer_auth(&self.api_key)
            .json(&request_body(&self.model, "You are a connectivity test.", "hi", false, Some(1)))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("HTTP {status}: {body}"));
        }
        Ok(t0.elapsed().as_millis() as u64)
    }
}
