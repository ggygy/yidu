# 02 调研:markdown 块级解析与双语渲染(对照/分栏)

工单:`issues/02-md-block-rendering.md` · 状态:resolved · 日期:2026-11-12

---

## 结论先行

**推荐方案(组合拳)**:

1. **切块在 Rust 侧,摄入时一次完成**:用 pulldown-cmark 的 `into_offset_iter()`(事件 + 源码字节区间)把文档切成块,每块保存**原文 md 切片(保真,不重构)** + 类型 + 规范化哈希,写入 SQLite。前端拿到的就是块数组,不再做全文切块。
2. **对齐表示 = 单条记录双语内联**:`{id, idx, kind, src, hash, trans, status}` —— 原文与译文是同一条块记录的两个字段,不存在"两个数组事后对齐"的问题。重译/原文变更时用 `hash`(规范化后)兜底再对齐。
3. **不可译块**:代码块/frontmatter/hr/纯 HTML 块标记 `untranslatable`,根本不进翻译请求,渲染直接用 `src`。行内 code 与链接 URL:P0 保留行内 md 原样送翻 + prompt 约束 + 返回后结构校验;备选占位符掩码(工业惯例,Crowdin 同款)。
4. **渲染**:前端逐块解析渲染(具体库随工单 01/05 定:react-markdown(remark)或 markdown-it),块组件 `memo` 化;**P0 不上 JS 虚拟滚动**,先用 CSS `content-visibility: auto` + `contain-intrinsic-size` 跳过屏外渲染,块数组架构保证后期可无痛换 TanStack Virtual。
5. **双语对照/折叠为纯译文**:纯视图态。每个块渲染 source/translation 两个 slot,容器级 CSS 类切换(`display:none` 或 grid 行过渡),数据永远双语存储。
6. **分栏同步滚动**:推荐**单滚动容器 + 行对齐网格**(每块一行,左原文右译文,行高取两者最大)——同步由构造保证、永不漂移,且与双语对照共享同一组件结构。备选:双容器 + 块锚点同步滚动。

**备选方案**:

- **备选 A(全前端单解析器)**:unified/remark 一次解析同时负责切块(mdast `position.start/end.offset` 可切源码)与渲染,React 栈下与 react-markdown 零缝隙。若工单 04 把 provider 调用定在前端、或工单 01 强烈倾向 remark 生态,则此方案反超为首选。代价:切块/规范化逻辑只存在于 JS,Rust 侧持久化依赖前端传完整块数组;LLM 结构化(粘贴翻译)输出的再切块也要在前端做。
- **备选 B(全 Rust 渲染)**:comrak / pulldown-cmark→html 在 Rust 产 HTML 字符串,前端 `innerHTML` 注入。性能最好但交互(点词收藏、折叠、分栏槽位)全要靠事后 DOM 挂钩,组件化差,仅作渲染极端优化时的底牌。comrak 的 `Sourcepos` 只有 1-based 行/列(无字节偏移),切块切源码不如 pulldown-cmark 顺手。
- **备选 C(markdown-it 切块)**:块 token 自带 `map=[起始行,结束行]`,可用但**只有行号**(无列/字节偏移,官方 issue #336/#821 讨论的就是这个限制),需自建行偏移表才能切源码。适合工单 01 选了非 React 栈后的统一方案,不作为切块首选。

**核心理由**:切块位置应与"翻译编排 + SQLite 持久化"同侧(map.md 已定数据全在 Rust 侧 SQLite);pulldown-cmark 是唯一同时给"事件流 + 源码字节区间"的主流 Rust 解析器,切块零信息损失;前端只解析"块内 md 片段",与切块器解耦,两个解析器在块内 inline 细节上的分歧不影响对齐。块粒度、规范化哈希、round-trip 规范化都直接抄 Google mdbook-i18n-helpers 的成熟作业。

---

## 分主题详述

### 1. 解析器选型与解析位置

#### 1.1 三个候选的能力对比(均查证过一手文档)

| 维度 | pulldown-cmark(Rust) | unified/remark(JS) | markdown-it(JS) |
|---|---|---|---|
| 模型 | 拉取式事件流:`Event::{Start(Tag), End(TagEnd), Text, Code, Html, SoftBreak…}` | mdast AST(unist 规范) | token 流(开/闭对 + inline children,非 AST) |
| 源码位置 | **`into_offset_iter()` 给每个事件的字节区间**(`Range<usize>`),可精确切出原文切片 | `node.position.start/end` 含 `line/column/offset`,**offset 是 0-based UTF-16 码元偏移**,可直接切源码 | 块 token 只有 `map=[line_begin, line_end]` 行号;无列/字节偏移(issue #336、#821) |
| 保留原始写法 | 事件是抽象的(`*x*` 与 `_x_` 同为 Emphasis);但**区间指向源码**,切片保真 | AST 同样抽象;有 `mdast-util-to-markdown` 反序列化(会规范化) | `token.content` 保留 inline 原文;`token.markup`/`token.info` 保留围栏写法 |
| GFM/扩展 | 编译期 flag:表格、删除线、tasklist、脚注、frontmatter、定义列表等 | 插件:`remark-gfm`、`remark-frontmatter` 等 | 内置表格/删除线;插件补 |
| 生态角色 | Rust 侧切块/校验;配 `pulldown-cmark-to-cmark` 反序列化 | React 渲染主力(react-markdown 底层即 remark);mdast 工具链 40+ 个(visit/to-markdown/to-hast/gfm…) | 轻量高速;renderer rules 可按 token 类型覆写,适合自定义输出 |

comrak(Rust 备选):完整 AST(`parse_document`),节点带 `Sourcepos`(1-based 行/列,`LineColumn`),有 `format_commonmark` 可把子树序列化回 md。但行列→字节偏移要自己换算,切块不如 pulldown-cmark 的 offset iter 直接;它的优势场景是"AST 变换 + 直接产 HTML"。

#### 1.2 位置怎么定:切块与渲染解耦

把"解析"拆成两件独立的事,选型就不打架了:

- **块切分(translation unit 化)**:需要源码区间,把原文 md 切片原样存库。只做一次,在摄入(打开 md 文件 / 粘贴文本被 LLM 结构化成 md 之后)时完成。
- **块渲染**:前端拿单块 md 片段(自身是合法的 md 子文档)再解析成 DOM。块边界已由 Rust 定死,前端解析器与 Rust 解析器即使对块内 inline 细节有分歧,也**不影响对齐**——这是双解析器并存不漂移的关键前提。

推荐 Rust 切块的论据:
1. map.md 已定"数据全本地 SQLite(Rust 侧)"。块是持久化实体(文章库、重译、翻译记忆 P2),块表 schema 落在 Rust,切块结果天然同侧。
2. 翻译编排(分批、并发、流式回填、失败重试)在哪侧发起,哪侧就需要块列表;provider 调用即使放前端(工单 04 未定),持久化与重译入口仍在 Rust,切块逻辑放 Rust 可被所有入口复用(文件导入、粘贴结构化输出、P2 批量翻译)。
3. pulldown-cmark 的 offset iter 是"保真切片"的最短路径:见 mdbook-i18n-helpers `lib.rs` 的 `extract_events`——`parser.into_offset_iter()` 把事件配上区间,再按行号 `partition_point` 折算(它只要行号,我们要区间本身,更直接)。

备选 A(全前端)成立的条件:工单 04 决定前端直连 provider + 工单 01 选 React/remark。届时切块逻辑用 `unist-util-visit` 遍历根级节点、`position` 偏移切源码,一样保真。**两个方向在 05 grilling 时与 01/04 结论合流即可,本工单倾向 Rust。**

#### 1.3 块粒度怎么定(与 CONTEXT.md "块"对齐)

参考 mdbook-i18n-helpers 的 `group_events`(Translate/Skip 二分)与它的演进史:

- **顶层块 = 翻译单元**:heading、paragraph、code block、table、blockquote、thematic break、html 块、frontmatter;**列表整块为一个块**(渲染与对照的单位),但翻译协议要求模型按 item 逐项返回(协议细节归工单 03/06)。
- mdbook 0.1→0.2 的教训:最初把整个列表 `- foo\n- bar` 作为一条 msgid,后来改成**逐 item 独立消息**。对我们:列表是对照/折叠的显示单元,但**送翻时按 item 编号**,防止 LLM 并项/漏项;对齐表示里 item 是块内子结构,不单独入库(P0)。
- 嵌套结构(list item 内多段、blockquote 内多段):P0 整块送翻(结构随原文走,模型保留结构);备选 mdbook 式"骨架(Skip)+ 文本槽位(Translate)"分解——更精细、更省 token,但回填时要做结构重组,复杂度明显更高,留给 P2 优化。
- 表格:整块送翻,返回后校验行列数不变,失配则降级(整块回退原文/标 failed)。mdbook 甚至逐 cell 提取(`extract_messages` 的 table 测试),那是给人翻文档用的粒度;LLM 阅读翻译整块即可。
- 块切片必须"自包含合法 md":嵌套在 blockquote/list 里的块,切片要么带容器前缀(`> `),要么存 `context` 元数据(所在容器、heading level)供渲染时恢复——这是需要在实现时定死的约定(mdbook 的 `reconstruct_markdown` 专门处理了 padding 的剥与还,可抄)。

### 2. 段落级原文↔译文的对齐表示

推荐数据结构(单记录内联,前端形态;SQLite 字段一一对应):

```ts
interface Block {
  id: string      // `${articleId}:${seq}`,持久化主键
  idx: number     // 文档内顺序(渲染序)
  kind: 'heading'|'paragraph'|'list'|'table'|'code'|'quote'|'hr'|'html'|'frontmatter'
  src: string     // 原文 md 切片(保真,含行内标记)
  srcRange?: [number, number]  // 源文档字节区间(源文件引用/再切分用)
  hash: string    // sha256(normalize(src)) —— 规范化后哈希,见下
  trans: string | null        // 译文 md(未翻译为 null)
  status: 'pending'|'translating'|'streaming'|'done'|'failed'|'untranslatable'
  error?: string
}
interface Article { id: string; blocks: Block[]; srcLang: string; tgtLang: string; … }
```

要点:

- **对齐靠 id,不靠位置推理**。LLM 请求按块编号发出,返回带编号(或结构化 JSON 数组按序),回填按 id 写 `trans`。流式到达时按块粒度更新状态,前端按 id 局部重渲染。
- **重对齐靠规范化哈希**:原文小幅编辑(软换行重排、`*` ↔ `_`、引用链接展开)后重新切块,用 `hash` 匹配旧块搬译文;匹配不上但顺序邻近的标"模糊"(可显示旧译文+提示),这正是 gettext `msgmerge` 的 fuzzy 模型。mdbook 的核心教训:**直接拿原始文本做 key 必失配**——它的 `reconstruct_markdown` 把事件规范化(`*` → `_`、`__` → `**`、`[foo][1]` 展开成 `[foo](url)`、SoftBreak → 空格、剥容器 padding)之后才当 msgid。我们的 `normalize(src)` 应实现同等规范化(或干脆走"事件重构"路线,即存规范化文本为匹配键、保真切片为渲染源,两个字段)。
- **`trim_paragraph` 同款问题**:译文 md 回填/重解析时可能被包上多余段落,mdbook 有专门的 `trim_paragraph` 处理;我们的对应物是"译文 lint"(见风险节)。
- 为什么不用"原文数组 + 译文数组两表对齐":LLM 偶发漏块/并块时两数组错位是灾难;id 内联把错位隔离在单块(failed),不传染。

### 3. 不可译块的保留策略

**块级(CONTEXT.md 已定:代码块是不可译块)**:

- `kind ∈ {code, frontmatter, hr, html}` → `status = 'untranslatable'`,**不进任何翻译请求**,渲染直接用 `src`。fence 的 info string、缩进代码块形态原样保留(offset 切片天然做到)。
- 代码块可将其首行/语言标识作为**上下文**随相邻块的请求发送(帮模型消歧,不要求返回),属工单 03/06 协议范围。
- 反例参考:mdbook-i18n-helpers 会用 syntect 解析代码、只抽出注释和字符串字面量送翻(文档本地化场景)。我们是阅读翻译场景,P0 不翻代码内的注释/字符串;若未来要翻(P2+),它就是现成蓝图。

**行内(inline code、链接/图片 URL)**:

- **P0 推荐:原样保留 + 约束 + 校验**。块的 `src` 原样进 prompt,system/user 指令要求"保留反引号包裹的 code span 与 `[text](url)` 的 URL 与结构,只翻译可读文本"。返回后做机械校验:code span 数量一致、链接 URL 集合一致(mdbook 就是把含链接的整段作为 msgid 交给翻译且 URL 存活,证明该粒度可行;它靠规范化减少变体)。
- **备选:占位符掩码**。送翻前把 code span / URL 替换为 `⟦0⟧`、`⟦1⟧`,译后回填,并校验每个占位符恰好出现一次。这是本地化工业的标准做法(Crowdin 把 HTML/MD 标记与变量转成受保护 tag/placeholder,QA 检查缺失/多余)。优点是模型根本碰不到 URL;缺点是回填逻辑 + 占位符被模型改写的边缘 case。**建议:先上"保留+校验",校验失配率若不可接受再切掩码,两者不互斥(长 URL 用掩码、短 code span 用保留)。**
- 链接 text 可翻、URL 不可翻;图片 alt 可翻(可访问性文本)、src 不可翻;脚注引用标记 `[^1]` 保留(mdbook 的脚注测试展示了对齐做法:正文与脚注定义是两个独立翻译单元)。
- **译文安全**:LLM 输出是半可信输入(可能带回原始 HTML)。mdast 规范 Security 节明确要求转换 HTML 时 sanitize;remark 管线用 `rehype-sanitize`,markdown-it 默认 `html:false` 也是同理。这条必须进 spec。

### 4. 长文档渲染性能(虚拟滚动是否必要)

量级先算清楚:一篇 3000 词英文技术文 ≈ 40–80 个顶层块;一整章书 ≈ 200–500 块。块组件 memo 化之后,几百个块(每块一次单块解析 + 渲染)在现代 webview 里不是问题;真正的开销大头是**代码高亮**(shiki 每块几十毫秒级)与图片。

推荐分层策略:

1. **P0:不做 JS 虚拟滚动**,上两条便宜措施:
   - 块组件 `React.memo`(或等价),块数据不可变更新(流式只动正在翻译的块);
   - 块容器 CSS `content-visibility: auto` + `contain-intrinsic-size: auto 500px`。MDN:屏外子树跳过布局与绘制,盒子保留在布局中;`auto` 关键字记住上次渲染的实际尺寸,减少滚动条跳动;find-in-page、选择、无障碍树不受影响。**Baseline 2024(Safari 18 起)**,macOS WKWebView(Tauri 用系统 webview)满足。还配 `contentvisibilityautostatechange` 事件,可用于懒触发代码高亮。
2. **架构上留门**:渲染层就是"块数组 → 行组件列表",DOM 顺序即数组顺序。一旦实测(整本书粘贴、>2000 块、高亮卡顿)需要虚拟化,接入 TanStack Virtual(无头、支持动态高度,正合适非匀高块列表)即可,不动数据层。注意其已知坑:滚动事件会触发整列表重渲染(GitHub issue #139),行组件必须轻、memo 必须严。
3. content-visibility 与"块锚点同步滚动"(备选 B)兼容:盒子在布局中,`offsetTop` 可测;但屏外块首测高度是 intrinsic 估计值,锚点定位会有小误差,进入视口后自愈——这也是单容器方案 A 更省心的一个理由。

结论:**虚拟滚动不是 P0 必需**;content-visibility 先行 + 块数组架构兜底。

### 5. 双语对照(Interleave)与折叠为纯译文

状态模型:

```ts
viewMode: 'interleave' | 'translation'          // 全局视图态(可再扩展 'source')
expandedBlocks: Set<BlockId>                     // 纯译文模式下单块临时展开原文
```

实现推荐(视图态,不动数据):

- 每个块行渲染**两个 slot(source / translation)**,始终挂 DOM;
- 全局折叠 = 容器上加一个 class,`display: none` 隐藏 `.source`(瞬时切换、零重挂载,点词收藏/选中文本的行为监听不受影响);要动画可用 `grid-template-rows: 0fr → 1fr` 过渡;
- 纯译文模式下单块想看原文:行内展开(写 `expandedBlocks`),沉浸式翻译社区呼声最高的就是这个交互(issue #3724),顺手做了就是亮点;
- **不要**用 `<details>/<summary>` 做全局模式切换:语义是渐进披露、样式与布局控制弱;作为单块展开的备选可接受。

流式翻译期间的形态:interleave 模式下 source 先到(本来就有),trans slot 显示占位/骨架;trans 到达(按块)即填。不需要整篇完成才渲染——这正是块化的红利。

导出纯译文 md(P2)与显示无关,届时按块拼 `trans ?? src` 再序列化(Rust 侧可用 `pulldown-cmark-to-cmark` 或直接拼切片,因为译文本来就是 md)。

### 6. 分栏视图(Split View)与同步滚动

**推荐:单滚动容器 + 行对齐网格。**

- DOM:一个滚动容器,内部每块一个 grid row(`grid-template-columns: 1fr 1fr`),左列渲染 source,右列渲染 translation,行高自动 = max(两者)。同一滚动条 → **同步滚动由构造保证**,对齐永不漂移,流式更新高度变化也不会错位。
- 与 interleave 共享同一"块行"组件:interleave 是 row 内两 slot 纵向堆叠,split 是横向两列——切换视图只是行内布局不同,组件结构零改动。
- 先例:VS Code/Monaco 的并排 diff 正是"对齐行(补空位使对应 hunk 同高)+ 同一滚动语义";DeepL/Google 文档翻译预览也是段落行对齐布局。VS Code 后来加的"锁定滚动"(跨编辑器同步)反过来说明**独立容器同步是难做才要后补的功能**。
- 代价:两栏不能独立滚动;超长块另一侧留白。对"线性阅读"场景可接受,需在 05 与用户确认。
- row 即 containment 单元,`content-visibility: auto` 直接挂在 row 上,两栏一起跳过渲染。

**备选:双滚动容器 + 块锚点同步。**onScroll 时在主动侧找视口顶最近的块 id(缓存各块 offsetTop),把被动侧滚到同块顶部,块内按比例插值;用"互斥锁"(主动滚动期间挂起被动侧 handler)防反馈环。VS Code Sync Scroll 扩展的 NORMAL(顶部元素对齐)/OFFSET(偏移比例)两种模式就是这个思路。适用:确需两栏独立滚动的诉求出现时。

---

## 风险与坑

1. **双端解析器分歧**:块边界由 Rust 独占定夺可消解 99%,但**两端启用的语法扩展集必须写进 spec 对齐**(GFM 表格/删除线/tasklist/脚注、frontmatter、autolink),否则同一文档两端块数不同。pulldown-cmark 的扩展是编译期 flag,remark 走插件,一一对应表要在实现时列清。
2. **不规范化就哈希 = 重译全废**:`*x*` vs `_x_`、软换行重排、`[t][1]` vs `[t](url)` 语义等价但字符串不等。匹配键必须是规范化产物(mdbook `reconstruct_markdown` 的规范化清单可直接抄:emphasis/strong 统一、引用链接展开、SoftBreak→空格、剥容器 padding)。
3. **保真切片 vs 规范化文本要分字段存**:渲染/回显用保真 `src`(用户认识自己的原文),匹配/去重用规范化 `hash`。只存一种会顾此失彼。
4. **块切片自包含性**:嵌套块(blockquote/list 内)的切片是否带 `> `/缩进前缀必须约定死,否则前端单块解析结果与全文解析不一致(mdbook 为此维护了 cmark State 的 padding 传递,别低估这块工作量)。
5. **LLM 译文 lint 必须有**:模型会回寄生内容——未闭合 fence、把两块并成一块、夹带解释文字、擅自加标题层级。每块回填前校验:能被解析、块级结构不越界(kind 不变)、列表项数一致、表格行列一致;失配自动重试一次,再失败标 failed 显示原文。mdbook 的 `trim_paragraph` 处理的"译文多包一层段落"就是同族问题。
6. **XSS/提示注入**:原文与译文都可能是半可信输入(译文里可被注入 raw HTML)。渲染层 sanitize 必须默认开(react-markdown 默认不渲染 raw html;开启 rehype-raw 就必须配 rehype-sanitize;markdown-it 保持 `html:false`)。链接 href 校验协议(`javascript:` 等)。
7. **content-visibility 的滚动条跳动**:intrinsic 尺寸估计不准时,快速滚动会出现高度跳变。用 `contain-intrinsic-size: auto <估算>`(auto 记住实测值)+ 给块一个像样的估算基数(按 kind:heading 短、code 长)。
8. **TanStack Virtual 后期接入的暗坑**:scroll 时全量 re-render(issue #139),行组件要轻;虚拟化后 `Ctrl+F` 浏览器查找失效(视口外不在 DOM)——content-visibility 方案反而保留查找能力,这是 P0 选它的又一理由。
9. **markdown-it 路线的位置短板**:`token.map` 只有行号(issue #336/#821),切块切不出字节精确切片,需自行维护行偏移表并处理行尾换行归属;若 01/05 定了 markdown-it,建议切块仍留 Rust。
10. **性能红线**:整本书级别(>2000 块)的粘贴输入在 P0 就可能出现(用户不讲道理)。翻译侧本来就应分批(工单 03),渲染侧有 content-visibility 兜底;但 spec 里应写明"超大文档"的降级策略(分章折叠渲染/提示)。
11. **流式渲染的半成品块**:逐 token 流式时块内 md 可能暂时非法(半个 fence),按"块完成事件"提交渲染可避免闪烁;或流式期间用纯文本渐进、完成时切 md 渲染。

---

## 来源链接

**解析器规范与文档(一手)**

- mdast 规范(节点类型/内容模型/工具清单):https://github.com/syntax-tree/mdast
- unist 规范(Position/Point:line/column/offset 定义):https://github.com/syntax-tree/unist
- markdown-it 架构文档(token 流/core-block-inline 链/renderer rules):https://github.com/markdown-it/markdown-it/blob/master/docs/architecture.md
- markdown-it Token.map 文档(markdown-it-py 同源 API):https://markdown-it-py.readthedocs.io/en/latest/api/markdown_it.token.html
- markdown-it 源码位置信息限制:issue #336 https://github.com/markdown-it/markdown-it/issues/336 · issue #821 https://github.com/markdown-it/markdown-it/issues/821
- pulldown-cmark 文档(Event/Tag/OffsetIter):https://docs.rs/pulldown-cmark/latest/pulldown_cmark/
- pulldown-cmark-to-cmark(事件→md 反序列化,mdbook-i18n-helpers 依赖):https://crates.io/crates/pulldown-cmark-to-cmark
- comrak 文档(format_commonmark 等):https://docs.rs/comrak/latest/comrak/ · nodes 模块(Sourcepos/LineColumn):https://docs.rs/comrak/latest/comrak/nodes/index.html

**块级翻译先例(一手,重点参考)**

- mdbook-i18n-helpers 仓库:https://github.com/google/mdbook-i18n-helpers
- 其 USAGE(gettext 对齐/fuzzy/列表逐项化演进):https://github.com/google/mdbook-i18n-helpers/blob/main/i18n-helpers/USAGE.md
- 其核心源码 `lib.rs`(extract_events 的 offset_iter 用法、group_events 的 Translate/Skip 分组、reconstruct_markdown 规范化、trim_paragraph):https://github.com/google/mdbook-i18n-helpers/blob/main/i18n-helpers/src/lib.rs

**渲染性能与交互(一手/权威)**

- MDN content-visibility(auto/contain-intrinsic-size/Baseline 2024):https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility
- TanStack Virtual 文档:https://tanstack.com/virtual/latest/docs/introduction · 滚动重渲染 issue:https://github.com/TanStack/virtual/issues/139
- 沉浸式翻译(双语对照/仅显示译文的主流 UX 验证):https://immersivetranslate.com/zh-Hans · 悬停展开原文诉求 issue #3724:https://github.com/immersive-translate/immersive-translate/issues/3724
- VS Code 并排 diff 同步滚动先例:Locked Scrolling 教程 https://neutrondev.com/vs-code-locked-scrolling/ · https://www.lexo.ch/blog/2025/04/toggle-lock-scrolling-across-editors-in-vs-code (及社区实现 Sync Scroll 扩展 NORMAL/OFFSET 模式:https://marketplace.visualstudio.com/items?itemName=dqisme.sync-scroll · split editor 同步 issue:https://github.com/microsoft/vscode/issues/33110)

**占位符保护先例(工业惯例)**

- Crowdin 编辑器文档(tag/placeholder 保护与 QA 校验):https://support.crowdin.com/online-editor
