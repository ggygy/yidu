// Tauri command 封装:全部走 Rust,流式经 Channel
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Article, Block, HotkeyStatus, Prefs, Provider, ProviderForm, StreamEvent, TestResult, UsageSummary } from "./types";

export function listArticles(query = ""): Promise<Article[]> {
  return invoke<Article[]>("list_articles", { query });
}

export function getArticle(id: number): Promise<{ article: Article; blocks: Block[] }> {
  return invoke<{ article: Article; blocks: Block[] }>("get_article", { id });
}

export function pinArticle(id: number, pinned: boolean): Promise<void> {
  return invoke("pin_article", { id, pinned });
}

export function deleteArticle(id: number): Promise<void> {
  return invoke("delete_article", { id });
}

export function translate(
  request: { text: string; article_id?: number | null; direction: string; kind: string },
  onEvent: (e: StreamEvent) => void,
): Promise<number> {
  const ch = new Channel<StreamEvent>();
  ch.onmessage = onEvent;
  return invoke<number>("translate", { request, onEvent: ch });
}

export function cancelTranslate(session: number): Promise<void> {
  return invoke("cancel_translate", { session });
}

export function providerList(): Promise<Provider[]> {
  return invoke<Provider[]>("provider_list");
}

export function providerSave(input: {
  id?: number | null;
  name: string;
  kind: string;
  base_url: string;
  model: string;
  extra?: string | null; // 不传 = 保留原值
}): Promise<Provider> {
  return invoke<Provider>("provider_save", { input });
}

export function providerSetKey(id: number, key: string): Promise<void> {
  return invoke("provider_set_key", { id, key });
}

export function providerSetActive(id: number): Promise<void> {
  return invoke("provider_set_active", { id });
}

export function providerDelete(id: number): Promise<void> {
  return invoke("provider_delete", { id });
}

export function providerTest(id: number): Promise<TestResult> {
  return invoke<TestResult>("provider_test", { id });
}

/** 用表单当前值测试(未保存的地址 / 密钥 / 模型也能测) */
export function providerTestForm(form: ProviderForm): Promise<TestResult> {
  return invoke<TestResult>("provider_test_form", { form });
}

/** 拉取可用模型(OpenAI 兼容 /models;Ollama /api/tags) */
export function providerModels(form: ProviderForm): Promise<string[]> {
  return invoke<string[]>("provider_models", { form });
}

/** 已存密钥尾号「····9a1e」;无密钥 = null */
export function providerKeyHint(id: number): Promise<string | null> {
  return invoke<string | null>("provider_key_hint", { id });
}

/** 当前思考设置实际附加到请求体的字段(JSON;空串 = 不附加) */
export function thinkingPreview(form: ProviderForm): Promise<string> {
  return invoke<string>("thinking_preview", { form });
}

export function getPrefs(): Promise<Prefs> {
  return invoke<Prefs>("get_prefs");
}

export function setPrefs(update: Partial<Prefs>): Promise<Prefs> {
  return invoke<Prefs>("set_prefs", { update });
}

export function hotkeyStatus(): Promise<HotkeyStatus> {
  return invoke<HotkeyStatus>("hotkey_status");
}

/** 打开独立设置窗口(section: models | translate | quick | usage | about) */
export function openSettings(section?: string): Promise<void> {
  return invoke("open_settings", { section: section ?? null });
}

export function usageSummary(): Promise<UsageSummary> {
  return invoke<UsageSummary>("usage_summary");
}

// ---------- 词典 / 生词 / 术语 ----------

export function lookupWord(word: string): Promise<import("./types").DictCard> {
  return invoke("lookup_word", { word });
}

export function vocabAdd(input: {
  word: string;
  phonetic: string;
  definition: string;
  source: string;
  sentence?: string;
  article_id?: number | null;
}): Promise<number> {
  return invoke<number>("vocab_add", { ...input });
}

export function vocabList(): Promise<import("./types").VocabEntry[]> {
  return invoke("vocab_list");
}

export function vocabExamples(id: number): Promise<string[]> {
  return invoke("vocab_examples", { id });
}

export function vocabDelete(id: number): Promise<void> {
  return invoke("vocab_delete", { id });
}

export function glossaryList(): Promise<import("./types").GlossaryItem[]> {
  return invoke("glossary_list");
}

export function glossaryAdd(term: string, translation: string): Promise<void> {
  return invoke("glossary_add", { term, translation });
}

export function glossarySetEnabled(id: number, enabled: boolean): Promise<void> {
  return invoke("glossary_set_enabled", { id, enabled });
}

export function glossaryDelete(id: number): Promise<void> {
  return invoke("glossary_delete", { id });
}
