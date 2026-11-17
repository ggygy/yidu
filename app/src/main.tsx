import { createRoot } from "react-dom/client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { check as checkUpdateFn } from "@tauri-apps/plugin-updater";
import { Md, PassBlock, type TermHit } from "./md";
import { isPassthrough, linkDefs, toUnits, type Unit } from "./blocks";
import { Icon } from "./icons";
import * as api from "./api";
import { dirLabel, langZh, splitDir, detectDir } from "./languages";
import { DirPicker } from "./dirselect";
import { IS_MAC, initNative } from "./native";
import { applyReading, stepScale } from "./reader";
import { ConfirmCard, Segmented, TbButton, fmtTokens } from "./ui";
import { IDLE, LiveStatus, MetricsDetail, reduceLive, sec, startLive, type Live } from "./metrics";
import { addUsage, EMPTY_USAGE } from "./types";
import type { Article, Block, DictCard, GlossaryItem, Prefs, Provider, SessionUsage, StreamEvent, VocabEntry } from "./types";
import "./styles.css";

initNative();

type View = "interleave" | "split" | "zh";
type Panel = "vocab" | "glossary" | null;

// 工具栏分段控件:对照 | 分栏 | 译文(§2.7.5;v0.2 的「纯净」并入译文视图,文本本就可自由选择)
const VIEWS = [["interleave", "对照"], ["split", "分栏"], ["zh", "译文"]] as const;

function useLocalFlag(key: string, init: boolean) {
  const [v, setV] = useState(() => (localStorage.getItem(key) === null ? init : localStorage.getItem(key) === "1"));
  return [v, (n: boolean) => { localStorage.setItem(key, n ? "1" : "0"); setV(n); }] as const;
}

function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  if (d.toDateString() === new Date().toDateString()) return "今天";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SOURCE_LABEL: Record<string, string> = {
  youdao: "有道词典(免费)",
  dictapi: "dictionaryapi.dev(免费)",
  model: "模型兜底",
  miss: "未收录",
};

// 点词卡:有道 → dictapi → 模型兜底;命中本地缓存即时返回
function VocabCard({ word, x, y, sentence, articleId, onClose, onAdded }: {
  word: string; x: number; y: number; sentence?: string; articleId?: number; onClose: () => void; onAdded: (n: number) => void;
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
    const def = card?.senses.map((s) => `${s.pos ? s.pos + ". " : ""}${s.gloss}`).join("; ") || card?.web_trans.join(";") || "(无释义)";
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
    } catch (e) { setErr(String(e)); }
  };

  const left = Math.min(x, window.innerWidth - 320);
  const top = Math.min(y + 14, window.innerHeight - 300);
  return (
    <div className="selectable fixed w-[300px] bg-surface rounded-xl shadow-[var(--shadow-card)] p-3.5 z-[60]" style={{ left: Math.max(8, left), top: Math.max(8, top) }} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2">
        <b className="text-[15px] font-semibold">{word}</b>
        <span className="text-[11px] text-t3">{card?.phonetic_us ? `/${card.phonetic_us}/` : card?.phonetic_uk ? `/${card.phonetic_uk}/` : ""}</span>
        <button title="发音" onClick={speak} className="tbtn ml-auto"><Icon n="volume" size={14} /></button>
      </div>
      {!card && !err && <p className="text-[12px] text-t3 mt-2 mb-0">查询中…</p>}
      {err && <p className="text-[12px] text-t3 mt-2 mb-0">{err}</p>}
      {card && (
        <>
          <p className="text-[11px] text-t3 mt-2 mb-0">释义 · {SOURCE_LABEL[card.source] ?? card.source}{card.source === "miss" ? " · 可手动加入生词本" : ""}</p>
          {card.senses.length > 0 && (
            <p className="text-[13px] leading-[1.6] text-t2 mt-0.5 mb-0">
              {card.senses.slice(0, 5).map((s, i) => <span key={i}>{s.pos && <b className="text-t3 font-medium">{s.pos}. </b>}{s.gloss}<br /></span>)}
            </p>
          )}
          {card.web_trans.length > 0 && <p className="text-[13px] leading-[1.6] text-t2 mt-0.5 mb-0">网络释义:{card.web_trans.slice(0, 3).join(";")}</p>}
          {card.examples.length > 0 && (
            <>
              <div className="h-px bg-line my-2.5" />
              <p className="text-[11px] text-t3 m-0">词典例句</p>
              {card.examples.slice(0, 2).map((ex, i) => (
                <p key={i} className="text-[12px] italic text-t2 leading-[1.6] mt-1 mb-0">“{ex.en}”{ex.zh ? <span className="text-t3">{ex.zh}</span> : null}</p>
              ))}
            </>
          )}
          {sentence && (
            <>
              <div className="h-px bg-line my-2.5" />
              <p className="text-[11px] text-t3 m-0">本文例句</p>
              <p className="text-[12px] italic text-t2 leading-[1.6] mt-1 mb-0">“{sentence.slice(0, 220)}{sentence.length > 220 ? "…" : ""}”</p>
            </>
          )}
        </>
      )}
      <div className="flex gap-2 mt-3 justify-end">
        <button className="btn" onClick={onClose}>忽略</button>
        <button className="btn primary" onClick={add}>加入生词本</button>
      </div>
    </div>
  );
}

// ---------- 生词本 / 术语库(弹出面板) ----------

function SheetPanel({ title, count, onClose, children, foot }: { title: string; count: number; onClose: () => void; children: React.ReactNode; foot: React.ReactNode }) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <aside className="fixed right-3 top-[60px] bottom-3 w-[320px] bg-surface rounded-xl shadow-[var(--shadow-card)] z-50 flex flex-col gap-2.5 px-3 pt-3 pb-2.5 [animation:fadein_0.15s]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-1">
          <b className="text-[13px] font-semibold">{title}</b><span className="text-[11px] text-t3">{count}</span>
          <span className="flex-1" />
          <TbButton icon="x" title="关闭" onClick={onClose} size={13} />
        </div>
        {children}
        <div className="border-t-[0.5px] border-line pt-2 px-1 text-[11px] text-t3">{foot}</div>
      </aside>
    </>
  );
}

function VocabPanel({ onClose, onCount, say }: { onClose: () => void; onCount: (n: number) => void; say: (m: string) => void }) {
  const [items, setItems] = useState<VocabEntry[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [examples, setExamples] = useState<string[]>([]);
  const refresh = () => api.vocabList().then((v) => { setItems(v); onCount(v.length); }).catch(() => {});
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <SheetPanel title="生词本" count={items.length} onClose={onClose} foot="点原文单词即可收藏">
      <div className="flex-1 overflow-y-auto flex flex-col gap-0.5">
        {items.map((v) => (
          <div
            key={v.id}
            className="group py-1.5 px-2 rounded-md flex flex-col gap-0.5 hover:bg-surface2"
            onClick={() => {
              if (openId === v.id) { setOpenId(null); return; }
              setOpenId(v.id);
              api.vocabExamples(v.id).then(setExamples).catch(() => setExamples([]));
            }}
          >
            <div className="text-[13px] text-t1 flex items-center gap-1.5">
              <span>{v.lemma}</span>{v.phonetic && <span className="text-t3 text-[11px]">/{v.phonetic}/</span>}
              <span className="flex-1" />
              <span className="text-[11px] text-t3">{v.source === "dict" ? "词典" : v.source === "model" ? "模型" : "手动"} · {v.examples} 例句</span>
              <button className="tbtn !w-5 !h-5 opacity-0 group-hover:opacity-100" title="删除" onClick={(e) => { e.stopPropagation(); api.vocabDelete(v.id).then(refresh); say("已删除"); }}><Icon n="x" size={11} /></button>
            </div>
            <div className="text-[12px] text-t2">{v.definition.slice(0, 90)}{v.definition.length > 90 ? "…" : ""}</div>
            {openId === v.id && examples.map((ex, i) => <div key={i} className="text-[11px] text-t3 mt-1 pl-2 border-l-2 border-line">“{ex.slice(0, 160)}”</div>)}
          </div>
        ))}
        {items.length === 0 && <div className="p-2 text-t3 text-[12px]">还没有生词 · 阅读时点任意英文词收藏</div>}
      </div>
    </SheetPanel>
  );
}

function GlossaryPanel({ onClose, say, onChanged }: { onClose: () => void; say: (m: string) => void; onChanged: (g: GlossaryItem[]) => void }) {
  const [items, setItems] = useState<GlossaryItem[]>([]);
  const [term, setTerm] = useState("");
  const [trans, setTrans] = useState("");
  const refresh = () => api.glossaryList().then((g) => { setItems(g); onChanged(g); }).catch(() => {});
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async () => {
    if (!term.trim() || !trans.trim()) return;
    await api.glossaryAdd(term.trim(), trans.trim());
    setTerm(""); setTrans("");
    refresh();
    say("术语已加入,下批翻译生效");
  };
  return (
    <SheetPanel title="术语库" count={items.length} onClose={onClose} foot="全局一张表 · 已译块不回改,重译生效">
      <div className="flex gap-1.5 items-center">
        <input className="field mono flex-1" placeholder="原文(如 hydration)" value={term} onChange={(e) => setTerm(e.target.value)} spellCheck={false} />
        <span className="text-t3">→</span>
        <input className="field mono flex-1" placeholder="译法(如 水合)" value={trans} onChange={(e) => setTrans(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} spellCheck={false} />
        <button className="btn primary" onClick={add}>添加</button>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-0.5">
        {items.map((g) => (
          <div key={g.id} className="group py-1.5 px-2 rounded-md flex items-center gap-2 text-[13px] hover:bg-surface2">
            <span className={g.enabled ? "text-t1" : "text-t3 line-through"}>{g.term}</span>
            <span className="text-t3">→</span>
            <span className={g.enabled ? "text-accent" : "text-t3"}>{g.translation}</span>
            <span className="flex-1" />
            <button className="btn !h-5 !px-2 !text-[11px] opacity-0 group-hover:opacity-100" onClick={() => api.glossarySetEnabled(g.id, !g.enabled).then(refresh)}>{g.enabled ? "停用" : "启用"}</button>
            <button className="tbtn !w-5 !h-5 opacity-0 group-hover:opacity-100" title="删除" onClick={() => { api.glossaryDelete(g.id).then(refresh); say("已删除"); }}><Icon n="x" size={11} /></button>
          </div>
        ))}
        {items.length === 0 && <div className="p-2 text-t3 text-[12px]">空术语库 · 添加后翻译时强制使用,并在译文中高亮</div>}
      </div>
    </SheetPanel>
  );
}

// ---------- 主应用 ----------

function App() {
  const [view, setView] = useState<View>(() => {
    const v = localStorage.getItem("yidu-view");
    return v === "split" || v === "zh" ? v : "interleave";
  });
  const [doc, setDoc] = useState<{ article: Article; blocks: Block[] } | null>(null);
  const [vocab, setVocab] = useState<{ word: string; x: number; y: number; sentence?: string } | null>(null);
  const [vocabCount, setVocabCount] = useState(0);
  const [glossary, setGlossary] = useState<GlossaryItem[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftFmt, setDraftFmt] = useState<"auto" | "md" | "plain">("auto"); // 原文格式(§2.2.5)
  const [panel, setPanel] = useState<Panel>(null);
  const [sideOpen, setSideOpen] = useLocalFlag("yidu-side", false); // 文章库侧栏:默认收起(☰ / ⌘K)
  const [inspOpen, setInspOpen] = useLocalFlag("yidu-insp", false); // 检查器:默认收起(ⓘ / ⌘I)
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<{ title: string; body?: string; confirmText: string; onConfirm: () => void } | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [prefs, setPrefsState] = useState<Prefs | null>(null);
  const [direction, setDirection] = useState("en2zh");
  const [busy, setBusy] = useState(false);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [termPop, setTermPop] = useState<{ hit: TermHit; x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [sessUsage, setSessUsage] = useState<SessionUsage>(EMPTY_USAGE);
  const [live, setLive] = useState<Live>(IDLE); // 阶段 / 计时 / 结束明细(§2.6.5–6)
  const sessionRef = useRef(0);
  const busyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number>(0);
  const markBusy = (v: boolean) => { busyRef.current = v; setBusy(v); };

  useEffect(() => { localStorage.setItem("yidu-view", view); }, [view]);


  const say = (m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };

  const refreshLib = () => api.listArticles().then(setArticles).catch(() => {});
  const openSettings = (section?: string) => { api.openSettings(section).catch((e) => say(String(e))); };

  useEffect(() => {
    refreshLib();
    // 首启引导:无任何服务商 → 打开设置窗的「模型」分区(以真实加载结果为准,避免初始空数组误触发)
    api.providerList().then((p) => { setProviders(p); if (p.length === 0) openSettings("models"); }).catch(() => {});
    api.getPrefs().then((p) => {
      setPrefsState(p);
      setDirection(p.direction);
      // v0.3 迁移:旧 localStorage 深色开关 → prefs.theme_mode(之后由 Rust set_theme 统一驱动)
      const old = localStorage.getItem("v3-dark");
      if (old !== null) {
        localStorage.removeItem("v3-dark");
        if (old === "1" && p.theme_mode === "system") api.setPrefs({ theme_mode: "dark" }).catch(() => {});
      }
    }).catch(() => {});
    api.vocabList().then((v) => setVocabCount(v.length)).catch(() => {});
    checkUpdateFn().then((u) => { if (u) say(`发现新版本 v${u.version} · 菜单「译读 › 检查更新…」`); }).catch(() => {});
    api.glossaryList().then(setGlossary).catch(() => {});
    api.hotkeyStatus().then((h) => { if (h.error) say("快捷窗热键注册失败(可能被占用)· 在设置里改键"); }).catch(() => {});
    const subs = [
      listen<Prefs>("prefs-changed", (e) => { setPrefsState(e.payload); setDirection(e.payload.direction); }),
      listen<Provider[]>("providers-changed", (e) => setProviders(e.payload)),
    ];
    return () => { subs.forEach((u) => u.then((f) => f())); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 阅读字号 / 密度(prefs,三窗经 prefs-changed 同步)
  useEffect(() => { applyReading("main", prefs?.main_scale ?? 1, prefs?.density ?? "standard"); }, [prefs?.main_scale, prefs?.density]);
  const zoom = (dir: "zoom-in" | "zoom-out" | "zoom-reset") => {
    const next = stepScale(prefs?.main_scale ?? 1, dir);
    applyPrefs({ main_scale: next });
    say(`字号 ${Math.round(next * 100)}%`);
  };

  const applyPrefs = (u: Partial<Prefs>) => {
    api.setPrefs(u).then((p) => { setPrefsState(p); setDirection(p.direction); }).catch((e) => say(String(e)));
  };

  // 菜单路由(Rust 原生菜单 → "menu" 事件);state 依赖经 ref 转发,避免空依赖闭包冻结首帧
  const actionsRef = useRef<Record<string, () => void>>({});
  actionsRef.current = {
    new: () => setComposing(true),
    resume: () => resumeOrDone(),
    library: () => { const open = !sideOpen; setSideOpen(open); if (open) window.setTimeout(() => searchRef.current?.focus(), 60); },
    inspector: () => setInspOpen(!inspOpen),
    cancel: () => cancelCurrent(),
    "zoom-in": () => zoom("zoom-in"),
    "zoom-out": () => zoom("zoom-out"),
    "zoom-reset": () => zoom("zoom-reset"),
  };
  useEffect(() => {
    const un = listen<string>("menu", (e) => actionsRef.current[e.payload]?.());
    return () => { un.then((f) => f()); };
  }, []);

  // 键盘:Esc 取消 / 关层;1–3 切视图(无修饰键,输入框内不响应)。
  // ⌘N / ⌘K / ⌘R / ⌘I / ⌘, / ⌘L 在 macOS 由原生菜单承担(防双触发);其他平台无应用菜单,仍走 JS
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!mod && !typing && ["1", "2", "3"].includes(e.key)) { setView(VIEWS[Number(e.key) - 1][0]); return; }
      if (!IS_MAC && mod) {
        const k = e.key.toLowerCase();
        const map: Record<string, string> = { n: "new", k: "library", r: "resume", i: "inspector", "=": "zoom-in", "+": "zoom-in", "-": "zoom-out", "0": "zoom-reset" };
        if (map[k]) { e.preventDefault(); actionsRef.current[map[k]](); return; }
        if (k === ",") { e.preventDefault(); openSettings(); return; }
      }
      if (e.key === "Escape") {
        if (busyRef.current) { actionsRef.current.cancel(); return; }
        setPanel(null); setVocab(null); setTermPop(null); setComposing(false);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 库变化 / 快捷窗请求打开文章
  useEffect(() => {
    const subs = [
      listen("library-changed", () => refreshLib()),
      listen<{ id: number }>("open-article", (e) => { openArticle(e.payload.id); }),
    ];
    return () => { subs.forEach((u) => u.then((f) => f())); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openArticle = async (id: number) => {
    try {
      setDoc(await api.getArticle(id));
      setExpanded(new Set());
      setComposing(false);
    } catch (e) { say(String(e)); }
  };

  // 当前流式会话的文章 id:created 到达时同步写入,紧随其后的 block/partial 才不会被丢
  const streamArticleRef = useRef(-1);

  const onStreamEvent = (e: StreamEvent) => {
    setLive((l) => reduceLive(l, e));
    if (e.type === "created") {
      streamArticleRef.current = e.article_id;
      setDoc({ article: e.article, blocks: e.blocks });
      setExpanded(new Set());
      refreshLib();
    } else if (e.type === "usage") {
      setSessUsage((u) => addUsage(u, e));
    } else if (e.type === "block") {
      const { idx, text, terms } = e;
      setDoc((d) => d && d.article.id === streamArticleRef.current
        ? { ...d, blocks: d.blocks.map((b) => (b.idx === idx ? { ...b, trans: text, status: "done", terms, format_warn: e.format_warn } : b)) }
        : d);
    } else if (e.type === "partial") {
      const { idx, text } = e;
      setDoc((d) => d && d.article.id === streamArticleRef.current
        ? { ...d, blocks: d.blocks.map((b) => (b.idx === idx ? { ...b, trans: text, status: "streaming" } : b)) }
        : d);
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
    const effDir = direction === "auto" ? detectDir(draft) : direction;
    try {
      setSessUsage(EMPTY_USAGE);
      setLive(startLive());
      sessionRef.current = await api.translate({ text: draft, direction: effDir, kind: "md", format: draftFmt }, onStreamEvent);
      setDraft("");
      setStreamErr(null);
      markBusy(true);
    } catch (e) { say(String(e)); }
  };

  const resumeOrDone = async () => {
    if (!doc) return;
    const pending = doc.blocks.filter((b) => b.status !== "done");
    if (!pending.length) { say("本文已全部译完"); return; }
    if (sessionRef.current) { try { await api.cancelTranslate(sessionRef.current); } catch {} }
    try {
      setSessUsage(EMPTY_USAGE);
      setLive(startLive());
      sessionRef.current = await api.translate({ text: "", article_id: doc.article.id, direction: doc.article.direction, kind: "resume" }, onStreamEvent);
      setStreamErr(null);
      markBusy(true);
      say(`续译 ${pending.length} 块`);
    } catch (e) { say(String(e)); }
  };

  const cancelCurrent = async () => {
    if (!sessionRef.current) return;
    try { await api.cancelTranslate(sessionRef.current); } catch {}
    markBusy(false);
    setLive((l) => ({ ...l, running: false }));
    say("已取消 · 未完成块可续译");
  };

  // 单元重译:清空该单元各块 → 续译(只剩它们待译)
  const retryUnit = async (u: Unit) => {
    if (!doc) return;
    try {
      for (const b of u.blocks) await api.resetBlock(doc.article.id, b.idx);
      const ids = new Set(u.blocks.map((b) => b.idx));
      const next = { ...doc, blocks: doc.blocks.map((b) => (ids.has(b.idx) ? { ...b, trans: "", status: "pending" as const, format_warn: "", terms: "" } : b)) };
      setDoc(next);
      if (sessionRef.current) { try { await api.cancelTranslate(sessionRef.current); } catch {} }
      setSessUsage(EMPTY_USAGE);
      setLive(startLive());
      sessionRef.current = await api.translate({ text: "", article_id: doc.article.id, direction: doc.article.direction, kind: "resume" }, onStreamEvent);
      setStreamErr(null);
      markBusy(true);
    } catch (e) { say(String(e)); }
  };

  const blocks = doc?.blocks ?? [];
  const pendingCount = blocks.filter((b) => b.status !== "done").length;
  const doneCount = blocks.length - pendingCount;
  const progress = blocks.length ? Math.round((doneCount / blocks.length) * 100) : 0;
  const filtered = useMemo(() => articles.filter((a) => a.title.toLowerCase().includes(query.toLowerCase())), [articles, query]);
  const activeProvider = providers.find((p) => p.is_active);

  // 目录:h1–h3(≥3 条才显示)
  const toc = useMemo(() => {
    if (!doc) return [];
    return doc.blocks
      .filter((b) => b.kind !== "code" && /^#{1,3}\s+\S/.test(b.src))
      .map((b) => ({ idx: b.idx, level: (b.src.match(/^#+/) ?? ["#"])[0].length, text: b.src.replace(/^#+\s*/, "").trim() }));
  }, [doc]);
  const jumpTo = (idx: number) => document.querySelector(`[data-bidx="${idx}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  // 本文术语命中(检查器):块级 terms JSON 汇总
  const termHitsInDoc = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of blocks) {
      if (!b.terms) continue;
      try { for (const t of JSON.parse(b.terms) as TermHit[]) m.set(t.from, t.to); } catch { /* 旧数据 */ }
    }
    return [...m.entries()];
  }, [blocks]);

  const disableTerm = async (hit: TermHit) => {
    try {
      const items = await api.glossaryList();
      const g = items.find((it) => it.term === hit.from || it.translation === hit.to);
      if (g) { await api.glossarySetEnabled(g.id, false); say(`已停用术语 ${g.term}(下次翻译起生效)`); }
      setGlossary(await api.glossaryList());
      setTermPop(null);
    } catch (e) { say(String(e)); }
  };

  const En = ({ text, cls }: { text: string; cls?: string }) => (
    <div className={"en md " + (cls ?? "text-[length:var(--en-size)] leading-[var(--en-line)]")}><Md text={text} defs={defs} onWord={(w, x, y) => setVocab({ word: w, x, y, sentence: text })} /></div>
  );
  const glossaryHits: TermHit[] = useMemo(() => glossary.filter((g) => g.enabled).map((g) => ({ from: g.term, to: g.translation })), [glossary]);
  const units = useMemo(() => toUnits(blocks), [blocks]);
  const defs = useMemo(() => linkDefs(blocks), [blocks]);
  // 译文单元(组内未译完的项用原文占位,保持列表结构)+「格式可能有误 · 重译」
  const ZhUnit = ({ u }: { u: Unit }) => (
    <>
      {u.translated ? (
        <div className={"zh md" + (u.streaming ? " streaming" : "")}>
          <Md text={u.trans} defs={defs} termHits={glossaryHits.length ? glossaryHits : undefined} onTerm={(t, x, y) => setTermPop({ hit: t, x, y })} />
        </div>
      ) : (
        <p className="zh m-0 text-t3 !text-[13px]">{u.streaming ? <span className="caret" /> : "待译"}</p>
      )}
      {u.warn && !busy && (
        <button className="self-start inline-flex items-center gap-1.5 h-[22px] px-2 rounded-md border-none bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger text-[11px]" title={`${u.warn}(已自动重译一次)`} onClick={() => retryUnit(u)}>
          格式可能有误 · 重译
        </button>
      )}
    </>
  );

  const price = prefs?.price_per_mtok ?? 0;

  return (
    <div className="h-screen flex flex-col overflow-hidden mat" onClick={() => { setVocab(null); setTermPop(null); }}>
      {/* 统一工具栏(52pt,红绿灯 {20,28} 中线对齐) */}
      <header className="tb" data-tauri-drag-region>
        <Segmented value={view} options={VIEWS} onChange={setView} />
        <span className="flex-1 min-w-[12px] self-stretch" data-tauri-drag-region />
        <span className="text-[13px] font-semibold truncate max-w-[40%]" data-tauri-drag-region>{composing ? "新建翻译" : doc ? doc.article.title : "译读"}</span>
        <span className="flex-1 min-w-[12px] self-stretch" data-tauri-drag-region />
        {doc && !inspOpen && !composing && (
          <span className="flex items-center gap-2 text-[11px] text-t3 whitespace-nowrap flex-none" title={`${doneCount}/${blocks.length} 块`}>
            {busy && live.running && <LiveStatus live={live} />}
            <span className="w-[64px] h-[5px] rounded-full bg-fill2 overflow-hidden"><i className="block h-full bg-accent transition-[width] duration-500" style={{ width: `${progress}%` }} /></span>
            {doneCount}/{blocks.length}
            {!busy && live.metrics ? ` · 首字 ${sec(live.metrics.ttft_ms)} · 总 ${sec(live.metrics.total_ms)}` : sessUsage.requests ? ` · ${fmtTokens(sessUsage.completion_tokens)} tok` : ""}
          </span>
        )}
        <span className="flex items-center gap-0.5 flex-none">
          <TbButton icon="plus" title="新建翻译(⌘N)" active={composing} onClick={() => setComposing(!composing)} />
          <TbButton icon="library" title="文章库(⌘K)" active={sideOpen} onClick={() => actionsRef.current.library()} />
          <TbButton icon="info" title="检查器(⌘I)" active={inspOpen} onClick={() => setInspOpen(!inspOpen)} />
          <TbButton icon="sliders" title="设置(⌘,)" onClick={() => openSettings()} />
        </span>
      </header>

      <div
        className="flex-1 min-h-0 grid transition-[grid-template-columns] duration-200 ease-out"
        style={{ gridTemplateColumns: `${sideOpen ? 240 : 0}px minmax(0,1fr) ${inspOpen ? 248 : 0}px` }}
      >
        {/* 文章库侧栏(材质) */}
        <aside className={"min-w-0 overflow-hidden flex flex-col " + (sideOpen ? "border-r-[0.5px] border-line" : "")} onClick={(e) => e.stopPropagation()}>
          <div className="w-[240px] flex flex-col min-h-0 flex-1">
            <div className="px-2.5 pt-2.5 pb-1.5">
              <div className="h-[26px] rounded-md bg-surface2 flex items-center px-2 gap-1.5 text-t3">
                <Icon n="search" size={13} />
                <input ref={searchRef} className="border-none outline-none bg-transparent w-full text-[12px] text-t1 placeholder:text-t3" placeholder="搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-2 flex flex-col gap-px">
              {filtered.some((a) => a.pinned) && <div className="text-[11px] font-semibold text-t3 px-2 pt-2 pb-1">置顶</div>}
              {[...filtered.filter((a) => a.pinned), ...filtered.filter((a) => !a.pinned)].map((a, i, arr) => (
                <React.Fragment key={a.id}>
                  {!a.pinned && (i === 0 || arr[i - 1].pinned) && <div className="text-[11px] font-semibold text-t3 px-2 pt-2 pb-1">最近</div>}
                  <div
                    className={"group px-2 py-1.5 rounded-md " + (doc?.article.id === a.id ? "bg-fill2" : "hover:bg-surface2")}
                    onClick={() => openArticle(a.id)}
                  >
                    <div className="flex items-center gap-1">
                      <span className="text-[13px] text-t1 truncate flex-1">{a.title}</span>
                      <button className="tbtn !w-5 !h-5 opacity-0 group-hover:opacity-100" title={a.pinned ? "取消置顶" : "置顶"} onClick={(e) => { e.stopPropagation(); api.pinArticle(a.id, !a.pinned).then(refreshLib); }}><Icon n="pin" size={11} /></button>
                      <button
                        className="tbtn !w-5 !h-5 opacity-0 group-hover:opacity-100"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirm({ title: "删除这篇文章?", body: a.title, confirmText: "删除", onConfirm: () => { api.deleteArticle(a.id).then(() => { refreshLib(); if (doc?.article.id === a.id) setDoc(null); say("已删除"); }); } });
                        }}
                      ><Icon n="x" size={11} /></button>
                    </div>
                    <div className="text-[11px] text-t3">{fmtDate(a.updated_at)} · {a.blocks_done === a.blocks_total ? "已译完" : `${a.blocks_done}/${a.blocks_total}`} · {a.kind === "md" ? "md" : "粘贴"}</div>
                  </div>
                </React.Fragment>
              ))}
              {filtered.length === 0 && <div className="px-2 py-2 text-t3 text-[12px]">{query ? "无匹配" : "还没有文章"}</div>}
            </div>
            <div className="border-t-[0.5px] border-line p-2 flex flex-col gap-px">
              <div className="text-[11px] font-semibold text-t3 px-2 pb-1">资料</div>
              <button className="flex items-center gap-2 h-7 px-2 rounded-md border-none bg-transparent text-[13px] text-t1 hover:bg-surface2" onClick={() => setPanel("glossary")}><Icon n="tag" size={14} />术语库<span className="ml-auto text-[11px] text-t3">{glossary.length}</span></button>
              <button className="flex items-center gap-2 h-7 px-2 rounded-md border-none bg-transparent text-[13px] text-t1 hover:bg-surface2" onClick={() => setPanel("vocab")}><Icon n="bookmark" size={14} />生词本<span className="ml-auto text-[11px] text-t3">{vocabCount}</span></button>
            </div>
          </div>
        </aside>

        {/* 文档区:实底 */}
        <main className="relative min-w-0 min-h-0 bg-doc">
          <div className="doc absolute inset-0 overflow-y-auto">
            <div className={"max-w-[760px] mx-auto px-10 pt-8 pb-24 flex flex-col " + (view === "zh" ? "gap-[calc(var(--pair-gap)*0.5)]" : "gap-[var(--pair-gap)]")}>
              {!doc && (
                <div className="flex flex-col items-center justify-center min-h-[60vh] gap-2 text-center">
                  <div className="w-14 h-14 rounded-[14px] grid place-items-center text-[26px] font-bold text-white mb-2 shadow-[0_6px_18px_color-mix(in_srgb,var(--accent)_35%,transparent)]" style={{ background: "linear-gradient(145deg, color-mix(in srgb, var(--accent) 80%, white), var(--accent))" }}>译</div>
                  <h1 className="text-[28px] font-bold m-0">译读</h1>
                  <p className="text-t2 text-[13px] m-0">本地优先的 markdown 翻译阅读器</p>
                  <div className="flex items-center gap-2 mt-3">
                    <button className="btn" onClick={() => actionsRef.current.library()}>打开文章库</button>
                    <button className="btn primary" title="⌘N" onClick={() => setComposing(true)}>新建翻译</button>
                  </div>
                  {providers.length > 0 && !activeProvider && (
                    <button className="border-none bg-transparent text-accent text-[12px] mt-2" onClick={() => openSettings("models")}>尚未选择使用中的模型 · 打开设置</button>
                  )}
                  {providers.length === 0 && (
                    <button className="border-none bg-transparent text-accent text-[12px] mt-2" onClick={() => openSettings("models")}>尚未配置翻译模型 · 打开设置,粘贴 API 密钥即可开始</button>
                  )}
                  <p className="text-t3 text-[12px] mt-5 mb-0">阅读时点任意英文单词即可查词收藏</p>
                </div>
              )}
              {doc && (
                <div className="pb-1">
                  <h1 className="text-[28px] font-bold leading-[1.25] tracking-[-0.01em] m-0 selectable">{doc.article.title}</h1>
                  <div className="text-[12px] text-t3 mt-2 flex gap-2 flex-wrap items-center">
                    <span>{doc.article.kind === "md" ? "md" : "粘贴"}</span>·
                    <span>{dirLabel(doc.article.direction)}</span>·
                    <span>{doneCount}/{blocks.length} 块</span>·
                    <span>{fmtDate(doc.article.updated_at)}</span>
                    {!busy && pendingCount > 0 && <button className="btn !h-[20px] !text-[11px] ml-1" title="⌘R" onClick={resumeOrDone}>续译 {pendingCount} 块</button>}
                  </div>
                </div>
              )}

              {doc && streamErr && (
                <div className="text-danger text-[12px] bg-surface2 rounded-md px-3 py-2" onClick={() => setStreamErr(null)} title="点击关闭">
                  {streamErr}{!busy && pendingCount > 0 && " · 可续译未完成块"}
                </div>
              )}

              {doc && view === "interleave" && units.map((u) =>
                isPassthrough(u.kind) ? <div key={u.key} data-bidx={u.blocks[0].idx}><PassBlock kind={u.kind} src={u.src} /></div> : (
                  <div key={u.key} data-bidx={u.blocks[0].idx} className={"group relative flex flex-col gap-1.5 " + (u.terms ? "border-l-2 border-accent pl-3" : "")}>
                    <button
                      className={"absolute -right-7 top-0 tbtn !w-6 !h-6 text-[11px] " + (collapsed.has(u.blocks[0].idx) ? "" : "opacity-0 group-hover:opacity-100")}
                      title={collapsed.has(u.blocks[0].idx) ? "展开原文" : "收起原文"}
                      onClick={() => setCollapsed((s) => { const k = u.blocks[0].idx; const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                    >{collapsed.has(u.blocks[0].idx) ? "▸" : "▾"}</button>
                    {!collapsed.has(u.blocks[0].idx) && <En text={u.src} />}
                    <ZhUnit u={u} />
                  </div>
                ),
              )}

              {doc && view === "split" && (
                <>
                  <div className="grid grid-cols-2 gap-6 text-[11px] text-t3 font-semibold border-b-[0.5px] border-line pb-2">
                    <span>原文 · {langZh(splitDir(doc.article.direction)[0])}</span><span>译文 · {langZh(splitDir(doc.article.direction)[1])}</span>
                  </div>
                  {units.map((u) =>
                    isPassthrough(u.kind) ? <div key={u.key} data-bidx={u.blocks[0].idx}><PassBlock kind={u.kind} src={u.src} /></div> : (
                      <div key={u.key} data-bidx={u.blocks[0].idx} className="grid grid-cols-2 gap-6">
                        <div className="min-w-0"><En text={u.src} /></div>
                        <div className="min-w-0"><ZhUnit u={u} /></div>
                      </div>
                    ),
                  )}
                </>
              )}

              {doc && view === "zh" && units.map((u) =>
                isPassthrough(u.kind) ? <div key={u.key} data-bidx={u.blocks[0].idx}><PassBlock kind={u.kind} src={u.src} /></div> : (
                  <div key={u.key} data-bidx={u.blocks[0].idx} className="group relative flex flex-col gap-1">
                    <button
                      className={"absolute -right-7 top-0 tbtn !w-6 !h-6 text-[11px] " + (expanded.has(u.blocks[0].idx) ? "" : "opacity-0 group-hover:opacity-100")}
                      title={expanded.has(u.blocks[0].idx) ? "收起原文" : "查看原文"}
                      onClick={() => setExpanded((s) => { const k = u.blocks[0].idx; const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                    >{expanded.has(u.blocks[0].idx) ? "▾" : "▸"}</button>
                    <ZhUnit u={u} />
                    {expanded.has(u.blocks[0].idx) && <En text={u.src} />}
                  </div>
                ),
              )}
            </div>
          </div>

          {/* 目录:≥3 个标题才出现,hover 展开 */}
          {doc && toc.length >= 3 && !composing && (
            <nav className="group absolute left-0 top-6 bottom-6 z-10 flex items-start pointer-events-none">
              <div className="pointer-events-auto bg-surface rounded-r-lg shadow-[var(--shadow-ctl)] py-2 px-1 w-7 max-h-full overflow-hidden overflow-y-auto transition-[width] duration-200 ease-out group-hover:w-[230px] group-hover:px-2">
                <span className="[writing-mode:vertical-rl] text-[11px] text-t3 tracking-[4px] pl-1 whitespace-nowrap group-hover:hidden">目录</span>
                {toc.map((t) => (
                  <button
                    key={t.idx}
                    className={"hidden group-hover:block w-full border-none bg-transparent text-left text-t2 py-1 px-2 rounded-md truncate hover:text-t1 hover:bg-surface2 " + (t.level >= 3 ? "pl-5 text-[12px] text-t3" : "text-[12px]")}
                    title={t.text}
                    onClick={() => jumpTo(t.idx)}
                  >{t.text}</button>
                ))}
              </div>
            </nav>
          )}

          {/* 新建翻译(覆盖文档区) */}
          {composing && (
            <div className="absolute inset-0 bg-doc z-20 flex flex-col [animation:fadein_0.15s]" onClick={(e) => e.stopPropagation()}>
              <div className="flex-1 overflow-y-auto flex flex-col items-center px-10 pt-7">
                <div className="w-full max-w-[720px] flex flex-col">
                  <textarea
                    autoFocus
                    className="w-full min-h-[320px] border-none outline-none resize-none text-[15px] leading-[1.8] text-t1 bg-transparent placeholder:text-t3"
                    value={draft}
                    placeholder="粘贴要翻译的文本(支持 markdown),或拖入 .md / .txt 文件"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startTranslate(); }}
                    onDrop={async (e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setDraft(await f.text()); }}
                    onDragOver={(e) => e.preventDefault()}
                  />
                </div>
              </div>
              <div className="h-[46px] flex-none flex items-center gap-2.5 px-4 border-t-[0.5px] border-line">
                <span className="text-[11px] text-t3 whitespace-nowrap">{draft.length} 字</span>
                <DirPicker value={direction} onChange={(d) => { setDirection(d); applyPrefs({ direction: d }); }} />
                <Segmented value={draftFmt} options={[["auto", "自动"], ["md", "Markdown"], ["plain", "纯文本"]] as const} onChange={setDraftFmt} />
                <span className="flex-1" />
                <button className="btn" onClick={() => setComposing(false)}>取消</button>
                <button className="btn" onClick={() => fileRef.current?.click()}>导入 .md…</button>
                <button className="btn primary" disabled={!draft.trim()} title="⌘↩" onClick={startTranslate}>翻译</button>
              </div>
            </div>
          )}
        </main>

        {/* 检查器(材质):进度 / 本次翻译 / 术语命中 */}
        <aside className={"min-w-0 overflow-hidden " + (inspOpen ? "border-l-[0.5px] border-line" : "")} onClick={(e) => e.stopPropagation()}>
          <div className="w-[248px] h-full overflow-y-auto px-3.5 py-3 text-[12px]">
            <h5 className="text-[11px] font-semibold text-t3 m-0 mb-1.5">进度</h5>
            {doc ? (
              <>
                <div className="h-[5px] rounded-full bg-fill2 overflow-hidden"><i className="block h-full bg-accent transition-[width] duration-500" style={{ width: `${progress}%` }} /></div>
                <KV k="块" v={`${doneCount} / ${blocks.length}`} />
                <div className="flex gap-2 mt-2">
                  {busy ? <button className="btn" onClick={cancelCurrent}>取消翻译</button>
                    : pendingCount > 0 ? <button className="btn primary" onClick={resumeOrDone}>续译 {pendingCount} 块</button> : null}
                </div>
              </>
            ) : <p className="text-t3 m-0">未打开文章</p>}
            <h5 className="text-[11px] font-semibold text-t3 m-0 mt-4 mb-1.5">本次翻译</h5>
            {live.running ? (
              <>
                <div className="text-[12px] text-t2 py-1"><LiveStatus live={live} /></div>
                {live.thinkTail && <p className="selectable text-[11px] text-t3 leading-snug m-0 line-clamp-4">…{live.thinkTail}</p>}
                <KV k="输入" v={sessUsage.requests ? sessUsage.prompt_tokens.toLocaleString() : "—"} />
                <KV k="输出" v={sessUsage.requests ? sessUsage.completion_tokens.toLocaleString() : "—"} />
              </>
            ) : live.metrics ? (
              <MetricsDetail m={live.metrics} price={price} cachedPrice={prefs?.cached_price_per_mtok} thinkTail={live.thinkTail} />
            ) : (
              <>
                <KV k="模型" v={activeProvider?.model ?? "未配置"} />
                <p className="text-t3 m-0 mt-1">翻译后显示首字、耗时、速度与成本</p>
              </>
            )}
            <h5 className="text-[11px] font-semibold text-t3 m-0 mt-4 mb-1.5">术语命中</h5>
            {termHitsInDoc.length ? termHitsInDoc.map(([f, t]) => <KV key={f} k={f} v={t} />) : <p className="text-t3 m-0">无</p>}
          </div>
        </aside>
      </div>

      {/* 术语高亮弹卡 */}
      {termPop && (
        <div className="fixed z-[70] bg-surface rounded-lg shadow-[var(--shadow-card)] px-3 py-2.5 min-w-[200px]" style={{ left: Math.min(termPop.x, window.innerWidth - 240), top: Math.min(termPop.y, window.innerHeight - 130) }} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-code text-[12px] text-t2">{termPop.hit.from}</span><span className="text-t3">→</span><span className="text-accent font-semibold">{termPop.hit.to}</span>
          </div>
          <div className="flex gap-2 mt-2 justify-end">
            <button className="btn" onClick={() => setTermPop(null)}>关闭</button>
            <button className="btn" onClick={() => disableTerm(termPop.hit)}>停用此术语</button>
          </div>
        </div>
      )}

      {panel === "vocab" && <VocabPanel onClose={() => setPanel(null)} onCount={setVocabCount} say={say} />}
      {panel === "glossary" && <GlossaryPanel onClose={() => setPanel(null)} say={say} onChanged={setGlossary} />}

      {vocab && (
        <VocabCard
          word={vocab.word} x={vocab.x} y={vocab.y} sentence={vocab.sentence} articleId={doc?.article.id}
          onClose={() => setVocab(null)}
          onAdded={() => { setVocabCount((c) => c + 1); say(`「${vocab.word}」已加入生词本`); }}
        />
      )}
      <input
        ref={fileRef} type="file" accept=".md,.markdown,.txt" className="hidden"
        onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setDraft(await f.text()); setComposing(true); e.target.value = ""; }}
      />
      {confirm && <ConfirmCard title={confirm.title} body={confirm.body} confirmText={confirm.confirmText} onConfirm={confirm.onConfirm} onClose={() => setConfirm(null)} />}
      {toast && <div className="toast fixed bottom-6 left-1/2 -translate-x-1/2 z-[99]">{toast}</div>}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-t2">
      <span className="truncate">{k}</span><b className="text-t1 font-medium tabular-nums truncate">{v}</b>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
