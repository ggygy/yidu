# 04: Provider 层与 Ollama 集成调研

Type: research
Status: resolved

## Question

Provider 层(见 CONTEXT.md)如何抽象与实现?调研:Tauri 2 中从 Rust 侧 vs 前端侧发起 LLM 请求的取舍(CORS、key 安全存储——keychain/keyring、代理需求);OpenAI 兼容请求的要点(自定义 Base URL、模型名、stream/SSE 解析、上下文长度差异);Ollama 的模型列表发现、拉取与选择交互;错误处理、超时、重试与断流恢复;多 provider 配置的数据形态。产出:推荐架构 + 关键库清单。

## Answer

完整调研见 [research/04-provider-layer.md](../research/04-provider-layer.md)。结论:

1. **Provider 层全放 Rust 侧**:一个 `Provider` trait + `OpenAiCompatible`/`Ollama` 两实现,reqwest 发请求,流式增量经 `tauri::ipc::Channel` 推前端(官方推荐的流式机制)。前端不直连 LLM API。
2. 关键 crate:`reqwest`、`eventsource-stream`(SSE)、`keyring 4`(v1 + apple-native,存 macOS Keychain)、`thiserror`、`tokio-util`(取消);不建议 reqwest-eventsource(自动重连不适用)与 stronghold(过重)。
3. 不走前端 plugin-http 的原因:URL scope 是构建期静态白名单、与 BYOK 任意 Base URL 冲突,key 须进 JS;Ollama 默认 CORS 也不放行 `tauri://localhost`(其流式支持虽已修复,见 PR #2479)。
4. OpenAI 兼容要点:Base URL 需归一化(各家 /v1、/api/paas/v4 形态不一);模型名不硬编码,用 `GET /models` + 手填;SSE `data:`/`[DONE]`/include_usage 末包 choices 为空;GLM/DeepSeek 思考模型的 `reasoning_content` 须与译文隔离。
5. Ollama 走原生 `/api/*`(NDJSON 非 SSE):`/api/tags` 发现、`/api/pull` 流式进度(可断点续传)、`/api/show` 拿 context_length;**每请求必须显式 `options.num_ctx`(默认仅 4096 且静默截断)**;不用其实验性 OpenAI 兼容层(无法设 num_ctx)。
6. 超时/重试:流式只设 connect_timeout + read_timeout(reqwest 总 timeout 会腰斩长流);首字节前指数退避重试,断流不自动续传(无游标),按块保留部分译文 + 用户重译单块。
7. 多 provider 配置:serde tag 枚举(kind: openai_compatible | ollama)+ tuning 参数,存 SQLite/config;key 只存 keychain(service=应用名,user=provider_id),配置里仅存 `api_key_set` 标记。
