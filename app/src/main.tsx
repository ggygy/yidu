import { createRoot } from "react-dom/client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkUpdateFn } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { CodeBox, Md, type TermHit, type WordHandler } from "./md";
import { Icon } from "./icons";
import * as api from "./api";
import { dirLabel, langZh, splitDir } from "./languages";
import { DirPicker } from "./dirselect";
import { applyReaderStyle, loadReaderStyle, RS_ACCENTS, RS_DEFAULT, type ReaderStyle } from "./reader";
import type { Article, Block, DictCard, GlossaryItem, Prefs, Provider, StreamEvent, UsageSummary, VocabEntry } from "./types";
import "./styles.css";

type View = "interleave" | "split" | "zh" | "pure";
type Panel = "library" | "vocab" | "glossary" | null;

// macOS 顶栏需给系统红绿灯让位;Windows 有原生标题栏,正常内边距
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

// 视图切换配置:v4 胶囊 = 图标 + 文字,功能一目了然
const VIEWS: [View, string, string][] = [
  ["interleave", "对照", "rows"],
  ["split", "分栏", "cols"],
  ["zh", "译文", "lines"],
  ["pure", "纯净", "eye"],
];

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

// ---------- 阅读外观自定义(实现抽到 reader.ts,两窗共用) ----------

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
    <div className="fixed w-[300px] bg-surface border border-line rounded-2xl shadow-[var(--shadow-card)] p-4 z-[60]" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2">
        <b className="text-base font-semibold">{word}</b>
        <span className="text-[11px] text-t3">{card?.phonetic_us ? `/${card.phonetic_us}/` : card?.phonetic_uk ? `/${card.phonetic_uk}/` : ""}</span>
        <button title="发音" onClick={speak} className="ml-auto text-t3 cursor-pointer border-none bg-none flex hover:text-accent">
          <Icon n="volume" size={14} />
        </button>
      </div>
      {!card && !err && <p className="text-xs text-t3 mt-2.5 tracking-widest">查询中 ···</p>}
      {err && <p className="text-xs text-t3 mt-2.5">{err}</p>}
      {card && (
        <>
          <p className="text-[10px] text-t3 tracking-[0.5px] mt-2">释义 · {SOURCE_LABEL[card.source] ?? card.source}{card.source === "miss" ? " · 可点「加入生词本」手动记录" : ""}</p>
          {card.senses.length > 0 && (
            <p className="text-[12.5px] leading-[1.65] text-t2 mt-0.5">
              {card.senses.slice(0, 5).map((s, i) => (
                <span key={i}>{s.pos && <b className="text-t3 font-medium">{s.pos}. </b>}{s.gloss}<br /></span>
              ))}
            </p>
          )}
          {card.web_trans.length > 0 && (
            <p className="text-[12.5px] leading-[1.65] text-t2 mt-0.5">网络释义:{card.web_trans.slice(0, 3).join(";")}</p>
          )}
          {card.examples.length > 0 && (
            <>
              <div className="h-px bg-line my-2.5" />
              <p className="text-[10px] text-t3 tracking-[0.5px]">词典例句</p>
              {card.examples.slice(0, 2).map((ex, i) => (
                <p key={i} className="text-[11.5px] italic text-t2 leading-[1.6] mt-1">“{ex.en}”{ex.zh ? <span className="text-t3">{ex.zh}</span> : null}</p>
              ))}
            </>
          )}
          {sentence && (
            <>
              <div className="h-px bg-line my-2.5" />
              <p className="text-[10px] text-t3 tracking-[0.5px]">本文例句</p>
              <p className="text-[11.5px] italic text-t2 leading-[1.6] mt-1">“{sentence.slice(0, 220)}{sentence.length > 220 ? "…" : ""}”</p>
            </>
          )}
        </>
      )}
      <div className="flex gap-2 mt-3">
        <button className="flex items-center gap-1.5 h-8 bg-accent text-white rounded-[9px] text-xs font-medium px-3 cursor-pointer" onClick={add}>
          <Icon n="plus" size={12} /> 加入生词本
        </button>
        <button className="flex items-center gap-1.5 h-8 bg-surface2 text-t2 rounded-[9px] text-xs px-3 cursor-pointer hover:text-t1" onClick={onClose}>忽略</button>
      </div>
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      className={"relative w-[34px] h-5 rounded-full cursor-pointer transition-colors duration-150 border-none shrink-0 " + (on ? "bg-accent" : "bg-line")}
      onClick={onClick}
      aria-pressed={on}
    >
      <i className={"absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-[left] duration-150 " + (on ? "left-4" : "")} />
    </button>
  );
}

// v4:应用内确认小卡(替代 window.confirm,与整体自定义 UI 一致)
function ConfirmCard({ title, body, confirmText, onConfirm, onClose }: { title: string; body?: string; confirmText: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <>
      <div className="absolute inset-0 bg-scrim z-[80] [animation:fadein_0.18s]" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[320px] bg-surface border border-line rounded-2xl shadow-[var(--shadow-card)] p-4 z-[90]">
        <b className="text-sm font-semibold">{title}</b>
        {body && <p className="text-xs text-t2 mt-1.5 break-all">{body}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button className="flex items-center h-8 bg-surface2 text-t2 rounded-[9px] text-xs px-3 cursor-pointer hover:text-t1" onClick={onClose}>取消</button>
          <button
            className="flex items-center h-8 bg-accent text-white rounded-[9px] text-xs font-medium px-3 cursor-pointer"
            onClick={() => { onConfirm(); onClose(); }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </>
  );
}

// ---------- 设置面板 ----------

// 预设 provider + 模型清单(2026-11 官网调研;模型可自由手填任意名)
const PRESETS: Record<string, { kind: string; base_url: string; models: string[]; model: string }> = {
  DeepSeek: {
    kind: "openai_compatible",
    base_url: "https://api.deepseek.com",
    models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat"],
    model: "deepseek-flash",
  },
  GLM: {
    kind: "openai_compatible",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5-flash", "glm-4.6", "glm-4-flash"],
    model: "glm-4.5-flash",
  },
  OpenAI: {
    kind: "openai_compatible",
    base_url: "https://api.openai.com/v1",
    models: ["gpt-5-mini", "gpt-5-nano", "gpt-5", "gpt-4o-mini"],
    model: "gpt-5-mini",
  },
  Ollama: {
    kind: "ollama",
    base_url: "http://localhost:11434",
    models: ["qwen3:4b", "qwen3:8b", "gemma3:4b", "llama3.3"],
    model: "qwen3:4b",
  },
};

const ROW = "flex items-center justify-between gap-2.5 bg-surface2 rounded-[10px] px-3 py-[7px] min-h-[38px]";
const ROW_NAME = "text-[12.5px] text-t2";
const ROW_VAL = "flex items-center gap-2 font-code text-[11px] text-t1";
const PLAIN = "font-ui text-xs";
const INPUT = "flex-1 min-w-0 h-[26px] border border-line rounded-[7px] bg-bg text-t1 font-code text-[11.5px] px-2 outline-none focus:border-accent";

function SettingsPanel({
  onClose, prefs, applyPrefs, dark, setDark, providers, refreshProviders, say, rs, setRs,
}: {
  onClose: () => void;
  prefs: Prefs | null;
  applyPrefs: (u: Partial<Prefs>) => void;
  dark: boolean;
  setDark: (v: boolean) => void;
  providers: Provider[];
  refreshProviders: () => void;
  say: (m: string) => void;
  rs: ReaderStyle;
  setRs: (v: ReaderStyle) => void;
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
  const [capturing, setCapturing] = useState(false); // v4:行内录制快捷键(替代 window.prompt)
  const [promptDraft, setPromptDraft] = useState(""); // 翻译提示词草稿,失焦保存
  const [addingCustom, setAddingCustom] = useState(false); // 自定义 provider 表单
  const [cName, setCName] = useState("");
  const [cUrl, setCUrl] = useState("");
  const [cModel, setCModel] = useState("");
  const [cKey, setCKey] = useState("");
  const [delCand, setDelCand] = useState<Provider | null>(null); // 删除确认

  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);
  useEffect(() => { setPromptDraft(prefs?.custom_prompt ?? ""); }, [prefs?.custom_prompt]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // v4:录制态全局捕获下一次按键组合,Esc 取消
  useEffect(() => {
    if (!capturing) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(false); return; }
      const parts: string[] = [];
      if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      const k = e.key;
      if (/^[a-zA-Z]$/.test(k)) parts.push(k.toUpperCase());
      else if (/^[0-9]$/.test(k)) parts.push(k);
      else if (/^F[0-9]+$/.test(k)) parts.push(k);
      else return; // 仅修饰键按压,忽略
      const combo = parts.join("+");
      setCapturing(false);
      applyPrefs({ hotkey: combo });
      say(`热键已改为 ${combo}(立即生效)`);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [capturing]); // eslint-disable-line react-hooks/exhaustive-deps

  // 预设 chip:已配置过 = 仅选中查看(不隐式改配置/激活);未配置 = 创建并启用(首配一步到位)
  const pickPreset = async (preset: string) => {
    const { kind, base_url, model } = PRESETS[preset];
    const existing = providers.find((p) => p.name === preset);
    try {
      if (existing) { setSelId(existing.id); return; }
      const saved = await api.providerSave({ id: null, name: preset, kind, base_url, model });
      await api.providerSetActive(saved.id);
      await refreshProviders();
      setSelId(saved.id);
      say(`已启用 ${preset},粘贴 API Key 后即可翻译`);
    } catch (e) { say(String(e)); }
  };

  // 自定义 provider:任意 OpenAI 兼容端点,存为命名条目(与预设同级,可删除)
  const saveCustom = async () => {
    const n = cName.trim();
    if (!n || !cUrl.trim() || !cModel.trim()) { say("名称、Base URL、模型为必填"); return; }
    try {
      const saved = await api.providerSave({ id: null, name: n, kind: "openai_compatible", base_url: cUrl.trim(), model: cModel.trim() });
      if (cKey.trim()) await api.providerSetKey(saved.id, cKey.trim());
      await refreshProviders();
      setSelId(saved.id);
      setAddingCustom(false);
      setCName(""); setCUrl(""); setCModel(""); setCKey("");
      say(`已添加自定义 Provider「${n}」`);
    } catch (e) { say(String(e)); }
  };

  const delProvider = async (p: Provider) => {
    try {
      await api.providerDelete(p.id);
      await refreshProviders();
      setSelId((cur) => (cur === p.id ? null : cur));
      say(`已删除「${p.name}」`);
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
      <div className="absolute inset-0 bg-scrim z-40 [animation:fadein_0.18s]" onClick={onClose} />
      <aside className="absolute right-0 top-0 bottom-0 w-[420px] max-w-[92vw] bg-surface border-l border-line shadow-[var(--shadow-card)] z-50 flex flex-col gap-3.5 px-[18px] pt-[18px] pb-3.5 overflow-y-auto [animation:slidein-r_0.2s_ease]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center" data-tauri-drag-region>
          <b className="text-base font-semibold" data-tauri-drag-region>设置</b>
          <button className="ml-auto w-[34px] h-[34px] rounded-[9px] text-t3 hover:bg-surface2 hover:text-t1 flex items-center justify-center cursor-pointer" onClick={onClose}><Icon n="x" size={15} /></button>
        </div>
        <div className="h-px bg-line" />

        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-[10.5px] font-semibold tracking-[1px] text-t3">PROVIDER</span>
          <div className="flex gap-1.5 flex-wrap">
            {Object.keys(PRESETS).map((p) => (
              <button
                key={p}
                title={selPresetName === p ? "查看配置(激活状态见下方绿点)" : `配置 ${p}`}
                className={"flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] cursor-pointer border-none " + (selPresetName === p ? "bg-accentsoft text-accent font-semibold" : "bg-surface2 text-t2")}
                onClick={() => pickPreset(p)}
              >
                {active?.name === p && <i className="w-[5px] h-[5px] rounded-full bg-ok" title="使用中" />}{p}
              </button>
            ))}
            {providers.filter((p) => !PRESETS[p.name]).map((p) => (
              <button
                key={p.id}
                title={p.base_url}
                className={"flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] cursor-pointer border-none " + (selId === p.id ? "bg-accentsoft text-accent font-semibold" : "bg-surface2 text-t2")}
                onClick={() => setSelId(p.id)}
              >
                {p.is_active && <i className="w-[5px] h-[5px] rounded-full bg-ok" />}{p.name}
              </button>
            ))}
            {!addingCustom && (
              <button
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] cursor-pointer border border-dashed border-line bg-none text-t3 hover:text-accent hover:border-accent"
                onClick={() => setAddingCustom(true)}
              >
                + 自定义
              </button>
            )}
          </div>
          {addingCustom && (
            <div className="flex flex-col gap-1.5 border border-dashed border-line rounded-[10px] p-2">
              <div className={ROW}><span className={ROW_NAME}>名称</span><input className={INPUT} value={cName} placeholder="如 SiliconFlow" onChange={(e) => setCName(e.target.value)} spellCheck={false} /></div>
              <div className={ROW}><span className={ROW_NAME}>Base URL</span><input className={INPUT} value={cUrl} placeholder="https://…(OpenAI 兼容)" onChange={(e) => setCUrl(e.target.value)} spellCheck={false} /></div>
              <div className={ROW}><span className={ROW_NAME}>模型</span><input className={INPUT} value={cModel} placeholder="如 Qwen/Qwen3-32B" onChange={(e) => setCModel(e.target.value)} spellCheck={false} /></div>
              <div className={ROW}><span className={ROW_NAME}>API Key</span><input className={INPUT} type="password" value={cKey} placeholder="可留空稍后填" onChange={(e) => setCKey(e.target.value)} spellCheck={false} /></div>
              <div className="flex gap-2">
                <button className="flex items-center h-8 bg-accent text-white rounded-[9px] text-xs font-medium px-3 cursor-pointer border-none" onClick={saveCustom}>添加</button>
                <button className="flex items-center h-8 bg-surface2 text-t2 rounded-[9px] text-xs px-3 cursor-pointer border-none hover:text-t1" onClick={() => { setAddingCustom(false); setCName(""); setCUrl(""); setCModel(""); setCKey(""); }}>取消</button>
              </div>
            </div>
          )}
          {sel ? (
            <div className="flex flex-col gap-1.5">
              <div className={ROW}><span className={ROW_NAME}>Base URL</span>
                <input className={INPUT} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
              </div>
              <div className={ROW}><span className={ROW_NAME}>API Key</span>
                <input className={INPUT} type="password" placeholder={sel.has_key ? "已存 Keychain·输入以更换" : "sk-…(只存 Keychain)"} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} spellCheck={false} />
                <button className="text-[10.5px] text-t2 cursor-pointer border-none bg-none px-1 disabled:opacity-50" disabled={testing} onClick={test}>{testing ? "测试中…" : "测试"}</button>
                {testMsg && <span className={"font-code text-[10.5px] font-semibold " + (testMsg.startsWith("✓") ? "text-ok" : "text-t2")}>{testMsg}</span>}
              </div>
              <div className={ROW}><span className={ROW_NAME}>模型</span>
                <input className={INPUT} value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} list={"model-presets-" + sel.id} />
                <datalist id={"model-presets-" + sel.id}>
                  {(Object.values(PRESETS).find((d) => d.base_url === sel.base_url)?.models ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              <div className={ROW}>
                <span className={ROW_NAME}>状态</span>
                <span className={ROW_VAL}>
                  {sel.is_active ? <span className="font-code text-[10.5px] font-semibold text-ok">● 使用中</span> : <span className={PLAIN}>未激活</span>}
                  {!sel.is_active && <button className="text-[10.5px] text-t2 cursor-pointer border-none bg-none px-1" onClick={() => api.providerSetActive(sel.id).then(refreshProviders).then(() => say("已激活")).catch((e) => say(String(e)))}>设为使用中</button>}
                  {!PRESETS[sel.name] && <button className="text-[10.5px] text-[#d25a5a] cursor-pointer border-none bg-none px-1" onClick={() => setDelCand(sel)}>删除</button>}
                </span>
              </div>
              <div className={ROW}>
                <button className="flex items-center gap-1.5 h-8 bg-accent text-white rounded-[9px] text-xs font-medium px-3 cursor-pointer" onClick={save}><Icon n="sparkles" size={12} /> 保存配置</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5"><div className={ROW}><span className={ROW_VAL}>点击上方预设开始配置</span></div></div>
          )}
        </div>

        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-[10.5px] font-semibold tracking-[1px] text-t3">翻译</span>
          <div className="flex flex-col gap-1.5">
            <div className={ROW}><span className={ROW_NAME}>默认方向</span>
              <DirPicker value={prefs?.direction ?? "en2zh"} onChange={(d) => applyPrefs({ direction: d })} />
            </div>
            <div className={ROW}><span className={ROW_NAME}>单词查词</span>
              <span className={ROW_VAL}><span className={PLAIN + " mr-2"}>免费词典 → 模型兜底</span></span>
              <Toggle on={!!prefs?.dict_fallback} onClick={() => applyPrefs({ dict_fallback: !prefs?.dict_fallback })} />
            </div>
            <div className={ROW + " !flex-col !items-stretch !gap-1.5"}>
              <div className="flex items-center">
                <span className={ROW_NAME}>翻译提示词</span>
                <span className="flex-1" />
                <button className="text-[10.5px] text-t3 cursor-pointer border-none bg-none px-1 hover:text-accent" onClick={() => { setPromptDraft(""); applyPrefs({ custom_prompt: "" }); say("已恢复默认提示词"); }}>恢复默认</button>
              </div>
              <textarea
                className="w-full h-[88px] border border-line rounded-[7px] bg-bg text-t1 font-code text-[11px] leading-[1.6] px-2 py-1.5 outline-none resize-none focus:border-accent"
                value={promptDraft}
                placeholder="留空 = 内置默认(英文)。支持 {from} / {to} 占位;标签协议与方向指令由应用自动附加。"
                spellCheck={false}
                onChange={(e) => setPromptDraft(e.target.value)}
                onBlur={() => { if (promptDraft !== (prefs?.custom_prompt ?? "")) { applyPrefs({ custom_prompt: promptDraft }); say("提示词已保存"); } }}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-[10.5px] font-semibold tracking-[1px] text-t3">快捷键与浮窗</span>
          <div className="flex flex-col gap-1.5">
            <div className={ROW}><span className={ROW_NAME}>呼出快捷窗</span>
              <span className={ROW_VAL}>
                <kbd>{(prefs?.hotkey ?? "Alt+T").replace("Alt", "⌥").replace("CommandOrControl", "⌘").replace("Shift", "⇧")}</kbd>
                <button className="text-[10.5px] text-t2 cursor-pointer border-none bg-none px-1" onClick={() => setCapturing(true)}>
                  {capturing ? "按下组合键…(Esc 取消)" : "改键"}
                </button>
              </span>
            </div>
            <div className={ROW}><span className={ROW_NAME}>粘贴即译</span><Toggle on={!!prefs?.paste_auto} onClick={() => applyPrefs({ paste_auto: !prefs?.paste_auto })} /></div>
            <div className={ROW}><span className={ROW_NAME}>置顶(pin)默认</span><Toggle on={!!prefs?.pin_default} onClick={() => applyPrefs({ pin_default: !prefs?.pin_default })} /></div>
            <div className={ROW}><span className={ROW_NAME}>失焦自动隐藏</span><Toggle on={!!prefs?.blur_hide} onClick={() => applyPrefs({ blur_hide: !prefs?.blur_hide })} /></div>
            <p className="text-[10px] text-t3 m-0">重启后不自动显示快捷窗(固定行为)</p>
          </div>
        </div>

        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-[10.5px] font-semibold tracking-[1px] text-t3">阅读外观<span className="float-right text-[10px] font-normal text-t3 cursor-pointer hover:text-accent" onClick={() => setRs(RS_DEFAULT)}>恢复默认</span></span>
          <div className="flex flex-col gap-1.5">
            <div className={ROW}><span className={ROW_NAME}>阅读背景</span>
              <span className="flex items-center gap-1.5 flex-wrap justify-end">
                {([["default", "跟随主题"], ["sepia", "#f3ecd9"], ["oled", "#000000"], ["custom", rs.customBg]] as const).map(([k, v]) => (
                  <button key={k} title={k === "default" ? "跟随主题" : k === "custom" ? "自定义" : k === "sepia" ? "护眼米黄" : "OLED 纯黑"}
                    className={"w-[22px] h-[22px] rounded-[7px] border border-line cursor-pointer p-0 " + (rs.theme === k ? "outline outline-2 outline-accent outline-offset-1" : "")}
                    style={{ background: k === "default" ? "var(--bg)" : v }}
                    onClick={() => setRs({ ...rs, theme: k })} />
                ))}
                {rs.theme === "custom" && <input type="color" className="w-[22px] h-[22px] border-none bg-none cursor-pointer p-0" value={rs.customBg} onChange={(e) => setRs({ ...rs, customBg: e.target.value })} />}
              </span>
            </div>
            <div className={ROW}><span className={ROW_NAME}>正文字体</span>
              <span className="flex items-center gap-1.5 flex-wrap justify-end">
                {([["serif", "衬线"], ["sans", "无衬线"], ["kai", "楷体"], ["mono", "等宽"]] as const).map(([k, label]) => (
                  <button key={k} className={"text-[11px] rounded-[7px] px-2 py-[3px] cursor-pointer border-none " + (rs.font === k ? "bg-accentsoft text-accent font-medium" : "bg-surface2 text-t2")} onClick={() => setRs({ ...rs, font: k })}>{label}</button>
                ))}
              </span>
            </div>
            <div className={ROW}><span className={ROW_NAME}>字号 <b className="text-accent font-semibold ml-0.5">{rs.size}px</b></span>
              <input className="flex-1 max-w-[150px] accent-accent h-[3px] cursor-pointer" type="range" min={14} max={20} step={1} value={rs.size} onChange={(e) => setRs({ ...rs, size: Number(e.target.value) })} />
            </div>
            <div className={ROW}><span className={ROW_NAME}>行距 <b className="text-accent font-semibold ml-0.5">{rs.lineH.toFixed(1)}</b></span>
              <input className="flex-1 max-w-[150px] accent-accent h-[3px] cursor-pointer" type="range" min={1.5} max={2.2} step={0.1} value={rs.lineH} onChange={(e) => setRs({ ...rs, lineH: Number(e.target.value) })} />
            </div>
            <div className={ROW}><span className={ROW_NAME}>段间距 <b className="text-accent font-semibold ml-0.5">{rs.gap}px</b></span>
              <input className="flex-1 max-w-[150px] accent-accent h-[3px] cursor-pointer" type="range" min={4} max={24} step={1} value={rs.gap} onChange={(e) => setRs({ ...rs, gap: Number(e.target.value) })} />
            </div>
            <div className={ROW}><span className={ROW_NAME}>页宽 <b className="text-accent font-semibold ml-0.5">{rs.width}px</b></span>
              <input className="flex-1 max-w-[150px] accent-accent h-[3px] cursor-pointer" type="range" min={640} max={1000} step={20} value={rs.width} onChange={(e) => setRs({ ...rs, width: Number(e.target.value) })} />
            </div>
            <div className={ROW}><span className={ROW_NAME}>强调色</span>
              <span className="flex items-center gap-1.5 flex-wrap justify-end">
                {RS_ACCENTS.map((c) => (
                  <button key={c || "default"} title={c || "默认"} className={"w-4 h-4 rounded-full border border-line cursor-pointer p-0 " + (rs.accent === c ? "outline outline-2 outline-accent outline-offset-1" : "")}
                    style={{ background: c || "var(--accent)" }} onClick={() => setRs({ ...rs, accent: c })} />
                ))}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-[10.5px] font-semibold tracking-[1px] text-t3">外观与用量</span>
          <div className="flex flex-col gap-1.5">
            <div className={ROW}><span className={ROW_NAME}>深色外观</span><Toggle on={dark} onClick={() => setDark(!dark)} /></div>
            <div className={ROW}><span className={ROW_NAME}>翻译用量</span>
              <span className={ROW_VAL}>{usage ? `${usage.requests} 次 · ${fmtTokens(usage.prompt_tokens + usage.completion_tokens)} tokens` : "—"}</span>
            </div>
            <div className={ROW}><span className={ROW_NAME}>成本估算</span>
              <span className={ROW_VAL}>
                <input className={INPUT + " flex-none w-[90px]"} placeholder="¥/1M tokens" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={savePrice} />
                {cost && <span className={PLAIN + " font-semibold ml-1.5"}>≈ ¥{cost}</span>}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 shrink-0">
          <span className="text-[10.5px] font-semibold tracking-[1px] text-t3">关于与更新</span>
          <div className="flex flex-col gap-1.5">
            <div className={ROW}><span className={ROW_NAME}>当前版本</span><span className={ROW_VAL}><span className={PLAIN}>{appVersion}</span></span></div>
            <div className={ROW}><span className={ROW_NAME}>软件更新</span>
              <span className="flex items-center gap-2.5">
                <button className="h-[26px] px-3 border-none bg-accent text-white text-[11.5px] font-medium rounded-[7px] cursor-pointer disabled:opacity-50" disabled={updBusy} onClick={checkUpdate}>{updBusy ? "检查中…" : "检查更新"}</button>
                {updMsg && <span className="text-[11.5px] text-t2">{updMsg}</span>}
              </span>
            </div>
          </div>
        </div>

        <span className="flex-1" />
        <span className="text-[10px] text-t3">v{appVersion || "0.1.0"} · 数据全部本地存储 · Key 只进 Keychain</span>
        {delCand && (
          <ConfirmCard
            title="删除 Provider"
            body={`「${delCand.name}」配置将被移除;其 API Key 只存于 Keychain,删除条目后不可再读取。`}
            confirmText="删除"
            onConfirm={() => delProvider(delCand)}
            onClose={() => setDelCand(null)}
          />
        )}
      </aside>
    </>
  );
}

// ---------- 生词本 / 术语库 滑出层 ----------

// v4 滑出层通用壳:圆角浮卡,头部 x 关闭(不用 accent 实心)
function SidePanel({ title, count, onClose, children, foot }: { title: string; count: number; onClose: () => void; children: React.ReactNode; foot: React.ReactNode }) {
  return (
    <>
      <div className="absolute inset-0 bg-scrim z-40 [animation:fadein_0.18s]" onClick={onClose} />
      <aside className="absolute left-[18px] top-3.5 bottom-3.5 w-[336px] bg-surface border border-line rounded-2xl shadow-[var(--shadow-card)] z-50 flex flex-col gap-3 px-3.5 pt-4 pb-3 [animation:slidein-l_0.2s_ease]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2" data-tauri-drag-region>
          <b className="text-[15px] font-semibold" data-tauri-drag-region>{title}</b><span className="text-[11px] text-t3" data-tauri-drag-region>{count}</span>
          <span className="flex-1" data-tauri-drag-region />
          <button className="w-7 h-7 rounded-lg text-t3 hover:bg-surface2 hover:text-t1 flex items-center justify-center cursor-pointer" onClick={onClose}><Icon n="x" size={14} /></button>
        </div>
        {children}
        <div className="border-t border-line pt-2.5 flex gap-2">{foot}</div>
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
    <SidePanel title="生词本" count={items.length} onClose={onClose} foot={<span className="flex-1 flex items-center gap-2 h-9 text-[12.5px] text-t2 px-2.5">P1 将内置 SRS 复习</span>}>
      <div className="flex-1 overflow-y-auto flex flex-col gap-0.5">
        {items.map((v) => (
          <div
            key={v.id}
            className="group py-2 px-2.5 rounded-[9px] cursor-pointer flex flex-col gap-[3px] hover:bg-surface2"
            onClick={() => {
              if (openId === v.id) { setOpenId(null); return; }
              setOpenId(v.id);
              api.vocabExamples(v.id).then(setExamples).catch(() => setExamples([]));
            }}
          >
            <div className="text-[10px] text-t3 flex gap-1.5 items-center">
              <span>{v.source === "dict" ? "词典" : v.source === "model" ? "模型" : "手动"}</span>
              <span>{v.examples} 例句</span>
              <span className="flex-1" />
              {/* v4:删除仅 hover 显示 */}
              <span
                className="opacity-0 group-hover:opacity-100 text-t3 hover:text-[#d25a5a] cursor-pointer"
                onClick={(e) => { e.stopPropagation(); api.vocabDelete(v.id).then(refresh); say("已删除"); }}
              >
                <Icon n="x" size={11} />
              </span>
            </div>
            <div className="text-[12.5px] text-t2 leading-snug group-hover:text-t1">{v.lemma} {v.phonetic && <span className="text-t3 text-[11px]">/{v.phonetic}/</span>}</div>
            <div className="text-[11px] text-t2 mt-0.5">{v.definition.slice(0, 90)}{v.definition.length > 90 ? "…" : ""}</div>
            {openId === v.id && examples.map((ex, i) => (
              <div key={i} className="text-[10.5px] text-t3 mt-1 pl-2 border-l-2 border-line">“{ex.slice(0, 160)}”</div>
            ))}
          </div>
        ))}
        {items.length === 0 && <div className="p-2 text-t3 text-[11px]">还没有生词 · 阅读时点任意英文词收藏</div>}
      </div>
    </SidePanel>
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
    <SidePanel title="术语库" count={items.length} onClose={onClose} foot={<span className="flex-1 flex items-center gap-2 h-9 text-[12.5px] text-t2 px-2.5">全局一张表 · 已译块不回改,重译生效</span>}>
      <div className="flex gap-1.5 items-center px-0.5">
        <input className="flex-1 min-w-0 h-[26px] border border-line rounded-[7px] bg-bg text-t1 font-code text-[11.5px] px-2 outline-none focus:border-accent" placeholder="原文术语(如 hydration)" value={term} onChange={(e) => setTerm(e.target.value)} spellCheck={false} />
        <span className="text-t3">→</span>
        <input className="flex-1 min-w-0 h-[26px] border border-line rounded-[7px] bg-bg text-t1 font-code text-[11.5px] px-2 outline-none focus:border-accent" placeholder="固定译法(如 水合)" value={trans} onChange={(e) => setTrans(e.target.value)} spellCheck={false} />
        <button className="flex items-center gap-1 h-[26px] bg-accent text-white rounded-[9px] text-xs font-medium px-2.5 cursor-pointer" onClick={add}><Icon n="plus" size={12} /> 加</button>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-0.5">
        {items.map((g) => (
          <div key={g.id} className="group py-2 px-2.5 rounded-[9px] cursor-default flex flex-col gap-[3px] hover:bg-surface2">
            <div className="text-[10px] text-t3 flex gap-1.5 items-center">
              <span>{g.enabled ? "注入中" : "已停用"}</span>
              <span className="flex-1" />
              {/* v4:启停/删除仅 hover 显示 */}
              <span
                className="opacity-0 group-hover:opacity-100 cursor-pointer text-t3 hover:text-accent"
                onClick={(e) => { e.stopPropagation(); api.glossarySetEnabled(g.id, !g.enabled).then(refresh); }}
              >{g.enabled ? "○ 停用" : "● 启用"}</span>
              <span
                className="opacity-0 group-hover:opacity-100 text-t3 hover:text-[#d25a5a] cursor-pointer"
                onClick={(e) => { e.stopPropagation(); api.glossaryDelete(g.id).then(refresh); say("已删除"); }}
              >
                <Icon n="x" size={11} />
              </span>
            </div>
            <div className="text-[12.5px] text-t2 leading-snug">{g.term} <span className="text-accent text-[11px]">→ {g.translation}</span></div>
          </div>
        ))}
        {items.length === 0 && <div className="p-2 text-t3 text-[11px]">空术语库 · 添加后 system prompt 强制使用 + 译后自动替换</div>}
      </div>
    </SidePanel>
  );
}

// ---------- 主应用 ----------

function App() {
  const [view, setView] = useState<View>("interleave");
  const [doc, setDoc] = useState<{ article: Article; blocks: Block[] } | null>(null);
  const [vocab, setVocab] = useState<{ word: string; x: number; y: number; sentence?: string } | null>(null);
  const [vocabCount, setVocabCount] = useState(0);
  const [glossaryCount, setGlossaryCount] = useState(0);
  const [glossary, setGlossary] = useState<GlossaryItem[]>([]); // 术语表(译文高亮用)
  const [articles, setArticles] = useState<Article[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [setOpen, setSetOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dark, setDark] = useLocalFlag("v3-dark", false);
  const [rs, setRs] = useState<ReaderStyle>(loadReaderStyle); // 阅读外观自定义
  const [hintDone, setHintDone] = useLocalFlag("yidu-hint-done", false); // v4:首译后永久隐藏快捷键提示
  const [confirm, setConfirm] = useState<{ title: string; body?: string; confirmText: string; onConfirm: () => void } | null>(null);

  // 阅读外观:本窗应用 + 广播快捷窗(quick 同源读 localStorage 兜初始值,事件管增量)
  useEffect(() => { applyReaderStyle(rs); emit("reader-changed", rs).catch(() => {}); }, [rs]);
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
  const refreshProviders = () => api.providerList().then((p) => { setProviders(p); emit("providers-changed", p).catch(() => {}); }).catch(() => {});

  useEffect(() => {
    refreshLib();
    refreshProviders();
    api.getPrefs().then((p) => { setPrefsState(p); setDirection(p.direction); }).catch(() => {});
    api.vocabList().then((v) => setVocabCount(v.length)).catch(() => {});
    // 启动静默检查更新:有新版仅 toast 提示,不自动安装(在设置面板操作)
    checkUpdateFn().then((u) => { if (u) say(`发现新版本 v${u.version} · ⌘, 打开设置更新`); }).catch(() => {});
    api.glossaryList().then((g) => { setGlossaryCount(g.length); setGlossary(g); }).catch(() => {});
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
    // 广播给快捷窗(webview 预创建,mount 后不再重读 prefs)
    api.setPrefs(u).then((p) => { setPrefsState(p); setDirection(p.direction); emit("prefs-changed", p).catch(() => {}); }).catch((e) => say(String(e)));
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
      // 输入控件聚焦时不响应全局快捷键(数字键切视图等)
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!mod && !typing && ["1", "2", "3", "4"].includes(e.key)) {
        setView((["interleave", "split", "zh", "pure"] as const)[Number(e.key) - 1]);
        return;
      }
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
      setHintDone(true); // v4:首译完成,快捷键提示永久隐藏
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

  // 术语弹卡「停用」:按 from/to 在术语库中定位并禁用,刷新高亮
  const disableTerm = async (hit: TermHit) => {
    try {
      const items = await api.glossaryList();
      const g = items.find((it) => it.term === hit.from || it.translation === hit.to);
      if (g) { await api.glossarySetEnabled(g.id, false); say(`已停用术语 ${g.term}(下次翻译起生效)`); }
      const fresh = await api.glossaryList();
      setGlossary(fresh); setGlossaryCount(fresh.length);
      setTermPop(null);
    } catch (e) { say(String(e)); }
  };

  const En = ({ text }: { text: string }) => (
    <div className="en md text-[12.5px] leading-[1.6]"><Md text={text} onWord={(w, x, y) => setVocab({ word: w, x, y, sentence: text })} /></div>
  );
  // 术语高亮来源 = 全部启用术语(不限于本块命中):术语表生效情况直接可见,点击弹卡
  const glossaryHits: TermHit[] = useMemo(
    () => glossary.filter((g) => g.enabled).map((g) => ({ from: g.term, to: g.translation })),
    [glossary],
  );

  const Zh = ({ b }: { b: Block }) =>
    b.trans ? (
      <div className={"zh md" + (b.status === "streaming" ? " streaming" : "")}>
        <Md text={b.trans} termHits={glossaryHits.length ? glossaryHits : undefined} onTerm={(t, x, y) => setTermPop({ hit: t, x, y })} />
      </div>
    ) : (
      <p className={"zh m-0 " + (b.status === "streaming" ? "streaming" : "text-t3")}>{b.status === "streaming" ? "…" : "待译"}</p>
    );

  // 纯净模式静态渲染:无点词/术语交互,文本可自由选择复制
  const ZhPlain = ({ b }: { b: Block }) =>
    b.trans ? (
      <div className={"zh md" + (b.status === "streaming" ? " streaming" : "")}><Md text={b.trans} /></div>
    ) : (
      <p className={"zh m-0 " + (b.status === "streaming" ? "streaming" : "text-t3")}>{b.status === "streaming" ? "…" : "待译"}</p>
    );

  const Shimmer = ({ label }: { label: string }) => (
    <div className="flex items-center gap-2.5 mt-1">
      <div className="w-[220px] h-[3px] bg-surface2 rounded-sm overflow-hidden">
        <i className="block w-2/5 h-full bg-accent rounded-sm [animation:slide_1.2s_infinite]" />
      </div>
      <span className="text-[11px] text-accent">{label}</span>
    </div>
  );

  return (
    <div className="relative h-screen overflow-hidden" onClick={() => { setVocab(null); setTermPop(null); }}>
      {/* 发丝进度条 */}
      <div className="absolute top-0 inset-x-0 h-[3px] z-[5]">
        <i className="block h-full bg-accent rounded-r-sm transition-[width] duration-700 ease-out" style={{ width: `${progress}%` }} />
      </div>

      {/* 顶栏(v4:即标题栏,可拖拽;红绿灯由系统 Overlay 叠加) */}
      <header className={"h-[60px] flex items-center gap-3 pr-7 " + (IS_MAC ? "pl-20" : "px-7")} data-tauri-drag-region>
        <button className="flex items-center gap-[7px] border-none bg-none text-[13px] font-medium text-t2 cursor-pointer px-2 py-1.5 rounded-lg hover:text-t1 hover:bg-surface2" onClick={() => setPanel(panel === "library" ? null : "library")}>
          <Icon n="library" /> 文章库 <kbd>⌘K</kbd>
        </button>
        <span className="flex-1" data-tauri-drag-region />
        <span className="text-[13px] text-t2 whitespace-nowrap overflow-hidden text-ellipsis max-w-[46%]" data-tauri-drag-region>{doc ? doc.article.title : "译读"}</span>
        <span className="flex-1" data-tauri-drag-region />
        <button className="w-[34px] h-[34px] border-none bg-none rounded-[9px] text-t3 cursor-pointer flex items-center justify-center hover:bg-surface2 hover:text-t1" title="设置(⌘,)" onClick={() => setSetOpen(true)}><Icon n="sliders" /></button>
      </header>

      {/* 正文 */}
      <div className="absolute inset-x-0 bottom-0 top-[60px] overflow-y-auto px-6 pt-[22px] pb-[170px] bg-[var(--reader-bg,transparent)] text-[color:var(--reader-t1,var(--t1))]">
        <div className="max-w-[var(--reader-w,720px)] mx-auto flex flex-col gap-[var(--reader-gap,10px)]">
          {!doc && (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-2 text-center">
              <h1 className="font-title text-[34px] font-semibold tracking-[0.02em] m-0">译读</h1>
              <p className="text-t2 text-[13px] m-0">本地优先的 markdown 翻译阅读器</p>
              <div className="flex items-center gap-2.5 mt-3">
                <button className="flex items-center gap-1.5 h-9 bg-accent text-white rounded-[9px] text-[13px] font-medium px-4 cursor-pointer" onClick={() => setComposing(true)}>
                  <Icon n="sparkles" size={13} /> 新建翻译
                </button>
                <button className="flex items-center gap-1.5 h-9 bg-surface2 text-t2 rounded-[9px] text-[13px] px-4 cursor-pointer hover:text-t1" onClick={() => setSetOpen(true)}>
                  <Icon n="sliders" size={13} /> 打开设置
                </button>
              </div>
              {!activeProvider && (
                <div className="text-accent text-xs font-medium cursor-pointer mt-1" onClick={() => setSetOpen(true)}>⚠ 尚未配置 Provider — 点「打开设置」粘贴 API Key 即可开始</div>
              )}
              {!hintDone && (
                <div className="flex flex-col gap-2 text-[12.5px] text-t2 mt-4">
                  <div><kbd>⌘N</kbd> 新建翻译 · 粘贴或导入 .md</div>
                  <div><kbd>⌘K</kbd> 打开文章库 · <kbd>⌘R</kbd> 续译未完成块 · <kbd>⌥T</kbd> 快捷窗</div>
                  <div className="text-t3 text-[11px]">阅读时点任意英文单词查词收藏(免费词典 → 模型兜底)· 点词可点击处有虚线标记</div>
                </div>
              )}
            </div>
          )}
          {doc && (
            <div className="text-center pt-1.5">
              <h1 className="font-title text-[25px] font-semibold tracking-[0.2px] m-0">{doc.article.title}</h1>
              <div className="text-[11.5px] text-t3 mt-1.5 flex justify-center gap-2 flex-wrap">
                <span>{doc.article.kind === "md" ? "MD" : "粘贴"}</span>
                <span>{dirLabel(doc.article.direction)}</span>
                <span>{doneCount}/{blocks.length} 块</span>
                <span>{fmtDate(doc.article.updated_at)}</span>
                {busy && (
                  <span className="text-t3 font-semibold cursor-pointer hover:underline" onClick={cancelCurrent}>■ 取消(Esc)</span>
                )}
                {!busy && pendingCount > 0 && (
                  <span className="text-accent font-semibold cursor-pointer hover:underline" onClick={resumeOrDone}>▶ 续译 {pendingCount} 块(⌘R)</span>
                )}
              </div>
            </div>
          )}

          {doc && streamErr && (
            <div className="text-[#d25a5a] text-[12.5px] bg-[rgba(210,90,90,0.08)] rounded-[10px] px-3 py-2 mt-2.5 cursor-pointer" onClick={() => setStreamErr(null)} title="点击关闭">
              ⚠ {streamErr}
              {!busy && pendingCount > 0 && " · 可 ⌘R 续译"}
            </div>
          )}

          {doc && view === "interleave" && blocks.map((b) =>
            b.kind === "code" ? (
              <CodeBox key={b.idx} src={b.src} />
            ) : (
              <div key={b.idx} data-bidx={b.idx} className={"group relative flex flex-col gap-1 " + (b.terms ? "border-l-[3px] border-accent pl-3.5" : "")}>
                <div className="flex justify-end h-0">
                  <button
                    className={"relative -top-1.5 -right-1 border-none bg-none text-t3 cursor-pointer text-[11px] px-1.5 py-0.5 rounded-md transition-opacity " + (collapsed.has(b.idx) ? "opacity-75 hover:text-accent hover:bg-surface2" : "opacity-0 group-hover:opacity-100 hover:text-accent hover:bg-surface2")}
                    title={collapsed.has(b.idx) ? "展开原文" : "收起原文"}
                    onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(b.idx)) n.delete(b.idx); else n.add(b.idx); return n; })}
                  >
                    {collapsed.has(b.idx) ? "▸ 原文" : "▾"}
                  </button>
                </div>
                {!collapsed.has(b.idx) && <En text={b.src} />}
                <Zh b={b} />
                {b.status === "streaming" && <Shimmer label="翻译中 · 流式上屏" />}
              </div>
            ),
          )}

          {doc && view === "split" && (
            <>
              <div className="grid grid-cols-2 gap-5 text-[11px] text-t3 font-semibold border-b border-line pb-2">
                <span>原文 · {langZh(splitDir(doc.article.direction)[0])}</span><span>译文</span>
              </div>
              {blocks.map((b) =>
                b.kind === "code" ? (
                  <div key={b.idx} className="py-3.5"><CodeBox src={b.src} /></div>
                ) : (
                  <div key={b.idx} data-bidx={b.idx} className="grid grid-cols-2 gap-5 py-3 border-b border-line">
                    <div className="border-r border-line pr-[18px]"><En text={b.src} /></div>
                    <div className="pl-[18px] flex flex-col gap-[7px]">
                      <Zh b={b} />
                      {b.status === "streaming" && <Shimmer label="翻译中" />}
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
              <div key={b.idx} data-bidx={b.idx} className="relative flex flex-col gap-1">
                <Zh b={b} />
                <div className="flex gap-2 items-center">
                  <button className="self-start text-[10.5px] text-t3 border border-line bg-surface rounded-md px-2 py-0.5 cursor-pointer mt-1 hover:text-accent hover:border-accent" onClick={() => setExpanded((s) => new Set(s).add(b.idx))}>
                    {expanded.has(b.idx) ? "⌃ 收起原文" : "⌄ 原文"}
                  </button>
                </div>
                {expanded.has(b.idx) && <En text={b.src} />}
              </div>
            ),
          )}

          {/* 纯净模式:纯译文静态渲染,无点词/术语交互,文本自由选择复制 */}
          {doc && view === "pure" && (
            <div className="flex flex-col gap-2">
              {blocks.map((b) =>
                b.kind === "code" ? (
                  <CodeBox key={b.idx} src={b.src} />
                ) : (
                  <div key={b.idx} data-bidx={b.idx} className="flex flex-col"><ZhPlain b={b} /></div>
                ),
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部悬浮胶囊(v4:视图带文字 · 续译状态化 · provider 截断) */}
      <div className="absolute left-1/2 -translate-x-1/2 bottom-[26px] h-[54px] bg-surface border border-line rounded-2xl shadow-[var(--shadow-capsule)] flex items-center gap-1 px-2.5 z-20">
        <div className="flex items-center gap-0.5">
          {VIEWS.map(([v, label, icon]) => (
            <button
              key={v}
              title={{ interleave: "双语对照", split: "分栏", zh: "纯译文", pure: "纯净模式(自由复制)" }[v]}
              className={"flex items-center gap-1.5 h-[38px] px-2.5 rounded-[10px] cursor-pointer border-none " + (view === v ? "bg-accentsoft text-accent" : "bg-none text-t3 hover:bg-surface2 hover:text-t1")}
              onClick={() => setView(v)}
            >
              <Icon n={icon} size={15} />
              <span className="text-[11px]" style={{ fontWeight: view === v ? 600 : 400 }}>{label}</span>
            </button>
          ))}
        </div>
        <i className="w-px h-5 bg-line mx-[5px]" />
        <button className="flex items-center gap-1.5 h-[38px] rounded-[10px] text-t2 text-[12.5px] px-2.5 cursor-pointer border-none hover:bg-surface2" onClick={() => setPanel("glossary")} title="术语库管理">
          <Icon n="tag" size={15} /><span>术语</span><b className="text-accent font-semibold text-xs">{glossaryCount}</b>
        </button>
        <button className="flex items-center gap-1.5 h-[38px] rounded-[10px] text-t2 text-[12.5px] px-2.5 cursor-pointer border-none hover:bg-surface2" onClick={() => setPanel("vocab")} title="生词本">
          <Icon n="bookmark" size={15} /><span>生词</span><b className="text-accent font-semibold text-xs">{vocabCount}</b>
        </button>
        <i className="w-px h-5 bg-line mx-[5px]" />
        <button className="flex items-center gap-[7px] h-[34px] bg-surface2 rounded-[9px] px-2.5 font-code text-[11px] text-t2 cursor-pointer border-none hover:text-t1 max-w-[170px]" onClick={() => setSetOpen(true)}>
          <i className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" /><span className="truncate">{activeProvider ? activeProvider.model : "未配置"}</span><Icon n="chev" size={12} />
        </button>
        {/* v4:续译/取消状态化 —— busy=spinner 点击取消;pending=数字徽章 */}
        <button
          className="relative w-[34px] h-[34px] border-none bg-none rounded-[9px] text-t3 cursor-pointer flex items-center justify-center hover:bg-surface2 hover:text-t1"
          title={busy ? "取消翻译(Esc)" : pendingCount > 0 ? `续译 ${pendingCount} 块(⌘R)` : "重新翻译(⌘R)"}
          onClick={busy ? cancelCurrent : resumeOrDone}
        >
          <span className={busy ? "animate-spin" : ""}><Icon n={busy ? "loader" : "refresh"} size={15} /></span>
          {!busy && pendingCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-accent text-white text-[9px] font-semibold flex items-center justify-center">{pendingCount}</span>
          )}
        </button>
      </div>
      {!doc && !hintDone && (
        <div className="absolute bottom-2 inset-x-0 text-center text-[10px] text-t3 opacity-80 z-[19]">点英文单词查词收藏 · ⌘N 新建 · ⌘R 续译 · ⌥T 快捷窗</div>
      )}

      {/* TOC 目录侧轨:≥3 个标题才出现,hover 展开;纯净模式隐藏 */}
      {doc && toc.length >= 3 && view !== "pure" && (
        <nav className="group fixed left-0 top-20 bottom-[110px] z-30 flex items-stretch">
          <div className="bg-surface border border-line border-l-0 rounded-r-xl shadow-[var(--shadow-capsule)] py-3 px-1 w-9 overflow-hidden overflow-y-auto transition-[width] duration-200 ease-out max-h-full group-hover:w-[230px] group-hover:px-3 group-hover:py-2.5">
            <span className="[writing-mode:vertical-rl] text-[10px] text-t3 tracking-[6px] pl-1.5 whitespace-nowrap group-hover:hidden">目录</span>
            {toc.map((t) => (
              <button
                key={t.idx}
                className={"hidden group-hover:block w-full border-none bg-none text-left text-t2 cursor-pointer py-1 px-2 rounded-md whitespace-nowrap overflow-hidden text-ellipsis hover:text-t1 hover:bg-surface2 " + (t.level >= 3 ? "pl-5 text-[11.5px] text-t3" : "text-xs leading-normal")}
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
        <div className="fixed z-[70] bg-surface border border-accent rounded-xl shadow-[var(--shadow-card)] px-3.5 py-3 min-w-[200px]" style={{ left: Math.min(termPop.x, window.innerWidth - 240), top: Math.min(termPop.y, window.innerHeight - 130) }}>
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-code text-xs text-t2">{termPop.hit.from}</span>
            <span className="text-t3">→</span>
            <span className="text-accent font-semibold">{termPop.hit.to}</span>
          </div>
          <div className="flex gap-2 mt-2">
            <button className="text-[11px] border border-line bg-none text-t2 rounded-[7px] px-2.5 py-[3px] cursor-pointer hover:text-accent hover:border-accent" onClick={() => disableTerm(termPop.hit)}>停用此术语</button>
            <button className="text-[11px] border border-line bg-none text-t2 rounded-[7px] px-2.5 py-[3px] cursor-pointer hover:text-accent hover:border-accent" onClick={() => setTermPop(null)}>关闭</button>
          </div>
        </div>
      )}

      {/* 库滑出层 */}
      {panel === "library" && (
        <>
          <div className="absolute inset-0 bg-scrim z-40 [animation:fadein_0.18s]" onClick={() => setPanel(null)} />
          <aside className="absolute left-[18px] top-3.5 bottom-3.5 w-[336px] bg-surface border border-line rounded-2xl shadow-[var(--shadow-card)] z-50 flex flex-col gap-3 px-3.5 pt-4 pb-3 [animation:slidein-l_0.2s_ease]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <b className="text-[15px] font-semibold">文章库</b><span className="text-[11px] text-t3">{articles.length}</span>
              <span className="flex-1" />
              <button className="flex items-center gap-1 h-[30px] bg-accent text-white rounded-[9px] text-xs font-medium px-2.5 cursor-pointer" onClick={() => { setPanel(null); setComposing(true); }}>
                <Icon n="plus" size={13} /> 新建
              </button>
            </div>
            <div className="h-[34px] bg-surface2 rounded-[9px] flex items-center px-2.5 gap-[7px] text-t3">
              <Icon n="search" size={14} />
              <input className="border-none outline-none bg-transparent w-full text-xs text-t1" placeholder="搜索标题…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="flex-1 overflow-y-auto flex flex-col gap-0.5">
              {filtered.map((a) => (
                <div
                  key={a.id}
                  className={"group py-2 px-2.5 rounded-[9px] cursor-pointer flex flex-col gap-[3px] hover:bg-surface2 " + (doc?.article.id === a.id ? "bg-accentsoft" : "")}
                  onClick={() => { setPanel(null); openArticle(a.id); }}
                >
                  <div className={"text-[10px] flex gap-1.5 items-center " + (doc?.article.id === a.id ? "text-accent" : "text-t3")}>
                    <span>{a.kind === "md" ? "MD" : "粘贴"}</span>
                    <span>{fmtDate(a.updated_at)} · {a.blocks_done}/{a.blocks_total} 块</span>
                    <span className="flex-1" />
                    {/* v4:置顶/删除仅 hover 显示,图标化 */}
                    <span className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100">
                      <button
                        title={a.pinned ? "取消置顶" : "置顶"}
                        className={"border-none bg-none cursor-pointer p-0 " + (a.pinned ? "text-accent" : "text-t3 hover:text-accent")}
                        onClick={(e) => { e.stopPropagation(); api.pinArticle(a.id, !a.pinned).then(refreshLib); }}
                      >
                        <Icon n="pin" size={11} />
                      </button>
                      <button
                        title="删除"
                        className="border-none bg-none cursor-pointer p-0 text-t3 hover:text-[#d25a5a]"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirm({
                            title: "删除这篇文章?",
                            body: a.title,
                            confirmText: "删除",
                            onConfirm: () => { api.deleteArticle(a.id).then(() => { refreshLib(); if (doc?.article.id === a.id) setDoc(null); say("已删除"); }); },
                          });
                        }}
                      >
                        <Icon n="x" size={11} />
                      </button>
                    </span>
                  </div>
                  <div className={"text-[12.5px] leading-snug " + (doc?.article.id === a.id ? "text-t1 font-medium" : "text-t2")}>{a.title}</div>
                </div>
              ))}
              {filtered.length === 0 && <div className="p-2 text-t3 text-[11px]">无匹配 · ⌘N 新建翻译</div>}
            </div>
            <div className="border-t border-line pt-2.5 flex gap-2">
              <button className="flex-1 flex items-center gap-2 h-9 rounded-[9px] text-[12.5px] text-t2 px-2.5 cursor-pointer border-none hover:bg-surface2 hover:text-t1" onClick={() => setPanel("glossary")}><Icon n="tag" size={15} /> 术语库 <b className="text-accent font-semibold text-xs">{glossaryCount}</b></button>
              <button className="flex-1 flex items-center gap-2 h-9 rounded-[9px] text-[12.5px] text-t2 px-2.5 cursor-pointer border-none hover:bg-surface2 hover:text-t1" onClick={() => setPanel("vocab")}><Icon n="bookmark" size={15} /> 生词本 <b className="text-accent font-semibold text-xs">{vocabCount}</b></button>
            </div>
          </aside>
        </>
      )}
      {panel === "vocab" && <VocabPanel onClose={() => setPanel(null)} onCount={setVocabCount} say={say} />}
      {panel === "glossary" && <GlossaryPanel onClose={() => setPanel(null)} say={say} />}

      {/* G3 全屏新建 */}
      {composing && (
        <div className="absolute inset-0 bg-surface z-[45] flex flex-col [animation:fadein_0.18s]">
          <div className="h-14 flex items-center gap-3 px-6" data-tauri-drag-region>
            <button className="flex items-center gap-1.5 border-none bg-none text-t2 text-[13px] rounded-lg px-2 py-1.5 cursor-pointer hover:bg-surface2 hover:text-t1" onClick={() => setComposing(false)}><Icon n="x" size={14} /> 取消</button>
            <span className="flex-1 text-center text-[13px] text-t2" data-tauri-drag-region>新建翻译</span>
            <span className="w-16" data-tauri-drag-region />
          </div>
          <div className="flex-1 overflow-y-auto flex flex-col items-center px-6 pt-2 pb-[130px]">
            <div className="w-full max-w-[720px] flex flex-col">
              <textarea
                autoFocus
                className="w-full min-h-[300px] border-none outline-none resize-none text-[15px] leading-[1.85] text-t1 bg-transparent placeholder:text-t3"
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
              {/* v4:拖放区仅空态显示 */}
              {!draft.trim() && (
                <div className="mt-2.5 h-14 rounded-xl border-[1.5px] border-dashed border-line flex items-center justify-center gap-2 text-xs text-t3 cursor-pointer hover:border-accent hover:text-accent" onClick={() => fileRef.current?.click()}>
                  <Icon n="import" size={15} /> 拖入 .md / .txt 文件,或点击选择
                </div>
              )}
            </div>
          </div>
          <div className="absolute left-1/2 -translate-x-1/2 bottom-7 h-[50px] bg-surface border border-line rounded-2xl shadow-[var(--shadow-capsule)] flex items-center gap-2 pl-4 pr-2.5">
            <span className="font-code text-[11px] text-t3">{draft.length} 字</span>
            <span className="flex items-center h-8 px-1.5 bg-surface2 rounded-lg">
              <DirPicker value={direction} onChange={(d) => { setDirection(d); applyPrefs({ direction: d }); }} />
            </span>
            <span className="flex-1" />
            <button className="flex items-center gap-1.5 h-8 bg-surface2 text-t2 rounded-[9px] text-xs px-3 cursor-pointer hover:text-t1 border-none" onClick={() => fileRef.current?.click()}>
              <Icon n="import" size={13} /> 导入 .md
            </button>
            <button className="flex items-center gap-1.5 h-8 bg-accent text-white rounded-[9px] text-xs font-medium px-3 cursor-pointer disabled:opacity-45 disabled:cursor-default border-none" disabled={!draft.trim()} onClick={startTranslate}>
              <Icon n="sparkles" size={13} /> 翻译 <kbd className="!bg-white/18 !text-white !border-transparent">⌘↩</kbd>
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
          rs={rs}
          setRs={setRs}
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
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setDraft(await f.text());
          setComposing(true);
          e.target.value = "";
        }}
      />
      {confirm && <ConfirmCard title={confirm.title} body={confirm.body} confirmText={confirm.confirmText} onConfirm={confirm.onConfirm} onClose={() => setConfirm(null)} />}
      {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-t1 text-bg text-xs px-4 py-2 rounded-[10px] z-[99] shadow-[var(--shadow-card)]">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
