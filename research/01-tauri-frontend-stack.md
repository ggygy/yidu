# 调研 01:Tauri 2 前端框架与 markdown 渲染库选型

- 工单:`issues/01-tauri-frontend-stack.md`
- 日期:2026-11-12
- 数据快照:npm registry(版本/发布日期)、bundlephobia(体积)、Tauri 2 官方文档、各库官方 README

---

## 一、结论先行

**推荐:React 19 + react-markdown@10(底座 unified/remark,配 remark-gfm)。**

理由(浓缩):

1. **唯一把"markdown → 框架组件树"打通的主流方案**。react-markdown 的 `components` prop 可把任意标签(`p`/`a`/`code`…)映射为自定义组件,且每个组件能拿到原始 hast 节点。本产品的双语对照(块内原文可折叠)、点词弹卡(P1)、复习高亮,本质都是"把交互嵌进渲染结果内部"——组件级拦截是四条路线里最顺的路。
2. **块级数据模型消解了它的流式弱点**。react-markdown 每次 props 变化会重解析整串 markdown(纯函数式),对"单一长文档流式追加"是劣势;但本产品按 Block(最小翻译单元)组织数据,每块独立渲染、独立更新,单块重解析成本可忽略。**流式的真正瓶颈在 Tauri IPC 层(用官方 Channel API),与前端框架无关。**
3. **安全默认**:官方 README 明确 "safe by default(no dangerouslySetInnerHTML or XSS attacks)",渲染 LLM 输出与外来粘贴文本时省掉整条 HTML 字符串净化链路(markdown-it/marked 路线必须配 DOMPurify)。
4. **长期维护有组织兜底**:remarkjs/unified collective 维护(15.9k stars),底层 micromark/mdast 2026 年仍在发版。react-markdown 本体最近一次发版是 2025-03(v10.1.0),频率低但 API 稳定、组织在持续运营,属"低频发版"而非"弃维护"。

**备选 A:Svelte 5 + markdown-it(+ DOMPurify)。** 体积与启动最优(编译期框架,无虚拟 DOM 运行时),语法最简。代价:Svelte 无第一方/事实标准的运行时 md 渲染器(svelte-markdown 已停更,mdsvex 是编译期 SSG 工具),走 `marked/markdown-it → HTML 字符串 → {@html}` 路线,点词、折叠等交互要靠事件委托和 DOM 后处理。若团队更熟 Svelte,此路线完全可行,推荐度仅次于主选。

**备选 B:Vue 3 + markdown-it(+ DOMPurify)。** Vue 官方文档系统 VitePress 内部就用 markdown-it("VitePress uses markdown-it as the Markdown renderer"),证明该组合是 Vue 生态事实标准,路线成熟。但与备选 A 同样走 `v-html` 字符串路线,且框架运行时体积(47 KB gzip)反而大于 Svelte,相对备选 A 无额外优势。

**淘汰:vanilla JS + marked/markdown-it**(手写 DOM 状态管理,交互密集场景成本失控);**Incremark 等新兴流式渲染器**(解决的是"单一长流追加"问题,与本产品块级模型不匹配,且太新);**svelte-markdown**(2023-12 后停更);**mdsvex**(编译期工具,不是运行时渲染器)。详见第四节。

---

## 二、关键架构前提:块级渲染改变了选型问题

本产品的渲染需求不是"渲染一篇长 markdown",而是(见 CONTEXT.md 术语):

- 文档解析为 **Block**(段落/标题/列表项/代码块…)列表,每块携带原文、译文、翻译状态;
- **双语对照(Interleave)** = 块列表,每块内原文可折叠为纯译文;
- **分栏视图(Split View)** = 左右两个滚动容器,按块索引锚点同步滚动;
- 翻译经 Tauri IPC 流式到达,**逐块上屏**——某块译文完成,只更新那一块。

这带来两个推论:

1. **流式增量是数据模型决定的,不是渲染库决定的。** 任何响应式框架下,更新单块状态就只重渲染单块。react-markdown "整串重解析"的著名弱点(见诸多 AI 聊天流式渲染讨论)在块级模型下不复存在——每块通常只有几百字,重解析在微秒~毫秒级。块内流式期间可先显示纯文本、块完成后再渲染 markdown,进一步规避中途重解析。
2. **真正拉开差距的是"交互注入灵活度"**:能否优雅地在渲染结果内部挂交互(折叠、点词)、能否自定义每个元素的渲染。这正是 react-markdown 的 `components` 设计与 HTML 字符串路线(v-html/{@html})的分水岭。

另注:块切分本身可在前端用 remark(mdast `root.children` 顶层遍历)完成,也可在 Rust 侧用 comrak 完成、前端只管渲染——两种做法都与本次框架选型正交,不影响结论。

---

## 三、分维度对比

### 3.1 双语对照与分栏两种视图的灵活度

| 组合 | 灵活度 | 说明 |
|---|---|---|
| React + react-markdown | ★★★★★ | `components` prop 把标签映射为组件,每个组件拿到原始 hast `node`(官方 README Appendix B);折叠、点词、代码块语法高亮都在组件层做,类型安全 |
| Svelte + markdown-it | ★★★☆ | 视图壳(折叠、两栏滚动)没问题;但 md 内容是 `{@html}` 字符串,内部交互需事件委托 + 手动 DOM 后处理 |
| Vue + markdown-it | ★★★☆ | 同上,`v-html`;VitePress 证明路线成熟,但交互注入方式相同 |
| vanilla + marked/markdown-it | ★★☆ | 视图全手写;无响应式,折叠/点词全靠手工 DOM 操作,代码量与出错面最大 |

分栏同步滚动四者都要自研(两列渲染同源块列表,按块 index 锚点 + 滚动比例混合算法),无现成库,不构成区分项。

### 3.2 翻译流式到达时的增量更新能力

| 组合 | 能力 | 说明 |
|---|---|---|
| React + react-markdown | ★★★★☆ | 块级更新天然增量;react-markdown "builds a virtual DOM, so React only replaces what changed"(官方 README)——但每次仍重解析该块字符串,单块成本可忽略;块流式期间显示纯文本即可 |
| Svelte 5 + markdown-it | ★★★★☆ | Svelte 5 runes 细粒度响应式,单块状态更新只触碰该块 DOM;块完成时 `md.render()` 一次 + `{@html}` |
| Vue 3 + markdown-it | ★★★★☆ | 同量级,响应式系统同样细粒度 |
| vanilla | ★★☆ | 手动 diff/replace,自己保证不整页重排 |

关键事实:流式管线本身走 **Tauri 2 Channel**——官方文档:"The Tauri channel is the recommended mechanism for streaming data such as streamed HTTP responses to the frontend",并明确事件系统"cannot return values and only supports JSON payloads",对有序高吞吐数据建议用 Channel。Channel 与框架无关,四组合等同。

### 3.3 包体积与启动速度

bundlephobia 快照(2026-11-12,min/gzip,未做 tree-shaking):

| 包 | min | gzip | 备注 |
|---|---|---|---|
| svelte 5.57.3 | 27.3 KB | 10.5 KB | 编译期框架,产物只含用到的代码 |
| solid-js 1.9.19 | 22.4 KB | 8.4 KB | 参考 |
| preact 11.2.0 | 11.8 KB | 4.9 KB | 参考 |
| vue 3.5.45 | 124.2 KB | 47.0 KB | runtime+compiler 全量(含 @vue/*) |
| react 19.3.1 | 7.8 KB | 3.0 KB | 仅 react 包 |
| react-dom 19.3.1 | (3.9) | (1.4) | **bundlephobia 对 React 19 只测到入口 stub,失真**;业界普遍引用的 react+react-dom 生产体积为 ~40–50 KB gzip 量级(估算) |
| react-markdown 10.1.0 | 111.0 KB | 33.3 KB | 含 unified 全家桶(bp 不 treeshake,实际更小) |
| markdown-it 15.0.3 | 95.9 KB | 39.8 KB | 含 6 个运行时依赖,同样未 treeshake |
| marked 18.2.0 | 48.2 KB | 14.5 KB | 零依赖 |
| dompurify 3.4.17 | 28.5 KB | 11.2 KB | markdown-it/marked 路线必需 |

排序:Svelte < Vue < React(框架本体);渲染库三者(markdown-it / react-markdown / marked+dompurify)最终 gzip 都在 25–40 KB 区间,互不悬殊。

但本产品是 **Tauri 桌面应用**:前端资源从本地 bundle 加载,无网络下载,首屏瓶颈是 WebView 进程初始化而非 JS 体积。JS 解析差异(几十 KB gzip)对启动速度的影响在 macOS WKWebView 上可忽略。**此维度权重应调低,不构成决策主因**——除非未来要做大量重文档(千块级)场景,Svelte 的细粒度更新才显现优势。

### 3.4 Tauri 2 兼容性

- Tauri 官方:"Tauri is frontend agnostic and supports most frontend frameworks out of the box";JS 侧推荐 Vite;明确不支持 SSR(本产品纯 SPA/本地资产,无冲突)。
- create-tauri-app 官方模板即含:vanilla、Vue、Svelte、React、Solid、Angular、Preact(TS/JS 双版本)。
- 四组合全部一等公民,无已知兼容性差异。macOS 上统一走系统 WKWebView(WebKit 内核),四框架均无 WebKit 特有问题;`@tauri-apps/api` 与框架无关。
- **结论:此维度无区分度。**

### 3.5 长期维护

npm registry 快照(2026-11-12):

| 包 | 最新版 | 发布日期 | 判断 |
|---|---|---|---|
| marked | 18.2.0 | 2026-11-09 | 非常活跃 |
| markdown-it | 15.0.3 | 2026-10-16 | 活跃(2026 年出了 v15) |
| micromark | 4.0.3 | 2026-09-26 | 活跃(unified 底座) |
| mdast-util-from-markdown | 2.1.0 | 2026-10-03 | 活跃 |
| dompurify | 3.4.17 | 2026-10-12 | 活跃 |
| vue | 3.5.45 | 2026-11-05 | 活跃 |
| react | 19.3.1 | 2026-10-14 | 活跃 |
| svelte | 5.57.3 | 2026-10-26 | 活跃 |
| mdsvex | 0.12.8 | 2026-07-19 | 缓慢维护(SSG 工具) |
| **react-markdown** | **10.1.0** | **2025-03-07** | 低频但组织在(unified collective);底层 remark 栈 2026 仍发版 |
| remark / unified / remark-parse | 15.0.1 / 11.0.5 / 11.0.0 | 2023–2024 | API 冻结期,micromark 层持续动 |
| svelte-markdown | 0.4.1 | 2023-12-25 | **停更** |

- React 路线:react-markdown 由 remarkjs 组织维护(15.9k stars),风险点是发版频率低;但 unified 生态(插件、AST 工具)极广,即便 react-markdown 停摆,`remark → mdast → hast → 自渲染`的退路清晰(`remark-react`、`hast-util-to-jsx-runtime` 均在)。
- markdown-it:持续活跃,架构稳定(tokens + rules),社区插件多;VitePress 背书。
- marked:发版最勤,但无统一 AST 规范体系,扩展面窄于 remark。
- 框架本体:React/Vue/Svelte 三者 2026 年都在高频发版,无维护风险。

---

## 四、淘汰项与原因

| 候选 | 判定 | 原因 |
|---|---|---|
| **vanilla + marked/markdown-it** | 淘汰 | 省下的框架体积(桌面场景无意义)换来手写:块状态管理、折叠动画、点词弹卡、复习 UI、流式局部更新全部手工 DOM;项目交互密度(两视图 + 弹卡 + 间隔重复)远超 vanilla 的合理适用面 |
| **Incremark 等 2025 新兴流式渲染器** | 淘汰 | 优化目标是"单一 markdown 长流增量追加、免重复解析"(自称 2–10x),与块级翻译模型不匹配(我们不需要长流解析);项目过新,长期维护未经验证 |
| **svelte-markdown** | 淘汰 | 2023-12 后停更;且无组件映射能力 |
| **mdsvex** | 不适用 | 编译期 SSG/预处理工具(把 .svx 编译为 Svelte 组件),不是运行时渲染器,无法渲染动态到达的译文 |
| **marked 作为主渲染库** | 降级为备注 | 库本身维护最好、零依赖最轻,但输出即 HTML 字符串、lexer token 模型弱于 mdast/hast,没有组件化路径;若选 Svelte/Vue 路线,markdown-it 因 VitePress 背书与插件体系优先于 marked |
| **Solid / Preact** | 不纳入 | 不在工单四候选内;顺带核查:均有一等 Tauri 模板、体积小,但 md 渲染生态接近零(Solid 无成熟渲染库,Preact 靠 React 兼容层有坑),维护风险高 |
| **rehype-raw(渲染原文内嵌 HTML)** | 慎用 | react-markdown 官方注明开启 raw HTML 会增加 "±60kb minzipped" 且引入信任问题;本产品原文多为标准 md,建议默认关闭,确有需求再评估 |

---

## 五、落地要点(给实现工单的输入)

1. 解析一次、渲染多次:原文在前端用 remark 解析为 mdast,按 `root.children` 顶层切 Block(代码块为不可译块);译文块直接是 md 片段。
2. 流式管线:Rust 侧 `tauri::ipc::Channel` 推送块级事件(block_id + 增量文本 + 完成标记),前端 store 按块更新。
3. 点词弹卡:React 路线在 `components.p` 内做文本节点切分;任何路线都可退化为容器级事件委托(读 selection),后者实现最简,建议 P1 先用委托。
4. 双语对照折叠 = 块组件内部 state;分栏同步滚动 = 两列块列表 + index 锚点映射,纯手写 ~100 行,与选型无关。
5. 语法高亮:代码块为不可译块,React 路线用 `components.code` 接 Shiki(桌面场景可接受其体积)。
6. GFM(表格/任务列表/删除线)在技术文档翻译中常见,建议默认启用 remark-gfm。

---

## 六、来源

- Tauri 2 前端立场与 Vite 推荐、不支持 SSR:https://v2.tauri.app/start/frontend/
- create-tauri-app 官方模板清单:https://v2.tauri.app/start/create-project/
- Tauri 2 Channel 流式机制与事件系统局限:https://v2.tauri.app/develop/calling-rust/
- react-markdown README(safe by default、components、virtual DOM、rehype-raw 代价、架构图):https://github.com/remarkjs/react-markdown
- VitePress 使用 markdown-it:https://vitepress.dev/guide/markdown
- markdown-it 默认配置(html:false 等):https://markdown-it.github.io/markdown-it/
- 版本/发布日期:npm registry(https://registry.npmjs.org/<pkg>,2026-11-12 查询:react-markdown、markdown-it、marked、remark、remark-parse、unified、micromark、mdast-util-from-markdown、dompurify、react、vue、svelte、solid-js、preact、mdsvex、svelte-markdown)
- 体积:bundlephobia API(https://bundlephobia.com/api/size?package=<pkg@ver>,2026-11-12;注:react-dom@19 仅测到入口 stub,已标注)
- 流式渲染讨论背景(secondary,佐证 react-markdown 重解析特性):https://www.reddit.com/r/reactjs/comments/1w3ajvw/i_built_a_streaming_markdown_renderer_for_react 、https://dev.to/kingshuaishuai/eliminate-redundant-markdown-parsing-typically-2-10x-faster-ai-streaming-4k94 、https://www.contentful.com/blog/react-markdown
