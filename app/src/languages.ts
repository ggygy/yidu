// 语言清单 + 方向编码(与 Rust prompt.rs 编码一一对应)
import { detectLang } from "./langdetect";
// 内置 8 语;自定义语言以 "~显示名" 段编码进 direction,如 "en2~泰语"
// UI 用中文标签,prompt 内由 Rust 端映射英文名

export const LANGS: { code: string; zh: string; short: string }[] = [
  { code: "zh", zh: "简体中文", short: "中" },
  { code: "en", zh: "英语", short: "EN" },
  { code: "ja", zh: "日语", short: "日" },
  { code: "ko", zh: "韩语", short: "韩" },
  { code: "fr", zh: "法语", short: "法" },
  { code: "de", zh: "德语", short: "德" },
  { code: "es", zh: "西班牙语", short: "西" },
  { code: "ru", zh: "俄语", short: "俄" },
];

// direction 按第一个 "2" 切分(与 Rust split_once 一致;自定义名编码时已净化 "2")
export function splitDir(direction: string): [string, string] {
  const i = direction.indexOf("2");
  if (i <= 0 || i >= direction.length - 1) return ["en", "zh"];
  return [direction.slice(0, i), direction.slice(i + 1)];
}

export function makeDir(a: string, b: string): string {
  return `${a}2${b}`;
}

export function langZh(seg: string): string {
  if (seg === "?") return "自动识别";
  if (seg.startsWith("~")) return seg.slice(1) || "自定义";
  return LANGS.find((l) => l.code === seg)?.zh ?? seg;
}

export function langShort(seg: string): string {
  if (seg === "?") return "?";
  if (seg.startsWith("~")) {
    const n = seg.slice(1);
    return [...n].length <= 3 ? n : [...n].slice(0, 2).join("");
  }
  return LANGS.find((l) => l.code === seg)?.short ?? seg;
}

export function dirLabel(direction: string): string {
  if (direction === "auto") return "自动识别";
  const [a, b] = splitDir(direction);
  return `${langZh(a)} → ${langZh(b)}`;
}

export function dirShort(direction: string): string {
  if (direction === "auto") return "自动";
  const [a, b] = splitDir(direction);
  return `${langShort(a)} → ${langShort(b)}`;
}

// ---------- 自动方向(v0.3 §2.1) ----------
// 目标语 = 母语 + 第二语言:源为母语 → 译第二语言,否则 → 译母语;整篇一个方向。
// 低置信(conf < 0.6)照发,但源写成 "?"(编码 ?2{to}),prompt 只写「译成 {to}」。

export const LOW_CONF = 0.6;
// 常见中文虚词 / 高频字:纯汉字短文本里出现任一个,就不再怀疑是日文
const ZH_FUNC = /[的了是在不和有我你他她它这那们吗呢吧啊着过也就都要说没很把被给让从与及或而但]/;

export type AutoDir = {
  dir: string;      // 发送用的具体方向(低置信时为 ?2{to})
  src: string;      // 识别出的源语言代码
  to: string;
  conf: number;
  low: boolean;     // 低置信:弹出按钮显示「?」
  maybeJa: boolean; // 纯汉字短文本:菜单首项「可能是日文」
};

export function targetFor(src: string, native: string, second: string): string {
  return src === native ? second : native;
}

export function autoDirection(text: string, native = "zh", second = "en"): AutoDir {
  const r = detectLang(text);
  let conf = r.conf;
  let maybeJa = false;
  if (r.lang === "zh" && r.why.startsWith("han jaOnly=0")) {
    const t = text; // 用原文判断:夹英文术语的(如「调用 API 失败」)不算纯汉字
    const han = (t.match(/\p{Script=Han}/gu) || []).length;
    const other = (t.match(/\p{L}/gu) || []).length - han;
    if (han > 0 && han <= 8 && other === 0 && !ZH_FUNC.test(t)) { conf = Math.min(conf, 0.5); maybeJa = true; }
  }
  const to = targetFor(r.lang, native, second);
  const low = conf < LOW_CONF;
  return { dir: low ? `?2${to}` : makeDir(r.lang, to), src: r.lang, to, conf, low, maybeJa };
}

/** 方向弹出按钮文案:「自动 · 中 → EN」,低置信加「?」 */
export function autoLabel(a: AutoDir): string {
  return `自动 · ${langShort(a.src)} → ${langShort(a.to)}${a.low ? " ?" : ""}`;
}

// 自定义语言名编码净化:去掉会截断 direction 的 "2"
export const encodeCustomName = (n: string) => n.replace(/2/g, "-").trim();
