// 服务商共享逻辑(设置窗 / 快捷窗模型菜单共用):预设、extra 读写、连通状态缓存、模型列表缓存
import * as api from "./api";
import type { Provider, ProviderForm, TestResult } from "./types";

export type Preset = { kind: string; base_url: string; model: string; hint: string };

// 预设(2026-11;模型以拉取到的 /models 为准,这里只是首个默认值)
export const PRESETS: Record<string, Preset> = {
  DeepSeek: { kind: "openai_compatible", base_url: "https://api.deepseek.com", model: "deepseek-chat", hint: "api.deepseek.com" },
  "GLM(智谱)": { kind: "openai_compatible", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5-flash", hint: "open.bigmodel.cn" },
  OpenAI: { kind: "openai_compatible", base_url: "https://api.openai.com/v1", model: "gpt-5-mini", hint: "api.openai.com" },
  "Ollama(本地)": { kind: "ollama", base_url: "http://localhost:11434", model: "qwen3:4b", hint: "localhost:11434 · 免密钥" },
};

/** 思考控制(§2.3.9):auto = 按 host 自动(DeepSeek / 智谱 / 百炼 / OpenAI 推理模型 / Ollama 自动关) */
export const THINKING_OPTIONS = [
  ["auto", "自动(按服务商)"],
  ["none", "不注入"],
  ["deepseek", "DeepSeek 式 · thinking: disabled"],
  ["qwen", "Qwen 式 · enable_thinking: false"],
  ["openai", "OpenAI 式 · reasoning_effort: none"],
  ["ollama", "Ollama 式 · think: false"],
  ["custom", "自定义 JSON…"],
] as const;

export type Extra = { thinking_control?: string; thinking_custom?: string; thinking_unsupported?: boolean; [k: string]: unknown };

export function parseExtra(p: Provider | null | undefined): Extra {
  try { return JSON.parse(p?.extra || "{}") ?? {}; } catch { return {}; }
}

/** 预设 host 是否自动关思考(用于「自动」档的说明文字) */
export function autoThinkingNote(kind: string, base_url: string): string {
  if (kind === "ollama") return "自动:请求带 think: false";
  const h = base_url.toLowerCase();
  if (/deepseek\.com|bigmodel\.cn|z\.ai/.test(h)) return "自动:请求带 thinking: disabled";
  if (/dashscope/.test(h)) return "自动:请求带 enable_thinking: false";
  if (/openai\.com/.test(h)) return "自动:推理模型带 reasoning_effort: none";
  return "自动:此地址不在已知列表,不注入任何字段;若首字很慢,试试下面的具体方式";
}

export function formOf(p: Provider, over: Partial<ProviderForm> = {}): ProviderForm {
  return { id: p.id, kind: p.kind, base_url: p.base_url, model: p.model, key: null, extra: p.extra, ...over };
}

// ---------- 连通状态缓存(localStorage 同源共享,三窗经 storage 事件同步) ----------

export type TestState = { ok: boolean; kind: TestResult["kind"]; ms: number; msg: string; sig: string; at: number };

const sigOf = (p: { base_url: string; model: string }) => `${p.base_url.trim()}|${p.model.trim()}`;
const TKEY = (id: number) => `yidu-test-${id}`;

/** 当前配置对应的测试结果;配置改过(签名不符)视为未测试 */
export function testState(p: Provider): TestState | null {
  try {
    const t: TestState | null = JSON.parse(localStorage.getItem(TKEY(p.id)) || "null");
    return t && t.sig === sigOf(p) ? t : null;
  } catch { return null; }
}

export function saveTest(p: { id: number; base_url: string; model: string }, r: TestResult) {
  const t: TestState = { ok: r.ok, kind: r.kind, ms: r.latency_ms, msg: r.message, sig: sigOf(p), at: Date.now() };
  try { localStorage.setItem(TKEY(p.id), JSON.stringify(t)); } catch { /* ignore */ }
}

export function clearTest(id: number) {
  try { localStorage.removeItem(TKEY(id)); } catch { /* ignore */ }
}

/** 测试并记录(表单值;成功 / 失败都写缓存) */
export async function runTest(p: Provider, over: Partial<ProviderForm> = {}): Promise<TestResult> {
  const form = formOf(p, over);
  let r: TestResult;
  try { r = await api.providerTestForm(form); } catch (e) { r = { ok: false, latency_ms: 0, kind: "other", message: String(e) }; }
  saveTest({ id: p.id, base_url: form.base_url, model: form.model }, r);
  return r;
}

// ---------- 模型列表缓存(会话内 + localStorage,10 分钟有效) ----------

const MKEY = (id: number) => `yidu-models-${id}`;

export function cachedModels(id: number): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MKEY(id)) || "null");
    return v && Date.now() - v.at < 600_000 ? v.list : [];
  } catch { return []; }
}

export async function fetchModels(p: Provider, over: Partial<ProviderForm> = {}): Promise<string[]> {
  const list = await api.providerModels(formOf(p, over));
  try { localStorage.setItem(MKEY(p.id), JSON.stringify({ at: Date.now(), list })); } catch { /* ignore */ }
  return list;
}

export function uniqueName(base: string, providers: Provider[]): string {
  if (!providers.some((p) => p.name === base)) return base;
  for (let i = 2; ; i++) if (!providers.some((p) => p.name === `${base} ${i}`)) return `${base} ${i}`;
}
