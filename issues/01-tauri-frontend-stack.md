# 01: Tauri 前端框架与渲染库选型调研

Type: research
Status: resolved

## Question

Tauri 2 之下,前端框架与 markdown 渲染库如何选?评估 React / Svelte / Vue / vanilla 组合各自的 md 渲染生态(react-markdown、markdown-it、unified/remark 等),维度:双语对照与分栏两种视图的灵活度、翻译流式到达时的增量更新能力、包体积与启动速度、Tauri 2 兼容性、长期维护。产出:带理由的推荐 + 备选,以及被淘汰项的淘汰原因。

## Answer

- 推荐:React 19 + react-markdown@10(unified/remark 底座,配 remark-gfm)。唯一打通"md → 组件树"的主流方案:components prop 支持块内折叠、点词弹卡等交互注入;safe by default 免 DOMPurify 链路;remarkjs 组织长期维护。
- 块级数据模型消解 react-markdown 流式重解析弱点:每 Block 独立渲染/更新,流式真正管线在 Tauri 2 Channel(官方推荐流式机制),与框架无关。
- 备选 A:Svelte 5 + markdown-it + DOMPurify(体积/启动最优,代价是 HTML 字符串 + 事件委托);备选 B:Vue 3 + markdown-it(VitePress 背书,路线成熟,相对 A 无额外优势)。
- 淘汰:vanilla(交互密集场景手工 DOM 成本失控)、Incremark 等新流式渲染器(与块级模型不匹配、太新)、svelte-markdown(停更)、mdsvex(编译期工具非运行时);marked 降级为备注。
- Tauri 2 对四框架均为一等公民(frontend agnostic,create-tauri-app 官方模板齐全),兼容性无区分度;桌面本地资产场景下体积差异不构成主因。
- 完整调研(分维度对比表、npm/bundlephobia 数据快照、落地要点、来源):../research/01-tauri-frontend-stack.md
