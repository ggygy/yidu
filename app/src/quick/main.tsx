import { createRoot } from "react-dom/client";
import React, { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { DEMO_INPUT } from "../data";
import { CodeBox, Md } from "../md";
import { Icon } from "../icons";
import * as api from "../api";
import { dirLabel, dirShort } from "../languages";
import { DirPicker } from "../dirselect";
import type { Block, Prefs, Provider, StreamEvent } from "../types";
import "../styles.css";

// macOS 头部需给系统红绿灯让位;Windows 有原生标题栏
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

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

const Q_ICON_BTN = "w-7 h-7 rounded-lg text-t3 hover:bg-surface2 hover:text-t1 flex items-center justify-center cursor-pointer border-none bg-none";

function QuickApp() {
  const [input, setInput] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [phase, setPhase] = useState<"idle" | "streaming" | "done">("idle");
  const [articleId, setArticleId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [direction, setDirection] = useState("en2zh");
  const [pin, setPin] = useLocalFlag("q-pin", true);
  const [hideOnBlur, setHideOnBlur] = useLocalFlag("q-blur-hide", false);
  const [auto, setAuto] = useLocalFlag("q-auto", true);
  const [showEn, setShowEn] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const sessionRef = useRef(0);
  const [dirOpen, setDirOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1800); };

  const active = providers.find((p) => p.is_active);
  const outText = blocks.filter((b) => b.trans).map((b) => b.trans).join("\n\n");

  const refreshProviders = () => api.providerList().then(setProviders).catch(() => {});
  useEffect(() => {
    refreshProviders();
    api.getPrefs().then((p) => { setPrefs(p); setDirection(p.direction); }).catch(() => {});
    // 主窗改动实时跟随(prefs/provider 广播;webview 预创建,mount 后事件是唯一同步渠道)
    const un1 = listen<Prefs>("prefs-changed", (e) => { setPrefs(e.payload); setDirection(e.payload.direction); });
    const un2 = listen<Provider[]>("providers-changed", (e) => setProviders(e.payload));
    return () => { un1.then((f) => f()); un2.then((f) => f()); };
  }, []);

  // 深色外观:跟随主窗设置(同源 localStorage + 跨窗事件即时同步)
  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem("v3-dark") === "1" ? "dark" : "";
    const un = listen("theme-changed", (e) => {
      const on = !!e.payload;
      localStorage.setItem("v3-dark", on ? "1" : "0");
      document.documentElement.dataset.theme = on ? "dark" : "";
    });
    return () => { un.then((f) => f()); };
  }, []);

  // ⌘D 切换对照双栏
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { e.preventDefault(); setShowEn((v) => !v); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
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

  // 唤出事件(Rust toggle_quick 发来):新剪贴板内容预填「假划词」
  useEffect(() => {
    const un = listen("quick-shown", async () => {
      try {
        const t = await readText();
        if (t && t.trim() && clipHash(t) !== localStorage.getItem("q-last-clip")) {
          localStorage.setItem("q-last-clip", clipHash(t));
          setInput(t);
          if (auto) fire(t);
        }
      } catch { /* 浏览器降级 */ }
    });
    return () => { un.then((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const onEvent = (e: StreamEvent) => {
    if (e.type === "created") {
      setArticleId(e.article_id); // 翻译即自动入库(工单 08)
      setBlocks(e.blocks);
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
    try {
      const s = await api.translate({ text, direction, kind: "paste" }, onEvent);
      sessionRef.current = s;
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

  const openInMain = async () => {
    if (!articleId) return;
    await safe(async () => {
      const m = await WebviewWindow.getByLabel("main");
      await m?.show();
      await m?.setFocus();
      await emit("open-article", { id: articleId });
    });
  };

  const openSettingsInMain = async () => {
    await safe(async () => {
      const m = await WebviewWindow.getByLabel("main");
      await m?.show();
      await m?.setFocus();
      await emit("open-settings", {});
    });
  };

  const cycleProvider = async () => {
    if (providers.length < 1) return;
    const i = providers.findIndex((p) => p.is_active);
    const next = providers[(i + 1) % providers.length];
    try {
      await api.providerSetActive(next.id);
      await refreshProviders();
      say(`已切换 ${next.model}`);
    } catch (e) { say(String(e)); }
  };

  const togglePin = () => {
    const next = !pin;
    if (next && hideOnBlur) { setHideOnBlur(false); say("已关闭「失焦隐藏」:两者互斥"); }
    setPin(next);
  };
  const toggleBlur = () => {
    const next = !hideOnBlur;
    if (next && pin) { setPin(false); say("已关闭 pin:失焦隐藏生效"); }
    setHideOnBlur(next);
  };

  const streaming = phase === "streaming";

  return (
    <div className="relative flex flex-col h-screen overflow-hidden bg-surface">
      {/* 单行头部(v4:即标题栏,可拖拽;系统红绿灯 Overlay 叠加,不再自绘) */}
      <div className={"h-12 flex items-center gap-2 pr-3 select-none " + (IS_MAC ? "pl-16" : "px-3")} data-tauri-drag-region>
        <b className="text-xs font-semibold" data-tauri-drag-region>快捷翻译</b>
        <kbd>{prefs ? prefs.hotkey.replace("Alt", "⌥").replace("CommandOrControl", "⌘").replace("Shift", "⇧") : "⌥T"}</kbd>
        <span className="flex-1" data-tauri-drag-region />
        <button title={pin ? "置顶中(点击取消)" : "置顶窗口"} className={Q_ICON_BTN + (pin ? " !text-accent !bg-accentsoft" : "")} onClick={togglePin}>
          <Icon n="pin" size={14} />
        </button>
        <button className={Q_ICON_BTN} title="打开主窗口" onClick={() => safe(async () => { const m = await WebviewWindow.getByLabel("main"); await m?.show(); await m?.setFocus(); })}>
          <Icon n="win" size={14} />
        </button>
        <button className={Q_ICON_BTN} title="隐藏(热键唤回)" onClick={() => w && safe(() => w.hide())}>
          <Icon n="x" size={14} />
        </button>
      </div>

      {/* 无 Provider 引导 */}
      {providers.length > 0 && !active && (
        <button className="flex items-center justify-center gap-1.5 mx-3.5 mt-1.5 py-[7px] px-2.5 border border-dashed border-accent rounded-[10px] bg-accentsoft text-accent text-[11.5px] font-medium cursor-pointer hover:brightness-95" onClick={openSettingsInMain}>
          <Icon n="sparkles" size={13} /> 尚未激活 Provider,点此打开设置配置
        </button>
      )}
      {providers.length === 0 && (
        <button className="flex items-center justify-center gap-1.5 mx-3.5 mt-1.5 py-[7px] px-2.5 border border-dashed border-accent rounded-[10px] bg-accentsoft text-accent text-[11.5px] font-medium cursor-pointer hover:brightness-95" onClick={openSettingsInMain}>
          <Icon n="sparkles" size={13} /> 首次使用:点此配置翻译 Provider
        </button>
      )}

      {/* 去框控制行 */}
      <div className="flex items-center gap-4 px-4 pt-0.5">
        <div className="relative">
          <button
            className="flex items-center gap-1.5 border-none bg-none text-xs text-t2 cursor-pointer px-0.5 py-1 hover:text-t1"
            title="翻译方向"
            onClick={() => setDirOpen(!dirOpen)}
          >
            <Icon n="swap" size={13} /> {dirShort(direction)} <Icon n="chev" size={11} />
          </button>
          {dirOpen && (
            <div className="absolute z-30 top-full mt-1 left-0 bg-surface border border-line rounded-xl shadow-[var(--shadow-card)] px-3 py-2.5">
              <DirPicker
                value={direction}
                onChange={(d) => { setDirection(d); setDirOpen(false); api.setPrefs({ direction: d }).then(setPrefs).catch(() => {}); }}
              />
            </div>
          )}
        </div>
        <button className={"flex items-center gap-1.5 border-none bg-none text-xs cursor-pointer px-0.5 py-1 hover:text-t1 " + (auto ? "text-accent font-medium" : "text-t2")} onClick={() => setAuto(!auto)}>
          <Icon n="zap" size={13} /> 粘贴即译{auto ? "" : " ·关"}
        </button>
        <span className="flex-1" />
        {active ? (
          <button className="flex items-center gap-1.5 h-[26px] border-none bg-surface2 rounded-lg px-2 font-code text-[10px] text-t2 cursor-pointer hover:text-t1" title="切换 Provider" onClick={cycleProvider}>
            <i className="w-[5px] h-[5px] rounded-full bg-ok" />{active.model}<Icon n="chev" size={11} />
          </button>
        ) : (
          <button className="flex items-center gap-1.5 h-[26px] border-none bg-surface2 rounded-lg px-2 font-code text-[10px] text-t2 cursor-pointer hover:text-t1" onClick={openSettingsInMain}>
            <i className="w-[5px] h-[5px] rounded-full bg-ok" />未配置<Icon n="chev" size={11} />
          </button>
        )}
      </div>

      {/* 输入块 */}
      <div className="mx-3.5 mt-2.5 bg-surface2 rounded-xl px-3 pt-2.5 pb-2">
        <textarea
          className="w-full h-[76px] border-none outline-none resize-none bg-transparent text-[12.5px] leading-[1.55] text-t1 placeholder:text-t3"
          value={input}
          placeholder="⌘V 粘贴文本或截图(P1 识别)· markdown"
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (t) { e.preventDefault(); pasteOrType(t); }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fire(); }
            if (e.key === "Escape") cancel();
          }}
        />
        <div className="flex items-center gap-2 mt-1">
          <kbd>⌘V</kbd><span className="text-[10px] text-t3">粘贴</span>
          <kbd>⌘↩</kbd><span className="text-[10px] text-t3">翻译</span>
          <kbd>Esc</kbd><span className="text-[10px] text-t3">取消</span>
          <span className="flex-1" />
          <button className="border-none bg-none text-[10.5px] text-t3 cursor-pointer px-1 py-0.5 hover:text-accent" onClick={() => { setInput(DEMO_INPUT); fire(DEMO_INPUT); }}>载入演示 ⚡</button>
          {input && <button className="border-none bg-none text-[10.5px] text-t3 cursor-pointer px-1 py-0.5 hover:text-accent" onClick={() => { setInput(""); setBlocks([]); setPhase("idle"); setErr(null); }}>清空</button>}
        </div>
      </div>

      {/* 输出:逐块流式 md 渲染 */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-[74px] flex flex-col gap-2.5">
        {err && <p className="text-[#d25a5a] text-[11.5px] bg-[rgba(210,90,90,0.08)] rounded-lg px-2.5 py-2 m-0">{err}</p>}
        {!blocks.length && !err && phase === "idle" && (
          <p className="text-t3 text-xs mt-1.5 m-0">译文将逐块流式渲染 · 自动存入文章库 · {dirLabel(direction)}</p>
        )}
        {blocks.length > 0 && (
          <>
            {showEn ? (
              /* 对照 = 左右双栏:左原文 · 右译文(竖线分隔);code 块左列渲染占位保块序 1:1 对齐 */
              <div className="grid grid-cols-2 gap-x-3 items-start">
                <div className="flex flex-col gap-2.5 min-w-0">
                  {blocks.map((b) =>
                    b.kind === "code" ? (
                      <div key={"e" + b.idx} className="text-[10.5px] text-t3 border border-dashed border-line rounded-lg px-2.5 py-[5px] text-center">··· 代码块({b.src.trim().split("\n").length} 行)···</div>
                    ) : (
                      <div key={"e" + b.idx} className="en md text-[11px] leading-[1.6] break-words">
                        <Md text={b.src} />
                      </div>
                    ),
                  )}
                </div>
                <div className="flex flex-col gap-2.5 min-w-0 border-l border-line pl-3">
                  {blocks.map((b) =>
                    b.kind === "code" ? (
                      <CodeBox key={b.idx} src={b.src} />
                    ) : b.trans ? (
                      <div key={b.idx} className="zh md !text-[13px] !leading-[1.8] !font-ui" style={{ opacity: b.status === "streaming" ? 0.55 : undefined }}>
                        <Md text={b.trans} />
                      </div>
                    ) : (
                      <p key={b.idx} className="text-t3 text-xs m-0">{streaming ? "…" : "待译"}</p>
                    ),
                  )}
                </div>
              </div>
            ) : (
              blocks.map((b) =>
                b.kind === "code" ? (
                  <CodeBox key={b.idx} src={b.src} />
                ) : b.trans ? (
                  <div key={b.idx} className="zh md !text-[13px] !leading-[1.8] !font-ui" style={{ opacity: b.status === "streaming" ? 0.55 : undefined }}>
                    <Md text={b.trans} />
                  </div>
                ) : (
                  <p key={b.idx} className="text-t3 text-xs m-0">{streaming ? "…" : "待译"}</p>
                ),
              )
            )}
            {streaming && (
              <div className="flex items-center gap-2.5 mt-1">
                <div className="w-[150px] h-[3px] bg-surface2 rounded-sm overflow-hidden">
                  <i className="block w-2/5 h-full bg-accent rounded-sm [animation:slide_1.2s_infinite]" />
                </div>
                <span className="text-[11px] text-accent">流式输出中(Esc 取消)</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* 交互提示 */}
      <div className="absolute inset-x-0 bottom-[62px] text-center text-[9.5px] text-t3 z-[19]">
        实验开关:
        <a className="cursor-pointer" style={{ color: hideOnBlur ? "var(--accent)" : "inherit" }} onClick={toggleBlur}>[失焦隐藏:{hideOnBlur ? "开" : "关"}]</a>
        {" · 热键唤出 · 自动入库"}
      </div>

      {/* 悬浮操作胶囊 */}
      <div className="absolute left-3.5 right-3.5 bottom-3.5 h-11 bg-surface border border-line rounded-[22px] shadow-[var(--shadow-capsule)] flex items-center gap-1.5 pl-2.5 pr-2 z-20">
        <button className="flex items-center gap-1.5 h-8 px-3 border-none bg-surface2 rounded-full text-[11.5px] text-t2 cursor-pointer disabled:opacity-40" disabled={!outText} onClick={() => navigator.clipboard?.writeText(outText).then(() => say("已复制"))}>
          <Icon n="copy" size={13} /> 复制
        </button>
        <button className={"flex items-center gap-1.5 h-8 px-3 border-none rounded-full text-[11.5px] cursor-pointer disabled:opacity-40 " + (showEn ? "bg-accentsoft text-accent font-medium" : "bg-surface2 text-t2")} disabled={!blocks.length} title="对照(⌘D)" onClick={() => setShowEn(!showEn)}>
          <Icon n="eye" size={13} /> 对照
        </button>
        <span className="flex-1" />
        <button className="flex items-center gap-1.5 h-8 px-3 border-none rounded-full text-[11.5px] font-medium text-accent cursor-pointer bg-none disabled:opacity-40 disabled:text-t3" disabled={!articleId} onClick={openInMain}>
          <Icon n="fileplus" size={13} /> 在主窗打开
        </button>
      </div>
      {toast && <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-t1 text-bg text-[11px] px-3 py-1.5 rounded-lg z-[99] whitespace-nowrap">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<QuickApp />);
