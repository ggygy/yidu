# 04 · md 结构保真原型结果

> 2026-11-17 · 工单 [04](../issues/04-md-fidelity.md) · 脚本 [proto-md/roundtrip.mjs](../proto-md/roundtrip.mjs)(`node .scratch/v03-polish/proto-md/roundtrip.mjs` 可复跑)
> 方法:用 app 依赖里的 mdast(micromark + GFM)解析;「现行」为仿 `blocks.rs` 规则的 JS 复刻(pulldown-cmark 与 mdast 在边角上可能有差异);**不经模型**,第 1 节测管线本身,第 2 节用人工构造的损伤模拟模型出错。真实模型输出的损伤频率未测(待工单 01 / 实现期)。

## 1. 管线自身保真(不经模型,恒等翻译)

| 样例 | 现行切块(仿 blocks.rs) | 现行逐块渲染结构一致? | 结构差异 | 提议切块 | 提议拼回一致? |
|---|---|---|---|---|---|
| 嵌套列表 | paragraph,list,list,list | ✗ | lists: ["ol1×3@0","ul×2@1"] → ["ol1×1@0","ul×2@1","ol2×1@0","ol3×1@0"] | paragraph,list | ✓ |
| 松散列表 | list,list | ✗ | lists: ["ul×2@0loose"] → ["ul×1@0","ul×1@0"] | list | ✓ |
| 表格 | table | ✓ | — | table | ✓ |
| 引用嵌套 | p | ✓ | — | blockquote | ✓ |
| 分隔线 | paragraph,DROPPED:thematicBreak,paragraph,DROPPED:thematicBreak,paragraph | ✗ | hr: 2 → 0 | paragraph,thematicBreak(直通),paragraph,thematicBreak(直通),paragraph | ✓ |
| HTML 块 | code,paragraph,code | ✓ | — | html(直通),paragraph,html(直通) | ✓ |
| 脚注与引用链接 | paragraph,DROPPED:footnoteDefinition,DROPPED:definition | ✗ | urls: ["https://guide.dev"] → []<br>footnotes: 1 → 0 | paragraph,footnoteDefinition(直通),definition(直通) | ✓ |
| 任务列表 | list,list | ✗ | lists: ["ul×2@0task"] → ["ul×1@0task","ul×1@0task"] | list | ✓ |
| 尖括号源文 | paragraph | ✓ | — | paragraph | ✓ |
| 编号续接 | list,list,paragraph,list | ✗ | lists: ["ol3×2@0","ol5×1@0"] → ["ol3×1@0","ol4×1@0","ol5×1@0"] | list,paragraph,list | ✓ |

现行 4/10 一致;提议 10/10 一致。

## 2. 模型格式损伤的检出率

| 损伤 | 现行校验(URL 集合 + ``` 计数) | 提议结构签名 |
|---|---|---|
| 列表标记丢失(- 变成段落) | ✗ 漏过 | ✓ 检出 |
| 有序列表重编号(3. → 1.) | ✗ 漏过 | ✓ 检出 |
| 嵌套层级被拍平 | ✗ 漏过 | ✓ 检出 |
| 标题级别改变(## → #) | ✗ 漏过 | ✓ 检出 |
| 表格两行被合并 | ✗ 漏过 | ✓ 检出 |
| 行内码反引号被去掉 | ✗ 漏过 | ✓ 检出 |
| 链接 URL 被改 | ✓ 检出 | ✓ 检出 |
| 引用 > 丢失 | ✗ 漏过 | ✓ 检出 |
| 任务勾选丢失 | ✗ 漏过 | ✓ 检出 |
| ~~~ 围栏代码块被拆 | ✗ 漏过 | ✓ 检出 |

现行检出 1/10;结构签名检出 10/10。

## 3. 协议尖括号与纯文本

- 源文含协议标签:{"原文中协议标签数":2,"转义后":0,"往返一致":true}

| 纯文本样例 | 现行解析 | 提议归一化后 |
|---|---|---|
| 诗/地址(单换行) | paragraph,paragraph | paragraph+硬换行,paragraph+硬换行 |
| 看似 md 的纯文本 | heading,list,blockquote | paragraph+硬换行 |
