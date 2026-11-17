// PROTOTYPE — 一次性原型,勿并入 app/。工单 04:md 结构保真。
// 用 app/node_modules 里的 mdast 解析器,把「现行切块(仿 blocks.rs)」与「提议切块」放在同一组样例上比较:
//   1) 切块后再拼回 / 逐块渲染,结构是否与原文一致(不经模型,只测管线本身)
//   2) 模拟模型常见格式损伤,现行校验 vs 提议的结构签名校验各能抓到几种
//   3) 协议尖括号冲突、纯文本软换行
// 运行:node .scratch/v03-polish/proto-md/roundtrip.mjs  (输出 markdown 报告到 stdout)
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../app/package.json", import.meta.url));
const { fromMarkdown } = await import(require.resolve("mdast-util-from-markdown"));
const { gfm } = await import(require.resolve("micromark-extension-gfm"));
const { gfmFromMarkdown } = await import(require.resolve("mdast-util-gfm"));

const parse = (md) => fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

// ---------------- 样例 ----------------
const CORPUS = {
  "嵌套列表": "Steps:\n\n1. Install the CLI\n   - macOS: `brew install foo`\n   - Linux: see [docs](https://a.dev/linux)\n2. Run `foo init`\n3. Done\n",
  "松散列表": "- First item has a paragraph.\n\n  And a second paragraph.\n\n- Second item.\n",
  "表格": "| Option | Default | Notes |\n|---|:---:|---|\n| `timeout` | 30 | in seconds |\n| `retries` | 3 | |\n",
  "引用嵌套": "> Note: this is important.\n>\n> - point one\n> - point two\n>\n> > nested quote\n",
  "分隔线": "Intro paragraph.\n\n---\n\nAfter the break.\n\n***\n\nEnd.\n",
  "HTML 块": "<details>\n<summary>Click to expand</summary>\n\nHidden text inside details.\n\n</details>\n",
  "脚注与引用链接": "See the spec[^1] and the [guide][g].\n\n[^1]: The official spec, 2024 edition.\n\n[g]: https://guide.dev\n",
  "任务列表": "- [x] Write tests\n- [ ] Update `README.md`\n",
  "尖括号源文": "Close the tag with </t> and open with <s id=\"1\"> in XML examples.\n",
  "编号续接": "3. third\n4. fourth\n\nInterruption.\n\n5. fifth\n",
};
const PLAIN = {
  "诗/地址(单换行)": "Roses are red\nViolets are blue\n\nLine A\nLine B",
  "看似 md 的纯文本": "# not a heading, just a hashtag\n1. not a list either, it's a year: 1. Jan\n> quoted from email",
};

// ---------------- 切块 ----------------
const slice = (md, n) => md.slice(n.position.start.offset, n.position.end.offset);
// 现行:仿 blocks.rs —— 顶层 heading/paragraph/code/blockquote(→p)/table/html(→code);列表按顶层 item 拆;其他节点丢弃
function splitCurrent(md) {
  const out = [];
  for (const n of parse(md).children) {
    if (n.type === "list") for (const it of n.children) out.push({ kind: "list", src: slice(md, it) });
    else if (["heading", "paragraph", "code", "blockquote", "table", "html"].includes(n.type))
      out.push({ kind: n.type === "blockquote" ? "p" : n.type === "html" ? "code" : n.type, src: slice(md, n) });
    else out.push({ kind: "DROPPED:" + n.type, src: slice(md, n), dropped: true });
  }
  return out;
}
// 提议:所有顶层节点都成块;list/blockquote/table 整体为一块(超预算才按 item 拆,但带 group 共渲染);
//      code/html/thematicBreak/definition/footnoteDefinition 直通不译;块间保留原始分隔文本
const BUDGET = 1200;
function splitProposed(md) {
  const tree = parse(md), out = [];
  tree.children.forEach((n, i) => {
    const sep = i === 0 ? "" : md.slice(tree.children[i - 1].position.end.offset, n.position.start.offset);
    const passthrough = ["code", "html", "thematicBreak", "definition", "footnoteDefinition"].includes(n.type);
    if (n.type === "list" && slice(md, n).length > BUDGET) {
      n.children.forEach((it, j) => out.push({ kind: "list", group: i, sep: j === 0 ? sep : md.slice(n.children[j - 1].position.end.offset, it.position.start.offset), src: slice(md, it) }));
    } else out.push({ kind: n.type, sep, src: slice(md, n), translate: !passthrough });
  });
  return out;
}

// ---------------- 结构签名 ----------------
function signature(md) {
  const sig = { headings: [], lists: [], tables: [], code: 0, inlineCode: [], urls: [], quotes: 0, hr: 0, html: 0, footnotes: 0 };
  const walk = (n, depth = 0) => {
    if (n.type === "heading") sig.headings.push(n.depth);
    if (n.type === "list") sig.lists.push(`${n.ordered ? "ol" + (n.start ?? 1) : "ul"}×${n.children.length}@${depth}${n.spread ? "loose" : ""}${n.children.some((c) => c.checked != null) ? "task" : ""}`);
    if (n.type === "table") sig.tables.push(`${n.children[0].children.length}c×${n.children.length}r`);
    if (n.type === "code") sig.code++;
    if (n.type === "inlineCode") sig.inlineCode.push(n.value);
    if (n.type === "link" || n.type === "definition") sig.urls.push(n.url);
    if (n.type === "blockquote") sig.quotes++;
    if (n.type === "thematicBreak") sig.hr++;
    if (n.type === "html") sig.html++;
    if (n.type === "footnoteDefinition") sig.footnotes++;
    (n.children || []).forEach((c) => walk(c, n.type === "list" ? depth + 1 : depth));
  };
  walk(parse(md));
  for (const k of ["inlineCode", "urls"]) sig[k].sort();
  return sig;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------- 1) 管线自身保真(恒等「翻译」) ----------------
const rows1 = [];
for (const [name, md] of Object.entries(CORPUS)) {
  const orig = signature(md);
  const cur = splitCurrent(md);
  // 现行:后端按块存、前端逐块 <Md> 渲染 → 等价于每块独立解析后的结构合并
  const curRender = cur.filter((b) => !b.dropped).map((b) => signature(b.src));
  const merged = curRender.reduce((acc, s) => { for (const k in acc) acc[k] = Array.isArray(acc[k]) ? acc[k].concat(s[k]) : acc[k] + s[k]; return acc; },
    { headings: [], lists: [], tables: [], code: 0, inlineCode: [], urls: [], quotes: 0, hr: 0, html: 0, footnotes: 0 });
  for (const k of ["inlineCode", "urls"]) merged[k].sort();
  const prop = splitProposed(md);
  const reassembled = prop.map((b) => b.sep + b.src).join("");
  const diffs = Object.keys(orig).filter((k) => !same(orig[k], merged[k])).map((k) => `${k}: ${JSON.stringify(orig[k])} → ${JSON.stringify(merged[k])}`);
  rows1.push({ name, curBlocks: cur.map((b) => b.kind).join(","), curOk: diffs.length === 0, diffs, propBlocks: prop.map((b) => b.kind + (b.translate === false ? "(直通)" : "")).join(","), propOk: same(orig, signature(reassembled)) });
}

// ---------------- 2) 模型损伤:现行校验 vs 结构签名 ----------------
// 现行 validate.rs:块数/id、标签外文本、URL 集合、``` 计数。这里只能比 URL 集合与 ``` 计数(块级)。
const curValidate = (src, out) => {
  const urls = (s) => (s.match(/https?:\/\/[^\s)\]]+/g) || []).sort().join();
  const fences = (s) => (s.match(/```/g) || []).length;
  return urls(src) === urls(out) && fences(src) === fences(out);
};
const DAMAGES = [
  ["列表标记丢失(- 变成段落)", "- alpha `a`\n- beta\n", "alpha `a`\nbeta\n"],
  ["有序列表重编号(3. → 1.)", "3. third\n4. fourth\n", "1. third\n2. fourth\n"],
  ["嵌套层级被拍平", "- a\n  - b\n", "- a\n- b\n"],
  ["标题级别改变(## → #)", "## Setup\n", "# Setup\n"],
  ["表格两行被合并", "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n", "| a | b |\n|---|---|\n| 1 3 | 2 4 |\n"],
  ["行内码反引号被去掉", "Run `npm ci` first.\n", "Run npm ci first.\n"],
  ["链接 URL 被改", "See [docs](https://a.dev/x).\n", "See [docs](https://a.dev/y).\n"],
  ["引用 > 丢失", "> quoted\n", "quoted\n"],
  ["任务勾选丢失", "- [x] done\n", "- done\n"],
  ["~~~ 围栏代码块被拆", "~~~\ncode\n~~~\n", "code\n"],
];
const rows2 = DAMAGES.map(([name, src, out]) => ({ name, cur: !curValidate(src, out), prop: !same(signature(src), signature(out)) }));

// ---------------- 3) 协议与纯文本 ----------------
const raw = CORPUS["尖括号源文"];
const esc = (s) => s.replace(/<(\/?)([st])(?=[\s>])/g, "&lt;$1$2");
const unesc = (s) => s.replace(/&lt;(\/?)([st])(?=[\s>])/g, "<$1$2");
const proto = { 原文中协议标签数: (raw.match(/<\/?[st][\s>]/g) || []).length, 转义后: (esc(raw).match(/<\/?[st][\s>]/g) || []).length, 往返一致: unesc(esc(raw)) === raw };

const plainRows = Object.entries(PLAIN).map(([name, txt]) => {
  const cur = parse(txt).children.map((n) => n.type).join(",");
  // 提议归一化:判定为非 md 粘贴时 —— 行首 md 记号转义;段内单换行转硬换行
  const norm = txt.split(/\n{2,}/).map((p) => p.split("\n").map((l) => l.replace(/^(\s*)([#>]|\d+\.|[-*+]\s)/, "$1\\$2")).join("\\\n")).join("\n\n");
  const prop = parse(norm).children.map((n) => n.type + (n.children?.some((c) => c.type === "break") ? "+硬换行" : "")).join(",");
  return { name, cur, prop };
});

// ---------------- 报告 ----------------
const L = [];
L.push("## 1. 管线自身保真(不经模型,恒等翻译)\n");
L.push("| 样例 | 现行切块(仿 blocks.rs) | 现行逐块渲染结构一致? | 结构差异 | 提议切块 | 提议拼回一致? |\n|---|---|---|---|---|---|");
for (const r of rows1) L.push(`| ${r.name} | ${r.curBlocks} | ${r.curOk ? "✓" : "✗"} | ${r.diffs.join("<br>") || "—"} | ${r.propBlocks} | ${r.propOk ? "✓" : "✗"} |`);
L.push(`\n现行 ${rows1.filter((r) => r.curOk).length}/${rows1.length} 一致;提议 ${rows1.filter((r) => r.propOk).length}/${rows1.length} 一致。\n`);
L.push("## 2. 模型格式损伤的检出率\n");
L.push("| 损伤 | 现行校验(URL 集合 + ``` 计数) | 提议结构签名 |\n|---|---|---|");
for (const r of rows2) L.push(`| ${r.name} | ${r.cur ? "✓ 检出" : "✗ 漏过"} | ${r.prop ? "✓ 检出" : "✗ 漏过"} |`);
L.push(`\n现行检出 ${rows2.filter((r) => r.cur).length}/${rows2.length};结构签名检出 ${rows2.filter((r) => r.prop).length}/${rows2.length}。\n`);
L.push("## 3. 协议尖括号与纯文本\n");
L.push(`- 源文含协议标签:${JSON.stringify(proto)}\n`);
L.push("| 纯文本样例 | 现行解析 | 提议归一化后 |\n|---|---|---|");
for (const r of plainRows) L.push(`| ${r.name} | ${r.cur} | ${r.prop} |`);
console.log(L.join("\n"));
