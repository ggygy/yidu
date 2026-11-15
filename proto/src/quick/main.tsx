import { createRoot } from "react-dom/client";
import React, { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { DEMO_INPUT, DEMO_TRANS } from "../data";
import { Icon } from "../icons";
import "../styles.css";

// 浏览器直开(无 Tauri 环境)时降级:窗口操作静默跳过
const w = (() => { try { return getCurrentWindow(); } catch { return null; } })();
const safe = async (fn: () => unknown) => { try { await fn(); } catch { /* 浏览器或权限缺失 */ } };

const HOTKEY = "Alt+T"; // 2026-11-14 定案:默认 ⌥T(⌥Space 与输入法冲突),设置页可改
const PROVIDERS = ["GLM-4-flash", "DeepSeek-V3", "Ollama · llama3.1"];

function useLocalFlag(key: string, init: boolean) {
  const [v, setV] = useState(() => (localStorage.getItem(key) === null ? init : localStorage.getItem(key) === "1"));
  return [v, (n: boolean) => { localStorage.setItem(key, n ? "1" : "0"); setV(n); }] as const;
}

// 模拟流式译文:逐字吐出罐头译文
function useMockTranslate(input: string, auto: boolean, fire: number) {
  const [out, setOut] = useState("");
  const [state, setState] = useState<"idle" | "streaming" | "done">("idle");
  useEffect(() => {
    setOut("");
    setState("idle");
    if (!input.trim() || fire === 0) return;
    let t0 = 0 as unknown as ReturnType<typeof setTimeout>;
    t0 = setTimeout(() => {
      setState("streaming");
      let i = 0;
      const iv = setInterval(() => {
        i += 2;
        setOut(DEMO_TRANS.slice(0, i));
        if (i >= DEMO_TRANS.length) {
          clearInterval(iv);
          setState("done");
        }
      }, 40);
      (window as any).__iv = iv;
    }, auto ? 500 : 0);
    return () => { clearTimeout(t0); clearInterval((window as any).__iv); };
  }, [fire]);
  return { out, state };
}

function QuickApp() {
  const [input, setInput] = useState("");
  const [fire, setFire] = useState(0);
  const [pin, setPin] = useLocalFlag("q-pin", true);
  const [hideOnBlur, setHideOnBlur] = useLocalFlag("q-blur-hide", false);
  const [auto, setAuto] = useLocalFlag("q-auto", true);
  const [showEn, setShowEn] = useState(false);
  const [prov, setProv] = useState(0);
  const { out, state } = useMockTranslate(input, auto, fire);
  const [toast, setToast] = useState<string | null>(null);
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 1600); };

  // 深色外观:跟随主窗设置(同源 localStorage)
  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem("v3-dark") === "1" ? "dark" : "";
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

  // 全局快捷键 ⌥T 切换显隐;JS 侧状态位,避免 hide 后 isVisible 抖动
  useEffect(() => {
    (async () => {
      if (!w) return;
      try {
        let shown = true;
        await unregister("Alt+Space").catch(() => {});
        await unregister(HOTKEY).catch(() => {});
        const qw0 = await WebviewWindow.getByLabel("quick");
        if (qw0) shown = await qw0.isVisible();
        await register(HOTKEY, async () => {
          const qw = await WebviewWindow.getByLabel("quick");
          if (!qw) return;
          if (shown) { await qw.hide(); shown = false; }
          else { await qw.show(); await qw.setFocus(); shown = true; }
        });
      } catch (e) {
        console.warn("global shortcut(可能无权限/被占用)", e);
      }
    })();
  }, []);

  const pasteOrType = (t: string) => {
    setInput(t);
    if (auto) setFire((f) => f + 1);
  };

  const saveToLibrary = () => {
    safe(() => emit("open-in-main", { title: `粘贴 · ${input.trim().slice(0, 24) || "演示文本"}…` }));
    say("已存入文章库(演示)· 主窗已接收");
  };

  const togglePin = () => {
    const next = !pin;
    // 互斥逻辑先于环境分支执行(浏览器演示也要一致)
    if (next && hideOnBlur) { setHideOnBlur(false); say("已关闭「失焦隐藏」:两者互斥"); }
    setPin(next);
    if (!w) say("浏览器演示:置顶仅应用内生效");
  };
  const toggleBlur = () => {
    const next = !hideOnBlur;
    if (next && pin) { setPin(false); say(!w ? "浏览器演示:失焦行为仅应用内生效(已关 pin)" : "已关闭 pin:失焦隐藏生效,点其他窗口即隐藏"); }
    setHideOnBlur(next);
  };

  return (
    <div className="q-app">
      {/* 单行头部:红绿灯 + 标题 + ⌥T + 窗口操作 */}
      <div className="q-title">
        <span className="q-dots"><i /><i /><i /></span>
        <b>快捷翻译</b>
        <kbd>⌥T</kbd>
        <span className="sp" />
        <button title={pin ? "置顶中(点击取消)" : "置顶窗口"} className={"icon-btn" + (pin ? " on" : "")} onClick={togglePin}>
          <Icon n="pin" size={14} />
        </button>
        <button className="icon-btn" title="打开主窗口" onClick={() => safe(async () => { const m = await WebviewWindow.getByLabel("main"); await m?.show(); await m?.setFocus(); })}>
          <Icon n="win" size={14} />
        </button>
        <button className="icon-btn" title="隐藏(⌥T 唤回)" onClick={() => w && safe(() => w.hide())}>
          <Icon n="x" size={14} />
        </button>
      </div>

      {/* 去框控制行 */}
      <div className="q-ctl">
        <button className="q-naked" onClick={() => say("EN → 中(演示,方向可切)")}>
          <Icon n="swap" size={13} /> EN → 中
        </button>
        <button className={"q-naked" + (auto ? " on" : "")} onClick={() => setAuto(!auto)}>
          <Icon n="zap" size={13} /> 粘贴即译{auto ? "" : " ·关"}
        </button>
        <span className="sp" />
        <button className="q-provider" title="切换 Provider" onClick={() => { const n = (prov + 1) % PROVIDERS.length; setProv(n); say(`已切换 ${PROVIDERS[n]}(演示)`); }}>
          <i className="dot" />{PROVIDERS[prov]}<Icon n="chev" size={11} />
        </button>
      </div>

      {/* 输入块 */}
      <div className="q-in">
        <textarea
          value={input}
          placeholder="⌘V 粘贴文本或截图(P1 识别)· markdown"
          onChange={(e) => pasteOrType(e.target.value)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (t) { e.preventDefault(); pasteOrType(t); }
          }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) setFire((f) => f + 1); }}
        />
        <div className="row">
          <kbd>⌘V</kbd><span style={{ fontSize: 10, color: "var(--t3)" }}>粘贴</span>
          <kbd>⌘↩</kbd><span style={{ fontSize: 10, color: "var(--t3)" }}>翻译</span>
          <span className="sp" />
          <button className="q-link" onClick={() => { setInput(DEMO_INPUT); setFire((f) => f + 1); }}>载入演示 ⚡</button>
          {input && <button className="q-link" onClick={() => { setInput(""); setFire(0); }}>清空</button>}
        </div>
      </div>

      {/* 输出 */}
      <div className="q-out">
        {!out && state === "idle" && <p className="placeholder">译文将在这里以 markdown 渲染(演示数据为罐头译文逐字流出)</p>}
        {out && (
          <>
            {showEn && DEMO_INPUT.split(/\n\s*\n/).map((p, i) => <p key={i} className="en" style={{ opacity: 0.75 }}>{p}</p>)}
            <div className="zh md">
              <Markdown remarkPlugins={[remarkGfm]}>{out}</Markdown>
            </div>
            {state === "streaming" && <div className="shimmer"><div className="track"><i /></div><span>流式输出中</span></div>}
          </>
        )}
      </div>

      {/* 实验开关(工单 09 已定默认:pin 开 · 失焦不隐藏) */}
      <div className="q-hint">
        实验开关:
        <a style={{ cursor: "pointer", color: hideOnBlur ? "var(--accent)" : "inherit" }} onClick={toggleBlur}>[失焦隐藏:{hideOnBlur ? "开" : "关"}]</a>
        {" · ⌥T 唤出 · 关掉重开试试位置记忆"}
      </div>

      {/* 悬浮操作胶囊 */}
      <div className="q-capsule">
        <button className="q-pill" disabled={!out} onClick={() => navigator.clipboard?.writeText(out).then(() => say("已复制"))}>
          <Icon n="copy" size={13} /> 复制
        </button>
        <button className={"q-pill" + (showEn ? " on" : "")} disabled={!out} onClick={() => setShowEn(!showEn)}>
          <Icon n="eye" size={13} /> 对照
        </button>
        <span className="sp" />
        <button className="q-save" disabled={!out} onClick={saveToLibrary}>
          <Icon n="fileplus" size={13} /> 存入文章库
        </button>
      </div>
      {toast && <div className="q-toast">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<QuickApp />);
