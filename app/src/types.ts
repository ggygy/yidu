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
  | { type: "created"; article_id: number; blocks: Block[] }
  | { type: "block"; idx: number; text: string; terms: string }
  | { type: "partial"; idx: number; text: string }
  | { type: "usage"; prompt_tokens: number; completion_tokens: number }
  | { type: "done"; article_id: number }
  | { type: "error"; message: string };

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
