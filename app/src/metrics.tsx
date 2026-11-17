// 流式感知与翻译指标(§2.6.5–2.6.6;快捷窗状态栏 / 主窗工具栏与检查器共用)
import { useEffect, useState } from "react";
import type { Phase, SessionMetrics, StreamEvent } from "./types";

export type Live = {
  running: boolean;
  phase: Phase;
  startedAt: number;
  thinkChars: number;
  thinkTail: string;
  metrics: SessionMetrics | null;
};

export const IDLE: Live = { running: false, phase: "conn", startedAt: 0, thinkChars: 0, thinkTail: "", metrics: null };

export const startLive = (): Live => ({ ...IDLE, running: true, startedAt: Date.now() });

/** 折叠流式事件到 Live;非指标事件原样返回 */
export function reduceLive(l: Live, e: StreamEvent): Live {
  switch (e.type) {
    case "phase": return { ...l, phase: e.phase };
    case "thinking": return { ...l, thinkChars: e.chars, thinkTail: e.tail };
    case "metrics": { const { type: _t, ...m } = e; return { ...l, metrics: m, running: false }; }
    case "done":
    case "error": return { ...l, running: false };
    default: return l;
  }
}

export const sec = (ms: number | null | undefined) => (ms == null ? "—" : ms < 10_000 ? `${(ms / 1000).toFixed(2)}s` : `${(ms / 1000).toFixed(1)}s`);

/** 正文生成速度:正文 tok /(末正文 − 首正文) */
export function speed(m: SessionMetrics): number | null {
  if (m.ttft_ms == null || m.last_content_ms == null) return null;
  const dt = (m.last_content_ms - m.ttft_ms) / 1000;
  const content = m.completion_tokens - m.reasoning_tokens;
  return dt > 0.2 && content > 0 ? content / dt : null;
}

const PHASE_ZH: Record<Phase, string> = { conn: "连接", think: "思考", gen: "生成" };

function useTicker(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => set((n) => n + 1), 100);
    return () => window.clearInterval(t);
  }, [on]);
}

/** 进行中:彩色呼吸点 + 阶段 + 运行计时(+ 思考字数) */
export function LiveStatus({ live }: { live: Live }) {
  useTicker(live.running);
  const color = live.phase === "gen" ? "var(--ok)" : live.phase === "think" ? "#bf5af2" : "var(--accent)";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap tabular-nums" title={live.thinkTail ? `思考末尾:${live.thinkTail}` : undefined}>
      <i className="w-1.5 h-1.5 rounded-full [animation:breathe_1.2s_infinite]" style={{ background: color }} />
      {PHASE_ZH[live.phase]}
      {live.phase === "think" && live.thinkChars > 0 ? ` ${live.thinkChars} 字` : ""}
      {" · "}{((Date.now() - live.startedAt) / 1000).toFixed(1)}s
    </span>
  );
}

/** 结束后一行:首字 · 总耗时 · 输出 tok */
export function metricsLine(m: SessionMetrics): string {
  const parts = [`首字 ${sec(m.ttft_ms)}`, `总 ${sec(m.total_ms)}`, `输出 ${m.completion_tokens} tok`];
  const s = speed(m);
  if (s) parts.push(`${Math.round(s)} tok/s`);
  return parts.join(" · ");
}

/** 明细:分段时间条 + 指标表(ⓘ 弹层 / 主窗检查器共用) */
/** 成本估算:缓存命中的输入按缓存单价(未填则按普通单价) */
export function estimateCost(prompt: number, completion: number, cached: number, price?: number, cachedPrice?: number | null): number {
  if (!price) return 0;
  const hit = Math.min(cached, prompt);
  return ((prompt - hit) * price + hit * (cachedPrice ?? price) + completion * price) / 1_000_000;
}

export function MetricsDetail({ m, price, cachedPrice, thinkTail }: { m: SessionMetrics; price?: number; cachedPrice?: number | null; thinkTail?: string }) {
  const total = Math.max(m.total_ms, 1);
  const think0 = m.first_reasoning_ms;
  const conn = think0 ?? m.ttft_ms ?? total;
  const think = think0 != null && m.ttft_ms != null ? m.ttft_ms - think0 : think0 != null ? total - think0 : 0;
  const gen = m.ttft_ms != null ? (m.last_content_ms ?? total) - m.ttft_ms : 0;
  const rest = Math.max(0, total - conn - think - gen);
  const seg = [
    ["连接", conn, "var(--accent)"],
    ["思考", think, "#bf5af2"],
    ["生成", gen, "var(--ok)"],
    ["收尾", rest, "var(--fill-2)"],
  ] as const;
  const s = speed(m);
  const cost = estimateCost(m.prompt_tokens, m.completion_tokens, m.cached_tokens ?? 0, price, cachedPrice);
  const heavyThink = m.reasoning_tokens > 0 && (m.reasoning_tokens / Math.max(1, m.completion_tokens) > 0.4 || think / total > 0.3);
  return (
    <div className="text-[12px]">
      <div className="flex h-[6px] rounded-full overflow-hidden bg-fill2">
        {seg.map(([k, v, c]) => v > 0 && <i key={k} style={{ width: `${(v / total) * 100}%`, background: c }} title={`${k} ${sec(v)}`} />)}
      </div>
      <div className="flex gap-3 mt-1.5 text-[11px] text-t3 flex-wrap">
        {seg.filter(([, v]) => v > 0).map(([k, v, c]) => (
          <span key={k} className="inline-flex items-center gap-1"><i className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />{k} {sec(v)}</span>
        ))}
      </div>
      <div className="mt-2">
        <Kv k="首字(TTFT)" v={sec(m.ttft_ms)} />
        <Kv k="首块" v={sec(m.first_block_ms)} />
        <Kv k="总耗时" v={sec(m.total_ms)} />
        <Kv k="输入" v={`${m.prompt_tokens.toLocaleString()} tok`} />
        {(m.cached_tokens ?? 0) > 0 && <Kv k="其中缓存命中" v={`${m.cached_tokens.toLocaleString()} tok · ${Math.round((m.cached_tokens / Math.max(1, m.prompt_tokens)) * 100)}%`} />}
        <Kv k="输出" v={`${m.completion_tokens.toLocaleString()} tok`} />
        {m.reasoning_tokens > 0 && <Kv k="其中思考" v={`${m.reasoning_tokens.toLocaleString()} tok`} />}
        <Kv k="生成速度" v={s ? `${Math.round(s)} tok/s` : "—"} />
        {cost > 0 && <Kv k="估算成本" v={`≈ ¥${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`} />}
        <Kv k="模型" v={m.model} />
        <Kv k="块 · 批 · 请求" v={`${m.blocks} · ${m.batches} · ${m.requests}`} />
      </div>
      {heavyThink && <p className="mt-2 mb-0 text-[11px] text-t2 leading-snug">思考占比高:在 设置 › 模型 › 思考控制 关闭思考可明显加快首字。</p>}
      {m.cancelled && <p className="mt-2 mb-0 text-[11px] text-t3">本次已取消,指标为取消前的部分。</p>}
      {thinkTail && <details className="mt-2"><summary className="text-[11px] text-t3">思考末尾</summary><p className="selectable text-[11px] text-t3 leading-snug mt-1 mb-0">…{thinkTail}</p></details>}
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-[3px] text-t2">
      <span className="whitespace-nowrap">{k}</span><b className="text-t1 font-medium tabular-nums truncate">{v}</b>
    </div>
  );
}
