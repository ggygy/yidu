// 块 → 渲染单元(v0.3 §2.2.3):大列表拆开的项(同 group)合回一个单元一起渲染;
// 对照视图按单元配对(整列表对整列表)。导出 / 复制按 `sep + 文本` 拼回原结构。
import type { Block } from "./types";

export type Unit = {
  key: string;
  kind: Block["kind"];
  blocks: Block[];
  /** 原文 md(组内按 sep 拼回) */
  src: string;
  /** 译文 md;未译完的项用原文占位,保持列表结构 */
  trans: string;
  translated: boolean;
  streaming: boolean;
  warn: string;
  terms: string;
};

const PASSTHROUGH = new Set(["code", "html", "hr", "footnote", "definition"]);
export const isPassthrough = (k: Block["kind"]) => PASSTHROUGH.has(k);

export function toUnits(blocks: Block[]): Unit[] {
  const out: Unit[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.group != null && last && last.blocks[0].group === b.group) {
      last.blocks.push(b);
      continue;
    }
    out.push({ key: String(b.idx), kind: b.kind, blocks: [b], src: "", trans: "", translated: false, streaming: false, warn: "", terms: "" });
  }
  for (const u of out) {
    const join = (f: (b: Block) => string) => u.blocks.map((b, i) => (i ? b.sep || "\n" : "") + f(b)).join("");
    u.src = join((b) => b.src);
    u.translated = u.blocks.some((b) => !!b.trans);
    u.trans = join((b) => b.trans || b.src);
    u.streaming = u.blocks.some((b) => b.status === "streaming");
    u.warn = u.blocks.map((b) => b.format_warn).filter(Boolean).join(";");
    u.terms = u.blocks.map((b) => b.terms).find(Boolean) ?? "";
  }
  return out;
}

/** 引用式链接定义(`[g]: https://…`)单独成直通块;渲染各块时附上,才能解析 [text][g] */
export function linkDefs(blocks: Block[]): string {
  return blocks.filter((b) => b.kind === "definition").map((b) => b.src).join("\n");
}

/** 整篇拼回 markdown(复制 / 导出):which = 译文(未译用原文)或原文 */
export function toMarkdown(blocks: Block[], which: "trans" | "src" = "trans"): string {
  return blocks
    .map((b, i) => (i ? b.sep || "\n\n" : "") + (which === "trans" ? b.trans || b.src : b.src))
    .join("")
    .trim();
}

/** 纯文本文章的复制形态:去掉行尾硬换行 `\` 与行首转义(`\#` `\>` `\-` `1\.`),
 *  模型还原出的列表 / 标题保持 Markdown 原样 */
export function plainCopy(md: string): string {
  return md
    .replace(/\\\n/g, "\n")
    .replace(/\\$/gm, "")
    .replace(/^(\s*)\\([#>+*-])/gm, "$1$2")
    .replace(/^(\s*)(\d+)\\([.)])/gm, "$1$2$3");
}

/** 复制整篇译文:纯文本文章给干净文本,其余给拼回的 Markdown */
export function copyText(blocks: Block[], articleKind: string | undefined): string {
  const md = toMarkdown(blocks, "trans");
  // 旧版纯文本文章 kind 仍是 paste:按原文里的硬换行标记识别
  const plain = articleKind === "plain" || (articleKind === "paste" && blocks.some((b) => /\\\n/.test(b.src)));
  return plain ? plainCopy(md) : md;
}

// ---------- HTML 块直通渲染(§2.2.2):白名单清洗,webview 里不允许任何脚本 ----------

const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE", "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "SVG", "MATH", "TEMPLATE", "FRAME", "FRAMESET"]);

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild as HTMLElement | null;
  if (!root) return "";
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if (DROP.has(c.tagName)) { c.remove(); continue; }
      for (const a of Array.from(c.attributes)) {
        const n = a.name.toLowerCase();
        const v = a.value.trim().toLowerCase();
        const badUrl = (n === "href" || n === "src" || n === "xlink:href" || n === "action" || n === "formaction") &&
          (v.startsWith("javascript:") || v.startsWith("vbscript:") || (v.startsWith("data:") && !v.startsWith("data:image/")));
        if (n.startsWith("on") || n === "style" || n === "srcdoc" || badUrl) c.removeAttribute(a.name);
      }
      walk(c);
    }
  };
  walk(root);
  return root.innerHTML;
}
