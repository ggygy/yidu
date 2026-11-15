# 10: 验证环境准备(API Key + Ollama)

Type: task
Status: resolved

## Question

准备 spec 定稿前的验证环境:① 一个可用的 OpenAI 兼容 API key(DeepSeek / 智谱 GLM 等,用户已有账号的直接用),跑通一次 chat 请求;② 决定本地是否装 Ollama(装哪几个模型),不装则 spec 中 Ollama 标记为"用户自备、未验证"。完成后在本文记录:key 的存放位置(不入库)、可用模型名、一次请求的粗略耗时,供工单 06、09 使用。

## Resolution (2026-11-14)

1. **Key**:用户提供 DeepSeek key(**仅测试用**),存 `proto/.env.local`(本地文件,不写入任何文档/源码/记忆);Base URL `https://api.deepseek.com`,模型 `deepseek-chat`。
2. **实测**:聊天+流式跑通,见 `proto/scripts/protocol-test.mjs` 与工单 06 附录(首 token ~0.7s,3 块批总耗时 ~1.5s,10 块批 ~1.6s)。
3. **Ollama**:本地未安装 → spec 中 Ollama 标记为"用户自备、协议按官方 /api/* 文档设计、未实机验证"。
