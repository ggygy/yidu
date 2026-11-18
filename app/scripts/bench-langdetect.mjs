// 自动方向识别回归(v0.3 §2.1 验收):106 条标注样本,目标方向 ≥ 95%、源语言 ≥ 90%
// 运行:npm run bench:lang [-- --verbose]
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const bench = resolve(root, "../.scratch/v03-polish/research/lang-detect-bench");
const dir = mkdtempSync(join(tmpdir(), "yidu-lang-"));
const out = join(dir, "lang.mjs");
await build({ entryPoints: [join(root, "src/languages.ts")], bundle: true, format: "esm", outfile: out, logLevel: "warning" });
const { autoDirection } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const verbose = process.argv.includes("--verbose");
let fail = false;
for (const f of ["samples.mjs", "holdout.mjs", "holdout2.mjs", "all.mjs"]) {
  const { samples } = await import(pathToFileURL(join(bench, f)).href);
  let src = 0, tgt = 0, low = 0;
  const miss = [];
  for (const s of samples) {
    const a = autoDirection(s.text, "zh", "en");
    const want = s.lang === "zh" ? "en" : "zh";
    src += a.src === s.lang; tgt += a.to === want; low += a.low;
    if (a.to !== want || a.src !== s.lang) miss.push(`${s.lang}→${a.src} ${a.dir} conf=${a.conf.toFixed(2)} ${JSON.stringify(s.text.slice(0, 30))}`);
  }
  const n = samples.length, ps = (100 * src) / n, pt = (100 * tgt) / n;
  console.log(`${f.padEnd(13)} n=${n}  源语言 ${ps.toFixed(1)}%  目标方向 ${pt.toFixed(1)}%  低置信 ${low}`);
  if (f === "all.mjs") {
    if (verbose) miss.forEach((m) => console.log("   ", m));
    if (pt < 95 || ps < 90) fail = true;
  }
}
if (fail) { console.error("✗ 未达验收线(目标 ≥ 95%、源 ≥ 90%)"); process.exit(1); }
console.log("✓ 达到验收线");
