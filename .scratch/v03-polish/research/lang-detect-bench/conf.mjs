// v2 置信度分布 + 首次调用(构建 GB2312/Big5/JIS 字表)耗时
const t0 = performance.now();
const { detectLang } = await import("./heuristic_v2.mjs");
detectLang("東京駅"); // 触发 buildSets
console.log("first kanji call incl. charset build:", (performance.now() - t0).toFixed(1), "ms");
const { samples } = await import("./all.mjs");
const res = samples.map((s) => ({ ...s, r: detectLang(s.text) }));
for (const th of [0.5, 0.6, 0.7]) {
  const lo = res.filter((x) => x.r.conf < th);
  const okHi = res.filter((x) => x.r.conf >= th && x.r.lang === x.lang).length;
  const hi = res.length - lo.length;
  const wrongLo = lo.filter((x) => x.r.lang !== x.lang).length;
  const wrongTotal = res.filter((x) => x.r.lang !== x.lang).length;
  console.log(`th=${th}: below=${lo.length}/${res.length} (wrong among them ${wrongLo}/${wrongTotal} of all wrong); precision above th = ${okHi}/${hi}`);
}
console.log("\nlow-conf (<0.6) items:");
res.filter((x) => x.r.conf < 0.6).forEach((x) => console.log(` ${x.lang}→${x.r.lang} conf=${x.r.conf.toFixed(2)} ${JSON.stringify(x.text.slice(0, 30))}`));
console.log("\nwrong with conf>=0.6:");
res.filter((x) => x.r.conf >= 0.6 && x.r.lang !== x.lang).forEach((x) => console.log(` ${x.lang}→${x.r.lang} conf=${x.r.conf.toFixed(2)} ${JSON.stringify(x.text.slice(0, 30))}`));
