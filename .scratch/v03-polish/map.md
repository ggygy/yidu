# Wayfinder Map: 译读 v0.3 体验优化

Label: wayfinder:map

## Destination

一份可直接开工的优化 spec,位于 `.scratch/v03-polish/spec-v0.3.md`:七大痛点(自动方向识别 / md 结构保真与渲染 / 模型配置交互 / 快捷窗唤出可靠性 / 译文可读性与视图自适应 / 流式感知与翻译指标 / **整体视觉设计**)逐项锁定**根因 + 方案 + 验收标准**(含可量化指标:TTFT、识别准确率、md 往返保真率),整体视觉以一套定稿的视觉语言(token + 关键屏视觉稿)为验收基准。用户确认定稿即到达。

**✅ 已到达终点:2026-11-17 用户确认 [spec-v0.3.md](spec-v0.3.md) 定稿。后续工作(按 spec §4 实现)不在本地图范围内。**

## Notes

- 域:Tauri 2 桌面应用 `app/`(Rust `src-tauri/src` + React `src/`),当前版本 v0.2.4;基线 spec 为根 `spec.md`,上一张地图为根 `map.md`(已到终点)。视觉基准:~~v4 `visual/exports-v4/`~~ → **v0.3 改为 macOS 原生方向**(工单 12:`research/12-visual-language.md` + `proto-visual/index.html?variant=C`);后续 06/07/09 原型均按此 token 做。
- **Plan, don't do**:本地图只产出决策,不改 `app/` 代码;原型放 `.scratch/v03-polish/proto-*/`(或复用 `proto/`)。
- **md 标准(用户 2026-11-17 定)**:结构保真(译文可直接复制为合法 md:标题/嵌套列表/表格/引用/hr/代码/链接/行内码一一对应)**且**渲染观感接近 GitHub/Typora,两者都要。
- **整体视觉(用户 2026-11-17 追加)**:用户认为整体视觉仍需优化,纳入本地图范围。先审计「实现 vs v4 视觉稿」差距,再定视觉语言;06/09 等组件级原型须在视觉语言定案后做,以免返工。初步观察(据用户截图,待 12 审计证实):实现为暗色而 v4 稿为亮色、二者已漂移;调试文案外露(「实验开关:[失焦隐藏:关]·热键唤出·自动入库」);输入区堆叠快捷键提示 chip 噪音大;正文衬线粗体 vs 界面无衬线混搭;大量 9.5~11px 低对比灰字;标题栏挤压红绿灯;设置抽屉遮挡主窗底部胶囊;设置页行行同权、缺分组层级;主窗空态整体发暗。
- 每会话 skills:grilling、domain-modeling;按工单类型另见 research、prototype。
- 交流与产物语言:中文。

### 诊断底稿(2026-11-17 读代码所得,spec「根因」节的素材)

**A 类:确定性缺陷 — 无需决策,直接写进 spec「必修清单」,不开工单**

- 快捷窗:无 `CloseRequested → prevent_close + hide`,红灯/⌘W 销毁窗口后 ⌥T 永久失效(`app/src-tauri/src/lib.rs:25-36`);`reregister_hotkey` 在旧键未注册时 `unregister?` 失败 → 无法从 UI 改键(`lib.rs:54`);注册失败只 `eprintln`(`lib.rs:110`);`quick-shown` 监听闭包过期,用旧 direction/input(`app/src/quick/main.tsx:110-123`)。
- 流式:SSE 解析在 usage/finish_reason chunk 提前 return,同 chunk 正文被丢(`sse.rs:49-60`),丢 `</t>` 会触发整套修复梯度多发请求;主窗 `created` 后重新拉取文章 + `lastArticleIdRef` 在 useEffect 里才更新 → 早到的 block/partial 事件被丢弃,短文"一次性出现"(`main.tsx:880-900`);每请求重复读 Keychain(`translate.rs:288`);`Usage` 事件已发出但两窗都未处理。
- md:pulldown-cmark 非 Start/End 事件(`---` 等)被静默丢弃(`blocks.rs:48-97`);temperature=1.0(`providers/openai.rs:22`)。
- 方向:快捷窗改方向不广播 `prefs-changed`,主窗方向陈旧(`quick/main.tsx:275`)。
- 视觉:按钮缺 `whitespace-nowrap`/`flex-none`,窄窗下标签逐字竖排(`quick/main.tsx:280,434-442`、`main.tsx:1167-1175`);只加载 Source Serif 4 的 600 字重,正文渲染成"标题体"(`styles.css:22-27,115-118`)。
- 主窗:⌘W 真关闭主窗后 tray「打开主窗口」失效,应同样改为关闭即隐藏(工单 13 发现)。
- 点词卡:`VocabCard` 计算了 left/top 却未写入 style,卡片不出现在被点单词旁(`main.tsx:104-107`,工单 11 发现)。
- 配置:Ollama `num_ctx` 默认 4096,与旧工单 07 决议 8192 不符(`ollama.rs:23`)。

**B 类:需要决策 — 已开为工单**(见 issues/)。

## Decisions so far

<!-- 一行一个已关闭工单:标题链接 + 一句话结论 -->

- [汇总撰写 spec-v0.3 并定稿](issues/10-write-spec.md): spec 定稿——必修 16 项 + 七大痛点根因/方案/验收 + 接口变更 + 实现顺序 M0 spike → M1 必修+提速 → M2 视觉 → M3 交互 → M4 md → M5 识别 + 量化验收线;**地图终点到达**。
- [语言识别方案调研](issues/02-lang-detect-research.md): 采用前端零依赖改良启发式 v2(先剔除代码/URL/标识符 → 加权脚本占比 → 假名比例 + 日文专用汉字判日中 → 拉丁语按功能词计分、重音封顶),返回 `{lang, conf}`,conf<0.6 照发但显示「?」一键改向;106 样本目标方向准确率 75%→95%、源语言 46%→91%;whatlang/lingua 弃(未实测,均把纯汉字日文判中文,lingua 约 +24MB);残余:无日文专用字的纯汉字日文仍判中文。详见 [调研](research/02-lang-detect.md)。
- [md 结构保真方案](issues/04-md-fidelity.md): 顶层节点全成块不丢弃,列表/引用/表格整体一块(超 1200 字按项拆但 group 合渲染),代码/HTML/hr/脚注/链接定义直通;新增结构签名校验(标题级/列表/表格/行内码/URL…),不一致自动重译一次再标「格式可能有误」;纯文本粘贴自动判定可切换、保留单换行;协议标签转义;temperature 默认 0.3 可覆盖。原型现行 4/10 → 10/10、损伤检出 1/10 → 10/10(不经模型)。详见 [结果](research/04-md-fidelity.md)。
- [快捷窗唤出语义](issues/08-quick-window-summon.md): ⌥T「已聚焦才藏,否则唤到当前桌面前台并聚焦」;仅快捷窗时为无 Dock 的菜单栏应用,主窗/设置打开才显示 Dock;出现在鼠标所在屏、记忆相对位置并夹回;关闭即隐藏;失焦隐藏转正为设置项(默认关、与置顶互斥、唤出 300ms 内不触发);热键冲突发系统通知 + 菜单栏感叹号;改键须含修饰键并当场试注册;剪贴板仅预填新复制内容。
- [翻译指标展示设计](issues/06-metrics-display.md): 进行中显示彩色阶段点(连接/思考/生成)+ 运行计时 + 实时 tok/s,当前块高亮+光标;结束后一行「首字 · 总耗时 · tok ⓘ」,ⓘ/检查器给分段时间条与全量明细;思考显示进度行可点开看尾部;用量页 = 月汇总 + 各模型首字中位数 + 最近 20 次分级着色请求表;`usage_log` 增 TTFT/首块等列。详见 [原型](proto-metrics/index.html)。
- [译文可读性与视图自适应](issues/09-readability-view.md): 快捷窗**自动长高**(宽固定记忆、高随内容到 85% 屏高后滚动,下方不够就上移,手拖则本次暂停自动);有结果后输入折成一行;分段控件 译文/对照/原文,窄宽对照上下排;⌘+/⌘−/⌘0 两窗各自记忆,阅读外观精简为字号+三档密度;md 样式按原型 `.md` 定为 GitHub 级基准。详见 [原型](proto-reading/index.html)。
- [模型配置交互重做](issues/07-provider-config-redo.md): 设置窗「模型」= **服务商列表(连通状态点)+ 详情**,自动保存无保存键、改动即标未测试;测试用表单当前值并分类报错;模型下拉点开即拉取;设为使用中前自动测试、失败不切换,点预设不再立即激活;快捷窗菜单每服务商一行、失败置灰;「＋」与首启空状态 = 预设面板、粘贴密钥即测并拉模型;密钥掩码+更改。详见 [原型](proto-config/index.html)。
- [自动方向的产品规则](issues/03-auto-direction-rules.md): 目标语 = 设置里的「母语(默认中)+ 第二语言(默认英)」——源为母语译第二语言,否则译母语;整篇一个方向;低置信照发,弹出按钮带「?」,纯汉字短文给「可能是日文」一键改向;手改只重译这一次、仍保持自动;低置信 prompt 不写源语言(`?2zh` 编码);两窗共享方向设置并同步。
- [原生观感的 Tauri 实现路径调研](issues/13-native-look-feasibility.md): 可行——材质用 Tauri 内置 `windowEffects`(主窗/设置 `sidebar`、快捷窗 `popover`;2.12.1+ 透明免 `macOSPrivateApi`,配置放 `tauri.macos.conf.json`),body 透明、文档区实底;强调色**不用** CSS `AccentColor`(WKWebView 恒蓝),改 Rust 读 `NSColor.controlAccentColor` 发 `accent-changed`;外观三态(跟随/浅/深)由 Rust `set_theme` 统一;`trafficLightPosition` 对齐 52pt 工具栏;设置独立窗口懒创建 + 关闭即隐藏,自定义菜单须自带「编辑」菜单。建议实现前先做半天 spike 实测四项。详见 [调研](research/13-native-look.md)。
- [整体视觉语言定案](issues/12-visual-language.md): 选 **macOS 原生**(系统材质、SF、统一工具栏+分段控件、系统设置式分组),跟随系统亮暗与强调色,译文无衬线中粗,文章库原生侧栏与检查器均默认收起;设置改独立窗口、底部胶囊取消;token 表最小字号 11、次要文字 ≥4.5:1。详见 [定案](research/12-visual-language.md)、[原型](proto-visual/index.html)。
- [实现与 v4 视觉稿差距审计](issues/11-visual-audit.md): 静态审计(未能实机运行)得 高 14/中 24/低 50;主轴问题 = 调试/实验文案外露、译文粗衬线单字重、字体与标题排版偏离稿、原文与暗色按钮对比度不达标(2.3~2.7:1)、胶囊缺主按钮、新建页压红绿灯、设置抽屉遮挡与过密;另揪出点词卡不跟随单词的功能缺陷;多屏无稿无截图待 01 实机补。详见 [审计](research/11-visual-audit.md)。
- [流式首 token 与延迟根因调研](issues/05-streaming-latency-research.md): 首 token 慢主因疑为默认预设(deepseek/glm-4.5-flash/qwen3)开思考且 `reasoning_content` 被丢 → 按 host 白名单注入关思考参数(400 则去参重试)+ 无法关时单独展示「思考中」;首批 1 块、流式请求 `Accept-Encoding: identity`;`usage_log` 加 TTFT/首块列;**数值全部未实测**(本机外网与 key 缺失),由「试用复现与性能基线」补测;另疑 `deepseek-chat` 已于 2026-07 下线需核实预设。详见 [调研](research/05-streaming-latency.md)。

## Not yet specified

- 快捷窗内历史记录/上一条翻译回看。
- 成本单价的维护方式(手填/内置/拉取)。

## Out of scope

- 旧 spec P1/P2 各项(真·划词、图片 OCR、SRS、区域截图、批量翻译等)——本次只优化已有 P0 体验。
- 新增 provider 类型或非 OpenAI 兼容/非 Ollama 协议。
- [试用复现与性能基线](issues/01-baseline-repro.md)(部分完成后关闭):剩余界面截图、TTFT/首块实测、⌥T 多场景测试属于实现期验收测量,不再阻塞任何决策,并入 spec §6 于 M1 后补测。
