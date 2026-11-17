// SSE 行解析 + `<t id="N">…</t>` 状态机(逐字移植 protocol-test.mjs 实测逻辑)
// 状态机要点:buf 累积;凑齐一个 `</t>` 即产出完整块;开标签跨 chunk 分裂天然安全
// (seg 从上一个 `</t>` 之后开始);partial 供当前块打字机预览。

#[derive(Debug, PartialEq)]
pub enum SsePayload {
    Delta(String),
    /// 思考文本(`delta.reasoning_content` / `delta.reasoning` / Ollama `message.thinking`):
    /// 绝不进 `</t>` 状态机与译文;M1 仅用于计时埋点(首 reasoning)
    Reasoning(String),
    /// cached_tokens:输入中命中服务商前缀缓存的部分(OpenAI / Qwen `prompt_tokens_details.cached_tokens`,DeepSeek `prompt_cache_hit_tokens`)
    Usage { prompt_tokens: i64, completion_tokens: i64, reasoning_tokens: i64, cached_tokens: i64 },
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
        let cached = u
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(|x| x.as_i64())
            .unwrap_or(0)
            .max(u.get("prompt_cache_hit_tokens").and_then(|x| x.as_i64()).unwrap_or(0));
        out.push(SsePayload::Usage { prompt_tokens: pt, completion_tokens: ct, reasoning_tokens: rt, cached_tokens: cached });
    }
    out
}

#[derive(Debug, PartialEq, Clone)]
pub struct Tagged {
    pub id: u32,
    pub text: String,
}

/// `<t id="N">…</t>` 状态机:feed 每个内容 delta,返回凑齐的完整块。
/// 宽容解析(模型偶尔不按原样输出):`id=1` / `id='1'` / 多余空格 / `</t >`,
/// 以及把输入的 `<s id="N">` 回显成开标签(实测 claude-deepseek 会写 `<s id="2">译文</t>`)。
/// `<t id>` 只认 `</t>` 闭合(译文里的 `<s>删除线</s>` 不截断);`<s id>` 认 `</s>` 或 `</t>`。
pub struct TagStateMachine {
    buf: String,
}

fn open_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#"<\s*([ts])\s+id\s*=\s*["'“”]?\s*(\d+)\s*["'“”]?\s*>"#).unwrap())
}

fn close_re(letter: &str) -> &'static regex::Regex {
    static T: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static S: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if letter == "s" {
        S.get_or_init(|| regex::Regex::new(r"<\s*/\s*[st]\s*>").unwrap())
    } else {
        T.get_or_init(|| regex::Regex::new(r"<\s*/\s*t\s*>").unwrap())
    }
}

/// 尾部可能是半个闭合标签的碎片(`<` `</` `</t` `< /`)
fn tail_fragment_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"<\s*/?\s*[ts]?\s*$").unwrap())
}

impl TagStateMachine {
    pub fn new() -> Self {
        TagStateMachine { buf: String::new() }
    }

    pub fn feed(&mut self, delta: &str) -> Vec<Tagged> {
        self.buf.push_str(delta);
        let mut out = Vec::new();
        loop {
            let Some(c) = open_re().captures(&self.buf) else { break };
            let (letter, id) = (c[1].to_string(), c[2].parse::<u32>().ok());
            let open_end = c.get(0).unwrap().end();
            let Some(close) = close_re(&letter).find(&self.buf[open_end..]) else { break };
            let text = self.buf[open_end..open_end + close.start()].trim().to_string();
            self.buf = self.buf[open_end + close.end()..].to_string();
            if let Some(id) = id {
                out.push(Tagged { id, text });
            }
        }
        out
    }

    /// 当前进行中块的预览(打字机):返回 (id, 已到文本)
    pub fn partial(&self) -> Option<(u32, String)> {
        let c = open_re().captures_iter(&self.buf).last()?;
        let id: u32 = c[2].parse().ok()?;
        let text = &self.buf[c.get(0)?.end()..];
        let text = tail_fragment_re().replace(text, "");
        Some((id, text.to_string()))
    }
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
                SsePayload::Usage { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0, cached_tokens: 0 },
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
                SsePayload::Usage { prompt_tokens: 7, completion_tokens: 3, reasoning_tokens: 2, cached_tokens: 0 },
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

    #[test]
    fn tolerant_tag_variants() {
        let mut m = TagStateMachine::new();
        let out = m.feed("<t id=1>甲</t >\n<t id='2'>乙< /t>\n< t  id = \"3\" >丙</t>");
        assert_eq!(out.iter().map(|t| (t.id, t.text.as_str())).collect::<Vec<_>>(), vec![(1, "甲"), (2, "乙"), (3, "丙")]);
    }

    #[test]
    fn echoed_s_tags_accepted() {
        let mut m = TagStateMachine::new();
        let out = m.feed("<s id=\"1\">译文一</s>\n<s id=\"2\">译文二</s>");
        assert_eq!(out.len(), 2);
        assert_eq!(out[1], Tagged { id: 2, text: "译文二".into() });
    }

    #[test]
    fn strikethrough_inside_t_not_a_close() {
        // 译文里的 <s>删除线</s> 不能截断 <t> 块
        let mut m = TagStateMachine::new();
        let out = m.feed("<t id=\"1\">保留 <s>旧</s> 新</t>");
        assert_eq!(out, vec![Tagged { id: 1, text: "保留 <s>旧</s> 新".into() }]);
    }

    #[test]
    fn sse_cached_tokens_both_shapes() {
        let mut p = SseParser::new();
        let out = p.feed("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":500,\"completion_tokens\":40,\"prompt_cache_hit_tokens\":256,\"prompt_cache_miss_tokens\":244}}\n");
        assert_eq!(out, vec![SsePayload::Usage { prompt_tokens: 500, completion_tokens: 40, reasoning_tokens: 0, cached_tokens: 256 }]);
        let out = p.feed("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1200,\"completion_tokens\":9,\"prompt_tokens_details\":{\"cached_tokens\":1024}}}\n");
        assert_eq!(out, vec![SsePayload::Usage { prompt_tokens: 1200, completion_tokens: 9, reasoning_tokens: 0, cached_tokens: 1024 }]);
    }

    #[test]
    fn mixed_s_open_t_close_real_reply() {
        // 2026-11-17 ada / claude-deepseek-v4.1-flash 实际回复(debug_last_unparsed)
        let raw = "<t id=\"1\">测试通过了。</t>\n<s id=\"2\">你粘贴的内容翻译得很干净。</t>\n<s id=\"3\">缓存也在正常工作。</t>\n<s id=\"5\">- 列表项一;\n- 列表项二 `\\`。</t>\n";
        let mut m = TagStateMachine::new();
        let ids: Vec<u32> = m.feed(raw).iter().map(|t| t.id).collect();
        assert_eq!(ids, vec![1, 2, 3, 5]);
        // <t> 块里的删除线仍不截断
        let mut m = TagStateMachine::new();
        assert_eq!(m.feed("<t id=\"1\">a <s>b</s> c</t>")[0].text, "a <s>b</s> c");
    }
}
