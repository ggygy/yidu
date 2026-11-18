// 设置 › 模型(§2.3):服务商列表 + 详情;自动保存;测试用表单当前值;模型下拉即拉取;激活前自动测试
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { Icon } from "../icons";
import {
  PRESETS, THINKING_FORMATS, THINKING_MODES, cachedModels, thinkingOf, clearTest, fetchModels, parseExtra, runTest, testState, uniqueName,
  type TestState,
} from "../providers";
import { ConfirmCard, Segmented, Toggle } from "../ui";
import type { Provider, TestResult } from "../types";

function StatusDot({ t }: { t: TestState | null }) {
  const c = !t ? "var(--fill-2)" : t.ok ? "var(--ok)" : "var(--danger)";
  return <i className="w-2 h-2 rounded-full flex-none" style={{ background: c }} title={!t ? "未测试" : t.ok ? `已连通 · ${t.ms} ms` : t.msg} />;
}

const KIND_ZH: Record<TestResult["kind"], string> = {
  ok: "已连通", no_key: "缺少密钥", auth: "密钥无效", model: "模型不存在", network: "无法连接", other: "失败",
};

function requestUrl(kind: string, base: string) {
  const b = base.trim().replace(/\/+$/, "");
  if (!b) return "—";
  if (kind === "ollama") return `${b}/api/chat`;
  return b.endsWith("/chat/completions") ? b : `${b}/chat/completions`;
}

// 测试状态跨窗同步:localStorage 写入会在其他窗口触发 storage 事件
function useTestTick() {
  const [n, set] = useState(0);
  useEffect(() => {
    const h = (e: StorageEvent) => { if (e.key?.startsWith("yidu-test-")) set((x) => x + 1); };
    window.addEventListener("storage", h);
    return () => window.removeEventListener("storage", h);
  }, []);
  return [n, () => set((x) => x + 1)] as const;
}

export function ModelsSection({ providers, refreshProviders, say }: { providers: Provider[]; refreshProviders: () => Promise<void>; say: (m: string) => void }) {
  const active = providers.find((p) => p.is_active);
  const [selId, setSelId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [focusKey, setFocusKey] = useState(0); // 新增后聚焦密钥框
  const [tick, bump] = useTestTick();

  useEffect(() => {
    if (selId != null && providers.some((p) => p.id === selId)) return;
    setSelId(active?.id ?? providers[0]?.id ?? null);
  }, [providers]); // eslint-disable-line react-hooks/exhaustive-deps
  const sel = providers.find((p) => p.id === selId) ?? null;

  const addPreset = async (name: string) => {
    setAdding(false);
    const pr = name === "__custom__"
      ? { kind: "openai_compatible", base_url: "", model: "", name: uniqueName("自定义", providers) }
      : { ...PRESETS[name], name: uniqueName(name.replace(/[（(].*[)）]$/, "").trim(), providers) };
    try {
      const saved = await api.providerSave({ id: null, name: pr.name, kind: pr.kind, base_url: pr.base_url, model: pr.model });
      await refreshProviders();
      setSelId(saved.id);
      setFocusKey((n) => n + 1);
      // Ollama 免密钥:直接测试 + 拉模型
      if (pr.kind === "ollama") {
        runTest(saved).then(bump);
        fetchModels(saved).catch(() => {});
      }
    } catch (e) { say(String(e)); }
  };

  if (!providers.length) {
    return (
      <div>
        <p className="text-[13px] text-t2 mt-0 mb-3">选一个服务商开始:粘贴 API 密钥后会自动测试并拉取模型列表。</p>
        <PresetGrid onPick={addPreset} />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-4 items-start">
      {/* 服务商列表 */}
      <div className="relative">
        <div className="flex flex-col gap-0.5" data-tick={tick} role="listbox">
          {providers.map((p) => {
            const t = testState(p);
            const on = p.id === selId;
            return (
              <button key={p.id} className="srow" role="option" aria-selected={on} onClick={() => setSelId(p.id)}>
                <StatusDot t={t} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[13px] truncate">{p.name}</span>
                    {p.is_active && <span className={"text-[11px] px-1.5 rounded-full whitespace-nowrap " + (on ? "ring-1 ring-inset ring-[color-mix(in_srgb,var(--on-accent)_60%,transparent)]" : "bg-accentsoft text-accenttx")}>使用中</span>}
                  </span>
                  <span className="sub block text-[11px] font-code truncate">{p.model || "未选模型"}</span>
                </span>
              </button>
            );
          })}
        </div>
        <button className="srow mt-1.5 !text-t2 text-[13px]" onClick={() => setAdding(!adding)}><span className="w-4 text-center text-[15px] leading-none">＋</span>添加服务商</button>
        {adding && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setAdding(false)} />
            <div className="menu absolute z-40 left-0 right-0 mt-1">
              {Object.entries(PRESETS).map(([k, v]) => (
                <button key={k} onClick={() => addPreset(k)}>{k}<span className="ml-auto pl-3 text-[11px] text-t3">{v.hint}</span></button>
              ))}
              <hr />
              <button onClick={() => addPreset("__custom__")}>自定义(OpenAI 兼容)…</button>
            </div>
          </>
        )}
      </div>

      {sel && <Detail key={sel.id} p={sel} providers={providers} refreshProviders={refreshProviders} say={say} focusKey={focusKey} onTested={bump} onDeleted={() => setSelId(null)} />}
    </div>
  );
}

function PresetGrid({ onPick }: { onPick: (k: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {Object.entries(PRESETS).map(([k, v]) => (
        <button key={k} className="gl text-left px-3 py-2.5 hover:bg-surface2" onClick={() => onPick(k)}>
          <div className="text-[13px] font-semibold">{k}</div>
          <div className="text-[11px] text-t3 mt-0.5">{v.hint}</div>
        </button>
      ))}
      <button className="gl text-left px-3 py-2.5 hover:bg-surface2" onClick={() => onPick("__custom__")}>
        <div className="text-[13px] font-semibold">自定义</div>
        <div className="text-[11px] text-t3 mt-0.5">任意 OpenAI 兼容地址</div>
      </button>
    </div>
  );
}

function Detail({ p, providers, refreshProviders, say, focusKey, onTested, onDeleted }: {
  p: Provider; providers: Provider[]; refreshProviders: () => Promise<void>; say: (m: string) => void;
  focusKey: number; onTested: () => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(p.name);
  const [base, setBase] = useState(p.base_url);
  const [model, setModel] = useState(p.model);
  const extra = parseExtra(p);
  const [tmode, setTmode] = useState(thinkingOf(extra).mode);
  const [tformat, setTformat] = useState(thinkingOf(extra).format);
  const [custom, setCustom] = useState(extra.thinking_custom ?? "");
  const [preview, setPreview] = useState<string | null>(null);
  const [temp, setTemp] = useState(typeof extra.temperature === "number" ? String(extra.temperature) : "");
  const saveTemp = async () => {
    const v = parseFloat(temp);
    const next = { ...parseExtra(p) };
    if (temp.trim() === "" || isNaN(v)) { delete next.temperature; setTemp(""); }
    else next.temperature = Math.min(2, Math.max(0, v));
    try {
      await api.providerSave({ id: p.id, name: p.name, kind: p.kind, base_url: p.base_url, model: p.model, extra: JSON.stringify(next) });
      await refreshProviders();
    } catch (e) { say(String(e)); }
  };
  const [hedge, setHedge] = useState(extra.hedge !== false);
  const saveHedge = async (on: boolean) => {
    setHedge(on);
    const next = { ...parseExtra(p) };
    if (on) delete next.hedge; else next.hedge = false;
    try {
      await api.providerSave({ id: p.id, name: p.name, kind: p.kind, base_url: p.base_url, model: p.model, extra: JSON.stringify(next) });
      await refreshProviders();
    } catch (e) { say(String(e)); }
  };
  const [hint, setHint] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(!p.has_key && p.kind !== "ollama");
  const [keyDraft, setKeyDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestState | null>(() => testState(p));
  const [models, setModels] = useState<string[]>(() => cachedModels(p.id));
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState(""); // 只在手打时过滤;点「列表」显示全部
  const [del, setDel] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<number>(0);

  useEffect(() => { api.providerKeyHint(p.id).then(setHint).catch(() => {}); }, [p.id, p.has_key]);
  useEffect(() => { if (focusKey && editingKey) keyRef.current?.focus(); }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 自动保存(§2.3.2):停手 500ms 落库;地址 / 模型变了 → 状态自动回到「未测试」(签名不符)
  const scheduleSave = (n: string, b: string, m: string) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        await api.providerSave({ id: p.id, name: n.trim() || p.name, kind: p.kind, base_url: b.trim(), model: m.trim() });
        await refreshProviders();
      } catch (e) { say(String(e)); }
    }, 500);
  };
  const flush = async () => {
    window.clearTimeout(saveTimer.current);
    if (name !== p.name || base !== p.base_url || model !== p.model) {
      await api.providerSave({ id: p.id, name: name.trim() || p.name, kind: p.kind, base_url: base.trim(), model: model.trim() });
      await refreshProviders();
    }
  };
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);
  useEffect(() => { setResult(testState({ ...p, base_url: base, model })); }, [base, model]); // eslint-disable-line react-hooks/exhaustive-deps

  // 实际会附加的字段:随设置 / 地址 / 模型实时预览
  useEffect(() => {
    const ex = JSON.stringify({ thinking_mode: tmode, thinking_format: tformat, thinking_custom: custom || undefined });
    api.thinkingPreview({ id: p.id, kind: p.kind, base_url: base, model, extra: ex }).then(setPreview).catch(() => setPreview(null));
  }, [tmode, tformat, custom, base, model, p.id, p.kind]);

  const saveExtra = async (mode: string, format: string, customJson: string) => {
    const next = { ...parseExtra(p), thinking_mode: mode, thinking_format: format, thinking_custom: customJson || undefined };
    delete next.thinking_control; // 旧版单选字段
    delete next.thinking_unsupported; // 换了设置,重新探测
    try {
      await api.providerSave({ id: p.id, name: p.name, kind: p.kind, base_url: p.base_url, model: p.model, extra: JSON.stringify(next) });
      await refreshProviders();
    } catch (e) { say(String(e)); }
  };

  const doTest = async (keyOverride?: string) => {
    setTesting(true);
    await flush().catch(() => {});
    const r = await runTest(p, { base_url: base, model, key: keyOverride ?? null });
    setResult(testState({ ...p, base_url: base, model }) ?? { ok: r.ok, kind: r.kind, ms: r.latency_ms, msg: r.message, sig: "", at: Date.now() });
    setTesting(false);
    onTested();
    return r;
  };

  const loadModels = async (keyOverride?: string) => {
    setModelsBusy(true); setModelsErr(null);
    try { setModels(await fetchModels(p, { base_url: base, model, key: keyOverride ?? null })); }
    catch (e) { setModelsErr(String(e)); }
    setModelsBusy(false);
  };

  const commitKey = async (k: string) => {
    const key = k.trim();
    if (!key) { setEditingKey(false); return; }
    try {
      await api.providerSetKey(p.id, key);
      setKeyDraft("");
      setEditingKey(false);
      clearTest(p.id);
      await refreshProviders();
      // 粘贴即自动测试 + 拉取模型(§2.3.7)
      doTest(key);
      loadModels(key);
    } catch (e) { say(String(e)); }
  };

  // 激活门槛(§2.3.5):先测,失败不切换
  const activate = async () => {
    const r = await doTest();
    if (!r.ok) { say(`未切换:${KIND_ZH[r.kind]}`); return; }
    try {
      await api.providerSetActive(p.id);
      await refreshProviders();
      say(`已切换到 ${p.name}`);
    } catch (e) { say(String(e)); }
  };

  const filtered = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    return models.filter((m) => !q || m.toLowerCase().includes(q)).slice(0, 300);
  }, [models, modelQuery]);
  const needsKey = p.kind !== "ollama";

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-3">
        <input className="field !h-[26px] !text-[15px] font-semibold !bg-transparent !border-transparent focus:!border-accent flex-1 min-w-0" value={name} onChange={(e) => { setName(e.target.value); scheduleSave(e.target.value, base, model); }} spellCheck={false} />
        {p.is_active && <span className="text-[11px] px-2 py-0.5 rounded bg-accentsoft text-accenttx whitespace-nowrap">使用中</span>}
      </div>

      <div className="gl">
        <div className="gr">
          <span className="w-[64px] flex-none">地址</span>
          <input className="field mono flex-1" value={base} placeholder="https://…/v1" onChange={(e) => { setBase(e.target.value); scheduleSave(name, e.target.value, model); }} spellCheck={false} />
        </div>
        {needsKey && (
          <div className="gr">
            <span className="w-[64px] flex-none">API 密钥</span>
            {editingKey ? (
              <>
                <input
                  ref={keyRef}
                  className="field mono flex-1"
                  type="password"
                  placeholder="粘贴密钥,只存于系统钥匙串"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onPaste={(e) => { const t = e.clipboardData.getData("text"); if (t.trim()) { e.preventDefault(); commitKey(t); } }}
                  onKeyDown={(e) => { if (e.key === "Enter") commitKey(keyDraft); if (e.key === "Escape") { setKeyDraft(""); setEditingKey(!p.has_key); } }}
                  onBlur={() => { if (keyDraft.trim()) commitKey(keyDraft); }}
                  spellCheck={false}
                />
                {p.has_key && <button className="btn" onClick={() => { setKeyDraft(""); setEditingKey(false); }}>取消</button>}
              </>
            ) : (
              <>
                <span className="flex-1 text-t2 text-[13px]">已存于钥匙串 <span className="font-code text-t3">{hint ?? ""}</span></span>
                <button className="btn" onClick={() => { setEditingKey(true); window.setTimeout(() => keyRef.current?.focus(), 30); }}>更改…</button>
              </>
            )}
          </div>
        )}
        <div className="gr relative">
          <span className="w-[64px] flex-none">模型</span>
          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            <input
              className="field mono flex-1 min-w-0"
              value={model}
              placeholder="手填或从列表选"
              onChange={(e) => { setModel(e.target.value); setModelQuery(e.target.value); if (models.length) setModelOpen(true); scheduleSave(name, base, e.target.value); }}
              spellCheck={false}
            />
            <button
              className="btn !px-2"
              title="拉取可用模型"
              onClick={() => { setModelQuery(""); setModelOpen(true); loadModels(); }}
            >{modelsBusy ? "拉取中…" : <>列表<Icon n="chev" size={11} /></>}</button>
          </div>
          {modelOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setModelOpen(false)} />
              <div className="menu absolute z-40 left-[84px] right-3 top-full mt-0.5 max-h-[260px] overflow-y-auto">
                {modelsErr && <p className="text-[12px] text-danger px-2 py-1.5 m-0">拉取失败:{modelsErr}</p>}
                {!modelsErr && !modelsBusy && filtered.length === 0 && <p className="text-[12px] text-t3 px-2 py-1.5 m-0">{models.length ? "无匹配,可直接手填" : "没有拉取到模型"}</p>}
                {modelsBusy && !models.length && <p className="text-[12px] text-t3 px-2 py-1.5 m-0">拉取中…</p>}
                {filtered.map((m) => (
                  <button key={m} onClick={() => { setModel(m); setModelOpen(false); scheduleSave(name, base, m); }}>
                    <span className="w-3 flex-none">{m === model ? "✓" : ""}</span><span className="font-code text-[12px] truncate">{m}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="gr">
          <span className="w-[64px] flex-none">思考</span>
          <Segmented value={tmode} options={THINKING_MODES} onChange={(m) => { setTmode(m); saveExtra(m, tformat, custom); }} />
        </div>
        {tmode !== "default" && (
          <div className="gr">
            <span className="w-[64px] flex-none">字段格式</span>
            <select className="field !h-[24px] flex-1 min-w-0" value={tformat} onChange={(e) => { setTformat(e.target.value); saveExtra(tmode, e.target.value, custom); }}>
              {THINKING_FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}
        <div className="gr">
          <span className="w-[64px] flex-none">温度</span>
          <input className="field w-[72px] text-right tabular-nums" inputMode="decimal" placeholder="0.3" value={temp} onChange={(e) => setTemp(e.target.value)} onBlur={saveTemp} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          <span className="text-[11px] text-t3">留空 = 0.3(翻译求稳);0–2</span>
        </div>
        {p.kind !== "ollama" && (
          <div className="gr">
            <span className="w-[64px] flex-none">超时重发</span>
            <span className="flex-1 min-w-0 text-[11px] text-t3">4 秒仍无输出就并发重发一次,谁先出字用谁;被中止的请求可能仍按输入计费</span>
            <Toggle on={hedge} onClick={() => saveHedge(!hedge)} />
          </div>
        )}
        {tmode !== "default" && tformat === "custom" && (
          <div className="gr">
            <span className="w-[64px] flex-none text-t3">字段</span>
            <input className="field mono flex-1" value={custom} placeholder='如 {"reasoning_effort": "none"}' onChange={(e) => setCustom(e.target.value)} onBlur={() => saveExtra(tmode, "custom", custom)} spellCheck={false} />
          </div>
        )}
      </div>
      <div className="gf selectable">
        {preview
          ? <>请求体附加 <span className="font-code text-t2">{preview}</span>{tmode === "auto" ? "(已知服务商自动关闭思考)" : ""};服务商不认时自动降级或去掉重试。</>
          : tmode === "default" ? "不附加思考字段,由模型自己决定是否思考。"
          : tmode === "auto" ? "自动:此地址不在已知服务商列表,不附加字段。要关闭思考请选「关闭」。"
          : "此格式不支持该设置,不附加字段。"}
        <br />请求 <span className="font-code">POST {requestUrl(p.kind, base)}</span>
        {models.length > 0 && <> · 已拉取 {models.length} 个模型</>}
      </div>

      {/* 测试结果 */}
      <div className={"mt-3 rounded-lg px-3 py-2 text-[12px] flex items-center gap-2 " + (!result ? "bg-surface2 text-t3" : result.ok ? "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-t1" : "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-t1")}>
        <StatusDot t={result} />
        {testing ? "测试中…" : !result ? "未测试 · 改动地址、密钥或模型后需重新测试" : result.ok ? <span><b>已连通</b> · {result.ms} ms</span> : <span className="min-w-0 break-all"><b>{KIND_ZH[result.kind]}</b> · {result.msg}</span>}
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button className="btn danger" onClick={() => setDel(true)}>删除</button>
        <span className="flex-1" />
        <button className="btn" disabled={testing} onClick={() => doTest()}>测试</button>
        {p.is_active
          ? <button className="btn" disabled>使用中</button>
          : <button className="btn primary" disabled={testing || (needsKey && !p.has_key)} title="切换前会先自动测试,失败不切换" onClick={activate}>设为使用中</button>}
      </div>

      {del && (
        <ConfirmCard
          title={`删除「${p.name}」?`}
          body={providers.length === 1 ? "这是唯一的服务商,删除后需重新配置才能翻译。" : "钥匙串里的密钥会一并清除。"}
          confirmText="删除"
          onConfirm={() => api.providerDelete(p.id).then(refreshProviders).then(() => { clearTest(p.id); onDeleted(); say(`已删除「${p.name}」`); }).catch((e) => say(String(e)))}
          onClose={() => setDel(false)}
        />
      )}
    </div>
  );
}
