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
import { SCALE_MAX, SCALE_MIN, stepScale } from "../reader";
import { estimateCost } from "../metrics";
import { Group, Row, Segmented, Toggle, fmtTokens, prettyAccel } from "../ui";
import { ModelsSection } from "./models";
import type { HotkeyStatus, Prefs, Provider, UsageReport } from "../types";
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
  useEffect(() => { setPromptDraft(prefs?.custom_prompt ?? ""); }, [prefs?.custom_prompt]);

  return (
    <>
      <Group title="翻译">
        <Row label="默认方向"><DirPicker value={prefs?.direction ?? "en2zh"} onChange={(d) => applyPrefs({ direction: d })} /></Row>
        <Row label="点词查词">免费词典 → 模型兜底<Toggle on={!!prefs?.dict_fallback} onClick={() => applyPrefs({ dict_fallback: !prefs?.dict_fallback })} /></Row>
        <Row label="长文分批">
          <Segmented
            value={prefs?.batch_mode ?? "cache"}
            options={[["speed", "速度优先"], ["cache", "缓存优先"]] as const}
            onChange={(m) => applyPrefs({ batch_mode: m })}
          />
        </Row>
        {(prefs?.batch_mode ?? "cache") === "speed" && (
          <Row label="并发批次" title="同时发出的请求数;首批始终单独先发。Ollama 本地恒为 1">
            <Segmented value={String(prefs?.concurrency ?? 3) as "1" | "2" | "3"} options={[["1", "1"], ["2", "2"], ["3", "3"]] as const} onChange={(v) => applyPrefs({ concurrency: Number(v) })} />
          </Row>
        )}
      </Group>
      <p className="gf !px-3 -mt-3 mb-4">
        {(prefs?.batch_mode ?? "cache") === "speed"
          ? "速度优先:每批独立请求、并行发出,长文最快;每次只有系统提示部分能命中服务商缓存。"
          : "缓存优先:整篇作为一段对话逐批翻译,前面的批次原样带上,大部分输入命中服务商缓存(按缓存价计费),术语与语气也更连贯;批次串行,长文更慢。总成本是否更低取决于服务商的缓存单价,可在「用量」页对比。"}
      </p>
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
      <Group title="外观与阅读" foot="字号也可在阅读时用 ⌘+ / ⌘− / ⌘0 调整,主窗与快捷窗各自记忆。外观可在菜单「显示 › 外观」切换,⌘L 在浅色与深色之间切换。">
        <Row label="外观">
          <Segmented
            value={prefs?.theme_mode ?? "system"}
            options={[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as const}
            onChange={(m) => applyPrefs({ theme_mode: m })}
          />
        </Row>
        <Row label="主窗字号"><ScaleStepper value={prefs?.main_scale ?? 1} onChange={(v) => applyPrefs({ main_scale: v })} /></Row>
        <Row label="快捷窗字号"><ScaleStepper value={prefs?.quick_scale ?? 1} onChange={(v) => applyPrefs({ quick_scale: v })} /></Row>
        <Row label="排版密度">
          <Segmented value={prefs?.density ?? "standard"} options={[["compact", "紧凑"], ["standard", "标准"], ["loose", "宽松"]] as const} onChange={(d) => applyPrefs({ density: d })} />
        </Row>
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
      if (e.metaKey) parts.push("CommandOrControl");
      if (e.ctrlKey) parts.push("Control");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      // e.code 不受 ⌥ 组合出的特殊字符影响(⌥T 的 e.key 是「†」)
      const c = e.code;
      const k = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit[0-9]$/.test(c) ? c.slice(5) : /^F[0-9]+$/.test(c) ? c : "";
      if (!k) return; // 仅修饰键,继续等
      if (!e.metaKey && !e.ctrlKey && !e.altKey) { say("快捷键须包含 ⌘ / ⌥ / ⌃ 之一"); return; }
      parts.push(k);
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

// ---------- 用量(§2.6.7) ----------

function ttftCls(ms: number | null) {
  if (ms == null) return "text-t3";
  return ms < 1000 ? "text-ok" : ms <= 3000 ? "text-[#c88a00] dark:text-[#ffd60a]" : "text-danger";
}
const s1 = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`);

function UsageSection({ prefs, applyPrefs, say }: { prefs: Prefs | null; applyPrefs: (u: Partial<Prefs>) => void; say: (m: string) => void }) {
  const [rep, setRep] = useState<UsageReport | null>(null);
  const [price, setPrice] = useState("");
  useEffect(() => {
    const d = new Date();
    const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
    api.usageReport(monthStart).then(setRep).catch((e) => say(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPrice(prefs?.price_per_mtok ? String(prefs.price_per_mtok) : ""); }, [prefs?.price_per_mtok]);
  const p = prefs?.price_per_mtok ?? 0;
  const cost = rep && p ? estimateCost(rep.month_prompt, rep.month_completion, rep.month_cached, p, prefs?.cached_price_per_mtok) : null;
  const [cprice, setCprice] = useState("");
  useEffect(() => { setCprice(prefs?.cached_price_per_mtok ? String(prefs.cached_price_per_mtok) : ""); }, [prefs?.cached_price_per_mtok]);
  const saveCprice = () => {
    const v = parseFloat(cprice);
    applyPrefs({ cached_price_per_mtok: isNaN(v) ? 0 : v });
  };
  const savePrice = () => {
    const v = parseFloat(price);
    applyPrefs({ price_per_mtok: isNaN(v) ? 0 : v });
    say(isNaN(v) ? "单价已清空" : "单价已保存");
  };
  const fmtTime = (t: number) => {
    const d = new Date(t * 1000);
    const today = d.toDateString() === new Date().toDateString();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return today ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
  };
  return (
    <>
      <div className="grid grid-cols-3 gap-2.5 mb-4">
        {[
          ["本月请求", rep ? `${rep.month_requests}` : "—"],
          ["本月 tokens", rep ? fmtTokens(rep.month_prompt + rep.month_completion) : "—"],
          ["估算成本", cost != null ? `¥${cost < 0.1 ? cost.toFixed(3) : cost.toFixed(2)}` : "填单价后显示"],
        ].map(([k, v]) => (
          <div key={k} className="gl px-3.5 py-3">
            <div className="text-[11px] text-t3">{k}</div>
            <div className="text-[20px] font-semibold tabular-nums mt-0.5 truncate">{v}</div>
          </div>
        ))}
      </div>
      {rep && (rep.month_reasoning > 0 || rep.month_cached > 0) && (
        <p className="gf !px-1 !pt-0 -mt-2 mb-3">
          {rep.month_cached > 0 && <>本月输入中 {fmtTokens(rep.month_cached)} tokens 命中服务商缓存({Math.round((rep.month_cached / Math.max(1, rep.month_prompt)) * 100)}%)。</>}
          {rep.month_reasoning > 0 && <>输出中有 {fmtTokens(rep.month_reasoning)} tokens 是思考({Math.round((rep.month_reasoning / Math.max(1, rep.month_completion)) * 100)}%)。</>}
        </p>
      )}

      <Group title="各模型首字(最近 20 次中位数)" foot="首字 < 1s 快 · 1–3s 一般 · > 3s 慢。">
        {rep?.models.length ? rep.models.map((m) => (
          <Row key={m.model} label={<span className="font-code text-[12px]">{m.model}</span>}>
            <span className={"tabular-nums font-medium " + ttftCls(m.ttft_median_ms)}>首字 {s1(m.ttft_median_ms)}</span>
            <span className="tabular-nums">总 {s1(m.total_median_ms)}</span>
            <span className="text-[11px]">{m.samples} 次</span>
          </Row>
        )) : <Row label={<span className="text-t3">还没有翻译记录</span>} />}
      </Group>

      <section className="mb-4">
        <div className="gh">最近 20 次请求</div>
        <div className="gl overflow-hidden">
          <table className="w-full text-[12px] tabular-nums border-collapse">
            <thead>
              <tr className="text-t3 text-[11px] text-left">
                {["时间", "模型", "首字", "总耗时", "输入 / 输出", "缓存", "思考"].map((h, i) => <th key={h} className={"font-medium px-3 py-2 " + (i >= 2 ? "text-right" : "")}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rep?.recent.map((r, i) => (
                <tr key={i} className="border-t-[0.5px] border-line">
                  <td className="px-3 py-1.5 text-t2 whitespace-nowrap">{fmtTime(r.created_at)}</td>
                  <td className="px-3 py-1.5 font-code text-[11px] truncate max-w-[140px]" title={r.provider}>{r.model || "—"}</td>
                  <td className={"px-3 py-1.5 text-right font-medium " + ttftCls(r.ttft_ms)}>{s1(r.ttft_ms)}</td>
                  <td className="px-3 py-1.5 text-right text-t2">{s1(r.latency_ms)}</td>
                  <td className="px-3 py-1.5 text-right text-t2 whitespace-nowrap">{r.prompt_tokens} / {r.completion_tokens}</td>
                  <td className="px-3 py-1.5 text-right text-t3">{r.cached_tokens || "—"}</td>
                  <td className="px-3 py-1.5 text-right text-t3">{r.reasoning_tokens || "—"}</td>
                </tr>
              ))}
              {rep && !rep.recent.length && <tr><td colSpan={7} className="px-3 py-3 text-t3">还没有翻译记录</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <Group title="单价" foot="按输入 + 输出合计估算;命中服务商前缀缓存的输入按「缓存命中」单价算(未填按普通单价)。不同模型单价不同时填平均值即可。">
        <Row label="每 100 万 tokens(¥)">
          <input className="field w-[100px] text-right" placeholder="0" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={savePrice} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </Row>
        <Row label="缓存命中 · 每 100 万 tokens(¥)">
          <input className="field w-[100px] text-right" placeholder="同上" value={cprice} onChange={(e) => setCprice(e.target.value)} onBlur={saveCprice} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </Row>
      </Group>
    </>
  );
}

function ScaleStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <button className="btn !px-2" disabled={value <= SCALE_MIN} onClick={() => onChange(stepScale(value, "zoom-out"))}>−</button>
      <button className="btn !px-2 min-w-[52px] justify-center tabular-nums" title="恢复 100%" onClick={() => onChange(1)}>{Math.round(value * 100)}%</button>
      <button className="btn !px-2" disabled={value >= SCALE_MAX} onClick={() => onChange(stepScale(value, "zoom-in"))}>＋</button>
    </span>
  );
}

createRoot(document.getElementById("root")!).render(<SettingsApp />);
