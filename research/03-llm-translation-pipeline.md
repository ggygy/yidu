# 03 调研:LLM 翻译 Markdown 链路与 prompt 协议

> 工单:`issues/03-llm-translation-pipeline.md`
> 产品:本地优先 Tauri 2 桌面翻译应用;BYOK(OpenAI 兼容 API:DeepSeek / 智谱 GLM 等 + Ollama 本地);默认英→中、方向可切换;用户术语库注入;代码块不译;译文流式逐块上屏。

---

## 一、结论先行:推荐协议草案

### 1.1 总体链路(五段式)

```
md 源文档
  → ① 解析:block 切分(mdast 风格,代码块/内联代码/URL 标记为保护段)
  → ② 分批:多个 block 组成一个 batch(预算 ~2000 字符/批)
  → ③ 翻译:每批一次 LLM 请求,流式 SSE
  → ④ 校验+修复:块数对齐 / 非空 / 术语命中 / 结构完整性;失败按成本升序修复
  → ⑤ 渲染:解析器按分隔符切流,完成一块上屏一块,当前块实时预览
```

### 1.2 推荐协议要点

| 维度 | 推荐 | 一句话理由 |
|---|---|---|
| 块粒度 | **block 级**(heading/段落/list 项/表格行为单位),而非整篇或句子 | 整篇译质量最好但无法流式、失败代价大;句子级太碎破坏上下文;block 级是流式渲染与质量的平衡点,也是沉浸式翻译(段落组批)与 GenAIScript(mdast 节点)的共同选择 |
| 请求粒度 | **批式**:一批 3~10 个 block、约 1500~2500 字符 | 沉浸式翻译默认约 1800 字符/请求、腾讯服务示例 25 段/请求;批式摊薄 prompt 开销并保留段间上下文,失败只重试一批 |
| 输出格式 | **分隔符协议为主**(默认):每块包 `<s id="n">原文</s>`,模型按相同 id 顺序输出 `<t id="n">译文</t>`;**JSON 模式为可选开关**(端点支持且用户关流式时) | DeepSeek/GLM 只有 `json_object`(无 strict schema),仍会截断/空输出,可靠性并不更高;而 JSON 流式必须增量解析部分 JSON,复杂度高。分隔符协议对流式天然友好:流中出现下一个分隔符即此前一块完整,可立即上屏 |
| 流式 | SSE `delta.content` 增量拼接 + **状态机按分隔符切块**,块完成即渲染;当前正在生成的块显示为"翻译中"预览 | 沉浸式翻译用 `streamingSelector`/`streamingChange` 做同样的增量渲染;Ollama 本地逐 token 更慢,块级上屏对体验更关键 |
| 长文分块 | 每 batch 附带**文档标题 + 上一批最后 1~2 段已译文(标注"仅上下文参考,勿输出")+ 全局术语表** | 业界通用做法:滑动窗口重叠 / 摘要前置 / 术语表随批注入,保持跨批一致性与指代连贯 |
| token 预算 | 按字符预算(输入+输出 ≤ 模型上下文 1/3);**Ollama 必须显式设 `num_ctx`**(默认仅 4096);`max_tokens` ≥ 预估译文 token × 1.5 | Ollama 默认 4096 上下文是本地长文最常见的静默截断源;DeepSeek JSON 指南明确要求 `max_tokens` 留足否则 JSON 截断 |
| 代码块 | 解析期就**从翻译队列剔除**,原样拼回;prompt 中再叮嘱内联代码/路径/URL 不译 | 双保险:结构层保护(程序)+ 指令层约束(prompt);GenAIScript、hostkey 等实践一致 |
| 术语注入 | system prompt 内注入"必须使用"术语表(沉浸式翻译 `terms_prompt` 同款措辞)+ **译后程序校验命中**,未命中标黄/自动替换 | mdpo-llm 的核心思路:术语不能只靠 prompt,模型调用后再程序性强制 |
| 方向切换 | prompt 全部参数化 `{{from}}`/`{{to}}`,不做硬编码;中→英时字符预算收紧(中文 token 密度低、英文展开约 1.5~2 倍) | 同一管线两方向复用;沉浸式翻译即用 `{{to}}` 变量 |
| 非 md 输入 | 纯文本按空行切段当作 paragraph 块,走同一管线;输出时保持原分段 | "结构化"发生在入口:任何输入统一归一化为 block 列表 |

### 1.3 一图流(数据形态)

```
输入 md ──解析──▶ Block[] { id, kind, raw, protected? }
                    │  code fence/inline code/URL → protected=true,直通
                    ▼
              Batch[] (≤N 块 & ≤预算字符)
                    │  每批请求: system(角色+规则+术语表) + user(标题+上文+<s id>…)
                    ▼
        流式 SSE ──状态机──▶ 逐块产出 TranslatedBlock,实时上屏
                    ▼
              校验: 块数一致?非空?术语命中?代码块数量一致?
                    ▼
          失败 → 修复梯度: 对齐补救 → 单块重试 → 整批重试 → 降级逐块翻译
```

---

## 二、各决策点对比

### 2.1 整篇直译 vs 按块(批)翻译

| 维度 | 整篇直译 | 按块分批翻译(推荐) |
|---|---|---|
| 译文质量/一致性 | 最好:全文语境完整、术语人称一致 | 需要靠"上文携带 + 术语表"补上下文,一致性略逊但可控 |
| 流式体验 | 差:首块延迟 = 整篇生成时间;长文等于无流式 | 好:首批几百毫秒~数秒即可上屏 |
| 失败代价 | 高:超时/截断则全篇重来,重试成本最大 | 低:只重试失败的批 |
| token 适配 BYOK | 差:Ollama 本地 4K~32K 上下文装不下长文;输出上限(DeepSeek 曾 8K)易截断 | 好:批大小可按端点能力动态调节 |
| 缓存/增量 | 粒度太粗 | 可做 block 级哈希缓存(编辑后只重译改动块,GenAIScript 的 SHA-256 节点哈希 + PO 文件思路) |
| 上下文窗口利用 | 长文直接超限 | 长文天然可处理 |

结论:**分批是唯一同时满足流式 + 本地模型 + 长文档的方案**;质量损失用"批内多块同译 + 跨批上文携带"弥补——一批内本来就有段间上下文,这是"批"区别于"逐块单发"的关键优势。

### 2.2 逐块结构化输出 vs 整篇译文再程序对齐

| 方案 | 机制 | 可靠性 | 流式配合 | 修复 |
|---|---|---|---|---|
| **A. 分隔符协议(推荐默认)** | 输入每块包 `<s id="n">`,要求输出 `<t id="n">`;或沉浸式翻译式 `%%` 分段 | 高:分隔符罕见不与正文冲突;id 可校验顺序与数量;模型天然擅长"按标记回填" | **最好**:流中出现下一个 `<t id>` 即上一块完整,立即可渲染 | 缺块/多块可程序对齐(按 id);局部重发 |
| **B. JSON(json_object)** | `response_format={"type":"json_object"}`,schema 写进 prompt,输出 `[{id,text}]` | 中:DeepSeek 明确"不可解析时把内容替换为空格"且可能表面 `finish_reason=stop`;GLM 官方也只保证"合法 JSON"不保证 schema;截断即整体非法 | **差**:需增量部分 JSON 解析器(partial-json-parser 类),状态复杂;LangChain `withStructuredOutput` 这类封装干脆不能流式部分结果 | 整体 JSON.parse 失败只能整批重试 |
| **C. JSON(json_schema strict)** | OpenAI 式严格 schema 约束解码 | 最高(端点支持时) | 仍需部分 JSON 解析;首 token 延迟与 token 开销略增 | 同 B,但非法率极低 |
| **D. 整篇译文程序对齐**(无标记,译完按段落数/相似度对齐原文) | 模型自由输出 md | 低:模型可能合并/拆分段落、增删空行、加"以下是译文"开场白,对齐全靠猜 | 可流式但不知道"当前在译哪一块",逐块上屏不可靠 | 几乎不可修复,只能人工 | 

关键事实:
- **DeepSeek** JSON 模式要求 prompt 含 "json" 字样,且"若输出无法解析为 JSON,API 会把非 JSON 内容替换为空格(U+0020)",结果可能看起来为空;官方建议调 prompt 并在代码里处理空内容(重试)。([JSON Output 指南](https://api-docs.deepseek.com/guides/json_mode))
- **智谱 GLM** 文档只演示 `json_object`,并建议把 schema 放 system、客户端再用 `jsonschema` 校验——官方自己都不承诺 schema 级保证。([结构化输出文档](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output))
- **Ollama** 支持 `format` 传完整 JSON schema(推荐同时把 schema 文本写进 prompt "grounding"),且经 OpenAI 兼容层可用 `response_format`;但云端不支持、流式下分块细节官方未承诺。([Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs))
- **OpenAI** 社区与实测:流式下结构化输出按 token 分片,需要自己拼接并增量解析;生态里有 openai-partial-stream / partial-json-parser 等库专治此事。

结论:**BYOK 场景下 JSON 的"可靠性优势"是幻觉(三家只有一家有 strict schema),而流式劣势是确定的** → 默认分隔符协议,id 标记 + 数量校验 + 对齐修复;JSON 留作可配置选项(端点支持 strict schema 且用户不要求流式时)。

分隔符协议的两种具体形态:
- `<s id="1">…</s>` / `<t id="1">…</t>` XML 风格:id 显式,容错最好(乱序也能按 id 回填)。
- 沉浸式翻译式 `%%`:输入段落用 `%%` 连接,要求输出保持**相同段落数、相同顺序、相同分隔符**;官方注释特意说明选 `%%` 是因为"不常见分隔符降低模型幻觉"。批量段落数少时(≤10)同样可靠,且 token 更省。

### 2.3 流式输出与逐块渲染的配合

- **请求层**:OpenAI 兼容 `stream: true`,SSE `choices[0].delta.content` 增量;Ollama 同样支持流式(OpenAI 兼容端点 `/v1/chat/completions` 行为一致)。
- **解析层**:维护一个增量缓冲 `buf += delta`;状态机扫描 `</t>`(或 `%%`):凑齐一个完整块 → 解析 id → emit 到渲染层 → 缓冲清到下一块起点。tail 部分作为"正在翻译"的实时预览追加显示。
- **渲染层**:已完成块直接替换为正式译文(可带完成态样式);进行中块用占位 + 打字机效果;失败块标红并保留原文。
- **节流**:Ollama 本地逐 token 更慢、delta 更碎,渲染层做 ~50ms 合帧即可;沉浸式翻译在网页侧就是用 `streamingSelector`/`streamingChange` 增量更新当前翻译元素,同理。
- **中止/取消**:用户取消时立即关闭流,已完成的块保留,未完成块标记"未翻译",可断点续译(batch 粒度天然支持)。

### 2.4 长文档分块与 token 预算控制

- **批预算用字符而非 token 计**(本地无 tokenizer 依赖):约 1500~2500 字符/批、3~10 块;与沉浸式翻译 `maxTextLengthPerRequest`(文档示例 1800)/`maxTextGroupLengthPerRequest`(示例 25 段)同量级,留出术语表 + 上文 + 输出余量。
- **跨批上下文**:每批 user 消息头附(1)文档标题,(2)上一批最后 1~2 段的**已译文**(明确标注"仅为上下文参考,不要输出/翻译它们"),维持指代与语气连贯。这是滑动窗口重叠 + 前文摘要两种业界通用技巧的轻量组合。
- **端点能力探测**:按 provider 配置上下文/输出上限(DeepSeek/GML 云端上下文 128K~200K、GLM-4.6 输出上限 128K,但按保守 4K~8K 输出预算设计;Ollama 视本地模型 8K~32K)。
- **Ollama 专项**:`num_ctx` 默认仅 4096(旧版 2048),长文会被**静默截断**;必须在请求 `options.num_ctx` 或 `OLLAMA_CONTEXT_LENGTH` 显式调大,并注意大上下文的显存代价。这是 BYOK 本地端最高频的坑。
- **截断处理**:流结束 `finish_reason === "length"` → 该批减半块数重试。
- **代码块**:不进翻译批次(不耗输出 token),但拼接回写时按原位置还原。

### 2.5 Prompt 模式要点(汇总)

| 需求 | 做法 | 来源依据 |
|---|---|---|
| 保留 md 语法 | 明确指令"保持 Markdown 结构/标记/空行数量不变";译后校验代码围栏数、链接数一致 | GenAIScript:"Do not change the structure of the document";译后 URL 集合 xor 比对 |
| 不译代码块 | ① 解析层剔除 fenced code;② prompt 再约束 inline code/变量/路径/URL 原样保留 | GenAIScript / hostkey / BookTranslator 一致:"DO NOT translate code, commands, $VAR, /paths" |
| 术语表 | system 注入"必须使用"表 + 译后程序校验/替换 | 沉浸式翻译 `terms_prompt`:"You MUST use the following terms";mdpo-llm 模型调用后强制执行术语 |
| 方向切换 | `{{from}}/{{to}}` 参数化;反向时预算与断句规则微调 | 沉浸式翻译 `{{to}}` 变量体系 |
| 非 md 输入 | 入口归一化:纯文本按空行→paragraph 块;HTML 转文本或按块保护;无标题则用文件名 | GenAIScript 同样只译 text/paragraph/heading/yaml 节点 |
| 防开场白 | "只输出译文,不要任何解释/前缀(如'以下是译文')" | 沉浸式翻译默认规则第 1 条同款 |
| 幻觉分隔符 | 选不常见分隔符;或 XML id 标签 | 沉浸式翻译选 `%%` 的理由;GenAIScript 用 `┌T001┐` 哈希标记 |

### 2.6 业界实践参照

- **沉浸式翻译**(最接近本产品的生产级实现):段落组批 + `%%` 分隔符/YAML(id+text 字段)两种协议;`maxTextGroupLengthPerRequest`/`maxTextLengthPerRequest` 控批、`limit` 控 QPS 限流、`requestTimeout` 控超时;术语经 `terms_prompt` 注入;流式用增量更新当前元素。还支持两步"反思式翻译"(step1 直译 → step2 润色,单请求双字段)。
- **GenAIScript 持续翻译**(Microsoft):mdast 节点级切分 + SHA-256 哈希缓存(只重译变更节点)+ `┌T001┐` 标记 + 围栏代码块语言位=哈希 id 的对齐协议;最多 5 轮迭代补漏;译后校验(md 可重新解析、URL 集合比对、LLM-as-judge)。
- **mdpo-llm**:PO 文件跟踪增量变更,术语在模型调用后程序性强制——印证"术语不能只靠 prompt"。
- **LLM 提供商**:DeepSeek `json_object` + prompt 含 "json" + 空 JSON 用空格替换的坑;GLM 仅 `json_object` + 客户端校验;Ollama `format`=schema + prompt 内重复 schema + temperature 0;OpenAI strict schema 最强但流式需自建部分 JSON 解析。

---

## 三、Prompt 骨架示例

### 3.1 System prompt(模板,方向/术语参数化)

```text
你是一名专业的{{from}}→{{to}}技术文档翻译。

规则:
1. 只输出译文。不要输出任何解释、前言、结语(例如"以下是译文")。
2. 输入被分成带编号的片段 <s id="N">…</s>。对每个片段,输出
   <t id="N">…</t>,id 与输入一一对应,顺序一致,数量一致,一个不漏。
3. 保持 Markdown 语法完全不变:标题层级、列表、粗斜体、链接、表格、
   引用、空行结构原样保留。
4. 代码块、行内代码 `…`、URL、文件路径、命令、变量名一律原样保留,不翻译。
5. 专有名词/产品名若无通用{{to}}译名,保留原文。
6. 标点遵循{{to}}习惯(英→中时用全角标点)。
7. {{context_note}} 标记的"上文参考"部分只用于理解语境,禁止翻译或输出。

术语表(必须使用以下固定译法;若术语保持原文则原样保留):
- LLM → 大语言模型
- token → token(不译)
- context window → 上下文窗口
```

要点:术语表放 system(每请求重复注入,沉浸式翻译同款"必须使用"措辞);规则第 2 条即分隔符协议契约;第 7 条配合跨批上文。

### 3.2 User prompt(每批)

```text
文档标题:{{title}}(供理解语境)

上文参考(勿翻译、勿输出):
{{prev_block_tail: 上一批最后 1~2 段已译文}}

请翻译以下 {{N}} 个片段:

<s id="1">{{block_1 原文}}</s>
<s id="2">{{block_2 原文}}</s>
<s id="3">{{block_3 原文}}</s>
```

(批内代码块已在解析层剔除,不出现;批大小受 2.4 的字符预算约束。)

### 3.3 期望输出(流式分片到达)

```text
<t id="1">…译文1…</t>
<t id="2">…译文2…</t>
<t id="3">…译文3…</t>
```

流式状态机:`buf += delta` → 每凑齐一个 `</t>` emit 一块上屏 → 尾部未闭合内容作为当前块预览。

### 3.4 备选:JSON 模式(可选开关)

```json
// response_format: {"type": "json_object"}(DeepSeek/GLM)
// prompt 中必须包含 "json" 字样并给出 schema 示例(DeepSeek 硬性要求)
{"translations": [{"id": 1, "text": "…"}, {"id": 2, "text": "…"}]}
```

客户端 `JSON.parse` + schema 校验(GLM 官方推荐做法);不用于流式渲染路径。

---

## 四、风险与兜底

| 风险 | 表现 | 兜底 |
|---|---|---|
| 模型漏块/并块(分隔符协议) | 输出 `<t>` 数 ≠ 输入 `<s>` 数 | ① 按 id 尽力对齐已产出块;② 缺失块**单块重发**(退化成块级请求);③ 仍失败整批重试;④ 终极降级:全文逐块串行翻译(最慢最稳) |
| 模型输出开场白/解释 | 译文混入"以下是翻译" | 剥离 `<t>` 标签外的一切文本;首块渲染前 trim 常见前缀 |
| JSON 截断/空内容(DeepSeek) | `finish_reason=stop` 但内容为空格;或 `length` 截断 | 检测空内容→按官方建议调 prompt 重试;`length`→减小批重试;JSON 仅作非流式备选路径 |
| 术语未命中 | 译文中术语与库不一致 | 译后程序扫描:命中原文术语的块内做译法替换或标黄提示用户(mdpo-llm 思路);`context window` 类词形变化做轻量词干匹配 |
| md 结构被改 | 代码围栏数/链接数变化,渲染破损 | 译后校验:代码围栏数、URL 集合与原文比对(GenAIScript 的 xor 比对法),不一致则该批重试 |
| Ollama 上下文静默截断 | 长批译文后半"忘原文" | 显式 `options.num_ctx`(≥8192,按模型上限);批预算按端点配置化;检测截断(输出戛然而止且无闭合标签)→减批重试 |
| Ollama 生成慢 | 流式 token 间隔大 | 块级上屏 + 渲染合帧(~50ms);并行度默认 1~2,`limit` 式限流保护本地机器 |
| 中英方向 token 密度差 | 中→英输出膨胀,预算溢出 | 方向化预算系数(英→中 ≈1.0,中→英 ≈1.6 字符系数);`max_tokens` 按批内原文 token × 2 |
| 限流/超时(BYOK 各家 QPS 不同) | 429/timeout | 请求间可配速率(沉浸式翻译 `limit` 同思路)+ 指数退避;批粒度断点续译 |
| 用户中途取消 | 流中断 | 已完成块保留,未完成块标记待译;重开任务从失败批续跑(块级哈希缓存可进一步免重译) |

---

## 五、来源链接

- 沉浸式翻译 prompt 机制(YAML/%% 协议、terms_prompt、流式变量):https://immersivetranslate.com/docs/prompts
- 沉浸式翻译高级配置(maxTextGroupLengthPerRequest / maxTextLengthPerRequest / limit / requestTimeout / streamingSelector):https://immersivetranslate.com/zh-Hans/docs/advanced
- 沉浸式翻译官方 prompt 仓库:https://github.com/immersive-translate/prompts
- Microsoft GenAIScript 持续 Markdown 翻译(mdast 切分、哈希标记、校验与重试):https://microsoft.github.io/genaiscript/blog/continuous-translations
- mdpo-llm(PO 增量翻译、模型后术语强制):https://pypi.org/project/mdpo-llm
- DeepSeek JSON Output 官方指南(json_object、prompt 须含 "json"、空格替换、max_tokens):https://api-docs.deepseek.com/guides/json_mode
- DeepSeek Chat Completions API(response_format):https://api-docs.deepseek.com/api/create-chat-completion
- 智谱 GLM 结构化输出官方文档(仅 json_object、客户端校验建议):https://docs.bigmodel.cn/cn/guide/capabilities/struct-output
- GLM-4.6 模型规格(200K 上下文):https://docs.bigmodel.cn/cn/guide/models/text/glm-4.6 、https://z.ai/blog/glm-4.6
- Ollama Structured Outputs 官方文档(format=schema、temperature 0、OpenAI 兼容):https://docs.ollama.com/capabilities/structured-outputs 、https://ollama.com/blog/structured-outputs
- Ollama 默认上下文 4096 与 num_ctx 调整:https://www.autodidacts.io/increase-ollama-context-length-num-ctx 、https://localllm.in/blog/local-llm-increase-context-length-ollama
- OpenAI Structured Outputs 指南(strict schema、流式需增量解析):https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI 社区:结构化输出流式行为:https://community.openai.com/t/streaming-mode-with-structured-output-in-responses-api/1368545 ;部分 JSON 解析库:https://github.com/st3w4r/openai-partial-stream ;LangChain 流式限制:https://forum.langchain.com/t/how-to-stream-a-json-by-using-a-chat-provider/1638
- 长文分块上下文携带(重叠窗口/摘要前置/术语随批):https://www.pinecone.io/learn/chunking-strategies 、https://help.getzep.com/chunking-large-documents
- 文档团队 LLM 翻译 agent 实践(代码不译、术语规范):https://hostkey.com/blog/161-how-our-documentation-team-built-an-llm-agent-for-automated-translation-from-english-to-other-languages
