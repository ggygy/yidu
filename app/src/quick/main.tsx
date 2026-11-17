import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { Md, PassBlock } from "../md";
import { isPassthrough, linkDefs, toMarkdown, toUnits, type Unit } from "../blocks";
import { Icon } from "../icons";
import * as api from "../api";
import { dirLabel, dirShort, detectDir } from "../languages";
import { DirPicker } from "../dirselect";
import { IS_MAC, initNative } from "../native";
import { Segmented, TbButton } from "../ui";
import { IDLE, LiveStatus, MetricsDetail, metricsLine, reduceLive, sec, startLive, type Live } from "../metrics";
import { cachedModels, fetchModels, testState } from "../providers";
import { applyReading, stepScale } from "../reader";
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

function useLocalFlagStr(key: string, init: string) {
  const [v, setV] = useState(() => { try { return localStorage.getItem(key) ?? init; } catch { return init; } });
  return [v, (n: string) => { try { localStorage.setItem(key, n); } catch { /* ignore */ } setV(n); }] as const;
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
  const [sideBySide, setSideBySide] = useLocalFlag("q-pair-cols", true); // 对照:左右两栏 / 上下
  const [live, setLive] = useState<Live>(IDLE); // 阶段 / 计时 / 结束明细
  const [srcOpen, setSrcOpen] = useState(true); // 有结果后源文收成一行;点开恢复
  const autoGrowRef = useRef(true); // 用户手拖高度 → 本次暂停自动长高
  const docRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [lastSrc, setLastSrc] = useState(""); // 上次翻译的原文:输入改了才把主按钮切回「翻译」
  const [expandProv, setExpandProv] = useState<number | null>(null); // 模型菜单里展开的服务商
  const [provModels, setProvModels] = useState<Record<number, string[] | "busy" | string>>({});
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
  // 复制 = 按原文分隔拼回的整篇 markdown(列表 / 引用 / 表格结构不散)
  const outText = blocks.some((b) => b.trans && !isPassthrough(b.kind)) ? toMarkdown(blocks, "trans") : "";
  const [fmt, setFmt] = useLocalFlagStr("q-format", "auto"); // 原文格式:自动 / Markdown / 纯文本(§2.2.5)

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

  // 字号 / 密度(prefs.quick_scale / density)
  useEffect(() => { applyReading("quick", prefs?.quick_scale ?? 1, prefs?.density ?? "standard"); }, [prefs?.quick_scale, prefs?.density]);
  const zoom = (dir: "zoom-in" | "zoom-out" | "zoom-reset") => {
    const next = stepScale(prefs?.quick_scale ?? 1, dir);
    savePrefs({ quick_scale: next }).catch(() => {});
    say(`字号 ${Math.round(next * 100)}%`);
  };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const un = listen<string>("menu", (e) => {
      if (e.payload === "zoom-in" || e.payload === "zoom-out" || e.payload === "zoom-reset") zoomRef.current(e.payload);
    });
    return () => { un.then((f) => f()); };
  }, []);

  // pin 置顶(默认开)
  useEffect(() => { if (w) safe(() => w.setAlwaysOnTop(pin)); }, [pin]);

  // 失焦自动隐藏(默认关;与 pin 互斥)
  useEffect(() => {
    if (!w) return;
    const un = w.onFocusChanged(({ payload: focused }) => {
      // 唤出后 300ms 内不触发(激活过程中可能先收到一次失焦,会把刚唤出的窗口立刻藏起来)
      if (!focused && hideOnBlur && !pin && Date.now() - shownAtRef.current > 300) safe(() => w.hide());
    });
    return () => { un.then((f) => f()); };
  }, [hideOnBlur, pin]);

  // 唤出事件(Rust toggle_quick 发来):新剪贴板内容预填「假划词」;监听只挂一次,经 ref 取最新闭包
  const shownRef = useRef<(t: string) => void>(() => {});
  const shownAtRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const un = listen("quick-shown", async () => {
      shownAtRef.current = Date.now();
      autoGrowRef.current = true; // 每次唤出恢复自动长高
      window.setTimeout(() => inputRef.current?.focus(), 30);
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
    setLive((l) => reduceLive(l, e));
    if (e.type === "created") {
      setArticleId(e.article_id); // 翻译即自动入库
      setBlocks(e.blocks);
    } else if (e.type === "usage") {
      setUsage((u) => addUsage(u, e));
    } else if (e.type === "block") {
      setBlocks((bs) => bs.map((b) => (b.idx === e.idx ? { ...b, trans: e.text, status: "done", format_warn: e.format_warn } : b)));
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
    autoGrowRef.current = true; // 新翻译恢复自动长高
    setSrcOpen(false);
    if (sessionRef.current) { try { await api.cancelTranslate(sessionRef.current); } catch {} }
    setPhase("streaming");
    setErr(null);
    setBlocks([]);
    setArticleId(null);
    setUsage(EMPTY_USAGE);
    setLive(startLive());
    setInfoOpen(false);
    setLastSrc(text);
    const effDir = direction === "auto" ? detectDir(text) : direction;
    try {
      sessionRef.current = await api.translate({ text, direction: effDir, kind: "paste", format: fmt as "auto" | "md" | "plain" }, onEvent);
    } catch (e) {
      setPhase("idle");
      setLive(IDLE);
      setErr(String(e));
    }
  };

  const cancel = async () => {
    if (sessionRef.current) { try { await api.cancelTranslate(sessionRef.current); } catch {} }
    setPhase("done");
    setLive((l) => ({ ...l, running: false }));
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

  // 切换服务商 / 同一服务商内换模型(model 不传 = 用该服务商当前模型)
  const switchProvider = async (id: number, model?: string) => {
    const next = providers.find((p) => p.id === id);
    setProvOpen(false);
    setExpandProv(null);
    if (!next) return;
    if (next.is_active && (!model || model === next.model)) return;
    try {
      if (model && model !== next.model) await api.providerSave({ id, name: next.name, kind: next.kind, base_url: next.base_url, model });
      if (!next.is_active) await api.providerSetActive(id);
      await refreshProviders();
      say(`已切换到 ${next.name} · ${model ?? next.model}`);
    } catch (e) { say(String(e)); }
  };

  const toggleExpand = (p: Provider) => {
    if (expandProv === p.id) { setExpandProv(null); return; }
    setExpandProv(p.id);
    const cached = cachedModels(p.id);
    if (cached.length) { setProvModels((m) => ({ ...m, [p.id]: cached })); return; }
    setProvModels((m) => ({ ...m, [p.id]: "busy" }));
    fetchModels(p).then((list) => setProvModels((m) => ({ ...m, [p.id]: list }))).catch((e) => setProvModels((m) => ({ ...m, [p.id]: String(e) })));
  };

  const togglePin = () => {
    const next = !pin;
    if (next && hideOnBlur) { savePrefs({ blur_hide: false }).catch(() => {}); say("已关闭「失焦隐藏」:两者互斥"); }
    setPin(next);
  };

  const clear = () => { setSrcOpen(true); setInput(""); setBlocks([]); setPhase("idle"); setErr(null); setUsage(EMPTY_USAGE); setArticleId(null); setLive(IDLE); setLastSrc(""); };
  const streaming = phase === "streaming";

  // 下拉点外部关闭
  useEffect(() => {
    if (!dirOpen && !provOpen && !infoOpen) return;
    const h = () => { setDirOpen(false); setProvOpen(false); setInfoOpen(false); setExpandProv(null); };
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [dirOpen, provOpen, infoOpen]);

  // 全局键:Esc 先收下拉、翻译中则取消;⌘D 切对照(视图切换也在工具栏分段控件)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { e.preventDefault(); setView((v) => (v === "pair" ? "zh" : "pair")); return; }
      // macOS 由菜单「显示 › 放大 / 缩小 / 实际大小」承担;其他平台走 JS
      if (!IS_MAC && (e.metaKey || e.ctrlKey) && ["=", "+", "-", "0"].includes(e.key)) {
        e.preventDefault();
        zoomRef.current(e.key === "-" ? "zoom-out" : e.key === "0" ? "zoom-reset" : "zoom-in");
        return;
      }
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

  // ---------- 自动长高(§2.5.1–3) ----------
  // 宽不动;高随内容(含流式)增长,220ms ease-out,上限 85% 屏高后内部滚动;清空缩回。
  // 下方放不下就整体上移;用户手拖高度 → 暂停到下次唤出 / 新翻译。
  const animUntil = useRef(0);
  const fitTimer = useRef(0);
  const fitting = useRef(false);
  const fit = async () => {
    if (!w || !autoGrowRef.current || fitting.current) return;
    const doc = docRef.current, content = contentRef.current;
    if (!doc || !content) return;
    fitting.current = true;
    try {
      const mon = await currentMonitor();
      const sf = mon?.scaleFactor ?? 1;
      const area = mon?.workArea ?? (mon ? { position: mon.position, size: mon.size } : null);
      const maxH = area ? (area.size.height / sf) * 0.85 : 900;
      const chrome = window.innerHeight - doc.clientHeight;
      const padY = 28;
      const hasContent = blocks.length > 0 || !!err;
      const want = chrome + (hasContent ? content.scrollHeight + padY : 96);
      const target = Math.round(Math.min(maxH, Math.max(hasContent ? 260 : 0, want)));
      const from = window.innerHeight;
      if (Math.abs(target - from) < 4) return;
      animUntil.current = Date.now() + 500;
      const t0 = performance.now();
      const width = window.innerWidth;
      for (;;) {
        const k = Math.min(1, (performance.now() - t0) / 220);
        const e = 1 - Math.pow(1 - k, 3); // ease-out
        await w.setSize(new LogicalSize(width, Math.round(from + (target - from) * e)));
        if (k >= 1) break;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      // 下方超出可用区域 → 整体上移,始终完整可见
      if (area) {
        const pos = await w.outerPosition();
        const size = await w.outerSize();
        const bottom = area.position.y + area.size.height;
        if (pos.y + size.height > bottom) {
          await w.setPosition(new PhysicalPosition(pos.x, Math.max(area.position.y, bottom - size.height)));
        }
      }
      animUntil.current = Date.now() + 150;
    } catch { /* 浏览器预览无窗口 */ } finally {
      fitting.current = false;
    }
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const scheduleFit = () => {
    window.clearTimeout(fitTimer.current);
    fitTimer.current = window.setTimeout(() => fitRef.current(), 60);
  };
  useEffect(() => {
    const c = contentRef.current;
    if (!c) return;
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(c);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { scheduleFit(); }, [blocks.length, err, srcOpen, view]); // eslint-disable-line react-hooks/exhaustive-deps
  // 非本程序引起的尺寸变化 = 用户手拖
  useEffect(() => {
    if (!w) return;
    const un = w.onResized(() => { if (Date.now() > animUntil.current && !fitting.current) autoGrowRef.current = false; });
    return () => { un.then((f) => f()); };
  }, []);

  // 单块渲染:译文 / 原文 / 对照(窄宽对照 = 每块上原文下译文)
  const units = toUnits(blocks);
  const defs = linkDefs(blocks);
  const zhOf = (u: Unit) => (
    <>
      {u.translated ? (
        <div className={"zh md" + (u.streaming ? " streaming" : "")}><Md text={u.trans} defs={defs} /></div>
      ) : (
        <p className="zh m-0 text-t3">{streaming ? <span className="caret" /> : "待译"}</p>
      )}
      {u.warn && <p className="m-0 mt-1 text-[11px] text-danger" title={u.warn}>格式可能有误(已自动重译一次)</p>}
    </>
  );
  const enOf = (u: Unit, extra = "") => <div className={"en md text-[length:var(--en-size)] leading-[var(--en-line)] " + extra}><Md text={u.src} defs={defs} /></div>;

  return (
    <div className="relative flex flex-col h-screen overflow-hidden mat">
      {/* 统一工具栏(44pt;红绿灯 {16,24} 中线对齐) */}
      <div className="tb tb-quick" data-tauri-drag-region>
        <Segmented value={view} options={QVIEWS} onChange={setView} />
        {view === "pair" && <TbButton icon={sideBySide ? "cols" : "rows"} title={sideBySide ? "对照:左右两栏(点击改上下)" : "对照:上下(点击改左右两栏)"} onClick={() => setSideBySide(!sideBySide)} size={14} />}
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
            <div className="menu absolute z-40 top-full mt-1 right-0 w-[290px] max-h-[420px] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              {providers.map((p) => {
                const t = testState(p);
                const ms = provModels[p.id];
                return (
                  <div key={p.id}>
                    <div className="flex items-center">
                      <button className="flex-1 min-w-0 !h-auto !py-1" title={p.base_url} onClick={() => switchProvider(p.id)}>
                        <span className="w-3 flex-none text-accent">{p.is_active ? "✓" : ""}</span>
                        <span className="min-w-0 flex flex-col leading-tight py-0.5">
                          <span className="truncate">{p.name}</span>
                          <span className="font-code text-[11px] text-t3 truncate">{p.model}</span>
                        </span>
                        <span className={"ml-auto pl-2 text-[11px] " + (!t ? "text-t3" : t.ok ? "text-t3" : "text-danger")}>{!t ? "" : t.ok ? `${t.ms} ms` : "连接失败"}</span>
                      </button>
                      <button className="!w-7 !px-0 justify-center flex-none" title="换模型" onClick={() => toggleExpand(p)}>
                        <span className={"inline-block transition-transform " + (expandProv === p.id ? "rotate-90" : "")}>›</span>
                      </button>
                    </div>
                    {expandProv === p.id && (
                      <div className="pl-5 pb-1 max-h-[200px] overflow-y-auto">
                        {ms === "busy" && <p className="text-[12px] text-t3 px-2 py-1 m-0">拉取模型中…</p>}
                        {typeof ms === "string" && ms !== "busy" && <p className="text-[12px] text-danger px-2 py-1 m-0 break-all">拉取失败:{ms.slice(0, 80)}</p>}
                        {Array.isArray(ms) && ms.length === 0 && <p className="text-[12px] text-t3 px-2 py-1 m-0">没有拉取到模型</p>}
                        {Array.isArray(ms) && ms.map((m) => (
                          <button key={m} className="!h-[22px]" onClick={() => switchProvider(p.id, m)}>
                            <span className="w-3 flex-none">{m === p.model ? "✓" : ""}</span><span className="font-code text-[12px] truncate">{m}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <hr />
              <button onClick={() => { setProvOpen(false); openSettings(); }}><span className="w-3 flex-none" />管理模型…<span className="ml-auto text-[11px] text-t3">⌘,</span></button>
            </div>
          )}
        </div>
      </div>

      {/* 源文:有结果后收成一行「原文 · …」,点击展开(§2.5.4) */}
      {blocks.length > 0 && !srcOpen ? (
        <button
          className="mx-3 mt-2.5 h-[30px] rounded-[10px] bg-ctl shadow-[0_0_0_0.5px_var(--border)] px-3 flex items-center gap-2 text-left border-none flex-none min-w-0"
          title="展开原文"
          onClick={() => { setSrcOpen(true); window.setTimeout(() => inputRef.current?.focus(), 30); }}
        >
          <span className="text-[11px] text-t3 flex-none">原文</span>
          <span className="text-[12px] text-t2 truncate min-w-0">{input.replace(/\s+/g, " ").trim()}</span>
          <Icon n="chev" size={11} className="ml-auto flex-none text-t3" />
        </button>
      ) : (
      <div className="mx-3 mt-2.5 rounded-[10px] bg-ctl shadow-[0_0_0_0.5px_var(--border)] px-3 py-2 flex-none focus-within:bg-doc focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_22%,transparent)] transition-[background-color,box-shadow] duration-150">
        <textarea
          ref={inputRef}
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
        <div className="flex items-center justify-end -mt-1">
          <button
            className="border-none bg-transparent text-[11px] text-t3 hover:text-t1 px-1"
            title="原文格式:自动按 Markdown 语法密度判定;纯文本 = 保留单换行、行首 # > 1. 不当作 Markdown"
            onClick={() => setFmt(fmt === "auto" ? "md" : fmt === "md" ? "plain" : "auto")}
          >{fmt === "auto" ? "格式:自动" : fmt === "md" ? "格式:Markdown" : "格式:纯文本"}</button>
        </div>
      </div>
      )}

      {/* 未配置引导 */}
      {(!providers.length || !active) && (
        <button className="btn primary mx-3 mt-2 justify-center" onClick={openSettings}>
          {providers.length ? "尚未选择使用中的模型 · 打开设置" : "首次使用:配置翻译模型"}
        </button>
      )}

      {/* 译文区:文档实底 */}
      <div ref={docRef} className="doc flex-1 min-h-0 mx-2.5 mt-2.5 rounded-[10px] bg-doc shadow-[0_0_0_0.5px_var(--border)] overflow-y-auto px-4 py-3.5">
       <div ref={contentRef} className="flex flex-col gap-[var(--pair-gap)]">
        {err && <p className="text-danger text-[12px] bg-surface2 rounded-md px-2.5 py-2 m-0">{err}</p>}
        {!blocks.length && !err && (
          <p className="text-t3 text-[12px] m-0">
            {streaming ? <>连接中 <span className="caret" /></> : `译文将逐块流式显示,并自动存入文章库 · ${autoDir ? (input.trim() ? dirLabel(detectDir(input)) : "自动识别语言") : dirLabel(direction)}`}
          </p>
        )}
        {units.map((u) =>
          isPassthrough(u.kind) ? (
            <PassBlock key={u.key} kind={u.kind} src={u.src} />
          ) : view === "src" ? (
            <div key={u.key}>{enOf(u)}</div>
          ) : view === "pair" ? (
            sideBySide
              ? <div key={u.key} className="grid grid-cols-2 gap-x-4 items-start">{enOf(u, "min-w-0 break-words")}<div className="min-w-0 border-l-[0.5px] border-line pl-4">{zhOf(u)}</div></div>
              : <div key={u.key} className="flex flex-col gap-1">{enOf(u)}{zhOf(u)}</div>
          ) : (
            <div key={u.key}>{zhOf(u)}</div>
          ),
        )}
       </div>
      </div>

      {/* 状态栏:进行中 = 阶段 + 计时;结束 = 首字 · 总耗时 · 输出 tok ⓘ */}
      <div className="relative h-[38px] flex items-center gap-2 px-3 flex-none">
        <span className="text-[11px] text-t3 truncate min-w-0 flex items-center gap-1.5">
          {streaming && live.running ? <LiveStatus live={live} /> : live.metrics ? (
            <>
              <span className="truncate tabular-nums" title={metricsLine(live.metrics)}>首字 {sec(live.metrics.ttft_ms)} · 总 {sec(live.metrics.total_ms)} · {live.metrics.completion_tokens} tok</span>
              <button className="tbtn !w-5 !h-5 flex-none" title="翻译明细" onClick={(e) => { e.stopPropagation(); setInfoOpen(!infoOpen); }}><Icon n="info" size={12} /></button>
            </>
          ) : usage.requests ? `输入 ${usage.prompt_tokens} · 输出 ${usage.completion_tokens} tok` : ""}
        </span>
        <span className="flex-1" />
        {input && !streaming && !blocks.length && <button className="btn" onClick={clear}>清空</button>}
        <TbButton icon="copy" title="复制译文" disabled={!outText} onClick={() => { navigator.clipboard?.writeText(outText).then(() => say("已复制")); }} size={14} />
        <TbButton icon="library" title="在主窗打开(已自动存入文章库)" disabled={!articleId || streaming} onClick={openInMain} size={14} />
        {streaming
          ? <button className="btn" onClick={cancel}>取消</button>
          : <button className={"btn " + (input.trim() !== lastSrc.trim() || !blocks.length ? "primary" : "")} disabled={!input.trim() || !active} onClick={() => fire()} title="⌘↩">{blocks.length && input.trim() === lastSrc.trim() ? "重新翻译" : "翻译"}</button>}
        {infoOpen && live.metrics && (
          <div className="menu absolute z-40 bottom-full mb-1 left-2 w-[280px] !p-3" onClick={(e) => e.stopPropagation()}>
            <MetricsDetail m={live.metrics} price={prefs?.price_per_mtok} thinkTail={live.thinkTail} />
          </div>
        )}
      </div>
      {toast && <div className="toast absolute top-14 left-1/2 -translate-x-1/2 z-[99]">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<QuickApp />);
