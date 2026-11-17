// 与 Rust 侧 serde 结构一一对应(字段名 snake_case 保持一致)
export type BlockKind = "heading" | "p" | "list" | "code" | "table";
export type BlockStatus = "pending" | "streaming" | "done" | "error";

export interface Block {
  idx: number;
  kind: BlockKind;
  src: string;
  trans: string;
  status: BlockStatus;
  terms?: string; // 命中术语 JSON [{"from","to"}]
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
  | { type: "block"; idx: number; text: string; terms: string }
  | { type: "partial"; idx: number; text: string }
  | { type: "usage"; prompt_tokens: number; completion_tokens: number; reasoning_tokens: number }
  | { type: "done"; article_id: number }
  | { type: "error"; message: string };

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
  message: string;
}
