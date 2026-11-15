import { createRoot } from "react-dom/client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkUpdateFn } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { CodeBox, Md, type TermHit, type WordHandler } from "./md";
import { Icon } from "./icons";
import * as api from "./api";
import type { Article, Block, DictCard, GlossaryItem, Prefs, Provider, StreamEvent, UsageSummary, VocabEntry } from "./types";
import "./styles.css";

type View = "interleave" | "split" | "zh";
type Panel = "library" | "vocab" | "glossary" | null;

function useLocalFlag(key: string, init: boolean) {
  const [v, setV] = useState(() => (localStorage.getItem(key) === null ? init : localStorage.getItem(key) === "1"));
  return [v, (n: boolean) => { localStorage.setItem(key, n ? "1" : "0"); setV(n); }] as const;
}

function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "今天";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}-${day}`;
}

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

const SOURCE_LABEL: Record<string, string> = {
  youdao: "有道词典(免费)",
  dictapi: "dictionaryapi.dev(免费)",
  model: "模型兜底",
  miss: "未收录",
};

// G1b 点词卡:真实查词链(有道 → dictapi → 模型兜底;命中本地缓存即时返回)
function VocabCard({
  word, x, y, sentence, articleId, onClose, onAdded,
}: {
  word: string;
  x: number;
  y: number;
  sentence?: string;
  articleId?: number;
  onClose: () => void;
  onAdded: (n: number) => void;
}) {
  const [card, setCard] = useState<DictCard | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setCard(null);
    setErr(null);
    api.lookupWord(word).then(setCard).catch((e) => setErr(String(e)));
  }, [word]);

  const speak = () => {
    const url = card?.audio || `https://dict.youdao.com/dictvoice?type=0&audio=${encodeURIComponent(word)}`;
    new Audio(url).play().catch(() => {});
  };

  const add = async () => {
    const def =
      card?.senses.map((s) => `${s.pos ? s.pos + ". " : ""}${s.gloss}`).join("; ") ||
      card?.web_trans.join(";") ||
      "(无释义)";
    try {
      await api.vocabAdd({
        word,
        phonetic: card?.phonetic_us || "",
        definition: def.slice(0, 500),
        source: card?.source === "miss" ? "manual" : card?.source || "manual",
        sentence,
        article_id: articleId ?? null,
      });
      onAdded(1);
      onClose();
    } catch (e) {
      setErr(String(e));
    }
  };

  const left = Math.min(x, window.innerWidth - 320);
  const top = Math.min(y + 14, window.innerHeight - 300);
  return (
    <div className="vocab-card" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
      <div className="h">
        <b>{word}</b>
        <span className="phon">{card?.phonetic_us ? `/${card.phonetic_us}/` : card?.phonetic_uk ? `/${card.phonetic_uk}/` : ""}</span>
        <button className="spk" title="发音" onClick={speak}>
          <Icon n="volume" size={14} />
        </button>
      </div>
      {!card && !err && <p className="loading">查询中 ···</p>}
      {err && <p className="loading">{err}</p>}
      {card && (
        <>
          <p className="src">释义 · {SOURCE_LABEL[card.source] ?? card.source}{card.source === "miss" ? " · 可点「加入生词本」手动记录" : ""}</p>
          {card.senses.length > 0 && (
            <p className="def">
              {card.senses.slice(0, 5).map((s, i) => (
                <span key={i}>{s.pos && <b style={{ color: "var(--t3)", fontWeight: 500 }}>{s.pos}. </b>}{s.gloss}<br /></span>
              ))}
            </p>
          )}
          {card.web_trans.length > 0 && (
            <p className="def" style={{ color: "var(--t2)" }}>网络释义:{card.web_trans.slice(0, 3).join(";")}</p>
          )}
          {card.examples.length > 0 && (
            <>
              <div className="div" />
              <p className="ex-label">词典例句</p>
              {card.examples.slice(0, 2).map((ex, i) => (
                <p key={i} className="ex">“{ex.en}”{ex.zh ? <span style={{ color: "var(--t3)" }}>{ex.zh}</span> : null}</p>
              ))}
            </>
          )}
          {sentence && (
            <>
              <div className="div" />
              <p className="ex-label">本文例句</p>
              <p className="ex">“{sentence.slice(0, 220)}{sentence.length > 220 ? "…" : ""}”</p>
            </>
          )}
        </>
      )}
      <div className="ops">
        <button className="btn-accent" onClick={add}>
          <Icon n="plus" size={12} /> 加入生词本
        </button>
        <button className="btn-ghost" onClick={onClose}>忽略</button>
      </div>
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className={"toggle" + (on ? " on" : "")} onClick={onClick} aria-pressed={on}><i /></button>;
}

// ---------- 设置面板 ----------

const PRESETS: Record<string, { kind: string; base_url: string; model: string }> = {
  DeepSeek: { kind: "openai_compatible", base_url: "https://api.deepseek.com", model: "deepseek-chat" },
  GLM: { kind: "openai_compatible", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  OpenAI: { kind: "openai_compatible", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  Ollama: { kind: "ollama", base_url: "http://localhost:11434", model: "llama3.1" },
};

function SettingsPanel({
  onClose, prefs, applyPrefs, dark, setDark, providers, refreshProviders, say,
}: {
  onClose: () => void;
  prefs: Prefs | null;
  applyPrefs: (u: Partial<Prefs>) => void;
  dark: boolean;
  setDark: (v: boolean) => void;
  providers: Provider[];
  refreshProviders: () => void;
  say: (m: string) => void;
}) {
  const active = providers.find((p) => p.is_active);
  const [selId, setSelId] = useState<number | null>(active?.id ?? providers[0]?.id ?? null);
  const sel = providers.find((p) => p.id === selId) ?? null;
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [price, setPrice] = useState(String(prefs?.price_per_mtok ?? ""));
  const [appVersion, setAppVersion] = useState("");
  const [updBusy, setUpdBusy] = useState(false);
  const [updMsg, setUpdMsg] = useState<string | null>(null);

  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);

  // 检查更新:有新版本 → 下载 → 安装 → 重启;失败/无更新给出文案
  const checkUpdate = async () => {
    if (updBusy) return;
    setUpdBusy(true); setUpdMsg(null);
    try {
      const upd = await checkUpdateFn();
      if (!upd) { setUpdMsg("已是最新版本"); return; }
      setUpdMsg(`发现 v${upd.version},下载中…`);
      let received = 0;
      let total = 0;
      await upd.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started": total = event.data.contentLength ?? 0; break;
          case "Progress": received += event.data.chunkLength; setUpdMsg(`下载中 ${total ? Math.round((received / total) * 100) + "%" : (received >> 10) + "KB"}`); break;
          case "Finished": setUpdMsg("下载完成,即将重启…"); break;
        }
      });
      await relaunch();
    } catch (e) {
      setUpdMsg(`检查失败:${String(e).slice(0, 80)}`);
    } finally {
      setUpdBusy(false);
    }
  };

  useEffect(() => {
    if (sel) { setName(sel.name); setBaseUrl(sel.base_url); setModel(sel.model); }
    setKeyInput("");
    setTestMsg(null);
  }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api.usageSummary().then(setUsage).catch(() => {}); }, []);

  const pickPreset = async (preset: string) => {
    const def = PRESETS[preset];
    const existing = providers.find((p) => p.name === preset);
    try {
      let id: number;
      if (existing && existing.base_url === def.base_url) {
        id = existing.id;
      } else {
        const saved = await api.providerSave({ id: existing?.id ?? null, name: preset, ...def });
        id = saved.id;
      }
      await api.providerSetActive(id);
      await refreshProviders();
      setSelId(id);
      say(`已启用 ${preset}`);
    } catch (e) { say(String(e)); }
  };

  const save = async () => {
    if (!sel) return;
    try {
      await api.providerSave({ id: sel.id, name, kind: sel.kind, base_url: baseUrl, model });
      if (keyInput.trim()) {
        await api.providerSetKey(sel.id, keyInput.trim());
        say("已保存 · API Key 已写入 Keychain");
      } else {
        say("已保存");
      }
      setKeyInput("");
      await refreshProviders();
    } catch (e) { say(String(e)); }
  };

  const test = async () => {
    if (!sel) return;
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await api.providerTest(sel.id);
      setTestMsg(r.message);
    } catch (e) { setTestMsg(String(e)); }
    setTesting(false);
  };

  const changeHotkey = async () => {
    const input = window.prompt("新快捷键(Tauri 格式,如 Alt+T / CommandOrControl+Alt+T):", prefs?.hotkey ?? "Alt+T");
    if (!input || !input.includes("+")) return;
    try {
      await api.setPrefs({ hotkey: input.trim() });
      applyPrefs({ hotkey: input.trim() });
      say(`热键已改为 ${input.trim()}(立即生效)`);
    } catch (e) { say(`改键失败:${String(e)}`); }
  };

  const savePrice = () => {
    const v = parseFloat(price);
    applyPrefs({ price_per_mtok: isNaN(v) ? 0 : v });
    say(isNaN(v) ? "单价已清空" : "单价已保存");
  };

  const selPresetName = sel ? Object.keys(PRESETS).find((k) => PRESETS[k].base_url === sel.base_url && sel.name === k) : null;
  const cost =
    usage && prefs?.price_per_mtok
      ? ((usage.prompt_tokens + usage.completion_tokens) / 1_000_000 * prefs.price_per_mtok).toFixed(3)
      : null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="set-panel" onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <b>设置</b>
          <button className="icon-btn" onClick={onClose}><Icon n="x" size={15} /></button>
        </div>
        <div className="set-div" />

        <div className="set-sec">
          <span className="set-label">PROVIDER</span>
          <div className="preset-row">
            {Object.keys(PRESETS).map((p) => (
              <button key={p} className={"preset" + (selPresetName === p || (!selPresetName && active?.name === p) ? " on" : "")} onClick={() => pickPreset(p)}>
                {p === "Ollama" && <i className="dot" />}{p}
              </button>
            ))}
          </div>
          {sel ? (
            <div className="set-rows">
              <div className="set-row"><span className="name">Base URL</span>
                <input className="set-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
              </div>
              <div className="set-row"><span className="name">API Key</span>
                <input className="set-input" type="password" placeholder={sel.has_key ? "••••••••(已存 Keychain,输入以更换)" : "sk-…(只存 Keychain)"} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} spellCheck={false} />
                <button className="q-link" style={{ color: "var(--t2)" }} disabled={testing} onClick={test}>{testing ? "测试中…" : "测试"}</button>
                {testMsg && <span className="test-ok" style={{ color: testMsg.startsWith("✓") ? "var(--ok)" : "var(--t2)" }}>{testMsg}</span>}
              </div>
              <div className="set-row"><span className="name">模型</span>
                <input className="set-input" value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
              </div>
              <div className="set-row">
                <span className="name">状态</span>
                <span className="val">
                  {sel.is_active ? <span className="test-ok" style={{ color: "var(--ok)" }}>● 使用中</span> : <span className="plain">未激活</span>}
                  <button className="q-link" style={{ color: "var(--t2)" }} onClick={() => api.providerSetActive(sel.id).then(refreshProviders).then(() => say("已激活")).catch((e) => say(String(e)))}>设为使用中</button>
                </span>
              </div>
              <div className="set-row">
                <button className="btn-accent" onClick={save}><Icon n="sparkles" size={12} /> 保存配置</button>
              </div>
            </div>
          ) : (
            <div className="set-rows"><div className="set-row"><span className="val">点击上方预设开始配置</span></div></div>
          )}
        </div>

        <div className="set-sec">
          <span className="set-label">翻译</span>
          <div className="set-rows">
            <div className="set-row"><span className="name">默认方向</span>
              <button className="q-naked" onClick={() => applyPrefs({ direction: prefs?.direction === "zh2en" ? "en2zh" : "zh2en" })}>
                <Icon n="swap" size={12} /> {prefs?.direction === "zh2en" ? "中 → EN" : "EN → 中"}
              </button>
            </div>
            <div className="set-row"><span className="name">单词查词</span>
              <span className="val"><span className="plain" style={{ marginRight: 8 }}>免费词典 → 模型兜底</span></span>
              <Toggle on={!!prefs?.dict_fallback} onClick={() => applyPrefs({ dict_fallback: !prefs?.dict_fallback })} />
            </div>
            <div className="set-row"><span className="name">术语库注入</span>
              <span className="val"><span className="plain">开 · 到「术语库」管理词条</span></span>
            </div>
          </div>
        </div>

        <div className="set-sec">
          <span className="set-label">快捷键与浮窗</span>
          <div className="set-rows">
            <div className="set-row"><span className="name">呼出快捷窗</span>
              <span className="val"><kbd>{(prefs?.hotkey ?? "Alt+T").replace("Alt", "⌥").replace("CommandOrControl", "⌘").replace("Shift", "⇧")}</kbd>
                <button className="q-link" style={{ color: "var(--t2)" }} onClick={changeHotkey}>改键</button></span>
            </div>
            <div className="set-row"><span className="name">粘贴即译</span><Toggle on={!!prefs?.paste_auto} onClick={() => applyPrefs({ paste_auto: !prefs?.paste_auto })} /></div>
            <div className="set-row"><span className="name">重启后显示快捷窗</span><span className="val"><span className="plain">关(固定,spec §2.1)</span></span></div>
            <div className="set-row"><span className="name">置顶(pin)默认</span><Toggle on={!!prefs?.pin_default} onClick={() => applyPrefs({ pin_default: !prefs?.pin_default })} /></div>
            <div className="set-row"><span className="name">失焦自动隐藏</span><Toggle on={!!prefs?.blur_hide} onClick={() => applyPrefs({ blur_hide: !prefs?.blur_hide })} /></div>
          </div>
        </div>

        <div className="set-sec">
          <span className="set-label">外观与用量</span>
          <div className="set-rows">
            <div className="set-row"><span className="name">深色外观</span><Toggle on={dark} onClick={() => setDark(!dark)} /></div>
            <div className="set-row"><span className="name">翻译用量</span>
              <span className="val">{usage ? `${usage.requests} 次 · ${fmtTokens(usage.prompt_tokens + usage.completion_tokens)} tokens` : "—"}</span>
            </div>
            <div className="set-row"><span className="name">成本估算</span>
              <span className="val">
                <input className="set-input" style={{ width: 90 }} placeholder="¥/1M tokens" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={savePrice} />
                {cost && <span className="plain" style={{ fontWeight: 600, marginLeft: 6 }}>≈ ¥{cost}</span>}
              </span>
            </div>
          </div>
        </div>

        <div className="set-sec">
          <span className="set-label">关于与更新</span>
          <div className="set-rows">
            <div className="set-row"><span className="name">当前版本</span><span className="val"><span className="plain">{appVersion}</span></span></div>
            <div className="set-row"><span className="name">软件更新</span>
              <span className="val upd-row">
                <button className="upd-btn" disabled={updBusy} onClick={checkUpdate}>{updBusy ? "检查中…" : "检查更新"}</button>
                {updMsg && <span className="upd-msg">{updMsg}</span>}
              </span>
            </div>
          </div>
        </div>

        <span style={{ flex: 1 }} />
        <span className="set-foot">v{appVersion || "0.1.0"} · 数据全部本地存储 · Key 只进 Keychain</span>
      </aside>
    </>
  );
}

// ---------- 生词本 / 术语库 滑出层 ----------

function VocabPanel({ onClose, onCount, say }: { onClose: () => void; onCount: (n: number) => void; say: (m: string) => void }) {
  const [items, setItems] = useState<VocabEntry[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [examples, setExamples] = useState<string[]>([]);
  const refresh = () => api.vocabList().then((v) => { setItems(v); onCount(v.length); }).catch(() => {});
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="lib-panel" onClick={(e) => e.stopPropagation()}>
        <div className="lib-head">
          <b>生词本</b><span className="count">{items.length}</span>
          <span className="sp" />
          <button className="lib-new" onClick={onClose}><Icon n="x" size={13} /> 关闭</button>
        </div>
        <div className="lib-list">
          {items.map((v) => (
            <div key={v.id} className="lib-item" onClick={() => {
              if (openId === v.id) { setOpenId(null); return; }
              setOpenId(v.id);
              api.vocabExamples(v.id).then(setExamples).catch(() => setExamples([]));
            }}>
              <div className="meta">
                <span>{v.source === "dict" ? "词典" : v.source === "model" ? "模型" : "手动"}</span>
                <span>{v.examples} 例句</span>
                <span onClick={(e) => { e.stopPropagation(); api.vocabDelete(v.id).then(refresh); say("已删除"); }} style={{ color: "var(--t3)", cursor: "pointer" }}>删除</span>
              </div>
              <div className="t">{v.lemma} {v.phonetic && <span style={{ color: "var(--t3)", fontSize: 11 }}>/{v.phonetic}/</span>}</div>
              <div style={{ fontSize: 11, color: "var(--t2)", marginTop: 2 }}>{v.definition.slice(0, 90)}{v.definition.length > 90 ? "…" : ""}</div>
              {openId === v.id && examples.map((ex, i) => (
                <div key={i} style={{ fontSize: 10.5, color: "var(--t3)", marginTop: 4, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>“{ex.slice(0, 160)}”</div>
              ))}
            </div>
          ))}
          {items.length === 0 && <div style={{ padding: 8, color: "var(--t3)", fontSize: 11 }}>还没有生词 · 阅读时点任意英文词收藏</div>}
        </div>
        <div className="lib-bottom">
          <span className="lib-entry" style={{ cursor: "default" }}>P1 将内置 SRS 复习</span>
        </div>
      </aside>
    </>
  );
}

function GlossaryPanel({ onClose, say }: { onClose: () => void; say: (m: string) => void }) {
  const [items, setItems] = useState<GlossaryItem[]>([]);
  const [term, setTerm] = useState("");
  const [trans, setTrans] = useState("");
  const refresh = () => api.glossaryList().then(setItems).catch(() => {});
  useEffect(() => { refresh(); }, []);
  const add = async () => {
    if (!term.trim() || !trans.trim()) return;
    await api.glossaryAdd(term.trim(), trans.trim());
    setTerm(""); setTrans("");
    refresh();
    say(`术语已加入,下批翻译生效`);
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="lib-panel" onClick={(e) => e.stopPropagation()}>
        <div className="lib-head">
          <b>术语库</b><span className="count">{items.length}</span>
          <span className="sp" />
          <button className="lib-new" onClick={onClose}><Icon n="x" size={13} /> 关闭</button>
        </div>
        <div className="g-add">
          <input className="set-input" placeholder="原文术语(如 hydration)" value={term} onChange={(e) => setTerm(e.target.value)} spellCheck={false} />
          <span style={{ color: "var(--t3)" }}>→</span>
          <input className="set-input" placeholder="固定译法(如 水合)" value={trans} onChange={(e) => setTrans(e.target.value)} spellCheck={false} />
          <button className="btn-accent" style={{ height: 26, padding: "0 10px" }} onClick={add}><Icon n="plus" size={12} /> 加</button>
        </div>
        <div className="lib-list">
          {items.map((g) => (
            <div key={g.id} className="lib-item">
              <div className="meta">
                <span>{g.enabled ? "注入中" : "已停用"}</span>
                <span onClick={(e) => { e.stopPropagation(); api.glossarySetEnabled(g.id, !g.enabled).then(refresh); }} style={{ color: g.enabled ? "var(--ok)" : "var(--t3)", cursor: "pointer" }}>{g.enabled ? "● 启用" : "○ 停用"}</span>
                <span onClick={(e) => { e.stopPropagation(); api.glossaryDelete(g.id).then(refresh); say("已删除"); }} style={{ color: "var(--t3)", cursor: "pointer" }}>删除</span>
              </div>
              <div className="t">{g.term} <span style={{ color: "var(--accent)", fontSize: 11 }}>→ {g.translation}</span></div>
            </div>
          ))}
          {items.length === 0 && <div style={{ padding: 8, color: "var(--t3)", fontSize: 11 }}>空术语库 · 添加后 system prompt 强制使用 + 译后自动替换</div>}
        </div>
        <div className="lib-bottom">
          <span className="lib-entry" style={{ cursor: "default" }}>全局一张表 · 已译块不回改,重译生效</span>
        </div>
      </aside>
    </>
  );
}

// ---------- 主应用 ----------

function App() {
  const [view, setView] = useState<View>("interleave");
  const [doc, setDoc] = useState<{ article: Article; blocks: Block[] } | null>(null);
  const [vocab, setVocab] = useState<{ word: string; x: number; y: number; sentence?: string } | null>(null);
  const [vocabCount, setVocabCount] = useState(0);
  const [glossaryCount, setGlossaryCount] = useState(0);
  const [articles, setArticles] = useState<Article[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [setOpen, setSetOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dark, setDark] = useLocalFlag("v3-dark", false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [prefs, setPrefsState] = useState<Prefs | null>(null);
  const [direction, setDirection] = useState("en2zh");
  const [busy, setBusy] = useState(false); // 翻译会话进行中(可取消)
  const [streamErr, setStreamErr] = useState<string | null>(null); // 持久错误横幅
  const [termPop, setTermPop] = useState<{ hit: TermHit; x: number; y: number } | null>(null); // 术语高亮弹卡
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set()); // 段落级原文折叠(interleave)
  const sessionRef = useRef(0);
  const busyRef = useRef(false); // 供空依赖 keydown 闭包读取,与 busy 同步
  const fileRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number>(0);
  const markBusy = (v: boolean) => { busyRef.current = v; setBusy(v); };

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "";
  }, [dark]);

  const say = (m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };

  const refreshLib = () => api.listArticles().then(setArticles).catch(() => {});
  const refreshProviders = () => api.providerList().then(setProviders).catch(() => {});

  useEffect(() => {
    refreshLib();
    refreshProviders();
    api.getPrefs().then((p) => { setPrefsState(p); setDirection(p.direction); }).catch(() => {});
    api.vocabList().then((v) => setVocabCount(v.length)).catch(() => {});
    // 启动静默检查更新:有新版仅 toast 提示,不自动安装(在设置面板操作)
    checkUpdateFn().then((u) => { if (u) say(`发现新版本 v${u.version} · ⌘, 打开设置更新`); }).catch(() => {});    api.glossaryList().then((g) => setGlossaryCount(g.length)).catch(() => {});
  }, []);

  // 首启引导:无任何 provider 时自动打开设置
  const guidedRef = useRef(false);
  useEffect(() => {
    if (!guidedRef.current && providers.length === 0) {
      guidedRef.current = true;
      setSetOpen(true);
    } else if (providers.length > 0) {
      guidedRef.current = true;
    }
  }, [providers]);

  const applyPrefs = (u: Partial<Prefs>) => {
    api.setPrefs(u).then((p) => { setPrefsState(p); setDirection(p.direction); }).catch((e) => say(String(e)));
  };

  // 深色跨窗同步:主窗切换 → 广播,两窗(含隐藏的快捷窗)即时应用
  useEffect(() => {
    const un = listen("theme-changed", (e) => {
      const on = !!e.payload;
      localStorage.setItem("v3-dark", on ? "1" : "0");
      document.documentElement.dataset.theme = on ? "dark" : "";
    });
    return () => { un.then((f) => f()); };
  }, []);
  const toggleDark = (v: boolean) => {
    setDark(v);
    emit("theme-changed", v);
  };

  // 快捷键:⌘N 新建 · ⌘K 文章库 · ⌘R 续译 · ⌘, 设置 · Esc 取消翻译/关层
  // resumeOrDone/cancelCurrent 依赖 state,经 ref 转发避免空依赖闭包冻结首帧(否则 ⌘R 静默无效)
  const resumeRef = useRef<() => void>(() => {});
  const cancelRef = useRef<() => void>(() => {});
  useEffect(() => { resumeRef.current = resumeOrDone; cancelRef.current = cancelCurrent; });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); setComposing(true); }
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setPanel((p) => (p === "library" ? null : "library")); }
      if (mod && e.key.toLowerCase() === "r") { e.preventDefault(); resumeRef.current(); }
      if (mod && e.key === ",") { e.preventDefault(); setSetOpen(true); }
      if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        toggleDark(document.documentElement.dataset.theme !== "dark");
      }
      if (e.key === "Escape") {
        if (busyRef.current) { cancelRef.current(); return; } // 翻译中 Esc = 取消会话
        setPanel(null); setSetOpen(false); setVocab(null); setTermPop(null);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 事件:库变化 / 快捷窗请求打开文章 / 请求打开设置
  useEffect(() => {
    const subs = [
      listen("library-changed", () => refreshLib()),
      listen<{ id: number }>("open-article", (e) => { openArticle(e.payload.id); }),
      listen("open-settings", () => setSetOpen(true)),
    ];
    return () => { subs.forEach((u) => u.then((f) => f())); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openArticle = async (id: number) => {
    try {
      const d = await api.getArticle(id);
      setDoc(d);
      setExpanded(new Set());
    } catch (e) { say(String(e)); }
  };

  const lastArticleIdRef = useRef(-1);
  useEffect(() => {
    if (doc) lastArticleIdRef.current = doc.article.id;
  }, [doc?.article.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onStreamEvent = (e: StreamEvent) => {
    if (e.type === "created") {
      api.getArticle(e.article_id).then(setDoc).catch(() => {});
      refreshLib();
    } else if (e.type === "block") {
      const { idx, text, terms } = e;
      setDoc((d) =>
        d && d.article.id === lastArticleIdRef.current
          ? { ...d, blocks: d.blocks.map((b) => (b.idx === idx ? { ...b, trans: text, status: "done", terms } : b)) }
          : d,
      );
    } else if (e.type === "partial") {
      const { idx, text } = e;
      setDoc((d) =>
        d && d.article.id === lastArticleIdRef.current
          ? { ...d, blocks: d.blocks.map((b) => (b.idx === idx ? { ...b, trans: text, status: "streaming" } : b)) }
          : d,
      );
    } else if (e.type === "error") {
      setStreamErr(e.message);
      say(e.message);
      markBusy(false);
    } else if (e.type === "done") {
      refreshLib();
      markBusy(false);
    }
  };

  const startTranslate = async () => {
    if (!draft.trim()) return;
    setComposing(false);
    if (sessionRef.current) { try { await api.cancelTranslate(sessionRef.current); } catch {} }
    try {
      const s = await api.translate({ text: draft, direction, kind: "md" }, onStreamEvent);
      sessionRef.current = s;
      setDraft("");
      setStreamErr(null);
      markBusy(true);
      say("已开始翻译 · 流式上屏");
    } catch (e) { say(String(e)); }
  };

  const resumeOrDone = async () => {
    if (!doc) return;
    const pending = doc.blocks.filter((b) => b.status !== "done");
    if (!pending.length) { say("本文已全部译完"); return; }
    if (sessionRef.current) { try { await api.cancelTranslate(sessionRef.current); } catch {} } // 顶替旧会话,防其迟到 Error 误伤
    try {
      const s = await api.translate({ text: "", article_id: doc.article.id, direction: doc.article.direction, kind: "resume" }, onStreamEvent);
      sessionRef.current = s;
      setStreamErr(null);
      markBusy(true);
      say(`续译 ${pending.length} 块`);
    } catch (e) { say(String(e)); }
  };

  // 取消当前翻译会话;未完成块留在库里,可 ⌘R 续译
  const cancelCurrent = async () => {
    if (!sessionRef.current) return;
    try { await api.cancelTranslate(sessionRef.current); } catch {}
    markBusy(false);
    say("已取消 · 未完成块可 ⌘R 续译");
  };

  const word: WordHandler = (w2, x, y) => setVocab({ word: w2, x, y });

  const blocks = doc?.blocks ?? [];
  const pendingCount = blocks.filter((b) => b.status !== "done").length;
  const doneCount = blocks.length - pendingCount;
  const progress = blocks.length ? Math.round((doneCount / blocks.length) * 100) : 0;
  const filtered = useMemo(
    () => articles.filter((a) => a.title.toLowerCase().includes(query.toLowerCase())),
    [articles, query],
  );
  const activeProvider = providers.find((p) => p.is_active);

  // TOC:从块 src 抽 h1-h3(≥3 条才显示),点击平滑滚动到块
  const toc = useMemo(() => {
    if (!doc) return [];
    return doc.blocks
      .filter((b) => b.kind !== "code" && /^#{1,3}\s+\S/.test(b.src))
      .map((b) => ({ idx: b.idx, level: (b.src.match(/^#+/) ?? ["#"])[0].length, text: b.src.replace(/^#+\s*/, "").trim() }));
  }, [doc]);
  const jumpTo = (idx: number) =>
    document.querySelector(`[data-bidx="${idx}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  // 术语弹卡「停用」:按 from/to 在术语库中定位并禁用
  const disableTerm = async (hit: TermHit) => {
    try {
      const items = await api.glossaryList();
      const g = items.find((it) => it.term === hit.from || it.translation === hit.to);
      if (g) { await api.glossarySetEnabled(g.id, false); say(`已停用术语 ${g.term}(下次翻译起生效)`); }
      setTermPop(null);
    } catch (e) { say(String(e)); }
  };

  const En = ({ text }: { text: string }) => (
    <div className="en md"><Md text={text} onWord={(w, x, y) => setVocab({ word: w, x, y, sentence: text })} /></div>
  );
  const Zh = ({ b }: { b: Block }) => {
    let hits: TermHit[] = [];
    try { hits = b.terms ? JSON.parse(b.terms) : []; } catch { /* ignore */ }
    return b.trans ? (
      <div className={"zh md" + (b.status === "streaming" ? " streaming" : "")}>
        <Md text={b.trans} termHits={hits.length ? hits : undefined} onTerm={(t, x, y) => setTermPop({ hit: t, x, y })} />
      </div>
    ) : (
      <p className={"zh" + (b.status === "streaming" ? " streaming" : "")}>{b.status === "streaming" ? "…" : "待译"}</p>
    );
  };
  const TermChips = ({ b }: { b: Block }) => {
    let hits: { from: string; to: string }[] = [];
    try { hits = b.terms ? JSON.parse(b.terms) : []; } catch { /* ignore */ }
    if (!hits.length) return null;
    return (
      <div className="term-chip-row">
        <span className="chip label">术语库</span>
        {hits.map((h, i) => <span key={i} className="chip term">{h.from} → {h.to}</span>)}
      </div>
    );
  };

  return (
    <div className="app" onClick={() => { setVocab(null); setTermPop(null); }}>
      <div className="hairline"><i style={{ width: `${progress}%` }} /></div>

      {/* 顶栏 */}
      <header className="top">
        <button className="lib-btn" onClick={() => setPanel(panel === "library" ? null : "library")}>
          <Icon n="library" /> 文章库 <kbd>⌘K</kbd>
        </button>
        <span className="sp" />
        <span className="doc-name">{doc ? doc.article.title : "译读"}</span>
        <span className="sp" />
        <button className="icon-btn" title="设置(⌘,)" onClick={() => setSetOpen(true)}><Icon n="sliders" /></button>
      </header>

      {/* 正文 */}
      <div className="content">
        <div className="col">
          {!doc && (
            <div className="welcome">
              <h1>译读</h1>
              <p className="t2">本地优先的 markdown 翻译阅读器</p>
              <div className="welcome-steps">
                <div><kbd>⌘N</kbd> 新建翻译 · 粘贴或导入 .md</div>
                <div><kbd>⌘K</kbd> 打开文章库 · <kbd>⌘R</kbd> 续译未完成块</div>
                <div><kbd>⌥T</kbd> 唤出快捷翻译浮窗</div>
                <div>点任意英文单词查词收藏(免费词典 → 模型兜底)</div>
                {!activeProvider && <div className="warn" onClick={() => setSetOpen(true)}>⚠ 尚未配置 Provider — 点此打开设置</div>}
              </div>
            </div>
          )}
          {doc && (
            <div className="doc-head">
              <h1>{doc.article.title}</h1>
              <div className="meta">
                <span>{doc.article.kind === "md" ? "MD" : "粘贴"}</span>
                <span>{doc.article.direction === "zh2en" ? "中 → EN" : "EN → 中"}</span>
                <span>{doneCount}/{blocks.length} 块</span>
                <span>{fmtDate(doc.article.updated_at)}</span>
                {busy && (
                  <span className="resume-btn cancel-btn" onClick={cancelCurrent}>■ 取消(Esc)</span>
                )}
                {!busy && pendingCount > 0 && (
                  <span className="resume-btn" onClick={resumeOrDone}>▶ 续译 {pendingCount} 块(⌘R)</span>
                )}
              </div>
            </div>
          )}

          {doc && streamErr && (
            <div className="err-banner" onClick={() => setStreamErr(null)} title="点击关闭">
              ⚠ {streamErr}
              {!busy && pendingCount > 0 && " · 可 ⌘R 续译"}
            </div>
          )}

          {doc && view === "interleave" && blocks.map((b) =>
            b.kind === "code" ? (
              <CodeBox key={b.idx} src={b.src} />
            ) : (
              <div key={b.idx} data-bidx={b.idx} className={"pair" + (b.terms ? " term-row" : "")}>
                <div className="en-bar">
                  <button
                    className={"en-toggle" + (collapsed.has(b.idx) ? " stay" : "")}
                    title={collapsed.has(b.idx) ? "展开原文" : "收起原文"}
                    onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(b.idx)) n.delete(b.idx); else n.add(b.idx); return n; })}
                  >
                    {collapsed.has(b.idx) ? "▸ 原文" : "▾"}
                  </button>
                </div>
                {!collapsed.has(b.idx) && <En text={b.src} />}
                <Zh b={b} />
                <TermChips b={b} />
                {b.status === "streaming" && (
                  <div className="shimmer"><div className="track"><i /></div><span>翻译中 · 流式上屏</span></div>
                )}
              </div>
            ),
          )}

          {doc && view === "split" && (
            <>
              <div className="split-head"><span>原文 · {doc.article.direction === "zh2en" ? "中" : "EN"}</span><span>译文</span></div>
              {blocks.map((b) =>
                b.kind === "code" ? (
                  <div key={b.idx} style={{ padding: "14px 0" }}><CodeBox src={b.src} /></div>
                ) : (
                  <div key={b.idx} data-bidx={b.idx} className="split-row">
                    <div className="cell-l"><En text={b.src} /></div>
                    <div className="cell-r">
                      <Zh b={b} />
                      <TermChips b={b} />
                      {b.status === "streaming" && <div className="shimmer"><div className="track"><i /></div><span>翻译中</span></div>}
                    </div>
                  </div>
                ),
              )}
            </>
          )}

          {doc && view === "zh" && blocks.map((b) =>
            b.kind === "code" ? (
              <CodeBox key={b.idx} src={b.src} />
            ) : (
              <div key={b.idx} data-bidx={b.idx} className="pair">
                <Zh b={b} />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="orig-toggle" onClick={() => setExpanded((s) => new Set(s).add(b.idx))}>
                    {expanded.has(b.idx) ? "⌃ 收起原文" : "⌄ 原文"}
                  </button>
                </div>
                {expanded.has(b.idx) && <En text={b.src} />}
                <TermChips b={b} />
              </div>
            ),
          )}
        </div>
      </div>

      {/* 底部悬浮胶囊 */}
      <div className="capsule">
        <div className="cap-seg">
          <button title="双语对照" className={view === "interleave" ? "on" : ""} onClick={() => setView("interleave")}><Icon n="rows" size={17} /></button>
          <button title="分栏" className={view === "split" ? "on" : ""} onClick={() => setView("split")}><Icon n="cols" size={17} /></button>
          <button title="纯译文" className={view === "zh" ? "on" : ""} onClick={() => setView("zh")}><Icon n="lines" size={17} /></button>
        </div>
        <i className="cap-sep" />
        <button className="stat-btn" onClick={() => setPanel("glossary")} title="术语库管理">
          <Icon n="tag" size={15} /><span>术语</span><b>{glossaryCount}</b>
        </button>
        <button className="stat-btn" onClick={() => setPanel("vocab")} title="生词本">
          <Icon n="bookmark" size={15} /><span>生词</span><b>{vocabCount}</b>
        </button>
        <i className="cap-sep" />
        <button className="provider-chip" onClick={() => setSetOpen(true)}>
          <i className="dot" />{activeProvider ? activeProvider.model : "未配置"}<Icon n="chev" size={12} />
        </button>
        <button className="cap-icon" title="续译未完成块(⌘R)" onClick={resumeOrDone}>
          <Icon n="refresh" size={15} />
        </button>
      </div>
      <div className="capsule-hint">点英文单词查词收藏 · ⌘N 新建 · ⌘R 续译 · ⌥T 快捷窗</div>

      {/* TOC 目录侧轨:≥3 个标题才出现,hover 展开 */}
      {doc && toc.length >= 3 && (
        <nav className="toc-rail">
          <div className="toc-list">
            <span className="toc-hint">目录</span>
            {toc.map((t) => (
              <button
                key={t.idx}
                className={"toc-item" + (t.level >= 3 ? " lv3" : "")}
                title={t.text}
                onClick={() => jumpTo(t.idx)}
              >
                {t.text}
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* 术语高亮弹卡 */}
      {termPop && (
        <div className="term-pop" style={{ left: Math.min(termPop.x, window.innerWidth - 240), top: Math.min(termPop.y, window.innerHeight - 130) }}>
          <div className="row">
            <span className="from">{termPop.hit.from}</span>
            <span className="arrow">→</span>
            <span className="to">{termPop.hit.to}</span>
          </div>
          <div className="ops">
            <button onClick={() => disableTerm(termPop.hit)}>停用此术语</button>
            <button onClick={() => setTermPop(null)}>关闭</button>
          </div>
        </div>
      )}

      {/* 库 / 生词本 / 术语库 滑出层 */}
      {panel === "library" && (
        <>
          <div className="scrim" onClick={() => setPanel(null)} />
          <aside className="lib-panel" onClick={(e) => e.stopPropagation()}>
            <div className="lib-head">
              <b>文章库</b><span className="count">{articles.length}</span>
              <span className="sp" />
              <button className="lib-new" onClick={() => { setPanel(null); setComposing(true); }}>
                <Icon n="plus" size={13} /> 新建
              </button>
            </div>
            <div className="lib-search">
              <Icon n="search" size={14} />
              <input placeholder="搜索标题…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="lib-list">
              {filtered.map((a) => (
                <div
                  key={a.id}
                  className={"lib-item" + (doc?.article.id === a.id ? " active" : "")}
                  onClick={() => { setPanel(null); openArticle(a.id); }}
                >
                  <div className="meta">
                    <span>{a.kind === "md" ? "MD" : "粘贴"}</span>
                    <span>{fmtDate(a.updated_at)} · {a.blocks_done}/{a.blocks_total} 块</span>
                    {a.pinned && <span
                      onClick={(e) => { e.stopPropagation(); api.pinArticle(a.id, false).then(refreshLib); }}
                      style={{ color: "var(--accent)", cursor: "pointer" }}
                    >置顶</span>}
                    {!a.pinned && <span
                      onClick={(e) => { e.stopPropagation(); api.pinArticle(a.id, true).then(refreshLib); }}
                      style={{ color: "var(--t3)", cursor: "pointer" }}
                    >置顶?</span>}
                    <span
                      onClick={(e) => { e.stopPropagation(); if (window.confirm("删除这篇文章?")) { api.deleteArticle(a.id).then(() => { refreshLib(); if (doc?.article.id === a.id) setDoc(null); }); } }}
                      style={{ color: "var(--t3)", cursor: "pointer" }}
                    >删除</span>
                  </div>
                  <div className="t">{a.title}</div>
                </div>
              ))}
              {filtered.length === 0 && <div style={{ padding: 8, color: "var(--t3)", fontSize: 11 }}>无匹配 · ⌘N 新建翻译</div>}
            </div>
            <div className="lib-bottom">
              <button className="lib-entry" onClick={() => setPanel("glossary")}><Icon n="tag" size={15} /> 术语库 <b>{glossaryCount}</b></button>
              <button className="lib-entry" onClick={() => setPanel("vocab")}><Icon n="bookmark" size={15} /> 生词本 <b>{vocabCount}</b></button>
            </div>
          </aside>
        </>
      )}
      {panel === "vocab" && <VocabPanel onClose={() => setPanel(null)} onCount={setVocabCount} say={say} />}
      {panel === "glossary" && <GlossaryPanel onClose={() => setPanel(null)} say={say} />}

      {/* G3 全屏新建 */}
      {composing && (
        <div className="composer">
          <div className="comp-top">
            <button className="comp-cancel" onClick={() => setComposing(false)}><Icon n="x" size={14} /> 取消</button>
            <span className="comp-title">新建翻译</span>
            <span style={{ width: 64 }} />
          </div>
          <div className="comp-write">
            <div className="comp-panel">
              <textarea
                autoFocus
                value={draft}
                placeholder="粘贴要翻译的文本…(支持 markdown)"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startTranslate(); }}
                onDrop={async (e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) setDraft(await f.text());
                }}
                onDragOver={(e) => e.preventDefault()}
              />
              <div className="comp-drop" onClick={() => fileRef.current?.click()}>
                <Icon n="import" size={15} /> 拖入 .md / .txt 文件,或点击选择
              </div>
            </div>
          </div>
          <div className="comp-capsule">
            <span className="comp-count">{draft.length} 字</span>
            <button className="dir-chip" onClick={() => { const d = direction === "en2zh" ? "zh2en" : "en2zh"; setDirection(d); applyPrefs({ direction: d }); }}>
              <Icon n="swap" size={13} /> {direction === "en2zh" ? "EN → 中" : "中 → EN"}
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
              <Icon n="import" size={13} /> 导入 .md
            </button>
            <button className="btn-accent" disabled={!draft.trim()} onClick={startTranslate}>
              <Icon n="sparkles" size={13} /> 翻译 <kbd style={{ background: "rgba(255,255,255,.18)", color: "#fff", borderColor: "transparent" }}>⌘↩</kbd>
            </button>
          </div>
        </div>
      )}

      {/* S 设置滑出层 */}
      {setOpen && (
        <SettingsPanel
          onClose={() => setSetOpen(false)}
          prefs={prefs}
          applyPrefs={applyPrefs}
          dark={dark}
          setDark={toggleDark}
          providers={providers}
          refreshProviders={refreshProviders}
          say={say}
        />
      )}

      {vocab && (
        <VocabCard
          word={vocab.word}
          x={vocab.x}
          y={vocab.y}
          sentence={vocab.sentence}
          articleId={doc?.article.id}
          onClose={() => setVocab(null)}
          onAdded={() => { setVocabCount((c) => c + 1); say(`「${vocab.word}」已加入生词本`); }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.txt"
        style={{ display: "none" }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setDraft(await f.text());
          setComposing(true);
          e.target.value = "";
        }}
      />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
