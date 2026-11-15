# 03: LLM 翻译链路与 prompt 协议调研

Type: research
Status: resolved

## Question

LLM 翻译 markdown 的链路怎么设计?调研:整篇直译 vs 按块翻译的取舍;让 LLM 逐块输出结构化结果(JSON/分隔符协议)vs 输出整篇译文再程序对齐,各自的可靠性与修复策略;流式输出与逐块渲染的配合;长文档分块与 token 预算控制;prompt 模式(保留 md 语法、不译代码块、术语表注入、方向切换、非 md 输入结构化);可参考的业界实践(沉浸式翻译、各家 LLM 翻译指南/评测)。产出:推荐的翻译协议草案(块粒度、输出格式、prompt 骨架、术语注入方式)。

## Answer

- 链路五段式:md 解析成 block(代码块/内联代码/URL 保护)→ 组批(3~10 块、~2000 字符/批,对齐沉浸式翻译 1800 字符量级)→ 流式请求 → 校验修复 → 逐块上屏。
- 输出协议:**分隔符协议为默认**(`<s id="n">原文</s>` → `<t id="n">译文</t>`),流中凑齐一个 `</t>` 即可上屏一块;JSON(`json_object`)仅作非流式备选——DeepSeek/GLM 无 strict schema 且有"空 JSON/截断"坑,可靠性并不更高,流式还需部分 JSON 增量解析。
- 术语注入:system prompt 内"必须使用"术语表(沉浸式翻译 `terms_prompt` 同款)+ 译后程序校验命中/替换(mdpo-llm 思路),不能只靠 prompt。
- 长文/预算:每批携带文档标题 + 上批末段已译文(标注勿输出);Ollama 必须显式设 `num_ctx`(默认仅 4096,静默截断头号坑);按 provider 配置批预算与 `max_tokens`。
- 修复梯度:id 对齐补救 → 缺块单发重试 → 整批重试 → 降级逐块串行;译后校验块数、代码围栏数、URL 集合。
- 完整调研(prompt 骨架、决策对比表、风险兜底表、来源):[research/03-llm-translation-pipeline.md](../research/03-llm-translation-pipeline.md)
