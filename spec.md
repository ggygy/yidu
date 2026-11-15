# spec:译读(暂名)— Markdown 翻译桌面应用

> 状态:**待用户确认定稿**(2026-11-14 草案;定稿即 wayfinder 地图终点)
> 来源:工单 01-13 全部决议 + v3 视觉稿七屏 + 可点击原型验证记录。术语以根目录 `CONTEXT.md` 为准。

## 0. 一句话与目标

本地优先的 macOS 桌面应用:用自带 Key 的 LLM 翻译 markdown 与粘贴文本,以双语形态渲染;快捷浮窗常驻桌面即贴即译;翻译沉淀为两条学习闭环(人的生词本、软件的术语库)。

三个原始痛点对应的解法:① LLM 翻译工具按字收费 → BYOK(DeepSeek/GLM/OpenAI 兼容)+ Ollama 可选;② 纯文本输出难读 → md 渲染 + 三视图双语阅读;③ 没有学习回路 → 点词收藏 + 术语库注入。

## 1. 分期与产品形态

| 期 | 内容 | 一句话 |
|---|---|---|
| **P0 主体** | 快捷翻译浮窗 | 产品心智所在:全局 ⌥T 唤出、pin 常驻、粘贴即译 |
| **P0 次体** | 主窗口(文章库+阅读) | 沉淀与长文阅读;实现排序靠后 |
| P1 | 真·划词、图片粘贴 OCR、内置 SRS 复习、暗色模式 | 暗色变量已备(v3 双主题),其余见 §8 |
| P2 | 区域截图、翻译记忆、关键词提取、Anki/md 导出、批量 | 见 §9 |

## 2. P0 功能清单

### 2.1 快捷翻译浮窗(主体)

- **全局快捷键 ⌥T** 唤出/隐藏(可配置;弃 ⌥Space——与输入法切换冲突实测偶发丢键)。
- **pin 默认开**(常驻置顶);「失焦自动隐藏」为可选开关,默认关,**与 pin 互斥**(开一个自动关另一个)。
- **重启后不自动显示**(禁用 window-state 插件对可见性的恢复;位置/尺寸仍记忆);首次由 tray 或快捷键唤出。
- 菜单栏 **tray**:唤出主窗/快捷窗、退出。
- **粘贴即译**(可关):粘贴自动触发翻译;唤出时自动预填新复制的剪贴板内容(「假划词」,与 P1 真·划词相区别)。
- 译文 **markdown 渲染 + 流式逐块上屏**;「对照」按钮展开原文(P0 补强项,原型已验证)。
- **存入文章库**:一键入库并在主窗打开(自动入库行为的入口演示)。
- **Provider chip 即时切换**(点 chip 轮换/弹出选择,不必进设置)。
- 输入框支持 ⌘V 粘贴文本;图片粘贴占位提示「P1 识别」。

### 2.2 主窗口(次体)

- **沉浸阅读**(视觉基准 v3 G1):无侧栏无工具栏;顶栏(文章库 ⌘K / 文章名 / 设置)+ 底部悬浮胶囊(三视图切换/术语/生词计数/Provider/重译)+ 顶部发丝进度条。
- **三视图**:双语对照(默认)/ 分栏(左原文右译文)/ 纯译文(单块可展开原文)。
- **点词查词**(G1b):点任意英文词 → 查词卡(音标/释义/本文例句/加入生词本),走 §2.4 通道;例句取自所在块,可跳源。
- **术语命中标记**:术语块左竖条 + chip(`hydration → 水合`),被自动替换的术语同样标记、可手改。
- **文章库滑出层 ⌘K**(G2):搜索、扁平列表、置顶、新建入口;底部术语库/生词本入口(两页为简单列表,实现期按 v3 语言设计,不另出稿)。
- **全屏新建翻译 ⌘N**(G3):书写区 + 拖入/导入 .md/.txt + 底部胶囊(字数/方向/导入/翻译 ⌘↩)。
- **设置右滑出层**(S):见 §2.3。
- 快捷窗「存入文章库」事件 → 主窗列表顶上新条目。

### 2.3 Provider 配置与管理

- 预设四件套:**DeepSeek / GLM / OpenAI / Ollama** + 自定义(Base URL + Key + 模型);Base URL 归一化预览。
- **全局唯一 active provider**;首启检测本地 Ollama,有则优先建议。
- Key 只存 **macOS Keychain**(keyring crate),不落 SQLite。
- **1-token 连通测试** + 延迟显示(如 `✓ 412 ms`);思考模式默认关。
- Ollama:模型发现/拉取进度/健康检查全进 P0;**每请求显式 `num_ctx`**(默认 4096 是静默截断源);走原生 `/api/*`(NDJSON)。
- 本地 usage 累计(tokens/请求数)+ 手填单价估算成本;代理环境变量透传。
- Provider 层全在 **Rust 侧**(trait + OpenAiCompatible/Ollama 两实现);不走前端 plugin-http(scope 白名单与 BYOK 冲突)。

### 2.4 单词查词通道(2026-11-14 定案)

- **单词级查词走免费词典接口;段落/句子翻译一律走模型**(取代早期「Provider 顺带生成释义」)。
- 回落链(实测定案):**有道 jsonapi → dictionaryapi.dev → 当前 Provider 兜底(可关)**。Google gtx 国内直连不可达、aidemo.youdao 411 限频且纯 MT——双双剔除。
- 有道要点:无 UA/Referer 校验、130~370ms、30+ 连发零限频;miss 信号 = `isHasSimpleDict:"0"` + 149B 空壳(HTTP 仍 200);必开 gzip(614KB→1.7KB)。
- `dict_cache(word UNIQUE, payload, fetched_at)`:payload 存**解析后归一化 JSON**(1~3KB:schema_version/source/phonetic/senses/examples);正常命中永不过期;`source:"miss"` 负缓存 24h。
- Rust 独立 Client:`connect_timeout(3s)+timeout(8s)+gzip(true)`(防黑洞路由挂 75s)、Semaphore(4) 并发限流 + in-flight 去重;任何网络错误映射为该级 miss 直落下一级;离线时自然落本地 Ollama,缓存离线可用。
- P1 真·划词边界:单词 → 本通道;多词短语/句子 → 模型管线。

## 3. 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 壳 | **Tauri 2**(macOS arm64 优先) | 架构不阻断 Windows/Linux |
| 前端 | **React 19 + react-markdown@10 + remark-gfm** | 组件树可注入交互(点词/术语 chip);备选 Svelte 5+markdown-it 已弃 |
| 切块 | Rust **pulldown-cmark** 字节区间 | 原文切片入库,代码块解析期剔除 |
| 后端/IPC | Rust commands + `tauri::ipc::Channel` 推流 | 查词等非流式走普通 invoke |
| 存储 | **SQLite**(schema 版本化)+ **Keychain** | 九表 + dict_cache,见 §5 |
| 窗口/快捷键 | tauri-plugin-window-state(**禁可见性恢复**)/ global-shortcut / tray | 交互默认值见 §2.1 |
| 网络 | reqwest(Provider + 词典两套独立 Client) | 词典见 §2.4 |

## 4. 翻译管线与协议(已实测)

五段式:**解析 → 组批 → 流式翻译 → 校验修复 → 逐块上屏**。

- **块模型**:`{id, idx, kind, src, hash, trans, status}`;块 = heading/段落/list 项/表格行;代码块 kind=code 直通不译;编辑后按**规范化哈希**再对齐,未变块不重译。
- **批式**:3~10 块/批、约 2000 字符(按字符预算);每批携带文档标题 + 上批末 1~2 段已译文(标注「仅上下文,勿输出」)+ 术语表;`finish_reason=length` → 减半重试。
- **输出协议**:`<s id="n">…</s>` 输入 / `<t id="n">…</t>` 输出(默认;JSON 仅非流式可选开关);流式状态机按 `</t>` 切块,凑齐即上屏,当前块打字机预览。
- **实测记录(2026-11-14,DeepSeek deepseek-chat)**:3 块批与 10 块批均块数/id/URL/术语全对,零标签外文本;首 token ~0.7s、**首块完成 ~0.9s**、整批 ~1.5-1.6s;usage ≈ 466+153 / 524+233 tokens。脚本 `proto/scripts/protocol-test.mjs`。
- **修复梯度**(防御性,未触发):id 对齐补救 → 缺块单发 → 整批重试 → 逐块串行。
- **术语**:system prompt「必须使用」注入 + **译后程序校验自动替换** + chip 标记可手改;轻量词干匹配降误伤。
- **译后校验**:块数/代码围栏数/URL 集合与原文比对。
- **非 md 粘贴输入**:空行切段归一化为 paragraph 块走同一管线(不做两步整理)。
- **方向参数化**:`{{from}}/{{to}}` 全参数化;中→英字符预算 ×1.6;默认 EN→中可切。
- 取消:已完成块保留、未完成标「待译」,批粒度断点续译。

## 5. 数据模型(SQLite,版本化 schema)

九表 + 增补:

| 表 | 要点 |
|---|---|
| articles | 扁平列表+搜索+置顶;**快捷窗翻译自动入库** |
| blocks | 块模型字段;trans_status 含 streaming 支撑断点续译 |
| vocab_entries | 生词按**词元去重**;增 `phonetic`、`source(dict|model|manual)` |
| vocab_examples | 例句取自原文块,每词条累积 ≤5,可跳源 |
| glossary | 术语库全局一张 |
| **dict_cache** | §2.4;归一化 payload + miss 负缓存 |
| review_state | P1 SRS 预留 |
| providers | 配置(不含 key) |
| usage_log | 本地用量统计 |
| app_state | 杂项(视图偏好等) |

Key 只在 Keychain。不留译文历史版本。

## 6. 视觉与交互基准

- **视觉基准 = v3 消费级沉浸式**:`visual/reader-ui-v3.pen` 七屏(G1 沉浸阅读 / G1b 点词卡 / G2 库滑出 / G3 全屏新建 / H+H2 快捷窗亮暗 / S 设置),导出 `visual/exports-v3/`;统一语言:无侧栏无工具栏、底部悬浮胶囊、滑出层、发丝进度条;变量级双主题(暗色为 P1 交付,变量已备)。
- **交互基准 = 可点击原型** `proto/`(已同步 v3,IAB 自动化测试记录见 `proto/README.md`):点词冒泡、快捷键状态位、pin/失焦互斥等 3+ bug 的修复方案随原型沉淀。
- 四个交互默认值定案:重启不自动显示快捷窗 / ⌥T 可配置 / 失焦不隐藏(与 pin 互斥)/ pin 默认开。

## 7. 非目标(Out of scope)

Windows/Linux 正式适配(仅不阻断);云同步/账号/多端/协作;自建或代理免费翻译 API 的服务端(坚持 BYOK/本地);品牌命名、签名公证、自动更新、商店分发;任何应用内付费/订阅。

## 8. P1 路线图

1. **真·划词**(Accessibility 取词 + 剪贴板兜底;权限引导;弹窗生命周期)——实现路径待细化(雾区)。
2. **图片粘贴 OCR**:快捷窗 ⌘V 贴图 → macOS Vision 本地识别 → 识别文字按**非 md 粘贴输入**进管线(零管线改动)。技术定案(工单 12):objc2-vision 0.3.2 **同步 performRequests**(弃 completion handler/block2);剪贴板走**前端 onPaste + Tauri 2 raw body invoke**(clipboard 插件给解码 RGBA,弃);Rust 侧归一化(boundingBox 行序/去断行/>1.5 行高分段);zh-Hans 仅 accurate 档可靠;Windows 预留 Windows.Media.Ocr。
3. **内置 SRS 复习**(SM-2 变体;卡片形态/每日队列/提醒待细化——雾区)。
4. **暗色模式**(变量已备,补系统跟随与快捷窗事件同步)。

## 9. P2 路线图

区域截图遮罩(快捷键框选 OCR)/ 改译文存翻译记忆 / 自动关键词提取 / Anki 导出 / md 导出 / 批量与文件夹翻译。

## 10. 风险与开放问题

| 风险/开放问题 | 应对 |
|---|---|
| 有道 jsonapi 为非官方接口(法律灰度) | 单用户低频 + 本地缓存,流量特征与网页用户一致;robots 未禁 `/jsonapi`;链尾模型兜底保证主接口失效不影响功能;有道智云官方 API 列为未来设置项 |
| ⌥T 可能被其他应用占用 | 注册失败时引导改键(设置页已留位) |
| Ollama 未实机验证 | 本地未安装;按官方 `/api/*` 文档设计,标「用户自备、未验证」 |
| 首启无 provider 的 onboarding | 流程细节在雾区,实现期出引导向导 |
| window-state 恢复可见性的坑 | 已在原型复现,实现期禁可见性恢复 |
| 多显示器/快捷窗位置记忆 | 原型未覆盖多显示器,实现期验证 |
| 词典缓存 schema 演进 | schema_version 懒迁移 |

---

**附:决议索引** — 工单 01-04(调研:前端栈/分块渲染/翻译链路/Provider 层)、05(React+react-markdown 定案;产品形态修正)、06(协议定案+实测附录)、07(Provider UX)、08(数据模型)、09(原型+四默认值)、10(验证环境)、12(OCR 路径)、13(词典实测)。调研报告在 `research/`,原型在 `proto/`,视觉稿在 `visual/`。
