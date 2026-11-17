// 运行:node bench.mjs [--verbose]
const SET = process.argv.includes("--all") ? "./all.mjs" : process.argv.includes("--holdout2") ? "./holdout2.mjs" : process.argv.includes("--holdout") ? "./holdout.mjs" : "./samples.mjs";
const { samples } = await import(SET);
import { detectLang, stripNoise } from "./heuristic.mjs";
import { detectLang as detectLang2 } from "./heuristic_v2.mjs";
import { detectLang as detectLang2s } from "./heuristic_v2_static.mjs";
import { franc } from "./lib/franc-min/index.js";
import { eld as eldXS } from "eld/extrasmall";
import { eld as eldS } from "eld/small";

const SUB = ["zh", "en", "ja", "ko", "fr", "de", "es", "ru"];
eldXS.setLanguageSubset(SUB);
eldS.setLanguageSubset(SUB);
const F3 = { cmn: "zh", eng: "en", jpn: "ja", kor: "ko", fra: "fr", deu: "de", spa: "es", rus: "ru" };
const FONLY = Object.keys(F3);

// app 现行实现(逐字复制自 app/src/languages.ts detectDir)
function detectDirOld(text) {
  const t = text.trim();
  if (!t) return "en2zh";
  if (/[぀-ヿ]/.test(t)) return "ja2zh";
  if (/[가-힯]/.test(t)) return "ko2zh";
  if (/[Ѐ-ӿ]/.test(t)) return "ru2zh";
  const cjk = (t.match(/[一-鿿]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (cjk > 0 && cjk * 2 >= latin) return "zh2en";
  if (/[àâäéèêëîïôùûüçœæ]/i.test(t)) return "fr2zh";
  if (/[äöüß]/i.test(t)) return "de2zh";
  if (/[áíóúñ¿¡]/i.test(t)) return "es2zh";
  return "en2zh";
}
const und = (x) => (x && SUB.includes(x) ? x : "und");

const approaches = {
  "current detectDir": (t) => detectDirOld(t).split("2")[0],
  "improved heuristic": (t) => detectLang(t).lang,
  "improved heuristic v2": (t) => detectLang2(t).lang,
  "improved heuristic v2 (J1-restricted tables)": (t) => detectLang2s(t).lang,
  // v2 + 拉丁无信号时(无功能词/变音符)才询问 eld-S,只在 en/fr/de/es 中取最高分
  "hybrid v2 + eld-S fallback": (t) => {
    const h = detectLang2(t);
    if (!h.why.startsWith("latin:no-signal")) return h.lang;
    const s = eldS.detect(stripNoise(t)).getScores?.() || {};
    return ["en", "fr", "de", "es"].filter((l) => s[l] != null).sort((a, b) => s[b] - s[a])[0] || h.lang;
  },
  "franc-min (only 8, raw)": (t) => und(F3[franc(t, { only: FONLY })]),
  "franc-min (only 8, minLength 1, stripped)": (t) => und(F3[franc(stripNoise(t), { only: FONLY, minLength: 1 })]),
  "eld-XS (subset 8, raw)": (t) => und(eldXS.detect(t).language),
  "eld-XS (subset 8, stripped)": (t) => und(eldXS.detect(stripNoise(t)).language),
  "eld-S (subset 8, stripped)": (t) => und(eldS.detect(stripNoise(t)).language),
  // 混合:启发式定脚本/中日韩俄;拉丁主导时交给 eld-XS(只在 en/fr/de/es 内选)
  "hybrid heuristic+eld-XS": (t) => {
    const h = detectLang(t);
    if (!["en", "fr", "de", "es"].includes(h.lang)) return h.lang;
    const r = eldXS.detect(stripNoise(t));
    const s = r.getScores?.() || {};
    const latinBest = ["en", "fr", "de", "es"].filter((l) => s[l] != null).sort((a, b) => s[b] - s[a])[0];
    return latinBest && r.isReliable() ? latinBest : h.lang;
  },
};

const verbose = process.argv.includes("--verbose");
const cats = [...new Set(samples.map((s) => s.cat))];
const rows = [];
const wrongs = {};
for (const [name, fn] of Object.entries(approaches)) {
  const per = {}; let ok = 0, tgt = 0, undc = 0;
  wrongs[name] = [];
  for (const s of samples) {
    const got = fn(s.text);
    const hit = got === s.lang;
    // 目标语是否正确:zh→en,其余→zh;und 视为 app 会兜底成 en2zh
    const g2 = got === "und" ? "en" : got;
    const tgtOk = (g2 === "zh") === (s.lang === "zh");
    if (got === "und") undc++;
    ok += hit; tgt += tgtOk;
    per[s.cat] ??= [0, 0]; per[s.cat][0] += hit; per[s.cat][1]++;
    if (!hit) wrongs[name].push(`${s.lang}→${got}  ${JSON.stringify(s.text.slice(0, 40))}`);
  }
  // 速度
  const N = 200; const t0 = performance.now();
  for (let i = 0; i < N; i++) for (const s of samples) fn(s.text);
  const us = ((performance.now() - t0) * 1000) / (N * samples.length);
  rows.push({ name, ok, tgt, undc, per, us });
}
const n = samples.length;
console.log(`samples: ${n}  (${cats.map((c) => `${c}=${samples.filter((s) => s.cat === c).length}`).join(", ")})\n`);
console.log(["approach", "lang acc", "target acc", "und", ...cats, "µs/call"].join(" | "));
for (const r of rows)
  console.log([r.name, `${r.ok}/${n} (${((100 * r.ok) / n).toFixed(0)}%)`, `${r.tgt}/${n} (${((100 * r.tgt) / n).toFixed(0)}%)`, r.undc,
    ...cats.map((c) => `${r.per[c][0]}/${r.per[c][1]}`), r.us.toFixed(1)].join(" | "));
console.log("\n--- misses ---");
for (const [k, v] of Object.entries(wrongs)) { console.log(`\n# ${k} (${v.length})`); v.forEach((x) => console.log("  " + x)); }
if (verbose) {
  console.log("\n--- improved heuristic v2 detail ---");
  for (const s of samples) { const r = detectLang2(s.text); console.log(`${s.lang === r.lang ? "OK " : "XX "} ${s.lang}→${r.lang} conf=${r.conf.toFixed(2)} ${r.why} | ${JSON.stringify(s.text.slice(0, 30))}`); }
}
