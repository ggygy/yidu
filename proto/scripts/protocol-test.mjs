// 工单 06 欠账的协议实测:DeepSeek 真实 key,验证 <s>/<t> 分隔符协议
// 用法:node scripts/protocol-test.mjs   (key 在 ../.env.local,仅测试)
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const { DEEPSEEK_API_KEY: KEY, DEEPSEEK_BASE_URL: BASE } = env;

const SYSTEM = `你是一名专业的英语→简体中文技术文档翻译。

规则:
1. 只输出译文。不要输出任何解释、前言、结语(例如"以下是译文")。
2. 输入被分成带编号的片段 <s id="N">…</s>。对每个片段,输出
   <t id="N">…</t>,id 与输入一一对应,顺序一致,数量一致,一个不漏。
3. 保持 Markdown 语法完全不变:标题层级、列表、粗斜体、链接、表格、引用、空行结构原样保留。
4. 代码块、行内代码 \`…\`、URL、文件路径、命令、变量名一律原样保留,不翻译。
5. 专有名词/产品名若无通用简体中文译名,保留原文。
6. 标点遵循简体中文习惯(用全角标点)。
7. "上文参考"标记的部分只用于理解语境,禁止翻译或输出。

术语表(必须使用以下固定译法;若术语保持原文则原样保留):
- hydration → 水合
- webview → webview(不译)
- context window → 上下文窗口`;

const P1 = "Tauri is a framework for building fast, lightweight desktop applications with a Rust backend and a web frontend. Unlike Electron, it does not bundle a full Chromium runtime — instead, it relies on the platform's native webview.";
const P2 = "During development the frontend talks to the Rust core over a custom IPC protocol. Streaming responses arrive through a channel, and hydration of the webview is deferred so that startup stays instant. See https://tauri.app/start/ for details.";
const P3 = "The bundle size of a typical Tauri app is a few megabytes, and memory usage stays far below equivalent Electron apps — a good fit for tools that live quietly in the menu bar.";

const userMsg = (title, prev, blocks) =>
  `文档标题:${title}(供理解语境)\n` +
  (prev ? `\n上文参考(勿翻译、勿输出):\n${prev}\n` : "") +
  `\n请翻译以下 ${blocks.length} 个片段:\n\n` +
  blocks.map((b, i) => `<s id="${i + 1}">${b}</s>`).join("\n");

// 流式调用 + 按 </t> 切块的状态机,返回逐块产出时刻与全文
async function translateBatch(title, prev, blocks) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 1.0,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg(title, prev, blocks) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let raw = "";
  let sse = "";
  let firstDelta = 0;
  const blocksOut = []; // {id, text, tMs}
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sse += dec.decode(value, { stream: true });
    const lines = sse.split("\n");
    sse = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      const j = JSON.parse(payload);
      if (j.usage) usage = j.usage;
      const delta = j.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;
      if (!firstDelta) firstDelta = Date.now() - t0;
      raw += delta;
      buf += delta;
      // 状态机:凑齐一个 </t> 即产出
      for (;;) {
        const close = buf.indexOf("</t>");
        if (close === -1) break;
        const seg = buf.slice(0, close);
        const m = seg.match(/<t id="(\d+)">([\s\S]*)/);
        if (m) blocksOut.push({ id: +m[1], text: m[2].trim(), tMs: Date.now() - t0 });
        buf = buf.slice(close + 4);
      }
    }
  }
  return { raw, blocksOut, firstDelta, totalMs: Date.now() - t0, usage };
}

const fenceCount = (s) => (s.match(/```/g) || []).length;
const urlSet = (s) => new Set((s.match(/https?:\/\/\S+/g) || []).map((u) => u.replace(/[).,]+$/, "")));

function report(name, r, blocks) {
  const ids = r.blocksOut.map((b) => b.id).join(",");
  const expected = blocks.map((_, i) => i + 1).join(",");
  const outside = r.raw.replace(/<t id="\d+">[\s\S]*?<\/t>/g, "").trim();
  const urlsOk = [...urlSet(blocks.join(" "))].every((u) => r.raw.includes(u));
  console.log(`\n===== ${name} =====`);
  console.log(`块数: ${r.blocksOut.length}/${blocks.length}  id 序列: ${ids}${ids === expected ? " ✓" : " ✗ 期望 " + expected}`);
  console.log(`标签外文本: ${outside === "" ? "无 ✓" : "有 ✗ → " + JSON.stringify(outside.slice(0, 80))}`);
  console.log(`URL 保留: ${urlsOk ? "✓" : "✗"}`);
  console.log(`首 token: ${r.firstDelta}ms  首块完成: ${r.blocksOut[0]?.tMs}ms  总耗时: ${r.totalMs}ms`);
  console.log(`usage: prompt=${r.usage?.prompt_tokens} completion=${r.usage?.completion_tokens} tokens`);
  return { idsOk: ids === expected, outsideOk: outside === "", urlsOk };
}

// ── 测试 A:3 块标准批(带跨批上文) ──
const rA = await translateBatch(
  "Tauri 2.0: Architecture Deep Dive",
  "Tauri 是一个构建轻量、快速桌面应用的框架:后端用 Rust,前端用 Web 技术。",
  [P1, P2, P3]
);
const a = report("A · 3 块标准批", rA, [P1, P2, P3]);
const termHit = rA.blocksOut.find((b) => b.id === 2)?.text.includes("水合");
console.log(`术语命中(hydration→水合,块2): ${termHit ? "✓" : "✗"}`);
console.log("块2 译文: " + rA.blocksOut.find((b) => b.id === 2)?.text);
console.log("块1 译文: " + rA.blocksOut.find((b) => b.id === 1)?.text);

// ── 测试 B:10 块上限批(切成小段,补足到 10) ──
const EXTRA = [
  "Plugins provide access to native APIs such as the filesystem and clipboard.",
  "Security is enforced through a capability system scoped per window.",
  "Updates can be shipped through a built-in updater plugin.",
];
const sentences = [...P1.match(/[^.!?]+[.!?]/g), ...P2.match(/[^.!?]+[.!?]/g), ...P3.match(/[^.!?]+[.!?]/g), ...EXTRA].map((s) => s.trim()).filter(Boolean).slice(0, 10);
console.log(`B 块数准备: ${sentences.length}`);
const rB = await translateBatch("Tauri 2.0: Architecture Deep Dive", null, sentences);
const b = report("B · 10 块上限批", rB, sentences);

console.log(`\n===== 总判定 =====`);
console.log(`A: ${a.idsOk && a.outsideOk && a.urlsOk && termHit ? "PASS" : "FAIL"}  B: ${b.idsOk && b.outsideOk && b.urlsOk ? "PASS" : "FAIL"}`);
