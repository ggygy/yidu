// SSE 行解析 + `<t id="N">…</t>` 状态机(逐字移植 protocol-test.mjs 实测逻辑)
// 状态机要点:buf 累积;凑齐一个 `</t>` 即产出完整块;开标签跨 chunk 分裂天然安全
// (seg 从上一个 `</t>` 之后开始);partial 供当前块打字机预览。

#[derive(Debug, PartialEq)]
pub enum SsePayload {
    Delta(String),
    /// 思考文本(`delta.reasoning_content` / `delta.reasoning` / Ollama `message.thinking`):
    /// 绝不进 `</t>` 状态机与译文;M1 仅用于计时埋点(首 reasoning)
    Reasoning(String),
    Usage { prompt_tokens: i64, completion_tokens: i64, reasoning_tokens: i64 },
    /// choices[0].finish_reason(stop/length 等,随最后一个内容 chunk 到达)
    Finish(String),
    Done,
}

/// 增量 SSE 解析:feed 返回本次完成解析的 data 载荷
pub struct SseParser {
    buf: String,
}

impl SseParser {
    pub fn new() -> Self {
        SseParser { buf: String::new() }
    }

    pub fn feed(&mut self, chunk: &str) -> Vec<SsePayload> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        // 消费到每个换行为止的完整行,不完整的尾行留在 buf
        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim_end_matches('\n');
            out.extend(parse_data_line(line));
        }
        out
    }
}

/// 一行 data 可能同时携带 正文 + finish_reason + usage(部分服务商把 usage 塞进最后一个内容 chunk):
/// 逐项提取、全部产出,不再提前 return(v0.2 在此丢正文,漏掉 `</t>` 触发多余修复请求)。
/// 产出顺序:Reasoning → Delta → Finish → Usage。
fn parse_data_line(line: &str) -> Vec<SsePayload> {
    let mut out = Vec::new();
    let line = line.trim_end_matches('\r');
    if !line.starts_with("data:") {
        return out;
    }
    let payload = line[5..].trim();
    if payload == "[DONE]" {
        out.push(SsePayload::Done);
        return out;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { return out };
    let choice0 = v.get("choices").and_then(|c| c.get(0));
    let delta = choice0.and_then(|c| c.get("delta"));
    if let Some(d) = delta {
        let reasoning = d
            .get("reasoning_content")
            .and_then(|x| x.as_str())
            .or_else(|| d.get("reasoning").and_then(|x| x.as_str()))
            .unwrap_or("");
        if !reasoning.is_empty() {
            out.push(SsePayload::Reasoning(reasoning.to_string()));
        }
        let content = d.get("content").and_then(|c| c.as_str()).unwrap_or("");
        if !content.is_empty() {
            out.push(SsePayload::Delta(content.to_string()));
        }
    }
    if let Some(reason) = choice0.and_then(|c| c.get("finish_reason")).and_then(|f| f.as_str()) {
        out.push(SsePayload::Finish(reason.to_string()));
    }
    if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
        let pt = u.get("prompt_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
        let ct = u.get("completion_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
        let rt = u
            .pointer("/completion_tokens_details/reasoning_tokens")
            .and_then(|x| x.as_i64())
            .unwrap_or(0);
        out.push(SsePayload::Usage { prompt_tokens: pt, completion_tokens: ct, reasoning_tokens: rt });
    }
    out
}

#[derive(Debug, PartialEq, Clone)]
pub struct Tagged {
    pub id: u32,
    pub text: String,
}

/// `</t>` 状态机:feed 每个内容 delta,返回凑齐的完整块
pub struct TagStateMachine {
    buf: String,
}

impl TagStateMachine {
    pub fn new() -> Self {
        TagStateMachine { buf: String::new() }
    }

    pub fn feed(&mut self, delta: &str) -> Vec<Tagged> {
        self.buf.push_str(delta);
        let mut out = Vec::new();
        loop {
            let Some(close) = self.buf.find("</t>") else { break };
            let seg = self.buf[..close].to_string();
            self.buf = self.buf[close + 4..].to_string();
            if let Some(t) = parse_open_tag(&seg) {
                out.push(t);
            }
        }
        out
    }

    /// 当前进行中块的预览(打字机):返回 (id, 已到文本)
    pub fn partial(&self) -> Option<(u32, String)> {
        let open = self.buf.find("<t id=\"")?;
        let after = &self.buf[open..];
        let id_end = after[7..].find('"')? + 7;
        let id: u32 = after[7..id_end].parse().ok()?;
        let mut text = &after[id_end + 2..];
        // 去掉尾部可能是半个 `</t>` 的碎片
        for suffix in ["</t", "</", "<"] {
            if let Some(stripped) = text.strip_suffix(suffix) {
                text = stripped;
                break;
            }
        }
        Some((id, text.to_string()))
    }

    pub fn raw(&self) -> &str {
        &self.buf
    }
}

fn parse_open_tag(seg: &str) -> Option<Tagged> {
    let open = seg.find("<t id=\"")?;
    let after = &seg[open + 7..];
    let id_end = after.find('"')?;
    let id: u32 = after[..id_end].parse().ok()?;
    let text = &after[id_end + 2..];
    Some(Tagged { id, text: text.trim().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_feed_splits_lines_and_keeps_partial() {
        let mut out: Vec<SsePayload> = Vec::new();
        let mut p = SseParser::new();
        out.extend(p.feed("data: {\"choices\":[{\"delta\":{\"content\":\"he"));
        assert!(out.is_empty()); // 行不完整,留存
        out.extend(p.feed("llo\"}}]}\n"));
        assert_eq!(out, vec![SsePayload::Delta("hello".into())]);
    }

    #[test]
    fn sse_done_and_usage() {
        let mut p = SseParser::new();
        let out = p.feed("data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5},\"choices\":[]}\n\ndata: [DONE]\n\n");
        assert_eq!(
            out,
            vec![
                SsePayload::Usage { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0 },
                SsePayload::Done,
            ]
        );
    }

    #[test]
    fn sse_finish_reason() {
        let mut p = SseParser::new();
        let out = p.feed("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n");
        assert_eq!(out, vec![SsePayload::Finish("length".into())]);
    }

    #[test]
    fn sse_content_with_finish_and_usage_in_same_chunk() {
        // v0.2 缺陷:usage/finish_reason 提前 return,同 chunk 的正文(常含 `</t>`)被丢
        let mut p = SseParser::new();
        let out = p.feed(
            "data: {\"choices\":[{\"delta\":{\"content\":\"尾</t>\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"completion_tokens_details\":{\"reasoning_tokens\":2}}}\n",
        );
        assert_eq!(
            out,
            vec![
                SsePayload::Delta("尾</t>".into()),
                SsePayload::Finish("stop".into()),
                SsePayload::Usage { prompt_tokens: 7, completion_tokens: 3, reasoning_tokens: 2 },
            ]
        );
    }

    #[test]
    fn sse_reasoning_separate_from_content() {
        let mut p = SseParser::new();
        let out = p.feed("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想\",\"content\":null}}]}\ndata: {\"choices\":[{\"delta\":{\"reasoning\":\"再想\"}}]}\n");
        assert_eq!(out, vec![SsePayload::Reasoning("想".into()), SsePayload::Reasoning("再想".into())]);
    }

    #[test]
    fn state_machine_basic() {
        let mut m = TagStateMachine::new();
        let out = m.feed("<t id=\"1\">你好</t><t id=\"2\">");
        assert_eq!(out, vec![Tagged { id: 1, text: "你好".into() }]);
        let out = m.feed("世界</t>");
        assert_eq!(
            out,
            vec![Tagged { id: 2, text: "世界".into() }]
        );
    }

    #[test]
    fn state_machine_tag_split_across_chunks() {
        let mut m = TagStateMachine::new();
        assert!(m.feed("<t id=\"1\">A</t").is_empty()); // </t> 被截断
        let out = m.feed(">text</t>");
        assert_eq!(out, vec![Tagged { id: 1, text: "A".into() }]);
    }

    #[test]
    fn partial_preview() {
        let mut m = TagStateMachine::new();
        m.feed("<t id=\"3\">正在翻");
        assert_eq!(m.partial(), Some((3, "正在翻".into())));
        m.feed("译中</"); // 尾部半个闭合标签
        assert_eq!(m.partial(), Some((3, "正在翻译中".into())));
    }

    #[test]
    fn leading_noise_outside_tags_ignored_by_machine() {
        let mut m = TagStateMachine::new();
        let out = m.feed("废话<t id=\"1\">A</t>");
        assert_eq!(out, vec![Tagged { id: 1, text: "A".into() }]);
    }
}
