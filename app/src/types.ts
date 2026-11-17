// 与 Rust 侧 serde 结构一一对应(字段名 snake_case 保持一致)
export type BlockKind = "heading" | "p" | "list" | "quote" | "code" | "table" | "html" | "hr" | "footnote" | "definition";
export type BlockStatus = "pending" | "streaming" | "done" | "error";

export interface Block {
  idx: number;
  kind: BlockKind;
  src: string;
  trans: string;
  status: BlockStatus;
  terms?: string; // 命中术语 JSON [{"from","to"}]
  group?: number | null; // 大列表拆项:同 group 合回一个列表渲染
  sep?: string; // 与前一块之间的原文分隔(拼回 = 原结构)
  format_warn?: string; // 结构签名不一致的说明;空 = 正常
}

export interface Article {
  id: number;
  title: string;
  kind: string;
  direction: string;
  pinned: boolean;
  created_at: number;
  updated_at: number;
  blocks_total: number;
  blocks_done: number;
}

export interface Provider {
  id: number;
  name: string;
  kind: string; // openai_compatible | ollama
  base_url: string;
  model: string;
  extra: string;
  is_active: boolean;
  has_key: boolean;
}

export type StreamEvent =
  | { type: "created"; article_id: number; article: Article; blocks: Block[] }
  | { type: "block"; idx: number; text: string; terms: string; format_warn: string }
  | { type: "partial"; idx: number; text: string }
  | { type: "usage"; prompt_tokens: number; completion_tokens: number; reasoning_tokens: number }
  | { type: "phase"; phase: Phase }
  | { type: "thinking"; chars: number; tail: string }
  | ({ type: "metrics" } & SessionMetrics)
  | { type: "done"; article_id: number }
  | { type: "error"; message: string };

export type Phase = "conn" | "think" | "gen";

/** 会话结束明细(Rust SessionMetrics;时间均相对会话开始,毫秒) */
export interface SessionMetrics {
  ttft_ms: number | null;
  first_block_ms: number | null;
  first_reasoning_ms: number | null;
  last_content_ms: number | null;
  total_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  requests: number;
  batches: number;
  blocks: number;
  model: string;
  cancelled: boolean;
}

/** 本次翻译会话累计用量(usage 事件按请求逐次累加) */
export interface SessionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  requests: number;
}

export const EMPTY_USAGE: SessionUsage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, requests: 0 };

export function addUsage(u: SessionUsage, e: { prompt_tokens: number; completion_tokens: number; reasoning_tokens?: number }): SessionUsage {
  return {
    prompt_tokens: u.prompt_tokens + e.prompt_tokens,
    completion_tokens: u.completion_tokens + e.completion_tokens,
    reasoning_tokens: u.reasoning_tokens + (e.reasoning_tokens ?? 0),
    requests: u.requests + 1,
  };
}

/** Rust 侧热键注册状态(error 非空 = 注册失败,多半被其他应用占用) */
export interface HotkeyStatus {
  accel: string;
  error: string | null;
}

export interface UsageSummary {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface Prefs {
  hotkey: string;
  paste_auto: boolean;
  blur_hide: boolean;
  pin_default: boolean;
  direction: string;
  dict_fallback: boolean;
  price_per_mtok: number;
  custom_prompt: string | null; // null = 用内置默认(英文)
  theme_mode: "system" | "light" | "dark"; // v0.3:外观三态(Rust set_theme 权威)
  quick_scale: number; // 0.8–1.5,⌘± / ⌘0(快捷窗)
  main_scale: number;  // 0.8–1.5(主窗)
  density: "compact" | "standard" | "loose";
}

export interface DictSense {
  pos: string;
  gloss: string;
}

export interface DictExample {
  en: string;
  zh: string;
}

export interface DictCard {
  schema_version: number;
  source: string; // youdao | dictapi | model | miss
  phonetic_us: string;
  phonetic_uk: string;
  senses: DictSense[];
  web_trans: string[];
  examples: DictExample[];
  audio: string;
}

export interface VocabEntry {
  id: number;
  lemma: string;
  phonetic: string;
  definition: string;
  source: string;
  created_at: number;
  examples: number;
}

export interface GlossaryItem {
  id: number;
  term: string;
  translation: string;
  note: string;
  enabled: boolean;
}

export interface TestResult {
  ok: boolean;
  latency_ms: number;
  kind: "ok" | "no_key" | "auth" | "model" | "network" | "other";
  message: string;
}

/** 设置页表单当前值(测试 / 拉模型用,未保存也可) */
export interface ProviderForm {
  id: number | null;
  kind: string;
  base_url: string;
  model: string;
  key?: string | null;
  extra?: string | null;
}

/** 用量页(§2.6.7) */
export interface UsageRow {
  created_at: number;
  model: string;
  provider: string;
  ttft_ms: number | null;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
}

export interface UsageReport {
  month_requests: number;
  month_prompt: number;
  month_completion: number;
  month_reasoning: number;
  models: { model: string; samples: number; ttft_median_ms: number | null; total_median_ms: number }[];
  recent: UsageRow[];
}
