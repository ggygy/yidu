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
import type { Block, Prefs, Provider, StreamEvent } from "../types";
import "../styles.css";

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
  const [toast, setToast] = useState<string | null>(null);
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1800); };

  const active = providers.find((p) => p.is_active);
  const outText = blocks.filter((b) => b.trans).map((b) => b.trans).join("\n\n");

  const refreshProviders = () => api.providerList().then(setProviders).catch(() => {});
  useEffect(() => {
    refreshProviders();
    api.getPrefs().then((p) => { setPrefs(p); setDirection(p.direction); }).catch(() => {});
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

  const dirLabel = direction === "en2zh" ? "EN → 中" : "中 → EN";
  const streaming = phase === "streaming";

  return (
    <div className="q-app">
      {/* 单行头部:红绿灯 + 标题 + 热键 + 窗口操作 */}
      <div className="q-title">
        <span className="q-dots"><i /><i /><i /></span>
        <b>快捷翻译</b>
        <kbd>{prefs ? prefs.hotkey.replace("Alt", "⌥").replace("CommandOrControl", "⌘").replace("Shift", "⇧") : "⌥T"}</kbd>
        <span className="sp" />
        <button title={pin ? "置顶中(点击取消)" : "置顶窗口"} className={"icon-btn" + (pin ? " on" : "")} onClick={togglePin}>
          <Icon n="pin" size={14} />
        </button>
        <button className="icon-btn" title="打开主窗口" onClick={() => safe(async () => { const m = await WebviewWindow.getByLabel("main"); await m?.show(); await m?.setFocus(); })}>
          <Icon n="win" size={14} />
        </button>
        <button className="icon-btn" title="隐藏(热键唤回)" onClick={() => w && safe(() => w.hide())}>
          <Icon n="x" size={14} />
        </button>
      </div>

      {/* 无 Provider 引导 */}
      {providers.length > 0 && !active && (
        <button className="q-guide" onClick={openSettingsInMain}>
          <Icon n="sparkles" size={13} /> 尚未激活 Provider,点此打开设置配置
        </button>
      )}
      {providers.length === 0 && (
        <button className="q-guide" onClick={openSettingsInMain}>
          <Icon n="sparkles" size={13} /> 首次使用:点此配置翻译 Provider
        </button>
      )}

      {/* 去框控制行 */}
      <div className="q-ctl">
        <button className="q-naked" onClick={() => setDirection((d) => (d === "en2zh" ? "zh2en" : "en2zh"))}>
          <Icon n="swap" size={13} /> {dirLabel}
        </button>
        <button className={"q-naked" + (auto ? " on" : "")} onClick={() => setAuto(!auto)}>
          <Icon n="zap" size={13} /> 粘贴即译{auto ? "" : " ·关"}
        </button>
        <span className="sp" />
        {active ? (
          <button className="q-provider" title="切换 Provider" onClick={cycleProvider}>
            <i className="dot" />{active.model}<Icon n="chev" size={11} />
          </button>
        ) : (
          <button className="q-provider" onClick={openSettingsInMain}>
            <i className="dot" />未配置<Icon n="chev" size={11} />
          </button>
        )}
      </div>

      {/* 输入块 */}
      <div className="q-in">
        <textarea
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
        <div className="row">
          <kbd>⌘V</kbd><span style={{ fontSize: 10, color: "var(--t3)" }}>粘贴</span>
          <kbd>⌘↩</kbd><span style={{ fontSize: 10, color: "var(--t3)" }}>翻译</span>
          <kbd>Esc</kbd><span style={{ fontSize: 10, color: "var(--t3)" }}>取消</span>
          <span className="sp" />
          <button className="q-link" onClick={() => { setInput(DEMO_INPUT); fire(DEMO_INPUT); }}>载入演示 ⚡</button>
          {input && <button className="q-link" onClick={() => { setInput(""); setBlocks([]); setPhase("idle"); setErr(null); }}>清空</button>}
        </div>
      </div>

      {/* 输出:逐块流式 md 渲染 */}
      <div className="q-out">
        {err && <p className="q-err">{err}</p>}
        {!blocks.length && !err && phase === "idle" && (
          <p className="placeholder">译文将逐块流式渲染 · 自动存入文章库 · {dirLabel}</p>
        )}
        {blocks.length > 0 && (
          <>
            {showEn ? (
              /* 对照 = 左右双栏:左原文 · 右译文(竖线分隔);code 块左列渲染占位保块序 1:1 对齐 */
              <div className="q-cols">
                <div className="q-col">
                  {blocks.map((b) =>
                    b.kind === "code" ? (
                      <div key={"e" + b.idx} className="q-code-slot">··· 代码块({b.src.trim().split("\n").length} 行)···</div>
                    ) : (
                      <div key={"e" + b.idx} className="en md">
                        <Md text={b.src} />
                      </div>
                    ),
                  )}
                </div>
                <div className="q-col">
                  {blocks.map((b) =>
                    b.kind === "code" ? (
                      <CodeBox key={b.idx} src={b.src} />
                    ) : b.trans ? (
                      <div key={b.idx} className={"zh md" + (b.status === "streaming" ? " streaming" : "")}>
                        <Md text={b.trans} />
                      </div>
                    ) : (
                      <p key={b.idx} className="placeholder">{streaming ? "…" : "待译"}</p>
                    ),
                  )}
                </div>
              </div>
            ) : (
              blocks.map((b) =>
                b.kind === "code" ? (
                  <CodeBox key={b.idx} src={b.src} />
                ) : b.trans ? (
                  <div key={b.idx} className={"zh md" + (b.status === "streaming" ? " streaming" : "")}>
                    <Md text={b.trans} />
                  </div>
                ) : (
                  <p key={b.idx} className="placeholder">{streaming ? "…" : "待译"}</p>
                ),
              )
            )}
            {streaming && <div className="shimmer"><div className="track"><i /></div><span>流式输出中(Esc 取消)</span></div>}
          </>
        )}
      </div>

      {/* 交互提示 */}
      <div className="q-hint">
        实验开关:
        <a style={{ cursor: "pointer", color: hideOnBlur ? "var(--accent)" : "inherit" }} onClick={toggleBlur}>[失焦隐藏:{hideOnBlur ? "开" : "关"}]</a>
        {" · 热键唤出 · 自动入库"}
      </div>

      {/* 悬浮操作胶囊 */}
      <div className="q-capsule">
        <button className="q-pill" disabled={!outText} onClick={() => navigator.clipboard?.writeText(outText).then(() => say("已复制"))}>
          <Icon n="copy" size={13} /> 复制
        </button>
        <button className={"q-pill" + (showEn ? " on" : "")} disabled={!blocks.length} title="对照(⌘D)" onClick={() => setShowEn(!showEn)}>
          <Icon n="eye" size={13} /> 对照
        </button>
        <span className="sp" />
        <button className="q-save" disabled={!articleId} onClick={openInMain}>
          <Icon n="fileplus" size={13} /> 在主窗打开
        </button>
      </div>
      {toast && <div className="q-toast">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<QuickApp />);
