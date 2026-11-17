# 05: 流式首 token 与延迟根因调研

Type: research (AFK)
Status: resolved
Blocked by: —

## Question

首 token 慢、流式不明显,除 A 类缺陷外还有哪些可控因素?调研:各 provider 关闭思考的参数(DeepSeek / GLM `thinking`、Qwen/DashScope `enable_thinking`、OpenAI `reasoning_effort`、Ollama `think`)及不关时 `reasoning_content` 如何展示;reqwest `gzip(true)` 是否导致代理缓冲 SSE;批大小(当前 ≤10 块/2000 字)与首块时间的关系、首批缩小到 1~2 块的收益;顺序批 vs 并发批;如何精确测 TTFT/首块/tok/s。给出推荐默认值。

## Answer

详见 [`../research/05-streaming-latency.md`](../research/05-streaming-latency.md)(未实测:无 key 且网络受限,基准脚本 `../research/latency-bench/bench.mjs` 待跑)。

- **首要根因**:三个默认预设(`deepseek-flash`、`glm-4.5-flash`、Ollama `qwen3:4b`)都可能默认开思考,而 `sse.rs` 丢弃 `reasoning_content` → 长时间空白。按 host 显式关:DeepSeek / 智谱 `"thinking":{"type":"disabled"}`(GLM-5.3 不可关)、百炼 `"enable_thinking":false`、OpenAI 推理模型 `"reasoning_effort":"none"`(非推理模型发了会 400)、Ollama `"think":false`(gpt-oss 用 `"low"`)。OpenAI 官方/vLLM 对未知字段 400,故只按白名单注入,400 时去字段重试。
- **关不掉时**:解析 `reasoning_content` / `message.thinking` 为独立事件,不进 `</t>` 状态机,UI 显示"思考中… N 字 · Ts"。
- **gzip**:客户端解压不是缓冲源,风险在服务端/中间代理压缩;流式请求加 `Accept-Encoding: identity` 作保险。
- **批**:首批 1 块(过短补到 2 块、≤300 字),其余 ≤10 块/2000 字;默认顺序,可选并发 2~3(Ollama 恒 1),首批单独先发。
- **计时**:provider 层记 headers/首字节/首 reasoning/首 content,translate 层记首 partial/首 block;`usage_log` 增 `ttft_ms, first_block_ms, reasoning_tokens` 等;tok/s 分母从首 token 起算。
