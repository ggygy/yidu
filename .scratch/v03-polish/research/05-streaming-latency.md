# 05 流式首 token 与延迟根因调研

> 日期:2026-11-17 · 对应工单:`../issues/05-streaming-latency-research.md`
> 数据来源说明:本机网络对外 HTTPS 被代理拒绝(WebFetch / curl 均 `CONNECT 403`),且 `proto/.env.local` 不存在,**未做任何实测**。下文所有"毫秒/tok/s"均为 **未实测**;参数结论来自 WebSearch 检索到的官方文档摘要(已注明链接),部分仅有第三方来源的单独标出"待官方核实"。基准脚本已写好:`latency-bench/bench.mjs`,有 key、有网后可直接跑。

## 0. 结论速览

1. **最大嫌疑不是网络,是"思考"被默认打开而 `reasoning_content` 被丢弃**。当前预设默认模型 `deepseek-flash`(V4 Flash,多个来源称 0731 之后快照默认开思考)、`glm-4.5-flash`(动态思考默认开)、Ollama `qwen3:4b`(API 默认开思考)——三个默认预设都可能在吐正文前先吐一大段 `reasoning_content` / `message.thinking`,而 `sse.rs` 只读 `delta.content`,用户看到的就是"长时间空白然后一下子出来"。
2. 修复优先级:**按 provider 显式关思考** > 修 `sse.rs` 早返回丢内容(A 类)> 首批缩小 > 其余(gzip 等)。
3. reqwest `gzip(true)` 在客户端侧基本不是缓冲源(服务端/中间代理是否压缩并缓冲才是关键);保留即可,但建议对流式请求显式发 `Accept-Encoding: identity` 作为低成本保险(见 §2)。
4. 推荐默认:首批 1 块(或 ≤300 字),之后 ≤10 块/2000 字;顺序执行,可选并发 2(仅非首批)。
5. 计时埋点:在 provider 层记 `t_send / t_headers / t_first_byte / t_first_reasoning / t_first_content`,在 translate 层记 `t_first_partial / t_first_block`,`usage_log` 增列 `ttft_ms, first_block_ms, reasoning_tokens, gen_ms`。

## 1. 各 provider 关闭/限制思考的参数

### 1.1 参数表

| Provider / 端点 | 关思考参数(HTTP JSON 顶层) | 限制思考强度 | 思考输出字段(流式) | 默认 | 来源 |
|---|---|---|---|---|---|
| DeepSeek 官方(V4 Flash/Pro,`deepseek-flash` / `deepseek-v4-*`) | `"thinking": {"type": "disabled"}`(开:`"enabled"`) | `"reasoning_effort": "low" \| "high" \| "max"` | `choices[0].delta.reasoning_content`(与 `content` 同级) | V4 Flash 新快照默认**开**(第三方实测/汇总,待官方核实);0423 快照据称默认关 | [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode) · [Seek-Chat 实测](https://seek-chat.com/docs/deepseek-thinking-mode/) · [Ofox 快照表](https://ofox.ai/docs/develop/models/deepseek) · [graphify#1621](https://github.com/Graphify-Labs/graphify/issues/1621) |
| DeepSeek 旧名 `deepseek-chat` / `deepseek-reasoner` | 由模型名决定(chat=非思考,reasoner=思考) | — | `reasoning_content` | 据多个来源 **2026-07-24 已下线**(此前映射到 V4 Flash 非思考/思考) | [DeepSeek 更新日志](https://api-docs.deepseek.com/updates/) · [developersdigest 弃用追踪](https://www.developersdigest.tech/deprecations/deepseek) |
| 智谱 GLM-4.5 / 4.5-Flash / 4.6 / 4.7(open.bigmodel.cn、api.z.ai) | `"thinking": {"type": "disabled"}` | 无(4.5/4.6 开启时为"动态思考",模型自行决定是否思考) | `delta.reasoning_content` | 4.5/4.6:**开**(动态) | [bigmodel 思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode) · [Z.ai thinking-mode](https://docs.z.ai/guides/capabilities/thinking-mode) · [Z.ai GLM-4.5](https://docs.z.ai/guides/llm/glm-4.5) |
| 智谱 GLM-5.3 / 5.3-Flash | **不支持关闭**,传 `disabled` 返回错误 | — | `reasoning_content` | 强制开 | 同上(检索摘要) |
| Qwen / 阿里云百炼 DashScope OpenAI 兼容 | `"enable_thinking": false`(HTTP/Node 直接放顶层;Python SDK 需 `extra_body`) | `"thinking_budget": N`(思考 token 上限) | `delta.reasoning_content`(先 reasoning 后 content 两阶段) | qwen-plus / qwen-flash 商业版:**关**;开源 qwen3-* 与 qwen3.5+ 部分(如 qwen3.8-max):**开** | [百炼 深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking) · [EN 版](https://www.alibabacloud.com/help/en/model-studio/deep-thinking) |
| OpenAI 官方(o 系列 / gpt-5.x) | `"reasoning_effort": "none"`(gpt-5.1+ 类;具体可选值按模型不同) | `"minimal"/"low"/...`;**gpt-5.6 拒绝 `minimal`(400)**,合法值 `none/low/medium/high/xhigh/max` | Chat Completions **不返回**推理文本(只在 usage 的 `reasoning_tokens` 里计数) | 推理模型默认 medium 左右 | [pydantic-ai#7081](https://github.com/pydantic/pydantic-ai/issues/7081)(含官方错误原文) · [OpenAI 社区](https://community.openai.com/t/evals-invalid-reasoning-effort-for-non-reasoning-model-gpt-5-chat-latest/1341785) |
| OpenAI 非推理模型(gpt-4o、gpt-5-chat-latest 等) | **不要发** `reasoning_effort`,会 400(Azure:`Unrecognized request argument supplied: reasoning_effort`) | — | — | — | 同上 |
| Ollama 原生 `/api/chat` | `"think": false`(与 `model` 同级,不在 `options` 里) | gpt-oss 只认 `"low"/"medium"/"high"`,布尔被忽略 | `message.thinking`(与 `message.content` 分开) | 支持思考的模型(qwen3、deepseek-r1…)在 API 中**默认开** | [Ollama Thinking](https://docs.ollama.com/capabilities/thinking) · [Ollama 博客](https://ollama.com/blog/thinking) |

### 1.2 给未知参数给其他 OpenAI 兼容端点会怎样

| 端点 | 未知顶层字段行为 | 来源 |
|---|---|---|
| OpenAI 官方 | **400** `unknown_parameter`(如 `Unknown parameter: 'extra_body'`) | [spring-ai#5197](https://github.com/spring-projects/spring-ai/issues/5197) |
| Azure OpenAI | **400** `Unrecognized request argument supplied: …` | 见 1.1 OpenAI 行 |
| vLLM(OpenAI server,pydantic `extra=forbid` 时) | **400** `Extra inputs are not permitted` | [litellm#4769](https://github.com/BerriAI/litellm/issues/4769) · [vllm#10463](https://github.com/vllm-project/vllm/pull/10463) |
| Gemini OpenAI 兼容 | 对 `reasoning_effort` 非法值 400 | [Google AI 论坛](https://discuss.ai.google.dev/t/title-reasoning-effort-minimal-not-working-for-gemini-3-flash-despite-documentation/117875) |
| DeepSeek / 智谱 / 百炼 / OpenRouter 等托管服务 | 多数宽松(忽略未识别字段),**但无官方保证**,未实测 | — |

**结论**:不能"一把梭"给所有 OpenAI 兼容端点都塞 `thinking` / `enable_thinking`。必须按 provider 类型/host 白名单注入,未知 host 默认不注入(用户可在 provider 设置里手动选"思考控制方式")。

### 1.3 推荐注入规则(按 base_url host 识别)

| host 匹配 | 注入 |
|---|---|
| `api.deepseek.com` | `"thinking": {"type": "disabled"}` |
| `open.bigmodel.cn` / `api.z.ai` | `"thinking": {"type": "disabled"}`;若 400 且模型名含 `glm-5.3` 则去掉重试(或预设里标"不可关") |
| `dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com` | `"enable_thinking": false` |
| `api.openai.com` | 仅模型名匹配推理模型(`^o\d`、`gpt-5`(非 `-chat`))时发 `"reasoning_effort": "none"`(老型号不认 `none` 时退 `"low"`);其余不发 |
| Ollama(kind=ollama) | `"think": false`;模型名含 `gpt-oss` 时改 `"think": "low"` |
| 其他 | 不注入;provider 设置提供"思考控制:自动 / 不注入 / DeepSeek式 / Qwen式 / 自定义 JSON"下拉 |

兜底:若注入后返回 400 且错误体提到该字段名 → 去掉字段自动重试一次,并把该 provider 标记为"不支持",写回 `extra`。

### 1.4 关不掉时如何展示 `reasoning_content`

- `sse.rs` 新增 `SsePayload::Reasoning(String)`:读 `delta.reasoning_content`(DeepSeek/GLM/Qwen),兼容 `delta.reasoning`(OpenRouter/部分 vLLM 字段名,未实测);Ollama 读 `message.thinking`。
- translate 层**不送入 `</t>` 状态机**(避免污染译文与 raw),只发新事件 `StreamEvent::Thinking { chars, tail }`,节流 ≥100ms 一次。
- UI:在当前待译块位置显示灰色"思考中… 已 1.2k 字 · 3.4s"(可折叠展开看尾部 200 字),首个 content 到达即收起。这样用户至少看到"在动",并能知道慢在思考。
- `usage_log` 记 `completion_tokens_details.reasoning_tokens`(DeepSeek/OpenAI 提供),便于统计思考占比与费用。

## 2. reqwest gzip 与 SSE 缓冲

| 环节 | 是否会缓冲 | 说明 |
|---|---|---|
| 客户端 reqwest `gzip(true)` 解压 | 低风险 | 解压器按到达的压缩块增量产出;只要服务端每个事件后做了 flush(gzip `Z_SYNC_FLUSH`),客户端就能立即解出。客户端解压不会"攒满再给"。 |
| 服务端/网关压缩 SSE | **高风险** | 若服务端或中间网关对 `text/event-stream` 做 gzip 而不逐事件 flush,压缩器内部缓冲会把多个事件攒成一块(Django 有同类问题 [#36293](https://code.djangoproject.com/ticket/36293));nginx 等指南普遍建议 SSE `gzip off`、`proxy_buffering off`([示例](https://oneuptime.com/blog/post/2025-12-16-server-sent-events-nginx/view))。 |
| 用户本地代理(Clash/Surge/公司代理)、自建中转(one-api 类) | 中风险 | 可能对响应重新压缩或缓冲;客户端发 `Accept-Encoding: gzip` 会"邀请"它们压缩。 |
| 官方 API(DeepSeek/智谱/百炼)对 SSE 是否返回 `Content-Encoding: gzip` | **未实测** | `bench.mjs` 会打印 `CE` 列并对比 identity/gzip 的首字节/首块时间。 |

**建议**:保留 client 级 `gzip(true)`(非流式接口如 models 列表仍受益),但**流式请求单独加 header `Accept-Encoding: identity`**。SSE 文本本身很小,不压缩的带宽代价可忽略,却消除了"中间层因压缩而攒包"这一整类问题。改动 1 行(`openai.rs` / `ollama.rs` 的 `.header(ACCEPT_ENCODING, "identity")`),reqwest 在用户显式设置该 header 时不会再自动解压/覆盖。

## 3. 批大小 vs 首块时间

### 3.1 模型(无实测,仅推导)

首块时间 ≈ `网络RTT + prefill(输入 token) + 思考时长 + 首块输出 token / 生成速率`。

- prefill 随输入长度增长,但在托管 API 上 2000 字(≈600~1000 token)量级的 prefill 通常只占几十~几百毫秒,并不是首块的主导项(**未实测**)。
- 思考开启时,思考时长随输入规模明显增长(要"读完全部 10 个片段再规划"),这一项才是批越大首块越慢的主因。
- 关思考后,首块时间对批大小不敏感:模型按顺序输出 `<t id="1">`,首块只取决于第 1 块的长度。

| 场景 | 批 1 块 | 批 3 块 | 批 10 块 | 状态 |
|---|---|---|---|---|
| TTFT(首 content token) | 未实测 | 未实测 | 未实测 | 待跑 `bench.mjs` |
| 首块(`</t>`) | 未实测 | 未实测 | 未实测 | 同上 |
| 总耗时 / 每块均摊 | 未实测 | 未实测 | 未实测 | 同上 |
| 思考开 vs 关 差值 | 未实测 | 未实测 | 未实测 | 同上 |

### 3.2 首批缩小的收益

- **收益**:第一批只含 1 块(或 ≤300 字)时,即使思考没关掉,思考规模也小,首块可明显提前;同时第一批完成后即可写库,用户立刻看到第一段译文。
- **代价**:多一次请求的 RTT 与 system prompt 重复 prefill(DeepSeek 有前缀缓存,system prompt 相同可命中,代价更小);首批上下文少,术语一致性略降(已有"上文参考"机制可缓解)。
- **推荐**:`首批 = 1 块(若该块 <150 字则补到 2 块,且 ≤300 字)`,其余沿用 ≤10 块/2000 字(CJK→拉丁 1250)。只对文章开头生效;重译/续译同理取"第一个待译块"。

### 3.3 顺序 vs 有限并发

| 方案 | 首块 | 总耗时 | 风险 |
|---|---|---|---|
| 顺序(现状) | 由首批决定 | Σ 各批 | 无 |
| 并发 2(首批单独先发,其余 2 路并行) | 不变(首批仍最先) | 约减半(未实测) | 上文参考(prev)需改为取源文而非译文;限流 429(DeepSeek/智谱免费层并发低);界面块到达乱序(按 idx 落位已支持) |
| 全并发 | 可能变慢(抢带宽/限流) | 最短 | 429、费用峰值、取消难 |

**推荐**:默认顺序;provider 设置加"并发数 1~3",默认 1(Ollama 本地强制 1,本地 GPU 并发只会互相拖慢)。首批永远单独先发、不参与并发。

## 4. 如何精确测 TTFT / 首块 / tok/s

### 4.1 埋点位置

| 时刻 | 位置 | 说明 |
|---|---|---|
| `t0` 请求发出 | `translate.rs` `request()` 中现有 `let t0 = Instant::now()`(约 L292) | 已有,但包含 `providers::build` 之后的 spawn,可接受 |
| `t_headers` | `openai.rs` / `ollama.rs` `.send().await?` 返回后 | 连接+TLS+排队+服务端开始响应 |
| `t_first_byte` | `bytes_stream()` 首个 chunk | 区分"服务端慢"与"解析慢" |
| `t_first_reasoning` | 首个 `Reasoning` 载荷 | 有它即说明思考开着 |
| `t_first_content`(=TTFT) | 首个非空 `Delta` | 用户意义上的首 token |
| `t_first_partial` | `process_payload` 首次发 `Partial` | 前端可见时间(去掉 `<t id>` 前缀后) |
| `t_first_block` | `process_payload` 首次发 `Block` | 首块完成 |
| `t_done` | `record_usage` 处(现有 `latency_ms`) | 总耗时 |

实现:`StreamStats` 增 `headers_ms / first_byte_ms / first_reasoning_ms / first_content_ms / reasoning_tokens`(provider 内用传入的 `t0` 或自己的 `Instant` 计算相对值,统一以 translate 的 `t0` 为基准最简单:把 `t0: Instant` 传进 `stream_chat`)。translate 层自己记 `first_partial_ms / first_block_ms`。

### 4.2 指标定义

- **TTFT** = `t_first_content - t0`;另记 **TTFR**(首推理 token)= `t_first_reasoning - t0`。
- **首块** = `t_first_block - t0`(文章级另记"文章首块",即第一批的首块)。
- **tok/s(生成速率)** = `completion_tokens / (t_done - min(t_first_reasoning, t_first_content))`。分母不含排队与 prefill,否则批越大越"慢"。思考开启时 `completion_tokens` 含 reasoning_tokens,另报 `正文 tok/s = (completion - reasoning) / (t_done - t_first_content)`。
- 依赖 `include_usage` 的最后一个 usage chunk——这正是 `sse.rs` 当前"usage 早返回"缺陷所在,修 A 类缺陷时需让同一 chunk 的 content 与 usage 都被处理。

### 4.3 落库

`usage_log` 增列:`ttft_ms, first_block_ms, first_byte_ms, reasoning_tokens, batch_blocks, batch_chars`。设置页"用量"里可显示最近 20 次中位数,方便用户自己判断换模型/关思考的效果。

### 4.4 基准脚本

`latency-bench/bench.mjs`:矩阵 = Accept-Encoding(identity/gzip)× thinking(disabled/不传)× 批 1/3/10 × 每格 N 次(默认 3)。key 从环境变量 `DEEPSEEK_API_KEY` 或 `proto/.env.local` 读取、不打印。输出 Markdown 表:headers / 首字节 / 首 reasoning / 首 content / 首块 / done / ct / reasoning_tok / tok/s / `Content-Encoding`。本次因无 key 且网络受限**未运行**。

```
cd .scratch/v03-polish/research/latency-bench && node bench.mjs 3
MODEL=deepseek-v4-pro node bench.mjs 2
```

## 5. 推荐默认值

| 项 | 推荐 | 现状 |
|---|---|---|
| 思考 | 按 host 白名单显式关(§1.3);关不掉则展示"思考中"进度 | 未传,默认可能开且被丢弃 |
| `reasoning_content` | 解析为独立事件,UI 显示进度,不入译文 | 忽略 |
| Accept-Encoding(流式) | `identity` | client `gzip(true)` 自动发 gzip |
| 首批 | 1 块(<150 字补到 2 块,≤300 字) | ≤10 块/2000 字 |
| 后续批 | ≤10 块 / 2000 字(CJK→拉丁 1250) | 同 |
| 并发 | 默认 1(可选 2~3,Ollama 恒 1),首批永远单独先发 | 顺序 |
| temperature | 关思考后可降到 0.3~0.7 提升一致性(与延迟无关,仅顺带建议;DeepSeek 思考模式下 temperature 无效) | 1.0 |
| 计时 | TTFT/首块/首字节/reasoning_tokens 入 `usage_log` | 仅总耗时 |

## 6. 待官方核实 / 未实测清单

- DeepSeek `deepseek-flash` 当前快照思考默认值(第三方称默认开)。
- GLM-4.5-Flash 是否已随 GLM-4.5 下线、默认是否动态思考。
- 各托管服务对未知字段是否宽松(DeepSeek/智谱/百炼)。
- 官方 SSE 是否带 `Content-Encoding: gzip`。
- 批 1/3/10 的 TTFT/首块/tok/s 全部数字。
