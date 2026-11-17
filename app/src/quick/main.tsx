import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { CodeBox, Md } from "../md";
import { Icon } from "../icons";
import * as api from "../api";
import { dirLabel, dirShort, detectDir } from "../languages";
import { DirPicker } from "../dirselect";
import { initNative } from "../native";
import { Segmented, TbButton } from "../ui";
import { addUsage, EMPTY_USAGE } from "../types";
import type { Block, Prefs, Provider, SessionUsage, StreamEvent } from "../types";
import "../styles.css";

initNative();

// 浏览器直开(无 Tauri 环境)时降级:窗口操作静默跳过
const w = (() => { try { return getCurrentWindow(); } catch { return null; } })();
const safe = async (fn: () => unknown) => { try { await fn(); } catch { /* 浏览器或权限缺失 */ } };

// 剪贴板指纹:判断「新复制的内容」(假划词预填用)
function clipHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

function useLocalFlag(key: string, init: boolean) {
  const [v, setV] = useState(() => (localStorage.getItem(key) === null ? init : localStorage.getItem(key) === "1"));
  return [v, (n: boolean) => { localStorage.setItem(key, n ? "1" : "0"); setV(n); }] as const;
}

type QView = "zh" | "pair" | "src";
const QVIEWS = [["zh", "译文"], ["pair", "对照"], ["src", "原文"]] as const;

function QuickApp() {
  const [input, setInput] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [phase, setPhase] = useState<"idle" | "streaming" | "done">("idle");
  const [articleId, setArticleId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [direction, setDirection] = useState("en2zh");
  const [pin, setPin] = useLocalFlag("q-pin", true);
  const [auto, setAuto] = useLocalFlag("q-auto", true);
  const [view, setView] = useState<QView>("zh");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [usage, setUsage] = useState<SessionUsage>(EMPTY_USAGE); // 本次翻译累计 token(usage 事件)
  const hideOnBlur = !!prefs?.blur_hide;
  const sessionRef = useRef(0);
  const [dirOpen, setDirOpen] = useState(false);
  const [provOpen, setProvOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1800); };

  const active = providers.find((p) => p.is_active);
  const outText = blocks.filter((b) => b.trans).map((b) => b.trans).join("\n\n");

  // 写 prefs(Rust 侧广播 prefs-changed,主窗 / 设置窗同步)
  const savePrefs = (u: Partial<Prefs>) => api.setPrefs(u).then((p) => { setPrefs(p); setDirection(p.direction); return p; });

  const refreshProviders = () => api.providerList().then((p) => { setProviders(p); emit("providers-changed", p).catch(() => {}); }).catch(() => {});
  useEffect(() => {
    refreshProviders();
    api.getPrefs().then((p) => { setPrefs(p); setDirection(p.direction); }).catch(() => {});
    const un1 = listen<Prefs>("prefs-changed", (e) => { setPrefs(e.payload); setDirection(e.payload.direction); });
    const un2 = listen<Provider[]>("providers-changed", (e) => setProviders(e.payload));
    return () => { un1.then((f) => f()); un2.then((f) => f()); };
  }, []);

  // pin 置顶(默认开)
  useEffect(() => { if (w) safe(() => w.setAlwaysOnTop(pin)); }, [pin]);

  // 失焦自动隐藏(默认关;与 pin 互斥)
  useEffect(() => {
    if (!w) return;
    const un = w.onFocusChanged(({ payload: focused }) => {
      if (!focused && hideOnBlur && !pin) safe(() => w.hide());
    });
    return () => { un.then((f) => f()); };
  }, [hideOnBlur, pin]);

  // 唤出事件(Rust toggle_quick 发来):新剪贴板内容预填「假划词」;监听只挂一次,经 ref 取最新闭包
  const shownRef = useRef<(t: string) => void>(() => {});
  useEffect(() => {
    const un = listen("quick-shown", async () => {
      try {
        const t = await readText();
        if (t && t.trim() && clipHash(t) !== localStorage.getItem("q-last-clip")) {
          localStorage.setItem("q-last-clip", clipHash(t));
          shownRef.current(t);
        }
      } catch { /* 浏览器降级 */ }
    });
    return () => { un.then((f) => f()); };
  }, []);

  const onEvent = (e: StreamEvent) => {
    if (e.type === "created") {
      setArticleId(e.article_id); // 翻译即自动入库
      setBlocks(e.blocks);
    } else if (e.type === "usage") {
      setUsage((u) => addUsage(u, e));
    } else if (e.type === "block") {
      setBlocks((bs) => bs.map((b) => (b.idx === e.idx ? { ...b, trans: e.text, status: "done" } : b)));
    } else if (e.type === "partial") {
      setBlocks((bs) => bs.map((b) => (b.idx === e.idx ? { ...b, trans: e.text, status: "streaming" } : b)));
    } else if (e.type === "error") {
      setErr(e.message);
    } else if (e.type === "done") {
      setPhase("done");
    }
  };

  const fire = async (text = input) => {
    if (!text.trim()) return;
    if (sessionRef.current) { try { await api.cancelTranslate(sessionRef.current); } catch {} }
    setPhase("streaming");
    setErr(null);
    setBlocks([]);
    setArticleId(null);
    setUsage(EMPTY_USAGE);
    const effDir = direction === "auto" ? detectDir(text) : direction;
    try {
      sessionRef.current = await api.translate({ text, direction: effDir, kind: "paste" }, onEvent);
    } catch (e) {
      setPhase("idle");
      setErr(String(e));
    }
  };

  const cancel = async () => {
    if (sessionRef.current) { try { await api.cancelTranslate(sessionRef.current); } catch {} }
    setPhase("done");
  };

  const pasteOrType = (t: string) => {
    setInput(t);
    if (auto && t.trim()) fire(t);
  };
  shownRef.current = pasteOrType;

  const showMain = () => safe(async () => {
    const m = await WebviewWindow.getByLabel("main");
    await m?.show();
    await m?.setFocus();
  });
  const openInMain = async () => {
    if (!articleId) return;
    await showMain();
    await safe(() => emit("open-article", { id: articleId }));
  };
  const openSettings = () => safe(() => api.openSettings("models"));

  const switchProvider = async (id: number) => {
    const next = providers.find((p) => p.id === id);
    setProvOpen(false);
    if (!next || next.is_active) return;
    try {
      await api.providerSetActive(id);
      await refreshProviders();
      say(`已切换到 ${next.name}`);
    } catch (e) { say(String(e)); }
  };

  const togglePin = () => {
    const next = !pin;
    if (next && hideOnBlur) { savePrefs({ blur_hide: false }).catch(() => {}); say("已关闭「失焦隐藏」:两者互斥"); }
    setPin(next);
  };

  const clear = () => { setInput(""); setBlocks([]); setPhase("idle"); setErr(null); setUsage(EMPTY_USAGE); setArticleId(null); };
  const streaming = phase === "streaming";

  // 下拉点外部关闭
  useEffect(() => {
    if (!dirOpen && !provOpen) return;
    const h = () => { setDirOpen(false); setProvOpen(false); };
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [dirOpen, provOpen]);

  // 全局键:Esc 先收下拉、翻译中则取消;⌘D 切对照(视图切换也在工具栏分段控件)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { e.preventDefault(); setView((v) => (v === "pair" ? "zh" : "pair")); return; }
      if (e.key !== "Escape") return;
      if (dirOpen || provOpen) { setDirOpen(false); setProvOpen(false); return; }
      if (phase === "streaming") cancel();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirOpen, provOpen, phase]);

  const autoDir = direction === "auto";
  // 「自动(英语)→ 中文」:有输入时显示识别结果,否则只显示「自动」
  const dirText = autoDir
    ? input.trim() ? (() => { const [a, b] = dirLabel(detectDir(input)).split(" → "); return `自动(${a})→ ${b}`; })() : "自动识别"
    : dirShort(direction);

  // 单块渲染:译文 / 原文 / 对照(窄宽对照 = 每块上原文下译文)
  const zhOf = (b: Block) =>
    b.trans ? (
      <div className={"zh md" + (b.status === "streaming" ? " streaming" : "")}><Md text={b.trans} /></div>
    ) : (
      <p className="zh m-0 text-t3">{streaming ? <span className="caret" /> : "待译"}</p>
    );
  const enOf = (b: Block, size: string) => <div className={"en md leading-[1.7] " + size}><Md text={b.src} /></div>;

  return (
    <div className="relative flex flex-col h-screen overflow-hidden mat">
      {/* 统一工具栏(44pt;红绿灯 {16,24} 中线对齐) */}
      <div className="tb tb-quick" data-tauri-drag-region>
        <Segmented value={view} options={QVIEWS} onChange={setView} />
        <span className="flex-1 self-stretch" data-tauri-drag-region />
        <TbButton icon="pin" title={pin ? "置顶中(点击取消)" : "置顶窗口"} active={pin} onClick={togglePin} size={14} />
        <TbButton icon="win" title="打开主窗口" onClick={showMain} size={14} />
      </div>

      {/* 弹出按钮行:方向 · 粘贴即译 · 模型 */}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <div className="relative min-w-0">
          <button
            className="pbtn max-w-[220px]"
            title={autoDir ? "自动识别源语言" : "翻译方向"}
            onClick={(e) => { e.stopPropagation(); setDirOpen(!dirOpen); setProvOpen(false); }}
          >
            <span className="truncate">{dirText}</span><Icon n="chev" size={11} />
          </button>
          {dirOpen && (
            <div className="menu absolute z-30 top-full mt-1 left-0 !p-2.5" onClick={(e) => e.stopPropagation()}>
              <DirPicker value={direction} onChange={(d) => { setDirection(d); setDirOpen(false); savePrefs({ direction: d }).catch(() => {}); }} />
            </div>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-t2 whitespace-nowrap flex-none" title="粘贴或唤出时检测到新复制的文本即自动翻译">
          <input type="checkbox" checked={auto} onChange={() => setAuto(!auto)} /> 粘贴即译
        </label>
        <span className="flex-1" />
        <div className="relative min-w-0">
          <button
            className="pbtn max-w-[170px]"
            title={active ? `${active.name} · ${active.model}` : "未配置模型"}
            onClick={(e) => { e.stopPropagation(); if (!providers.length) { openSettings(); return; } setProvOpen(!provOpen); setDirOpen(false); }}
          >
            {active ? <span className="truncate">{active.model}</span> : <span className="text-t3">未配置</span>}<Icon n="chev" size={11} />
          </button>
          {provOpen && (
            <div className="menu absolute z-40 top-full mt-1 right-0" onClick={(e) => e.stopPropagation()}>
              {providers.map((p) => (
                <button key={p.id} title={p.base_url} onClick={() => switchProvider(p.id)}>
                  <span className="w-3 flex-none text-accent">{p.is_active ? "✓" : ""}</span>
                  <span>{p.name}</span>
                  <span className="ml-auto pl-4 font-code text-[11px] text-t3">{p.model}</span>
                </button>
              ))}
              <hr />
              <button onClick={() => { setProvOpen(false); openSettings(); }}><span className="w-3 flex-none" />管理模型…</button>
            </div>
          )}
        </div>
      </div>

      {/* 源文 */}
      <div className="mx-3 mt-2.5 rounded-lg bg-doc/60 border-[0.5px] border-line px-2.5 py-2 flex-none">
        <textarea
          className="w-full h-[64px] border-none outline-none resize-none bg-transparent text-[13px] leading-[1.5] text-t1 placeholder:text-t3"
          value={input}
          placeholder={providers.length ? "粘贴或输入要翻译的文本" : "先配置一个翻译模型 →「管理模型…」"}
          title="⌘↩ 翻译 · Esc 取消"
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            e.preventDefault();
            if (t) pasteOrType(t);
            else say("剪贴板里没有文本");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fire(); }
          }}
        />
      </div>

      {/* 未配置引导 */}
      {(!providers.length || !active) && (
        <button className="btn primary mx-3 mt-2 justify-center" onClick={openSettings}>
          {providers.length ? "尚未选择使用中的模型 · 打开设置" : "首次使用:配置翻译模型"}
        </button>
      )}

      {/* 译文区:文档实底 */}
      <div className="doc flex-1 min-h-0 mx-2.5 mt-2.5 rounded-lg bg-doc overflow-y-auto px-4 py-3 flex flex-col gap-2.5 [--zh-size:15px] [--zh-line:1.75]">
        {err && <p className="text-danger text-[12px] bg-surface2 rounded-md px-2.5 py-2 m-0">{err}</p>}
        {!blocks.length && !err && (
          <p className="text-t3 text-[12px] m-0">
            {streaming ? <>连接中 <span className="caret" /></> : `译文将逐块流式显示,并自动存入文章库 · ${autoDir ? (input.trim() ? dirLabel(detectDir(input)) : "自动识别语言") : dirLabel(direction)}`}
          </p>
        )}
        {blocks.map((b) =>
          b.kind === "code" ? (
            <CodeBox key={b.idx} src={b.src} />
          ) : view === "src" ? (
            <div key={b.idx}>{enOf(b, "text-[14px]")}</div>
          ) : view === "pair" ? (
            <div key={b.idx} className="flex flex-col gap-1">{enOf(b, "text-[13.5px]")}{zhOf(b)}</div>
          ) : (
            <div key={b.idx}>{zhOf(b)}</div>
          ),
        )}
      </div>

      {/* 状态栏:指标 + 复制 + 主操作 */}
      <div className="h-[38px] flex items-center gap-2 px-3 flex-none">
        <span className="text-[11px] text-t3 truncate min-w-0" title={usage.requests ? `本次 ${usage.requests} 次请求 · 输入 ${usage.prompt_tokens} · 输出 ${usage.completion_tokens}${usage.reasoning_tokens ? `(含思考 ${usage.reasoning_tokens})` : ""} tokens` : undefined}>
          {streaming ? <><i className="inline-block w-1.5 h-1.5 rounded-full bg-accent mr-1.5 align-middle [animation:breathe_1.2s_infinite]" />翻译中</> : usage.requests ? `输入 ${usage.prompt_tokens} · 输出 ${usage.completion_tokens} tok` : ""}
        </span>
        <span className="flex-1" />
        {input && !streaming && <button className="btn" onClick={clear}>清空</button>}
        <button className="btn" disabled={!outText} onClick={() => navigator.clipboard?.writeText(outText).then(() => say("已复制"))}>复制</button>
        {streaming ? (
          <button className="btn" onClick={cancel}>取消</button>
        ) : phase === "done" && articleId ? (
          <button className="btn primary" onClick={openInMain} title="翻译已自动存入文章库">在主窗打开</button>
        ) : (
          <button className="btn primary" disabled={!input.trim() || !active} onClick={() => fire()} title="⌘↩">翻译</button>
        )}
      </div>
      {toast && <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-t1 text-doc text-[12px] px-3 py-1.5 rounded-md z-[99] whitespace-nowrap">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<QuickApp />);
