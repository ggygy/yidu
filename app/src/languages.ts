// 语言清单 + 方向编码(与 Rust prompt.rs 编码一一对应)
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
  if (seg.startsWith("~")) return seg.slice(1) || "自定义";
  return LANGS.find((l) => l.code === seg)?.zh ?? seg;
}

export function langShort(seg: string): string {
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

// 自动方向:按文字特征猜源语言。中文原文 → 译英;其余 → 译中(与 Rust 编码一致,发送前已解析成具体方向)
export function detectDir(text: string): string {
  const t = text.trim();
  if (!t) return "en2zh";
  if (/[\u3040-\u30ff]/.test(t)) return "ja2zh";      // 假名 → 日语
  if (/[\uac00-\ud7af]/.test(t)) return "ko2zh";      // 谚文 → 韩语
  if (/[\u0400-\u04ff]/.test(t)) return "ru2zh";      // 西里尔 → 俄语
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (cjk > 0 && cjk * 2 >= latin) return "zh2en";    // 汉字为主 → 译英
  if (/[àâäéèêëîïôùûüçœæ]/i.test(t)) return "fr2zh";
  if (/[äöüß]/i.test(t)) return "de2zh";
  if (/[áíóúñ¿¡]/i.test(t)) return "es2zh";
  return "en2zh";                                     // 默认按英语
}

// 自定义语言名编码净化:去掉会截断 direction 的 "2"
export const encodeCustomName = (n: string) => n.replace(/2/g, "-").trim();
