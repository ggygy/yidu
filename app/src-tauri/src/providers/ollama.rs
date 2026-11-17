// Ollama 原生 /api/*(NDJSON,工单 04)。代码按官方文档实现;本机未安装 Ollama,
// **未实机验证**(spec 已标注)。每请求显式 num_ctx(v0.3 默认 8192;Ollama 自身默认过小是静默截断源)。
// v0.3 M1:`think:false` 关思考(gpt-oss 用 "low")、`message.thinking` 单独解析、identity、计时埋点。
use super::{CancelCheck, StreamStats, Timing};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;

use crate::sse::SsePayload;

pub struct Ollama {
    pub base_url: String,
    pub model: String,
    /// 额外配置(JSON):{"num_ctx":8192,...}
    pub extra: String,
    pub thinking: Option<super::thinking::ThinkingParam>,
    pub provider_id: i64,
}

pub const DEFAULT_NUM_CTX: u64 = 8192;

fn num_ctx(extra: &str) -> u64 {
    serde_json::from_str::<Value>(extra)
        .ok()
        .and_then(|v| v.get("num_ctx").and_then(|n| n.as_u64()))
        .unwrap_or(DEFAULT_NUM_CTX)
}

impl Ollama {
    fn chat_url(&self) -> String {
        format!("{}/api/chat", self.base_url.trim_end_matches('/'))
    }

    /// NDJSON 逐行解析(非 SSE,无 data: 前缀),行缓冲处理跨 chunk 分裂
    fn feed_line(line: &str, tx: &UnboundedSender<SsePayload>, stats: &mut StreamStats, timing: Option<&Timing>) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        if let Some(thinking) = v.pointer("/message/thinking").and_then(|c| c.as_str()) {
            if !thinking.is_empty() {
                let p = SsePayload::Reasoning(thinking.to_string());
                if let Some(t) = timing {
                    t.observe(&p, stats);
                }
                let _ = tx.send(p);
            }
        }
        if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_str()) {
            if !content.is_empty() {
                let p = SsePayload::Delta(content.to_string());
                if let Some(t) = timing {
                    t.observe(&p, stats);
                }
                let _ = tx.send(p);
            }
        }
        if v.get("done").and_then(|d| d.as_bool()) == Some(true) {
            let pt = v.get("prompt_eval_count").and_then(|x| x.as_i64()).unwrap_or(0);
            let ct = v.get("eval_count").and_then(|x| x.as_i64()).unwrap_or(0);
            stats.prompt_tokens = pt;
            stats.completion_tokens = ct;
            if v.get("done_reason").and_then(|r| r.as_str()) == Some("length") {
                stats.finish_reason = Some("length".into());
            }
            let _ = tx.send(SsePayload::Done);
        }
    }
}

#[async_trait]
impl super::Provider for Ollama {
    async fn stream_chat(
        &self,
        system: &str,
        user: &str,
        tx: UnboundedSender<SsePayload>,
        cancel: CancelCheck,
    ) -> Result<StreamStats> {
        let body = json!({
            "model": self.model,
            "stream": true,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "options": { "num_ctx": num_ctx(&self.extra) },
        });
        let timing = Timing::start();
        let mut stats = StreamStats::default();
        let resp = super::send_stream_with_thinking(
            &self.chat_url(),
            None,
            body,
            self.thinking.clone(),
            self.provider_id,
            &timing,
            &mut stats,
        )
        .await?;
        let mut buf = String::new();
        let mut stream = resp.bytes_stream();
        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            if cancel() {
                return Ok(stats);
            }
            let chunk = chunk?;
            timing.mark(&mut stats.first_byte_ms);
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find('\n') {
                let line: String = buf.drain(..=pos).collect();
                let line = line.trim_end_matches('\n');
                Self::feed_line(line, &tx, &mut stats, Some(&timing));
            }
        }
        if !buf.trim().is_empty() {
            Self::feed_line(&buf, &tx, &mut stats, Some(&timing));
        }
        Ok(stats)
    }

    /// 健康检查 = /api/tags 探测(顺带验证 Ollama 在线)
    async fn test_conn(&self) -> Result<u64> {
        let t0 = Instant::now();
        let resp = super::shared_client()
            .get(format!("{}/api/tags", self.base_url.trim_end_matches('/')))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(anyhow!("HTTP {status}(Ollama 未运行?)"));
        }
        Ok(t0.elapsed().as_millis() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ndjson_lines() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut stats = StreamStats::default();
        Ollama::feed_line(r#"{"message":{"content":"","thinking":"嗯"},"done":false}"#, &tx, &mut stats, None);
        Ollama::feed_line(r#"{"message":{"content":"你好"},"done":false}"#, &tx, &mut stats, None);
        Ollama::feed_line(
            r#"{"message":{"content":""},"done":true,"prompt_eval_count":12,"eval_count":3,"done_reason":"length"}"#,
            &tx,
            &mut stats,
            None,
        );
        assert_eq!(rx.try_recv().unwrap(), SsePayload::Reasoning("嗯".into()));
        assert_eq!(rx.try_recv().unwrap(), SsePayload::Delta("你好".into()));
        assert_eq!(stats.prompt_tokens, 12);
        assert_eq!(stats.completion_tokens, 3);
        assert_eq!(stats.finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn num_ctx_from_extra() {
        assert_eq!(num_ctx(r#"{"num_ctx":8192}"#), 8192);
        assert_eq!(num_ctx(r#"{"num_ctx":4096}"#), 4096);
        assert_eq!(num_ctx("{}"), 8192);
        assert_eq!(num_ctx("not json"), 8192);
    }
}
