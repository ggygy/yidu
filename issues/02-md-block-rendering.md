# 02: markdown 分块解析与双语渲染方案调研

Type: research
Status: resolved

## Question

markdown 如何解析成"块"(见 CONTEXT.md)并支撑双语对照(可折叠)、分栏(同步滚动)两种交互?调研:解析器选型与解析位置(unified/remark、markdown-it 于前端,pulldown-cmark 于 Rust 侧,取舍?)、段落级原文↔译文的对齐表示、不可译块(代码块/行内 code/链接 URL)的保留策略、长文档的渲染性能(虚拟滚动是否必要)、折叠为纯译文的实现方式。产出:推荐方案 + 备选。

## Answer

推荐:**Rust 侧 pulldown-cmark `into_offset_iter()` 在摄入时切块**(保真原文 md 切片 + 规范化哈希入 SQLite),前端逐块渲染(库随工单 01/05 定)。对齐表示 = 单条块记录内联双语 `{id, kind, src, hash, trans, status}`,按 id 回填,重译用规范化哈希兜底(mdbook-i18n-helpers 教训:不规范化必失配)。代码块/frontmatter 标 `untranslatable` 不进请求;行内 code/URL 先"原样保留+prompt 约束+结构校验",失配率高再上占位符掩码。折叠纯译文/双语对照是纯视图态(块行双 slot + 容器级 CSS 切换);分栏推荐**单滚动容器行对齐网格**(同步由构造保证,与对照视图共享块行组件)。P0 不上 JS 虚拟滚动:块组件 memo + CSS `content-visibility: auto`(Baseline 2024,Safari 18 满足)先行,块数组架构为 TanStack Virtual 留门。备选:全前端 remark 单解析器(若 04 定前端直连 provider)、双容器块锚点同步滚动(若需独立滚动)。

调研全文:[../research/02-md-block-rendering.md](../research/02-md-block-rendering.md)
