// 服务商共享逻辑(设置窗 / 快捷窗模型菜单共用):预设、extra 读写、连通状态缓存、模型列表缓存
import * as api from "./api";
import type { Provider, ProviderForm, TestResult } from "./types";

export type Preset = { kind: string; base_url: string; model: string; hint: string };

// 预设(2026-11;模型以拉取到的 /models 为准,这里只是首个默认值)
export const PRESETS: Record<string, Preset> = {
  DeepSeek: { kind: "openai_compatible", base_url: "https://api.deepseek.com", model: "deepseek-v4-flash", hint: "api.deepseek.com" },
  "GLM(智谱)": { kind: "openai_compatible", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5-flash", hint: "open.bigmodel.cn" },
  OpenAI: { kind: "openai_compatible", base_url: "https://api.openai.com/v1", model: "gpt-5-mini", hint: "api.openai.com" },
  "Ollama(本地)": { kind: "ollama", base_url: "http://localhost:11434", model: "qwen3:4b", hint: "localhost:11434 · 免密钥" },
};

/** 思考级别(§2.3.9):auto = 已知服务商自动关闭、其他不干预;default = 不附加任何字段(模型默认) */
export const THINKING_MODES = [
  ["auto", "自动"], ["off", "关闭"], ["low", "低"], ["medium", "中"], ["high", "高"], ["default", "默认"],
] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number][0];

/** 字段格式:auto = 按地址识别(未知地址用 OpenAI 式 reasoning_effort) */
export const THINKING_FORMATS = [
  ["auto", "自动识别"],
  ["openai", "OpenAI 式 · reasoning_effort"],
  ["deepseek", "DeepSeek / 智谱式 · thinking.type(只有开关)"],
  ["qwen", "Qwen 式 · enable_thinking + thinking_budget"],
  ["ollama", "Ollama 式 · think"],
  ["custom", "自定义 JSON…"],
] as const;

/** 读 extra 里的思考设置(兼容旧版 thinking_control 单选) */
export function thinkingOf(ex: Extra): { mode: ThinkingMode; format: string } {
  const legacy = ex.thinking_control;
  const lmode = legacy === "none" ? "default" : legacy && legacy !== "auto" ? "off" : undefined;
  const lformat = legacy && !["none", "auto"].includes(legacy) ? legacy : undefined;
  return {
    mode: ((ex.thinking_mode as ThinkingMode) ?? lmode ?? "auto") as ThinkingMode,
    format: (ex.thinking_format as string) ?? lformat ?? "auto",
  };
}

export type Extra = { thinking_mode?: string; thinking_format?: string; thinking_control?: string; thinking_custom?: string; thinking_unsupported?: boolean; [k: string]: unknown };

export function parseExtra(p: Provider | null | undefined): Extra {
  try { return JSON.parse(p?.extra || "{}") ?? {}; } catch { return {}; }
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
