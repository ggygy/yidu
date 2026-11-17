// 体积测量:原始字节 / gzip 字节(Node zlib level 9)
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const SUB = ["zh", "en", "ja", "ko", "fr", "de", "es", "ru"];
const gz = (s) => gzipSync(Buffer.from(s), { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(0) + " KB";
const show = (name, s) => console.log(`${name} | raw ${kb(Buffer.byteLength(s))} | gzip ${kb(gz(s))}`);
for (const f of ["heuristic.mjs", "lib/franc-min/data.js", "lib/franc-min/index.js", "vendor/franc/packages/franc/data.js",
  "vendor/efficient-language-detector-js/src/ngrams/extrasmall.js", "vendor/efficient-language-detector-js/src/ngrams/small.js",
  "vendor/efficient-language-detector-js/minified/eld.xs.min.js"]) show(f, readFileSync(f, "utf8"));
// eld 8 语子集(按 saveLanguageSubset.dev.js 的过滤逻辑在 Node 里复现)
for (const sz of ["extrasmall", "small"]) {
  const { ngramsData } = await import(`./vendor/efficient-language-detector-js/src/ngrams/${sz}.js`);
  const ids = Object.entries(ngramsData.languages).filter(([, l]) => SUB.includes(l)).map(([i]) => i);
  const ng = {};
  for (const [k, v] of Object.entries(ngramsData.ngrams)) {
    const o = {}; for (const id of ids) if (v[id] != null) o[id] = v[id];
    if (Object.keys(o).length) ng[k] = o;
  }
  show(`eld ${sz} subset-8 (filtered ngrams, JSON)`, JSON.stringify({ languages: Object.fromEntries(ids.map((i) => [i, ngramsData.languages[i]])), ngrams: ng }));
  show(`eld ${sz} full (same JSON serialization, for comparison)`, JSON.stringify({ languages: ngramsData.languages, ngrams: ngramsData.ngrams }));
}
