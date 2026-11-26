import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { Md, PassBlock } from "../md";
import { copyText, isPassthrough, linkDefs, toUnits, type Unit } from "../blocks";
import { Icon } from "../icons";
import * as api from "../api";
import { LANGS, autoDirection, autoLabel, dirLabel, dirShort, langShort, langZh, makeDir, targetFor } from "../languages";
import { DirPicker } from "../dirselect";
import { VocabCard } from "../vocabcard";
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

/** 划到的是单个英文词:走词典卡而不是模型(spec §2.4) */
const isSingleWord = (t: string) => /^[A-Za-z][A-Za-z'’-]{0,39}$/.test(t.trim());

const PERM_TEXT = {
  accessibility: {
    title: "需要「辅助功能」权限",
    body: "划词翻译要读取你在其他应用里选中的文字。译读只在你按下快捷键的那一刻读取选区,不做其他事。",
    after: "勾选「译读」后回到这里,再按一次快捷键即可。",
  },
  screen: {
    title: "需要「屏幕录制」权限",
    body: "截图翻译要截取你框选的屏幕区域。没有这项权限时,系统只会给出桌面背景,所以识别不到文字。",
    after: "勾选「译读」后需要退出并重新打开译读才会生效。也可以先把截图粘贴(⌘V)到这里来翻译。",
  },
} as const;

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
  const [onceDir, setOnceDir] = useState<string | null>(null); // 自动模式下「只改这一次」的方向(§2.1.5),新翻译清掉
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
  const toastTimer = useRef(0);
  const say = (m: string, ms = 1800) => { setToast(m); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(null), ms); };
  // v0.4 划词 / 截图:本次结果是否为「未入库」的临时翻译、识别中、缺权限引导、单词查词卡
  const [ephemeral, setEphemeral] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [perm, setPerm] = useState<"accessibility" | "screen" | null>(null);
  const [word, setWord] = useState<string | null>(null);

  const active = providers.find((p) => p.is_active);
  // 复制 = 按原文分隔拼回的整篇 markdown(列表 / 引用 / 表格结构不散)
  const [articleKind, setArticleKind] = useState<string>("");
  const outText = blocks.some((b) => b.trans && !isPassthrough(b.kind)) ? copyText(blocks, articleKind) : "";
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
      setArticleKind(e.article.kind);
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

  const fire = async (text = input, once: string | null = null, temp = false) => {
    if (!text.trim()) return;
    setEphemeral(temp);
    setWord(null);
    setPerm(null);
    setOcrBusy(false);
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
    setOnceDir(once);
    const effDir = once ?? (direction === "auto" ? autoDirection(text, prefs?.native_lang, prefs?.second_lang).dir : direction);
    try {
      sessionRef.current = await api.translate({ text, direction: effDir, kind: "paste", format: fmt as "auto" | "md" | "plain", ephemeral: temp }, onEvent);
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

  // 粘贴图片:OCR → 立即翻译(与粘贴文本一样自动入库)
  const ocrPaste = async (file: File) => {
    setErr(null); setPerm(null); setWord(null); setBlocks([]); setOcrBusy(true);
    try {
      const out = await api.ocrImage(new Uint8Array(await file.arrayBuffer()), file.type);
      setOcrBusy(false);
      if (!out.text.trim()) { say("未在图片中识别到文字", 3200); return; }
      if (out.note) say(out.note, 4000);
      setInput(out.text);
      fire(out.text);
    } catch (e) {
      setOcrBusy(false);
      setErr(`文字识别失败:${String(e)}`);
    }
  };

  // ---------- 热键流程(Rust flow.rs 发来;监听只挂一次,经 ref 取最新闭包) ----------
  const flowRef = useRef<{
    capture: (text: string, origin: string) => void;
    busy: () => void;
    notice: (message: string, error: boolean) => void;
    permission: (kind: string) => void;
    replace: (text: string, front: number) => void;
  } | null>(null);
  const arrive = () => {
    shownAtRef.current = Date.now(); // 刚唤出:300ms 内不触发失焦隐藏
    autoGrowRef.current = true;
  };
  flowRef.current = {
    capture: (text, origin) => {
      arrive();
      setInput(text);
      setSrcOpen(true);
      if (origin === "selection" && isSingleWord(text)) {
        // 单词 → 词典卡;不发模型请求
        if (sessionRef.current && phase === "streaming") cancel();
        setOcrBusy(false); setPerm(null); setErr(null); setBlocks([]); setArticleId(null); setLive(IDLE); setUsage(EMPTY_USAGE); setLastSrc("");
        setWord(text.trim());
        return;
      }
      fire(text, null, true); // 按快捷键本身就是明确的翻译请求:不看「粘贴即译」;不自动入库
    },
    busy: () => { arrive(); setErr(null); setPerm(null); setWord(null); setBlocks([]); setInput(""); setLive(IDLE); setOcrBusy(true); },
    notice: (message, error) => {
      arrive();
      setOcrBusy(false);
      if (error) setErr(message); else say(message, 3200);
    },
    permission: (kind) => { arrive(); setOcrBusy(false); setErr(null); setWord(null); setBlocks([]); setPerm(kind === "screen" ? "screen" : "accessibility"); },
    replace: async (text, front) => {
      // 翻译并替换:窗口不出现。方向恒按自动规则(母语 → 第二语言,其余 → 母语)
      if (phase === "streaming") await cancel();
      const dir = autoDirection(text, prefs?.native_lang, prefs?.second_lang).dir;
      try {
        await api.replaceTranslate(text, dir, front);
      } catch (e) {
        arrive();
        await safe(async () => { await w?.show(); await w?.setFocus(); });
        setErr(`翻译并替换失败:${String(e)}`);
      }
    },
  };
  useEffect(() => {
    const uns = [
      listen<{ text: string; origin: string }>("quick-capture", (e) => flowRef.current?.capture(e.payload.text, e.payload.origin)),
      listen("quick-capture-busy", () => flowRef.current?.busy()),
      listen<{ message: string; error: boolean }>("quick-notice", (e) => flowRef.current?.notice(e.payload.message, e.payload.error)),
      listen<{ kind: string }>("quick-permission", (e) => flowRef.current?.permission(e.payload.kind)),
      listen<{ text: string; front: number }>("replace-request", (e) => flowRef.current?.replace(e.payload.text, e.payload.front)),
    ];
    return () => { uns.forEach((u) => u.then((f) => f()).catch(() => {})); };
  }, []);

  // 权限引导显示期间:窗口重新获焦(从系统设置回来)就复查,已授权则收起引导
  useEffect(() => {
    if (!perm || !w) return;
    const un = w.onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      api.permissionStatus().then((st) => {
        if (st[perm]) { setPerm(null); say(perm === "screen" ? "已授权:重新打开译读后生效" : "已授权,再按一次快捷键即可", 3200); }
      }).catch(() => {});
    });
    return () => { un.then((f) => f()); };
  }, [perm]); // eslint-disable-line react-hooks/exhaustive-deps

  const showMain = () => safe(async () => {
    const m = await WebviewWindow.getByLabel("main");
    await m?.show();
    await m?.setFocus();
  });
  const openInMain = async () => {
    if (!articleId) return;
    // 热键触发的临时翻译:此刻才「存入文章库」
    if (ephemeral) { try { await api.articleKeep(articleId); setEphemeral(false); say("已存入文章库"); } catch (e) { setErr(String(e)); return; } }
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

  // 一键缩小为悬浮图标:翻译在后台照常进行;图标上转圈 = 翻译中,绿点 = 缩小期间已译完
  const miniRef = useRef(false);
  const doneWhileMini = useRef(false);
  const pushMini = () => emitTo("quick-mini", "quick-mini-state", { busy: phase === "streaming", done: doneWhileMini.current }).catch(() => {});
  const minimize = () => {
    miniRef.current = true;
    doneWhileMini.current = false;
    invoke("quick_minimize").then(pushMini).catch((e) => setErr(String(e)));
  };
  useEffect(() => {
    if (miniRef.current && phase === "done") doneWhileMini.current = true;
    if (miniRef.current) pushMini();
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ready = listen("quick-mini-ready", () => pushMini());
    // 展开(点图标 / ⌥T / 托盘)后获焦:退出缩小态
    const focus = w?.onFocusChanged(({ payload }) => { if (payload) { miniRef.current = false; doneWhileMini.current = false; } });
    return () => { ready.then((f) => f()).catch(() => {}); focus?.then((f) => f()).catch(() => {}); };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = () => { setSrcOpen(true); setInput(""); setBlocks([]); setPhase("idle"); setErr(null); setUsage(EMPTY_USAGE); setArticleId(null); setLive(IDLE); setLastSrc(""); setWord(null); setPerm(null); setOcrBusy(false); };
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
  // 「自动 · 中 → EN」,低置信加「?」;本次手改过则显示手改的方向(仍是自动)
  const native = prefs?.native_lang ?? "zh", second = prefs?.second_lang ?? "en";
  const autoInfo = autoDir && input.trim() ? autoDirection(input, native, second) : null;
  const onceActive = autoDir && onceDir && input.trim() === lastSrc.trim() ? onceDir : null;
  const dirText = autoDir
    ? onceActive ? `自动 · ${dirShort(onceActive)}(本次)` : autoInfo ? autoLabel(autoInfo) : "自动识别"
    : dirShort(direction);
  /** 只改这一次:以该方向重译当前文本,保持自动(§2.1.5) */
  const retranslateAs = (src: string) => {
    setDirOpen(false);
    if (input.trim()) fire(input, makeDir(src, targetFor(src, native, second)));
  };

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
      const hasContent = blocks.length > 0 || !!err || !!word || !!perm;
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
  useEffect(() => { scheduleFit(); }, [blocks.length, err, srcOpen, view, word, perm]); // eslint-disable-line react-hooks/exhaustive-deps
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
        <TbButton icon="minimize" title="缩小为图标(点图标或按唤出快捷键展开)" onClick={minimize} size={14} />
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
              {autoDir ? (
                <div className="w-[264px] flex flex-col text-[12px]">
                  <p className="m-0 px-1 pb-1.5 text-t2">
                    {autoInfo
                      ? <>识别为 <b className="font-medium text-t1">{langZh(autoInfo.src)}</b>{autoInfo.low ? " · 把握不大(只告诉模型目标语)" : ` · 置信 ${Math.round(autoInfo.conf * 100)}%`}</>
                      : "自动识别源语言:母语 → 第二语言,其余 → 母语"}
                  </p>
                  {autoInfo?.maybeJa && (
                    <button onClick={() => retranslateAs("ja")}>
                      <span className="w-3 flex-none" />可能是日文 → {langShort("ja")} → {langShort(targetFor("ja", native, second))} 重译
                    </button>
                  )}
                  {input.trim() && (
                    <>
                      <p className="m-0 px-1 pt-1.5 pb-1 text-[11px] text-t3">本次按其他源语言重译(仍保持自动)</p>
                      <div className="flex flex-wrap gap-1 px-1 pb-1.5">
                        {LANGS.filter((l) => l.code !== (onceActive ? onceActive.split("2")[0] : autoInfo?.src)).map((l) => (
                          <button key={l.code} className="!w-auto !h-[22px] !px-2 rounded-md bg-surface2" onClick={() => retranslateAs(l.code)}>
                            {l.short} → {langShort(targetFor(l.code, native, second))}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <hr />
                  <button
                    title="退出自动,固定为一个方向"
                    onClick={() => {
                      const d = onceActive && !onceActive.startsWith("?") ? onceActive
                        : autoInfo && !autoInfo.low ? autoInfo.dir : makeDir(second, native);
                      setDirection(d); savePrefs({ direction: d }).catch(() => {});
                    }}
                  >
                    <span className="w-3 flex-none" />改为固定方向…
                  </button>
                </div>
              ) : (
                <DirPicker value={direction} onChange={(d) => { setDirection(d); setDirOpen(false); savePrefs({ direction: d }).catch(() => {}); }} />
              )}
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
                        <span className="w-3 flex-none text-accenttx">{p.is_active ? "✓" : ""}</span>
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
          placeholder={providers.length ? "粘贴或输入要翻译的文本,也可以粘贴截图" : "先配置一个翻译模型 →「管理模型…」"}
          title="⌘↩ 翻译 · Esc 取消"
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            // 图片:必须在事件内同步取出 File(事件返回后 clipboardData 不可靠)。文本与图片并存(从表格 / 文档复制)时取文本
            const img = Array.from(e.clipboardData.items).find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile();
            e.preventDefault();
            if (t) pasteOrType(t);
            else if (img) ocrPaste(img);
            else say("剪贴板里没有文本或图片");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fire(); }
          }}
        />
        <div className="flex items-center justify-end gap-1 -mt-1">
          {input && !streaming && (
            <button className="border-none bg-transparent text-[11px] text-t3 hover:text-t1 px-1 mr-auto" title="清空原文与译文" onClick={clear}>清空</button>
          )}
          <button
            className="border-none bg-transparent text-[11px] text-t3 hover:text-t1 px-1"
            title="原文格式:自动按 Markdown 语法密度判定;纯文本 = 保留单换行、行首 # > 1. 不当作 Markdown"
            onClick={() => setFmt(fmt === "auto" ? "md" : fmt === "md" ? "plain" : "auto")}
          >{fmt === "auto" ? "格式:自动" : fmt === "md" ? "格式:Markdown" : "格式:纯文本"}</button>
          {/* 主操作收进源文框(§2.7.4:状态栏只留指标 + 复制 + 存入) */}
          {!streaming && (
            <button
              className="border-none bg-transparent text-[12px] font-medium text-accenttx px-1 disabled:text-t3 whitespace-nowrap"
              disabled={!input.trim() || !active}
              title="⌘↩"
              onClick={() => fire()}
            >{blocks.length && input.trim() === lastSrc.trim() ? "重新翻译" : "翻译"} <span className="font-normal text-t3">⌘↩</span></button>
          )}
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
        {perm && (
          <div className="flex flex-col gap-2 text-[12px] leading-[1.6]">
            <b className="text-[13px] font-semibold text-t1">{PERM_TEXT[perm].title}</b>
            <p className="m-0 text-t2">{PERM_TEXT[perm].body}</p>
            <p className="m-0 text-t3">{PERM_TEXT[perm].after}</p>
            <div className="flex gap-2 mt-1">
              <button className="btn primary" onClick={() => api.permissionRequest(perm).catch((e) => setErr(String(e)))}>打开系统设置</button>
              <button className="btn" onClick={() => setPerm(null)}>以后再说</button>
            </div>
          </div>
        )}
        {word && (
          <>
            <VocabCard inline word={word} onClose={() => setWord(null)} onAdded={() => say("已加入生词本")} />
            <button className="self-start border-none bg-transparent text-[11px] text-t3 hover:text-t1 px-1" onClick={() => fire(word, null, true)}>改用模型翻译这个词</button>
          </>
        )}
        {!blocks.length && !err && !perm && !word && (
          <p className="text-t3 text-[12px] m-0">
            {ocrBusy ? <>正在识别图片文字 <span className="caret" /></>
              : streaming ? <>连接中 <span className="caret" /></>
              : `译文将逐块流式显示,并自动存入文章库 · ${autoInfo ? dirLabel(makeDir(autoInfo.src, autoInfo.to)) : autoDir ? "自动识别语言" : dirLabel(direction)}`}
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
        <TbButton icon="copy" title="复制译文" disabled={!outText} onClick={() => { navigator.clipboard?.writeText(outText).then(() => say("已复制")); }} size={14} />
        <TbButton icon="library" title={ephemeral ? "存入文章库并在主窗打开(划词 / 截图翻译默认不入库)" : "在主窗打开(已自动存入文章库)"} disabled={!articleId || streaming} onClick={openInMain} size={14} />
        {streaming && <button className="btn" title="Esc" onClick={cancel}>取消</button>}
        {infoOpen && live.metrics && (
          <div className="menu absolute z-40 bottom-full mb-1 left-2 w-[280px] !p-3" onClick={(e) => e.stopPropagation()}>
            <MetricsDetail m={live.metrics} price={prefs?.price_per_mtok} cachedPrice={prefs?.cached_price_per_mtok} thinkTail={live.thinkTail} />
          </div>
        )}
      </div>
      {toast && <div className="toast absolute top-14 left-1/2 -translate-x-1/2 z-[99]">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<QuickApp />);
