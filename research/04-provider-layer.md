# 调研 04:Provider 层(LLM 后端)抽象与实现

> 工单:`issues/04-provider-layer.md` · 状态:resolved · 日期:2026-11-12
> 产品前提:Tauri 2 桌面 Markdown 翻译器(macOS arm64 优先),Rust 后端 + web 前端,BYOK(OpenAI 兼容:DeepSeek / 智谱 GLM / 中转站)+ 可选 Ollama,翻译结果流式上屏,无账号无云。

---

## 一、结论先行

### 推荐架构

**Provider 层完全放在 Rust 侧**:一个 `Provider` trait + 两个实现(`OpenAiCompatible`、`Ollama`),用 `reqwest` 发请求,流式增量通过 `tauri::ipc::Channel` 推给前端;API key 存 macOS Keychain(`keyring` crate);provider 配置(不含 key)存本地(SQLite/config 文件)。前端只调用 `translate_stream`/`list_models`/`test_connection` 等 command,不直接 fetch LLM API。

理由(下文详述):

1. **key 安全**:key 不进 webview 内存、不落盘明文;Rust 侧注入 `Authorization` 头。
2. **CORS 免疫**:webview 原生 fetch 受 CORS 限制,LLM API 不发 CORS 头;tauri-plugin-http 虽可绕过,但其 URL scope 是**构建期静态声明**的,与 BYOK 任意 Base URL 冲突(要么写 `https://**` 通配架空权限系统)。Ollama 默认 CORS 白名单也不含 `tauri://localhost`。
3. **流式可行且更干净**:Tauri 官方明确 `tauri::ipc::Channel` 是"流式数据(如流式 HTTP 响应)推送给前端的推荐机制";Rust 侧统一做 SSE/NDJSON 双解析、重试、取消。
4. 前端侧 plugin-http 的 fetch 自 2025-03 起也支持 ReadableStream 流式(PR #2479),可作为备选,但对本项目劣势明显。

### 关键 crate / 库清单

| crate / 模块 | 用途 | 备注 |
|---|---|---|
| `reqwest`(rustls-tls) | HTTP 客户端 | 注意:不要对流式请求设总 `timeout()`(见超时一节) |
| `eventsource-stream` | SSE 解析(`bytes_stream()` → 事件流) | 处理跨 chunk 的 UTF-8 边界与行缓冲;`reqwest-eventsource` 自带重连,对"不可续传"的 LLM 流不合适,不推荐 |
| `keyring = "4"`(features = `["v1", "apple-native"]`) | macOS Keychain 存 API key | v1 模块提供经典 `Entry::new/set_password/get_password/delete_credential`;apple-native 后端落 Keychain Services |
| `serde` / `serde_json` / `thiserror` | 配置与错误序列化 | Tauri 要求 command 返回值含错误都实现 `Serialize` |
| `tokio` + `tokio-util`(`CancellationToken`) | 异步与用户取消 | 流循环中检查 token,取消即断开连接 |
| `tauri::ipc::Channel` | 流式增量推给前端 | Tauri 2 官方推荐方式,有序、类型安全、支持原始字节 |
| (可选)`async-openai` | OpenAI 兼容客户端全家桶 | `OpenAIConfig::with_api_base/with_api_key` 可指向任意兼容端点,支持流式;P0 建议手写薄层(约 200 行)减少对中转站怪格式的适配成本,async-openai 作为备选 |
| (可选)`ollama-rs` | Ollama 客户端 | 原生 REST 很薄(3-4 个端点),手写即可,不必引依赖 |

不建议:tauri-plugin-http(前端发 LLM 请求)、tauri-plugin-stronghold(key 存储,见下)、reqwest-eventsource(自动重连语义不匹配)。

---

## 二、Tauri 2:Rust 侧 vs 前端侧发起 LLM 请求

### 前端侧路径:tauri-plugin-http

- 官方 http 插件暴露一个贴近浏览器 `fetch` 的 JS API,请求实际经 IPC 由 Rust(reqwest)发出,**绕开 webview 的 CORS 限制**,URL 访问由 capability scope 控制;默认权限"不显式放行任何 origin",需在 capabilities 中配置 `http:default` + `allow: [{url: ...}]`(tauri.app 插件文档)。
- **流式支持**:2024-12 有 issue 报告 fetch 会阻塞到整个响应体结束才返回(plugins-workspace #2129);2025-03-08 PR #2479 合并"HTTP add stream support"——Rust 侧把 body 分块经 IPC Channel 发给 JS,`res.body.getReader()` 变成真正的 ReadableStream。当前 2.x 版本前端流式可用。
- **对本项目的两个硬伤**:
  1. **scope 是静态的**:BYOK 允许用户填任意 Base URL(DeepSeek/GLM/任意中转),capability 里的 URL 白名单在构建期写死,运行时无法按用户输入收敛——实践中只能放行 `https://**` 级别通配,权限模型形同虚设。
  2. **key 必须进 JS 上下文**才能设 `Authorization` 头(插件的"forbidden headers 默认忽略"还涉及 `unsafe-headers` feature 的取舍),增加泄漏面(webview devtools、前端依赖供应链)。

### Rust 侧路径:reqwest + Channel(推荐)

- 官方文档原话:"The Tauri channel is the recommended mechanism for streaming data such as streamed HTTP responses to the frontend."——command 参数里收一个 `tauri::ipc::Channel<TranslateDelta>`,流循环中 `channel.send(delta)`;Channel 与单次 invoke 绑定、按序投递、支持非 JSON 原始载荷,优于全局事件 `emit`(事件无类型、广播、仅 JSON、快速连发可能乱序)。
- 错误回传:Tauri 要求"everything returned from commands must implement serde::Serialize, including errors",官方推荐 thiserror 枚举 + `#[serde(tag = "kind", content = "message")]` 序列化为结构化对象,前端映射 TS 枚举。
- key 全程留在 Rust 进程:读取 → 注入 header → 丢弃,IPC 层面只传配置 id。

### CORS / 代理相关事实

- **Ollama**:默认"CORS 仅允许来自 127.0.0.1 与 0.0.0.0 的跨域请求",要放开需设 `OLLAMA_ORIGINS` 环境变量(docs.ollama.com FAQ)。Tauri 应用在 macOS 的 webview origin 是 `tauri://localhost`,不在默认白名单内 → 前端直连 Ollama 会因 CORS 失败,除非用户改环境变量;Rust 侧 reqwest 无此概念,天然免疫。
- **代理**:BYOK 用户(尤其走 OpenAI 官方/海外中转)可能依赖代理。reqwest 默认读取 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 环境变量;macOS 系统级代理设置不会自动套用(参照:plugin-http 直到 2026-08 才加 `system-proxy` feature)。P0 记录为已知限制即可,可在设置里提供"代理地址"透传为 reqwest 代理。

### key 安全存储

| 方案 | 结论 |
|---|---|
| **`keyring` crate(推荐)** | 最新 4.x 拆为 keyring-core + 平台 store;启用 `v1` + `apple-native` feature 后用经典 API:`Entry::new(service, user)` → `set_password/get_password/delete_credential`,macOS 落 **Keychain Services**,Windows 落 Credential Manager,Linux 落 Secret Service——正好满足"macOS 优先、架构不阻断 Windows"。无主密码 UX 负担,适合单用户桌面 BYOK。 |
| `tauri-plugin-stronghold` | IOTA Stronghold 加密保险库,argon2 从主密码派生 32 字节密钥,`store.insert/get` + `save()`。安全强度高但要求用户记主密码(或把派生密码也存某处,削弱意义),对"本地优先无账号"的翻译器过重。备选。 |
| 明文存 SQLite / config 文件 | 排除:与 BYOK 安全预期不符。 |

建议落地:`service = "md-translator"`,`user = provider_id`(或 `provider_id + ":key"`),配置库只存 keychain 引用不存 key 本体;前端永不回显完整 key(写入后只显示掩码,"测试连接"command 在 Rust 侧取 key 实测)。

### 推荐的 command 面(前端可见)

```
list_providers() -> Vec<ProviderConfig>          // 不含 key
upsert_provider(config) / delete_provider(id)    // key 单独走 set_provider_key(id, key)
set_provider_key(id, key) / clear_provider_key(id)
test_connection(id) -> Result<TestReport, ProviderError>
list_models(id) -> Vec<ModelInfo>                // OpenAI: GET /models;Ollama: GET /api/tags
translate(request, on_delta: Channel<Delta>) -> Result<TranslateResult, ProviderError>
   // request: {provider_id, blocks/segment, 术语表, 语言方向, 选项}
ollama_pull(model, on_progress: Channel<PullProgress>) -> Result<()>
cancel(job_id)                                   // 触发 CancellationToken
```

---

## 三、OpenAI 兼容请求的要点

### Base URL 与模型名

- 端点统一为 `POST {base}/chat/completions`,鉴权 `Authorization: Bearer <key>`。各家 base 习惯不一:
  - OpenAI:`https://api.openai.com/v1`
  - DeepSeek:`https://api.deepseek.com`(官方文档注明 OpenAI 格式 base_url 即此,不带 /v1;/v1 也被接受,与模型版本无关)
  - 智谱 GLM:`https://open.bigmodel.cn/api/paas/v4`(官方提供 OpenAI SDK 直连说明,注意是 `paas/v4` 而非 `v1`)
  - 中转站(one-api/new-api 系):通常 `https://host/v1`
- **实现必须做 Base URL 归一化**,推荐启发式:
  1. 用户填的串若已以 `/chat/completions` 结尾 → 原样用;
  2. 去尾斜杠后若以 `/v1` 或 `/v4`(GLM 场景)结尾 → 追加 `/chat/completions`;
  3. 否则追加 `/v1/chat/completions`;
  4. 归一化结果保存,UI 实时预览最终 URL。
- **模型名绝不硬编码**:DeepSeek 已把主推模型从 deepseek-chat 换成 deepseek-flash(1M 上下文)与 deepseek-v4-pro,更替很快。提供"拉取模型列表"(OpenAI 标准 `GET /models`,DeepSeek 返回 `data[].id` 还带 `context_window/max_output_tokens` 元数据;Ollama 兼容层也有 `/v1/models`)+ 自由输入框,失败可手填。GLM 常用 `glm-4.6`(200K 上下文)、`glm-4-flash` 等低价档。

### 流式(SSE)格式与解析

- 请求体 `{model, messages, stream: true}`,可选 `stream_options: {include_usage: true}`;响应为 `text/event-stream`,逐行 `data: {chunk}`,以 `data: [DONE]` 结束(DeepSeek 文档原文:"Tokens will be sent as data-only server-sent events … terminated by a data: [DONE] message")。
- 每个 chunk:`choices[0].delta.content` 为增量文本;`finish_reason`(stop/length/content_filter/tool_calls)出现即收尾;`include_usage` 时最后一个 chunk 携带 `usage`(此时 `choices` 可为空数组,解析须容忍);全程共享同一 `id/created`。
- 解析用 `eventsource-stream`:reqwest `response.bytes_stream()` 接入即自动处理 SSE 行协议、跨 chunk 的多字节 UTF-8 截断、行缓冲。手写解析的常见坑:chunk 边界切断 `data:` 行、`data:` 后带或不带空格、多行 data 事件。
- **思考型模型的差异(必须处理)**:GLM 流式 delta 里正文与推理分离在 `delta.content` 与 `delta.reasoning_content` 两个字段(官方 Python 示例分别遍历两者),并支持非标准参数 `thinking: {type: "enabled"}`;DeepSeek 思考模式同样输出 `reasoning_content`。翻译场景建议:默认选非思考模式/关 thinking(更快更便宜);解析层把 `reasoning_content` 作为独立事件透传,UI 可折叠显示或直接丢弃,**绝不能拼进译文**。
- 上下文长度差异大到不能写死:DeepSeek-flash 1M(最大输出 384K)、GLM-4.6 200K(最大输出 128K)、GLM-4.5 128K、OpenAI 分模型各异、Ollama 取决于模型文件。Provider 层只暴露"上下文上限提示"(可配、可被 /models 元数据覆盖),分块策略归翻译管线(工单 03/06)。

### 超时、重试与断流恢复(核心坑)

- **reqwest 超时语义**:`ClientBuilder::timeout()` 是"从开始连接到**响应体读完**的总 deadline"(docs.rs 原文),对长译文流会在中途硬断;`read_timeout` 是"单次读操作超时,成功读取后重置",适合流。**结论:流式请求只设 `connect_timeout`(约 10s)+ `read_timeout`(30–60s 检测卡死),不设总 timeout**;非流式小请求(如 list_models)可设总 timeout 10s。
- **重试分层**:
  - 首字节之前(建连/5xx/429):指数退避 + 抖动,重试 2–3 次;有 `Retry-After` 头优先遵守。DeepSeek 官方对 500/503 明确建议"短暂等待后重试",429 建议控制节奏;OpenAI 兼容生态普遍同此约定。
  - 首字节之后:不自动重试。OpenAI chat 流没有可续传的游标(SSE 重连会从头重新生成、重新计费),Ollama 亦然。正确做法:**保留已收到的部分译文** → 标记该块"断流" → 用户点"重译此块/继续"。因翻译按块分段(管线工单),重放单块成本低,这就是我们的"断流恢复"。
- **取消**:文档关闭/切换 provider → `CancellationToken.cancel()`,Rust 流循环每次读之间检查;reqwest future 被 drop 即断开连接。前端 AbortController 语义经 `cancel` command 映射。
- **错误分类**(thiserror 枚举 + serde tag):
  - 网络层:连接失败/DNS/代理错误(可重试)、读超时(流卡死)
  - HTTP 层:401(key 错)、402(DeepSeek 特有:余额不足)、422(参数)、429(限流)、5xx(服务端)
  - 流内错误:部分厂商在流中以 `data: {"error": ...}` 事件报错,须识别
  - 解析层:JSON 反序列化失败、缺 [DONE] 即断连
  - Ollama 特有:HTTP 状态码 + `{"error": "..."}` JSON 体;模型未加载(load_duration 可达数秒到数十秒,是首 token 延迟主因)

---

## 四、Ollama 集成

原生 REST API(默认 `http://127.0.0.1:11434`)为准,**不用**其 OpenAI 兼容层做主通道(官方自述"experimental and is subject to major adjustments",且 `/v1` 通道**无法设置上下文大小 num_ctx**——官方 openai.md 明说需要另建 Modelfile)。

### 模型发现与选择

- `GET /api/tags`:返回本地模型列表,字段 `name`(如 `deepseek-r1:latest`)、`size`(字节,UI 显示磁盘占用)、`details{family, parameter_size, quantization_level}`。
- `POST /api/show {model}`:拿模型详情,`model_info` 里有 `llama.context_length` 等 GGUF 元数据(可作为上下文上限提示),`capabilities`(completion/vision/tools)、`parameters`(Modelfile 里的 num_ctx 等)。
- `GET /api/version`:健康检查(区分"Ollama 未启动"与"无模型");`GET /api/ps`:当前已加载模型与 `expires_at`(预热提示)。
- UX:模型下拉 = /api/tags 实时刷新;"拉取更多"引导输入 `library/model:tag`。

### 拉取(pull)

- `POST /api/pull {model}` 流式返回 NDJSON:`{status:"pulling manifest"}` → `{status:"pulling <digest>", digest, total, completed}`(算百分比进度条)→ `verifying/writing manifest/success`。
- 官方行为:**"Cancelled pulls are resumed from where they left off, and multiple calls will share the same download progress"**——取消/重拉天然幂等续传,UI 直接暴露进度即可;进度经 `Channel<PullProgress>` 推前端,复用流式管道。
- 删除模型 `DELETE /api/delete {model}`(可选 P1)。

### 聊天与流式(与 SSE 不同!)

- `POST /api/chat {model, messages, stream: true, options: {...}, keep_alive}` 返回的是 **NDJSON(每行一个完整 JSON 对象),不是 SSE**:`{message: {role, content: "增量"}, done: false}` 逐行;最后一行 `done: true, done_reason: "stop"` 附带统计 `prompt_eval_count / eval_count / eval_duration`(纳秒;`eval_count/eval_duration*10^9` 即 tok/s)与 `total_duration`。
- → Provider 层需要**两种流解析器**(SSE for OpenAI 兼容,NDJSON for Ollama),统一归一化为内部 `Delta` 事件(content / reasoning / usage / done)。
- **必须显式设 `options.num_ctx`**:Ollama 默认上下文窗口仅 **4096 tokens**(FAQ 原文),超出会**静默截断提示词、无任何报错**(社区反复踩坑;见 particula.tech 分析与大量 issue)。翻译整篇 Markdown 极易超 4K,建议请求里带 `options: {num_ctx: 8192}`(可配,默认 8k;文档长时提示用户调大,注意显存代价,FAQ:"a 2K context with 4 parallel requests will result in an 8K context")。服务端全局可用 `OLLAMA_CONTEXT_LENGTH` 改默认,但不能依赖用户设置。
- `keep_alive` 默认 5m:模型加载后驻留 5 分钟;翻译是"长文章多次分块请求"模式,保持默认即可获得预热收益;`keep_alive: 0` 可显式卸载。首块请求含模型加载(load_duration),UI 要有"模型加载中"预期。
- 思考型模型:`think` 参数(boolean 或 low/medium/high/max),流式 delta 的 `message.thinking` 字段;同样归一化为 reasoning 事件。

---

## 五、多 Provider 配置的数据形态

原则:**配置可序列化、key 不入库、前后端共享类型定义、可版本化迁移**。

```rust
// provider 配置(不含 key;存 SQLite providers 表或 config 文件)
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderKind {
    OpenAiCompatible {
        name: String,           // 显示名 "DeepSeek" / "GLM" / "某中转"
        base_url: String,       // 归一化前原样保存,请求时归一化
        model: String,          // 当前选中模型(可从 /models 拉)
        api_key_set: bool,      // 仅标记 keychain 里有没有,不存 key
        #[serde(default)]
        extra_headers: BTreeMap<String, String>,  // 中转站偶需自定义头
        #[serde(flatten)]
        tuning: ProviderTuning, // 见下
    },
    Ollama {
        name: String,
        host: String,           // http://127.0.0.1:11434
        model: String,
        #[serde(default)]
        num_ctx: u32,           // 默认 8192
        #[serde(flatten)]
        tuning: ProviderTuning,
    },
}

pub struct ProviderTuning {
    pub context_limit_hint: Option<u32>, // 分块参考;Ollama 用 /api/show 自动填
    pub thinking: Option<ThinkingMode>,  // 默认关闭
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,         // 建议显式设,各厂商默认不一
    pub concurrency: u8,                 // 并发分块数,默认 1–2
}
// 全局:active_provider_id、schema_version: u32(迁移用)
```

- key:keychain `service="md-translator"`, `user=provider_id`;删除 provider 时同步 `delete_credential`。
- trait 抽象(实现侧):

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> &str;
    async fn chat_stream(&self, req: ChatRequest, tx: DeltaSink, cancel: CancellationToken)
        -> Result<UsageSummary, ProviderError>;
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError>;
    async fn test(&self) -> Result<TestReport, ProviderError>; // 1 token 级最小请求
}
// DeltaSink 内部枚举:Content(String) | Reasoning(String) | Usage(..) | Done(reason)
// 两个实现共享:归一化、超时策略、pre-stream 重试;差异只在请求构造与流解析(SSE vs NDJSON)
```

- 持久化中间态(衔接工单 08):译文按块存 SQLite,状态 `pending / streaming(partial) / done / error(reason)`,断流恢复 = 对 error/streaming 块重放。

---

## 六、风险与坑(汇总)

1. **reqwest 总 timeout 会腰斩长流**:流式只用 connect_timeout + read_timeout。
2. **Ollama 默认 num_ctx=4096 静默截断**:必须每请求显式传 `options.num_ctx`;显存随上下文增长,给用户可配项。
3. **Ollama OpenAI 兼容层是实验性的且不能设 num_ctx**:走原生 `/api/*`。
4. **前端 plugin-http 的 scope 是构建期静态白名单**,与 BYOK 任意 Base URL 冲突;且 Ollama 默认 CORS 不放行 `tauri://localhost`。→ 全部走 Rust。
5. **reasoning_content 污染译文**:GLM/DeepSeek 思考模型的推理流单独字段,须隔离;翻译默认关思考。
6. **Base URL 形态各异**(带/不带 /v1、GLM 的 /api/paas/v4、用户直接贴完整端点):必须归一化 + UI 预览最终 URL。
7. **模型目录变化快**:不硬编码;`GET /models` 拉取 + 手填兜底。
8. **SSE 细节**:`data:` 可带可不带空格;include_usage 的末包 `choices: []`;流内 error 事件;跨 chunk UTF-8 截断——用 eventsource-stream 并对上述情形写单测。
9. **断流不能自动重试续传**:OpenAI/Ollama 均无流式游标,重连即重新生成重新计费;按块重放是正解,部分译文先落库。
10. **keychain 与签名**:map 把签名公正列为 out of scope,但注意 macOS 上未签名/签名变更会导致 app 身份漂移,升级后可能触发"允许访问钥匙串"弹窗;P0 可接受,文档记录。
11. **系统代理**:reqwest 只认环境变量代理,不读 macOS 系统代理设置;设置页提供显式代理配置可解。
12. **首 token 延迟**:Ollama 冷加载可达数十秒(load_duration),UI 要区分"连接中/模型加载中/生成中"。

---

## 七、来源

**Tauri 2**
- HTTP Client 插件(fetch、scope、unsafe-headers):https://tauri.app/plugin/http-client/
- Channel 流式与 command 错误序列化:https://v2.tauri.app/develop/calling-rust/
- Stronghold 插件(备选 key 存储):https://v2.tauri.app/plugin/stronghold/
- plugin-http 流式修复追踪:issue https://github.com/tauri-apps/plugins-workspace/issues/2129(closed)、PR https://github.com/tauri-apps/plugins-workspace/pull/2479(merged 2025-03-08)

**Rust crates**
- keyring 4.x / v1 模块 / apple-native:https://docs.rs/keyring/latest/keyring/ 与 https://docs.rs/keyring/latest/keyring/v1/index.html
- reqwest 超时语义(timeout/read_timeout 原文):https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html
- async-openai(OpenAIConfig with_api_base、兼容厂商章节):https://docs.rs/async-openai/latest/async_openai/
- SSE 解析模式(reqwest bytes_stream + eventsource-stream 的通行做法):https://docs.rs/eventsource-stream/ 、https://docs.rs/reqwest-eventsource/ 、https://docs.venice.ai/learn/rust-llm-gateway

**Ollama**
- REST API 全量(api.md,/api/tags、/api/chat、/api/pull、/api/show、/api/ps、NDJSON、keep_alive、done_reason):https://github.com/ollama/ollama/blob/main/docs/api.md(迁移至 https://docs.ollama.com/api)
- OpenAI 兼容层(实验性、/v1 无法设上下文):https://github.com/ollama/ollama/blob/main/docs/openai.md
- 默认 4096 上下文与 OLLAMA_CONTEXT_LENGTH、CORS/OLLAMA_ORIGINS:https://docs.ollama.com/faq 、https://docs.ollama.com/context-length
- 默认上下文静默截断(社区分析):https://particula.tech/blog/ollama-num-ctx-silent-prompt-truncation

**OpenAI 兼容 / 各厂商**
- DeepSeek:base_url、模型与价格(deepseek-flash 1M 上下文等):https://api-docs.deepseek.com/ 与 https://api-docs.deepseek.com/quick_start/pricing ;SSE 与流式格式、reasoning_content、错误码表:https://api-docs.deepseek.com/api/create-chat-completion 、https://api-docs.deepseek.com/quick_start/error_codes ;模型列表端点:https://api-docs.deepseek.com/api/list-models
- 智谱 GLM:glm-4.6(200K/128K)、thinking 参数、delta.reasoning_content、Bearer 鉴权:https://docs.bigmodel.cn/cn/guide/models/text/glm-4.6 ;OpenAI SDK 直接兼容(base_url=open.bigmodel.cn/api/paas/v4):https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
- OpenAI Chat Streaming 参考规范(SSE/​[DONE]/include_usage,与 DeepSeek 文档一致):https://platform.openai.com/docs/api-reference/chat/streaming
