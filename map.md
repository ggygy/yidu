# Wayfinder Map: Markdown 翻译器

Label: wayfinder:map

## Destination

一份可直接开工的 spec,位于 `.scratch/md-translator/spec.md`:P0(MVP)范围、技术选型、数据模型、翻译协议全部锁定,P1/P2 以路线图形式勾勒。spec 经用户确认定稿,即到达终点。

**✅ 已到达终点:2026-11-14 用户确认定稿。全部工单(01-13)resolved。后续工作(实现)不在本地图范围内。**

## Notes

- 域:Tauri 2 桌面应用(Rust 后端 + web 前端),macOS arm64 优先,架构不阻断 Windows;数据全本地 SQLite,无账号无云。
- 翻译供给:BYOK(通用 OpenAI 兼容:Base URL + Key + 模型)+ Ollama 可选后端;默认英→中,方向可切换。
- 分期已定(2026-11-14 修订):**P0 主体 = 快捷翻译浮窗**(全局快捷键、pin 置顶、菜单栏 tray、粘贴即译、剪贴板预填"假划词"、md 渲染、存入文章库);**P0 次体 = 主窗口**(文章库、双语对照/分栏/纯译文三视图、md 文件翻译、术语库、生词收藏),实现排序靠后;P1 = 真·划词(Accessibility)+ **图片粘贴 OCR**(快捷窗 ⌘V 贴截图,macOS Vision 本地识别,免费离线)+ 内置 SRS 复习 + 暗色模式;P2 = 区域截图遮罩(快捷键框选 OCR)、改译文存翻译记忆、自动关键词提取、Anki 导出、md 导出、批量翻译。
- 视觉稿方向演进:~~v1 暖纸编辑部风~~ → ~~v2 简约现代(仍为三栏后台式,用户否定:太像管理系统不像面向用户的产品)~~ → **v3 消费级沉浸式(用户已确认,当前基准)**:`visual/reader-ui-v3.pen` 七屏(G1 沉浸阅读 / G1b 点词生词卡 / G2 库滑出层 ⌘K / G3 全屏新建翻译 / H 快捷浮窗亮 / H2 快捷浮窗暗 / S 设置右滑出层)+ `visual/exports-v3/*.png`(2026-11-14 补齐 S/G1b、修 H provider 可点 chip 与 G1 底部提示裁剪);v3 统一语言:无侧栏无工具栏、底部悬浮胶囊、滑出层、发丝进度条;**原型已同步 v3(2026-11-14 晚,IAB 自动化测试全过,详见 proto/README.md)**:去侧栏沉浸结构、⌘K 库滑出、⌘N 全屏新建、设置右滑出(含深色外观切换,快捷窗跟随)、快捷窗 ⌥T + Provider chip 轮换 + 悬浮胶囊、点词卡演示词典→模型兜底回落链;修复 mock 定时器不自清导致页面永不静默(IAB 截图全超时)的问题。
- 视觉稿覆盖度审计(2026-11-14,当日闭环):审计发现 4 个 P0 缺稿 + 1 处决策冲突;随后——设置页已补(S 屏,07 全决策落点:预设四件套/1-token 连通测试/Base URL 归一化/模型/思考默认关/方向与术语注入/⌥T 可配置/浮窗三默认/本地用量+手填单价成本)、点词生词卡已补(G1b 交互态:选中词高亮+释义音标+本文例句+加入生词本)、快捷窗 provider 已修回可点 chip(与 07 一致);术语库管理页与生词本列表页按用户路线**文字进 spec 不出稿**;tray 菜单、剪贴板预填、库内置顶同样文字进 spec;主窗暗色/划词/SRS/OCR 属 P1 且雾区已覆盖。
- 查词通道决策(2026-11-14):**单词级查词走免费接口,段落/句子翻译全部走模型**(用户定案;取代 G1b/05 原注「Provider 顺带生成释义,无第二 API」)。推荐回落链:有道词典(非官方)→ dictionaryapi.dev → 当前 Provider 兜底(可关,S 设置页已画「单词查词:免费词典 → 模型兜底」行,G1b 卡片带来源标签);数据模型增补 `dict_cache` 缓存 + `vocab_entries` 音标/来源字段;P1 划词边界:单词→查词通道,短语→模型。选型验证与接入路径 = 工单 13(blocks 11)。
- 术语以根目录 `CONTEXT.md` 为准(文章库/块/术语库/生词本/双语对照/分栏视图/Provider/单词查词 等)。
- 每个会话开工前应查阅的 skills:grilling、domain-modeling;按工单类型另见 research、prototype。
- 交流与产物语言:中文。

## Decisions so far

<!-- 一行一个已关闭工单:标题链接 + 一句话结论 -->

- [Tauri 前端框架与渲染库选型调研](issues/01-tauri-frontend-stack.md): 推荐 React 19 + react-markdown@10(remark 底座、组件树可注入交互、块级模型消解流式弱点);备选 Svelte 5 + markdown-it;详见 [调研](../research/01-tauri-frontend-stack.md)。
- [markdown 分块解析与双语渲染方案调研](issues/02-md-block-rendering.md): 切块放 Rust 侧(pulldown-cmark 字节区间,原文切片入库),前端逐块渲染;块记录内联双语 + 规范化哈希再对齐;分栏用单滚动容器行对齐网格;P0 用 content-visibility 不上虚拟滚动;详见 [调研](../research/02-md-block-rendering.md)。
- [LLM 翻译链路与 prompt 协议调研](issues/03-llm-translation-pipeline.md): 五段式链路(解析→组批 3~10 块/约 2000 字符→流式 SSE→校验修复→逐块上屏);输出用 `<s>/<t>` 分隔符协议而非 JSON(DeepSeek/GLM 无 strict schema 且 JSON 流式解析复杂);术语 system prompt 注入 + 译后程序校验;Ollama 必须显式设 num_ctx;详见 [调研](../research/03-llm-translation-pipeline.md)。
- [Provider 层与 Ollama 集成调研](issues/04-provider-layer.md): Provider 层全在 Rust 侧(trait + OpenAiCompatible/Ollama 两实现),reqwest + tauri::ipc::Channel 推流,key 存 macOS Keychain;不走前端 plugin-http(scope 白名单与 BYOK 冲突);Ollama 走原生 /api/*(NDJSON);详见 [调研](../research/04-provider-layer.md)。
- [前端框架与渲染方案定案](issues/05-frontend-rendering-decision.md): React 19 + react-markdown@10;Rust 侧 pulldown-cmark 切块、前端逐块渲染;块 `{id,idx,kind,src,hash,trans,status}` 内联双语 + 规范化哈希再对齐;**产品形态修正:快捷翻译浮窗进 P0 为主体**(快捷键/pin/tray/粘贴即译/剪贴板预填),主窗口为 P0 次体;视觉稿四屏见 `visual/`。
- [翻译输出协议与 prompt 结构定案](issues/06-translation-protocol.md): `<s id>/<t id>` 分隔符协议为默认(JSON 仅非流式备选);批式 3~10 块/~2000 字符 + 跨批携带标题与上批末段已译文;流式逐块上屏、批粒度断点续译;术语译后**自动替换 + chip 标记**;非 md 输入空行切段归一化;Ollama 显式 num_ctx、中→英 ×1.6 预算、四级修复梯度;prompt 骨架采调研 3.1/3.2;未实测(key 后补,09 原型期验证)。
- [Provider 配置与模型管理 UX 定案](issues/07-provider-config-ux.md): 设置页住主窗 + 快捷窗 chip 即时切换;预设四件套(DeepSeek/GLM/OpenAI/Ollama)+ 自定义;Ollama 发现/拉取进度/健康检查全进 P0(原生 /api/*,显式 num_ctx);全局唯一 active、首启 Ollama 检测优先;1-token 连通测试 + 本地 usage 累计 + 手填单价估成本;思考默认关、Base URL 归一化预览、代理透传。
- [SQLite 数据模型定案](issues/08-data-model.md): 九张表(articles/blocks/vocab_entries/vocab_examples/glossary/review_state 预留/providers/usage_log/app_state),key 只在 Keychain;行为定案:文章库扁平+搜索+置顶、**快捷窗翻译自动入库**、生词按词元去重+例句累积≤5 可跳源、不留译文历史版本、术语库全局一张、trans_status 含 streaming 支撑断点续译、schema 版本化。
- [可点击低保真原型(快捷窗+主窗)](issues/09-reader-ui-prototype.md): 原型建成 `proto/` 并自动化测试修 3 bug(详见 proto/README.md);四个交互默认值定案(2026-11-14):重启**不**自动显示快捷窗(实现时禁 window-state 可见性恢复)、默认快捷键 **⌥T 且可配置**(⌥Space 与输入法冲突偶发丢键)、失焦**不**隐藏(可选项,与 pin 互斥)、**pin 默认开**;快捷窗「显示原文(对照)」按钮作为补强进 P0。
- [图片粘贴 OCR 技术路径调研](issues/12-image-ocr-research.md): objc2-vision 0.3.2 + **同步 performRequests**(弃 completion handler/block2 与 swift-rs/apple-vision);剪贴板走**前端 onPaste + Tauri 2 raw body invoke**(arboard/clipboard 插件返回解码 RGBA 需重编码,弃);OCR 文本视为非 md 粘贴输入**零管线改动**,Rust 侧归一化(boundingBox 行序/去断行/>1.5 行高分段);zh-Hans 仅 accurate 档可靠;Windows 预留 Windows.Media.Ocr 不阻断;详见 [调研](../research/12-image-ocr.md)。
- [免费词典查词通道实测](issues/13-free-dict-lookup.md): 主接口**有道 jsonapi 实测成立**(无 UA/Referer 校验、130~370ms、30+ 连发零限频、gzip 后 ~1.7KB、miss 信号 = isHasSimpleDict"0"+149B 空壳);回落链定案 **有道 → dictionaryapi.dev → Provider 兜底**(Google gtx 国内直连不可达、aidemo.youdao 411 限频且纯 MT,双双剔除);dict_cache 存**解析后归一化 JSON**(1~3KB,弃 614KB 原始返回)+ miss 负缓存 24h;Rust 独立 Client 必设 connect_timeout(3s) 防黑洞挂起,离线自然落 Ollama;详见 [调研](../research/13-free-dict-lookup.md)。
- [验证环境准备](issues/10-api-keys-env.md): 用户提供 DeepSeek key(**仅测试**,存 `proto/.env.local` 不入文档);`deepseek-chat` 流式跑通;Ollama 本地未装 → spec 标「用户自备、未验证」。
- [翻译协议实测](issues/06-translation-protocol.md 附录): `<s>/<t>` 协议在 DeepSeek 实测两组 PASS(3 块批/10 块上限批:块数·id·URL·术语全对、零标签外文本;首 token ~0.7s、首块 ~0.9s、整批 ~1.6s);脚本 `proto/scripts/protocol-test.mjs`;四级修复梯度保留为防御性设计。
- [撰写并定稿 spec](issues/11-write-spec.md): `spec.md` 十节定稿(2026-11-14 用户确认):P0 功能清单(浮窗/主窗/Provider/查词通道)/技术栈/管线含实测数据/数据模型/v3 视觉交互基准/非目标/P1/P2/风险;**地图终点到达**。

## Not yet specified

<!-- 雾:随前沿推进逐步"毕业"为工单 -->

- 首次启动引导(onboarding)流程细节:无 provider 时的配置向导步骤与文案。
- P1 划词翻译的 macOS 实现路径细节:全局快捷键方案、Accessibility 取词 vs 剪贴板兜底、弹窗生命周期与权限引导。
- P1 内置 SRS 细节:算法参数(SM-2 变体)、卡片形态、每日复习队列与提醒。
- P2 各项(区域截图遮罩、翻译记忆、自动关键词提取、Anki 导出、md 导出、批量/文件夹翻译)均待 P0 spec 定稿后再细化。

## Out of scope

- Windows/Linux 正式适配(仅要求架构不阻断)。
- 云同步、账号体系、多端、团队协作。
- 自建或代理免费公共翻译 API 的服务端路线(坚持 BYOK/本地)。
- 品牌命名、签名公证、自动更新、应用商店分发。
- 任何形式的应用内付费/订阅。
