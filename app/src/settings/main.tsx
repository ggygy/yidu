// v0.3 §2.7.6 独立设置窗口(⌘,):系统设置式,左侧 4 分区 —— 模型 / 翻译 / 快捷窗 / 用量
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkUpdateFn } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import * as api from "../api";
import { DirPicker } from "../dirselect";
import { initNative } from "../native";
import { applyReaderStyle, loadReaderStyle, RS_DEFAULT, type ReaderStyle } from "../reader";
import { Group, Row, Segmented, Toggle, fmtTokens, prettyAccel } from "../ui";
import { ModelsSection } from "./models";
import type { HotkeyStatus, Prefs, Provider, UsageSummary } from "../types";
import "../styles.css";

initNative();

type Section = "models" | "translate" | "quick" | "usage";
const SECTIONS: { id: Section; label: string; icon: string; color: string }[] = [
  { id: "models", label: "模型", icon: "✦", color: "#5e5ce6" },
  { id: "translate", label: "翻译", icon: "文", color: "#30b0c7" },
  { id: "quick", label: "快捷窗", icon: "⌥", color: "#ff9f0a" },
  { id: "usage", label: "用量", icon: "¥", color: "#34c759" },
];
const asSection = (s: string): Section | null => (SECTIONS.some((x) => x.id === s) ? (s as Section) : null);

function SettingsApp() {
  const [section, setSection] = useState<Section>(() => asSection(location.hash.slice(1)) ?? "models");
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [updBusy, setUpdBusy] = useState(false);
  const [updMsg, setUpdMsg] = useState<string | null>(null);
  const say = (m: string) => { setToast(m); window.setTimeout(() => setToast(null), 1800); };

  const refreshProviders = () => api.providerList().then((p) => { setProviders(p); emit("providers-changed", p).catch(() => {}); }).catch(() => {});
  const applyPrefs = (u: Partial<Prefs>) => api.setPrefs(u).then(setPrefs).catch((e) => say(String(e)));

  // 检查更新:有新版本 → 下载 → 安装 → 重启
  const checkUpdate = async () => {
    if (updBusy) return;
    setUpdBusy(true); setUpdMsg(null);
    try {
      const upd = await checkUpdateFn();
      if (!upd) { setUpdMsg("已是最新版本"); return; }
      setUpdMsg(`发现 v${upd.version},下载中…`);
      let received = 0, total = 0;
      await upd.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") { received += ev.data.chunkLength; setUpdMsg(`下载中 ${total ? Math.round((received / total) * 100) + "%" : (received >> 10) + " KB"}`); }
        else if (ev.event === "Finished") setUpdMsg("下载完成,即将重启…");
      });
      await relaunch();
    } catch (e) {
      setUpdMsg(`检查失败:${String(e).slice(0, 80)}`);
    } finally {
      setUpdBusy(false);
    }
  };
  const checkRef = useRef(checkUpdate);
  checkRef.current = checkUpdate;

  useEffect(() => {
    refreshProviders();
    api.getPrefs().then(setPrefs).catch(() => {});
    getVersion().then(setAppVersion).catch(() => {});
    const subs = [
      listen<Prefs>("prefs-changed", (e) => setPrefs(e.payload)),
      listen<Provider[]>("providers-changed", (e) => setProviders(e.payload)),
      listen<string>("settings-section", (e) => {
        if (e.payload === "about") checkRef.current();
        else { const s = asSection(e.payload); if (s) setSection(s); }
      }),
    ];
    if (location.hash === "#about") checkUpdate();
    return () => { subs.forEach((u) => u.then((f) => f())); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cur = SECTIONS.find((s) => s.id === section)!;
  return (
    <div className="h-screen grid grid-cols-[188px_1fr] overflow-hidden">
      {/* 侧栏:透出系统材质;顶部 52pt 给红绿灯 */}
      <aside className="mat flex flex-col border-r-[0.5px] border-line">
        <div className="h-[52px] flex-none" data-tauri-drag-region />
        <nav className="flex flex-col gap-0.5 px-2.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={"flex items-center gap-2 h-[28px] px-2 rounded-md border-none text-[13px] text-left " + (section === s.id ? "bg-accent text-onaccent" : "bg-transparent text-t1 hover:bg-surface2")}
              onClick={() => setSection(s.id)}
            >
              <span className="w-5 h-5 rounded-[5px] grid place-items-center text-white text-[11px] font-semibold flex-none" style={{ background: s.color }}>{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <span className="flex-1" data-tauri-drag-region />
        <div className="px-4 pb-3.5 flex flex-col gap-1.5 text-[11px] text-t3">
          <span>译读 v{appVersion}</span>
          <button className="btn self-start" disabled={updBusy} onClick={checkUpdate}>{updBusy ? "检查中…" : "检查更新"}</button>
          {updMsg && <span className="text-t2 leading-snug">{updMsg}</span>}
        </div>
      </aside>

      {/* 内容:分组列表,窗底 groupbg */}
      <main className="bg-groupbg flex flex-col min-w-0 min-h-0">
        <div className="h-[52px] flex-none flex items-center px-6" data-tauri-drag-region>
          <h1 className="text-[15px] font-bold m-0" data-tauri-drag-region>{cur.label}</h1>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {section === "models" && <ModelsSection providers={providers} refreshProviders={refreshProviders} say={say} />}
          {section === "translate" && <TranslateSection prefs={prefs} applyPrefs={applyPrefs} say={say} />}
          {section === "quick" && <QuickSection prefs={prefs} applyPrefs={applyPrefs} say={say} />}
          {section === "usage" && <UsageSection prefs={prefs} applyPrefs={applyPrefs} say={say} />}
        </div>
      </main>
      {toast && <div className="toast fixed bottom-5 left-1/2 -translate-x-1/2 z-[99]">{toast}</div>}
    </div>
  );
}

// ---------- 翻译(含外观) ----------

function TranslateSection({ prefs, applyPrefs, say }: { prefs: Prefs | null; applyPrefs: (u: Partial<Prefs>) => void; say: (m: string) => void }) {
  const [promptDraft, setPromptDraft] = useState("");
  const [rs, setRsState] = useState<ReaderStyle>(loadReaderStyle);
  useEffect(() => { setPromptDraft(prefs?.custom_prompt ?? ""); }, [prefs?.custom_prompt]);
  const setRs = (v: ReaderStyle) => { setRsState(v); applyReaderStyle(v); emit("reader-changed", v).catch(() => {}); };

  return (
    <>
      <Group title="翻译">
        <Row label="默认方向"><DirPicker value={prefs?.direction ?? "en2zh"} onChange={(d) => applyPrefs({ direction: d })} /></Row>
        <Row label="点词查词">免费词典 → 模型兜底<Toggle on={!!prefs?.dict_fallback} onClick={() => applyPrefs({ dict_fallback: !prefs?.dict_fallback })} /></Row>
      </Group>
      <Group
        title="翻译提示词"
        foot={<>留空 = 内置默认(英文)。支持 {"{from}"} / {"{to}"} 占位;标签协议与方向指令由应用自动附加。<button className="ml-2 border-none bg-transparent text-accent text-[11px] p-0" onClick={() => { setPromptDraft(""); applyPrefs({ custom_prompt: "" }); say("已恢复默认提示词"); }}>恢复默认</button></>}
      >
        <div className="p-2">
          <textarea
            className="w-full h-[96px] border-none bg-transparent outline-none resize-none font-code text-[12px] leading-[1.6] text-t1 placeholder:text-t3"
            value={promptDraft}
            placeholder="使用内置默认提示词"
            spellCheck={false}
            onChange={(e) => setPromptDraft(e.target.value)}
            onBlur={() => { if (promptDraft !== (prefs?.custom_prompt ?? "")) { applyPrefs({ custom_prompt: promptDraft }); say("提示词已保存"); } }}
          />
        </div>
      </Group>
      <Group title="外观与阅读" foot="外观也可在菜单「显示 › 外观」切换,⌘L 在浅色与深色之间切换。">
        <Row label="外观">
          <Segmented
            value={prefs?.theme_mode ?? "system"}
            options={[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as const}
            onChange={(m) => applyPrefs({ theme_mode: m })}
          />
        </Row>
        <Row label={<>译文字号 <b className="text-t3 font-normal ml-1">{rs.size}px</b></>}>
          <input className="w-[160px]" type="range" min={14} max={22} step={1} value={rs.size} onChange={(e) => setRs({ ...rs, size: Number(e.target.value) })} />
        </Row>
        <Row label={<>行距 <b className="text-t3 font-normal ml-1">{rs.lineH.toFixed(2)}</b></>}>
          <input className="w-[160px]" type="range" min={1.5} max={2.2} step={0.05} value={rs.lineH} onChange={(e) => setRs({ ...rs, lineH: Number(e.target.value) })} />
        </Row>
        <Row label=""><button className="btn" onClick={() => setRs(RS_DEFAULT)}>恢复默认</button></Row>
      </Group>
    </>
  );
}

// ---------- 快捷窗 ----------

function QuickSection({ prefs, applyPrefs, say }: { prefs: Prefs | null; applyPrefs: (u: Partial<Prefs>) => Promise<void> | void; say: (m: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  const [hotkey, setHotkey] = useState<HotkeyStatus | null>(null);
  useEffect(() => {
    api.hotkeyStatus().then(setHotkey).catch(() => {});
    const un = listen<HotkeyStatus>("hotkey-status", (e) => setHotkey(e.payload));
    return () => { un.then((f) => f()); };
  }, []);

  // 录制态捕获下一次组合键;Esc 取消
  useEffect(() => {
    if (!capturing) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setCapturing(false); return; }
      const parts: string[] = [];
      if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      const k = e.key;
      if (/^[a-zA-Z]$/.test(k)) parts.push(k.toUpperCase());
      else if (/^[0-9]$/.test(k)) parts.push(k);
      else if (/^F[0-9]+$/.test(k)) parts.push(k);
      else return;
      const combo = parts.join("+");
      setCapturing(false);
      Promise.resolve(applyPrefs({ hotkey: combo })).then(() => say(`热键已改为 ${prettyAccel(combo)}`));
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [capturing]); // eslint-disable-line react-hooks/exhaustive-deps

  const bad = !!hotkey?.error;
  return (
    <>
      <Group title="唤出" foot={bad ? <span className="text-danger">注册失败:{hotkey?.error}。多半被其他应用占用,请换一个组合键。</span> : "全局热键:在任何应用里按下即唤出快捷窗,再按一次隐藏。"}>
        <Row label={bad ? "快捷键 · 注册失败" : "快捷键"} danger={bad}>
          <span className={"font-medium " + (bad ? "text-danger" : "text-t1")}>{prettyAccel(prefs?.hotkey ?? "Alt+T")}</span>
          <button className="btn" onClick={() => setCapturing(true)}>{capturing ? "按下组合键…(Esc 取消)" : "更改…"}</button>
        </Row>
      </Group>
      <Group title="行为" foot="置顶与失焦自动隐藏互斥。重启后不自动显示快捷窗。">
        <Row label="粘贴即译"><Toggle on={!!prefs?.paste_auto} onClick={() => applyPrefs({ paste_auto: !prefs?.paste_auto })} /></Row>
        <Row label="默认置顶"><Toggle on={!!prefs?.pin_default} onClick={() => applyPrefs({ pin_default: !prefs?.pin_default })} /></Row>
        <Row label="失焦自动隐藏"><Toggle on={!!prefs?.blur_hide} onClick={() => applyPrefs({ blur_hide: !prefs?.blur_hide })} /></Row>
      </Group>
    </>
  );
}

// ---------- 用量 ----------

function UsageSection({ prefs, applyPrefs, say }: { prefs: Prefs | null; applyPrefs: (u: Partial<Prefs>) => void; say: (m: string) => void }) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [price, setPrice] = useState("");
  useEffect(() => { api.usageSummary().then(setUsage).catch(() => {}); }, []);
  useEffect(() => { setPrice(prefs?.price_per_mtok ? String(prefs.price_per_mtok) : ""); }, [prefs?.price_per_mtok]);
  const cost = usage && prefs?.price_per_mtok ? (((usage.prompt_tokens + usage.completion_tokens) / 1_000_000) * prefs.price_per_mtok).toFixed(3) : null;
  const savePrice = () => {
    const v = parseFloat(price);
    applyPrefs({ price_per_mtok: isNaN(v) ? 0 : v });
    say(isNaN(v) ? "单价已清空" : "单价已保存");
  };
  return (
    <>
      <Group title="累计" foot="首字耗时、各模型对比与最近请求明细将在后续版本加入。">
        <Row label="请求">{usage ? `${usage.requests} 次` : "—"}</Row>
        <Row label="输入 tokens">{usage ? fmtTokens(usage.prompt_tokens) : "—"}</Row>
        <Row label="输出 tokens">{usage ? fmtTokens(usage.completion_tokens) : "—"}</Row>
        <Row label="估算成本">{cost ? `≈ ¥${cost}` : "填写单价后显示"}</Row>
      </Group>
      <Group title="单价">
        <Row label="每 100 万 tokens(¥)">
          <input className="field w-[100px] text-right" placeholder="0" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={savePrice} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </Row>
      </Group>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<SettingsApp />);
