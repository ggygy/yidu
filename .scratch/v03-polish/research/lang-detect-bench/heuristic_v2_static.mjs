// v2-static:与 v2 相同,但字表限定在 JIS 第一水准并预计算为静态集合(不依赖运行时 TextDecoder)。
// 原注释:在 v1 基础上把"日本专用汉字"限定为 JIS X 0208 第一水准常用汉字(看过留出集 1 后修改)
// 返回 { lang, conf, why }。lang ∈ zh en ja ko fr de es ru

// ---------- 1. 去噪:代码 / URL / 路径 / 标识符 ----------
export function stripNoise(text) {
  let t = text;
  t = t.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/~~~[\s\S]*?(?:~~~|$)/g, " "); // 围栏代码块
  t = t.replace(/`[^`\n]*`/g, " ");                                                 // 行内代码
  t = t.replace(/<\/?[A-Za-z][^>]*>/g, " ");                                         // HTML 标签
  t = t.replace(/\]\([^)]*\)/g, "] ");                                               // md 链接目标
  t = t.replace(/\b(?:https?|ftp|file):\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " "); // URL
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, " ");                                   // email
  t = t.replace(/@[\w-]+\/[\w.-]+/g, " ");                                           // @scope/pkg
  t = t.replace(/(?:^|(?<=\s))(?:[.~]{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\/?/g, " ");       // 路径
  t = t.replace(/(?:^|(?<=\s))--?[A-Za-z][\w-]*/g, " ");                            // CLI flag
  t = t.replace(/#\d+/g, " ");
  // 标识符:camelCase / snake_case / 含数字 / a.b / a::b / f() / T<U> / 全大写缩写
  t = t.replace(/[A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*(?:\([^)\n]*\))?(?:<[^>\s]*>)?/g, (m) => {
    if (/[_$]/.test(m) || /[a-z][A-Z]/.test(m) || /\d/.test(m) || /\.|::|->|\(|</.test(m)) return " ";
    if (/^[A-Z]{2,6}s?$/.test(m)) return " "; // API / URL / JSON / PRs
    return m;
  });
  return t;
}

// ---------- 2. 汉字归属表:GB2312(简)/ Big5(繁)运行时用 TextDecoder 构建 ----------
let GB = null, B5 = null, JIS1 = null;
function buildSets() {
  const han = /\p{Script=Han}/u;
  GB = new Set(); B5 = new Set(); JIS1 = new Set();
  const sj = new TextDecoder("shift_jis"); // JIS X 0208 第一水准 = SJIS 0x889F..0x9872
  for (let h = 0x88; h <= 0x98; h++) for (let l = 0x40; l <= 0xfc; l++) {
    if (l === 0x7f || (h === 0x88 && l < 0x9f) || (h === 0x98 && l > 0x72)) continue;
    const c = sj.decode(new Uint8Array([h, l])); if (c.length === 1 && han.test(c)) JIS1.add(c);
  }
  const gb = new TextDecoder("gb2312");
  for (let h = 0xb0; h <= 0xf7; h++) for (let l = 0xa1; l <= 0xfe; l++) {
    const c = gb.decode(new Uint8Array([h, l])); if (c.length === 1 && han.test(c)) GB.add(c);
  }
  const b5 = new TextDecoder("big5");
  for (let h = 0xa4; h <= 0xf9; h++) for (const [a, b] of [[0x40, 0x7e], [0xa1, 0xfe]]) for (let l = a; l <= b; l++) {
    const c = b5.decode(new Uint8Array([h, l])); if (c.length === 1 && han.test(c)) B5.add(c);
  }
}

// ---------- 3. 拉丁语种:功能词 + 变音符 ----------
const STOP = {
  en: "the a an and or of to in on at for with is are was were be been it this that you your we they i he she have has had not but from by as will can do does my me our its if so".split(" "),
  fr: "le la les un une des du de et est sont ce cette il elle nous vous ils pas pour dans sur avec que qui au aux en ne se mais très".split(" "),
  de: "der die das und ist sind ein eine einen nicht mit für auf den dem des zu von im ich sie wir es auch sehr gut durch oder bitte".split(" "),
  es: "el la los las un una y es son de del que en por para con no se mi su está muy pero lo al como".split(" "),
};
const MARK = {
  de: [[/ß/g, 3], [/[äöü]/gi, 1.5]],
  es: [[/[ñ¿¡]/gi, 3], [/[áíóú]/gi, 1.5]],
  fr: [[/[çœæ]/gi, 2], [/[èêàâîïôûùë]/gi, 1.5], [/é/gi, 0.75]],
  en: [],
};
function latinLang(t) {
  const words = (t.toLowerCase().match(/\p{L}+/gu) || []);
  const score = { en: 0, fr: 0, de: 0, es: 0 };
  for (const w of words) for (const l in STOP) if (STOP[l].includes(w)) score[l] += 2;
  for (const l in MARK) for (const [re, wt] of MARK[l]) score[l] += Math.min(3, (t.match(re) || []).length * wt);
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [top, s1] = ranked[0], s2 = ranked[1][1];
  if (s1 === 0) return { lang: "en", conf: 0.4, why: "latin:no-signal→en" };
  return { lang: top, conf: Math.min(1, 0.5 + 0.5 * (s1 - s2) / s1), why: `latin:${JSON.stringify(score)}` };
}

// ---------- 4. 主判定 ----------
const cnt = (t, re) => (t.match(re) || []).length;
export function detectLang(text) {
  const raw = text.trim();
  if (!raw) return { lang: "en", conf: 0, why: "empty" };
  let t = stripNoise(raw);
  if (!/\p{L}/u.test(t)) t = raw.replace(/```[\s\S]*?(?:```|$)/g, " "); // 纯代码:退回原文
  const han = cnt(t, /\p{Script=Han}/gu);
  const hira = cnt(t, /\p{Script=Hiragana}/gu);
  const kata = cnt(t, /[\p{Script=Katakana}ー]/gu);
  const hangul = cnt(t, /\p{Script=Hangul}/gu);
  const cyr = cnt(t, /\p{Script=Cyrillic}/gu);
  const latin = cnt(t, /\p{Script=Latin}/gu);
  const W = { cj: 2.5 * (han + hira + kata), ko: 2.5 * hangul, ru: cyr, latin };
  const total = W.cj + W.ko + W.ru + W.latin;
  if (total === 0) return { lang: "en", conf: 0, why: "no-letters" };
  const [dom, dw] = Object.entries(W).sort((a, b) => b[1] - a[1])[0];
  let share = dw / total;
  const letters = han + hira + kata + hangul + cyr + latin;
  const shortPen = letters < 4 ? 0.8 : 1;
  if (dom === "ko") return { lang: "ko", conf: share * shortPen, why: "hangul" };
  if (dom === "ru") return { lang: "ru", conf: share * (cyr < 6 ? 0.8 : 1), why: "cyrillic" };
  if (dom === "latin") {
    const r = latinLang(t);
    return { lang: r.lang, conf: share * r.conf * (latin < 10 ? 0.7 : 1), why: r.why };
  }
  // dom === cj:先看假名(引号内的假名不算,防「おもてなし」类引用)
  const unq = t.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g, " ");
  const base = /\p{L}/u.test(unq) ? unq : t;
  const h2 = cnt(base, /\p{Script=Han}/gu), hi2 = cnt(base, /\p{Script=Hiragana}/gu), ka2 = cnt(base, /[\p{Script=Katakana}ー]/gu);
  const kanaRatio = (hi2 + ka2) / Math.max(1, h2 + hi2 + ka2);
  if (hi2 + ka2 > 0) {
    if (h2 === 0) return { lang: "ja", conf: share * shortPen, why: "kana-only" };
    if (hi2 >= 1 && kanaRatio >= 0.1) return { lang: "ja", conf: share * Math.min(1, 0.6 + kanaRatio), why: `kana ${kanaRatio.toFixed(2)}` };
    if (ka2 > 0 && kanaRatio >= 0.5) return { lang: "ja", conf: share * 0.7, why: "katakana-heavy" };
  }
  // 纯汉字:日本新字体/国字(非 GB2312 且非 Big5)或 简体专属+繁体专属混用 → 日文
  if (!GB) buildSets();
  let jaOnly = 0, simpOnly = 0, tradOnly = 0;
  for (const c of base.match(/\p{Script=Han}/gu) || []) {
    const g = GB.has(c), b = B5.has(c);
    if (!JIS1.has(c)) continue;
    if (!g && !b) jaOnly++; else if (g && !b) simpOnly++; else if (!g && b) tradOnly++;
  }
  if (jaOnly >= 2 || (jaOnly >= 1 && jaOnly / Math.max(1, h2) >= 0.15))
    return { lang: "ja", conf: share * 0.75, why: `kanji jaOnly=${jaOnly}` };
  if (simpOnly >= 1 && tradOnly >= 1)
    return { lang: "ja", conf: share * 0.6, why: `kanji simp+trad mix ${simpOnly}/${tradOnly}` };
  return { lang: "zh", conf: share * shortPen * (kanaRatio > 0 ? 0.7 : 1), why: `han jaOnly=${jaOnly} simp=${simpOnly} trad=${tradOnly}` };
}

export const dirOf = (lang) => (lang === "zh" ? "zh2en" : `${lang}2zh`);
