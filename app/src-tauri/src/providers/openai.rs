// OpenAI 兼容实现(DeepSeek / GLM / OpenAI / 任意兼容端点)
// 请求体与 proto/scripts/protocol-test.mjs 实测一致:stream + include_usage + temperature 1.0
// v0.3 M1:按 host 白名单关思考(thinking.rs)、流式 Accept-Encoding: identity、计时埋点
use super::{chat_url, shared_client, CancelCheck, StreamStats, Timing};
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
    /// 关思考注入字段(None = 不注入)
    pub thinking: Option<super::thinking::ThinkingParam>,
    pub provider_id: i64,
    /// v0.3 §2.2.7:默认 0.3,服务商 extra.temperature 可覆盖
    pub temperature: f64,
}

fn request_body(model: &str, system: &str, history: &[(String, String)], user: &str, stream: bool, max_tokens: Option<i64>, temperature: f64) -> Value {
    let mut body = json!({
        "model": model,
        "stream": stream,
        "temperature": temperature,
        "messages": super::chat_messages(system, history, user),
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
        history: &[(String, String)],
        user: &str,
        tx: UnboundedSender<SsePayload>,
        cancel: CancelCheck,
    ) -> Result<StreamStats> {
        let timing = Timing::start();
        let mut stats = StreamStats::default();
        let resp = super::send_stream_with_thinking(
            &chat_url(&self.base_url),
            Some(&self.api_key),
            request_body(&self.model, system, history, user, true, None, self.temperature),
            self.thinking.clone(),
            self.provider_id,
            &timing,
            &mut stats,
        )
        .await?;
        let mut sse = SseParser::new();
        let mut utf8buf: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel() {
                return Ok(stats); // 取消:已收到的统计照常返回
            }
            let chunk = chunk?;
            timing.mark(&mut stats.first_byte_ms);
            utf8buf.extend_from_slice(&chunk);
            let text = super::take_complete_utf8(&mut utf8buf);
            for payload in sse.feed(&text) {
                timing.observe(&payload, &mut stats);
                match &payload {
                    SsePayload::Usage { prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens } => {
                        stats.prompt_tokens = *prompt_tokens;
                        stats.completion_tokens = *completion_tokens;
                        stats.reasoning_tokens = *reasoning_tokens;
                    stats.cached_tokens = *cached_tokens;
                        stats.cached_tokens = *cached_tokens;
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
                timing.observe(&payload, &mut stats);
                if let SsePayload::Usage { prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens } = &payload {
                    stats.prompt_tokens = *prompt_tokens;
                    stats.completion_tokens = *completion_tokens;
                    stats.reasoning_tokens = *reasoning_tokens;
                    stats.cached_tokens = *cached_tokens;
                }
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
            .json(&request_body(&self.model, "You are a connectivity test.", &[], "hi", false, Some(1), self.temperature))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("HTTP {status}: {body}"));
        }
        Ok(t0.elapsed().as_millis() as u64)
    }

    async fn list_models(&self) -> Result<Vec<String>> {
        let resp = shared_client()
            .get(super::models_url(&self.base_url))
            .bearer_auth(&self.api_key)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("HTTP {status}: {body}"));
        }
        let v: serde_json::Value = resp.json().await?;
        let mut out: Vec<String> = v
            .get("data")
            .and_then(|d| d.as_array())
            .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(str::to_string)).collect())
            .unwrap_or_default();
        out.sort();
        Ok(out)
    }

    async fn transcribe_image(&self, image_b64: &str, mime: &str) -> Result<String> {
        let body = json!({
            "model": self.model,
            "stream": false,
            "temperature": 0,
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": super::TRANSCRIBE_PROMPT },
                    { "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{image_b64}") } },
                ],
            }],
        });
        let resp = shared_client()
            .post(chat_url(&self.base_url))
            .bearer_auth(&self.api_key)
            .timeout(std::time::Duration::from_secs(90))
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("HTTP {status}: {}", text.chars().take(300).collect::<String>()));
        }
        let v: Value = resp.json().await?;
        let content = v.pointer("/choices/0/message/content").and_then(|c| c.as_str()).unwrap_or("");
        Ok(super::strip_outer_fence(content))
    }
}
