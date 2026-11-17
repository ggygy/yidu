// 05 延迟基准:批大小 1/3/10 × thinking on/off × Accept-Encoding gzip/identity
// 用法:node bench.mjs [runs=3]   key 从环境变量 DEEPSEEK_API_KEY 或 proto/.env.local 读取,绝不打印
// 输出:每次请求的 headers / 首字节 / 首 reasoning / 首 content / 首块(</t>) / 结束 毫秒 + tok/s
import { readFileSync, existsSync } from "node:fs";

const envPath = new URL("../../../../proto/.env.local", import.meta.url);
const fileEnv = existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, "utf8").split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))
  : {};
const KEY = process.env.DEEPSEEK_API_KEY || fileEnv.DEEPSEEK_API_KEY;
const BASE = (process.env.DEEPSEEK_BASE_URL || fileEnv.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.MODEL || "deepseek-flash";
if (!KEY) { console.error("缺少 DEEPSEEK_API_KEY(环境变量或 proto/.env.local)"); process.exit(1); }

const PARA = "Tauri is a framework for building fast, lightweight desktop applications with a Rust backend and a web frontend. Unlike Electron, it does not bundle a full Chromium runtime; instead it relies on the platform's native webview, which keeps bundles small.";
const SYSTEM = "你是专业英译中翻译。输入为 <s id=\"N\">…</s>,对每个片段输出 <t id=\"N\">…</t>,只输出译文。";
const user = (n) => `请翻译以下 ${n} 个片段:\n\n` + Array.from({ length: n }, (_, i) => `<s id="${i + 1}">${PARA}</s>`).join("\n");

async function once(n, thinking, encoding) {
  const body = { model: MODEL, stream: true, temperature: 1.0, stream_options: { include_usage: true },
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user(n) }] };
  if (thinking !== "omit") body.thinking = { type: thinking };
  const t0 = performance.now(); const r = { n, thinking, encoding };
  const res = await fetch(`${BASE}/chat/completions`, { method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Accept-Encoding": encoding },
    body: JSON.stringify(body) });
  r.headers = performance.now() - t0; r.status = res.status; r.ce = res.headers.get("content-encoding") || "-";
  if (!res.ok) { r.err = (await res.text()).slice(0, 200); return r; }
  const dec = new TextDecoder(); let buf = "", content = "", reasoningChars = 0;
  for await (const chunk of res.body) {
    const now = performance.now() - t0; r.firstByte ??= now;
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue; const p = line.slice(5).trim();
      if (p === "[DONE]") continue; let v; try { v = JSON.parse(p); } catch { continue; }
      if (v.usage) { r.pt = v.usage.prompt_tokens; r.ct = v.usage.completion_tokens;
        r.rt = v.usage.completion_tokens_details?.reasoning_tokens; }
      const d = v.choices?.[0]?.delta || {};
      if (d.reasoning_content) { r.firstReasoning ??= now; reasoningChars += d.reasoning_content.length; }
      if (d.content) { r.firstContent ??= now; content += d.content;
        if (r.firstBlock == null && content.includes("</t>")) r.firstBlock = now; }
    }
  }
  r.done = performance.now() - t0; r.reasoningChars = reasoningChars;
  const genMs = r.done - (r.firstReasoning ?? r.firstContent ?? r.done);
  r.tokPerSec = r.ct && genMs > 0 ? +(r.ct / (genMs / 1000)).toFixed(1) : null;
  return r;
}

const runs = +(process.argv[2] || 3);
const rows = [];
for (const encoding of ["identity", "gzip"])
  for (const thinking of ["disabled", "omit"])
    for (const n of [1, 3, 10])
      for (let k = 0; k < runs; k++) rows.push(await once(n, thinking, encoding));
const f = (x) => (x == null ? "-" : Math.round(x));
console.log("| enc | thinking | n | status | CE | headers | 1st byte | 1st reasoning | 1st content | 1st block | done | ct | reasoning_tok | tok/s |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.encoding} | ${r.thinking} | ${r.n} | ${r.status} | ${r.ce} | ${f(r.headers)} | ${f(r.firstByte)} | ${f(r.firstReasoning)} | ${f(r.firstContent)} | ${f(r.firstBlock)} | ${f(r.done)} | ${r.ct ?? "-"} | ${r.rt ?? "-"} | ${r.tokPerSec ?? "-"} |${r.err ? " " + r.err : ""}`);
