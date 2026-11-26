// 生词复习(v0.6):全屏卡片,空格揭示,1 / 2 / 3 评分(忘了 / 模糊 / 记得),Esc 退出。
// 调度在 Rust(srs.rs,SM-2 变体);「忘了」的词 10 分钟后到期,本次复习末尾再出现一次。
import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { ReviewCard, ReviewGrade } from "./types";

const GRADES: { grade: ReviewGrade; key: string; label: string; cls: string }[] = [
  { grade: "forgot", key: "1", label: "忘了", cls: "text-danger" },
  { grade: "hard", key: "2", label: "模糊", cls: "text-t1" },
  { grade: "good", key: "3", label: "记得", cls: "text-accenttx" },
];

function nextLabel(grade: ReviewGrade, days: number): string {
  if (grade === "forgot") return "稍后再考";
  if (days < 1.5) return "明天";
  if (days < 30) return `${Math.round(days)} 天后`;
  return `${Math.round(days / 30)} 个月后`;
}

/** 例句里把目标词挖空(揭示前),避免例句直接泄题 */
function mask(sentence: string, lemma: string): string {
  const re = new RegExp(`\\b${lemma.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*`, "gi");
  return sentence.replace(re, "____");
}

export function ReviewSession({ onClose, say }: { onClose: (reviewed: number) => void; say: (m: string) => void }) {
  const [queue, setQueue] = useState<ReviewCard[] | null>(null);
  const [pos, setPos] = useState(0);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.reviewDue().then(setQueue).catch((e) => setErr(String(e))); }, []);

  const card = queue && pos < queue.length ? queue[pos] : null;
  const finished = !!queue && pos >= queue.length;

  const grade = async (g: ReviewGrade) => {
    if (!card || !shown || busy) return;
    setBusy(true);
    try {
      const r = await api.reviewGrade(card.entry_id, g);
      setLast(`${card.lemma} · ${nextLabel(g, r.interval_days)}`);
      // 忘了:本次末尾再出现一次(已在队尾的不重复追加)
      if (g === "forgot" && queue && queue[queue.length - 1]?.entry_id !== card.entry_id) setQueue([...queue, { ...card, is_new: false }]);
      setDone((n) => n + 1);
      setShown(false);
      setPos((p) => p + 1);
    } catch (e) {
      say(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 键盘:捕获阶段拦下,免得主窗的 1/2/3 切视图、Esc 关层同时触发
  const ref = useRef({ grade, card, shown, done });
  ref.current = { grade, card, shown, done };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const c = ref.current;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); onClose(c.done); return; }
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); if (c.card && !c.shown) setShown(true); return; }
      const g = GRADES.find((x) => x.key === e.key);
      if (g) { e.preventDefault(); e.stopImmediatePropagation(); c.grade(g.grade); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const speak = (w: string) => { new Audio(`https://dict.youdao.com/dictvoice?type=0&audio=${encodeURIComponent(w)}`).play().catch(() => {}); };

  return (
    <div className="fixed inset-0 z-[70] bg-doc flex flex-col items-center [animation:fadein_0.15s]">
      <div className="w-full h-[52px] flex items-center gap-3 px-5 flex-none" data-tauri-drag-region>
        <span className="w-[72px] flex-none" />
        <b className="text-[13px] font-semibold">复习生词</b>
        {queue && <span className="text-[12px] text-t3 tabular-nums">{Math.min(pos + (card ? 1 : 0), queue.length)} / {queue.length}</span>}
        <span className="flex-1" data-tauri-drag-region />
        {last && <span className="text-[11px] text-t3 truncate max-w-[40%]">{last}</span>}
        <button className="btn" title="Esc" onClick={() => onClose(done)}>结束</button>
      </div>
      <div className="h-[2px] w-full bg-surface2 flex-none">
        <div className="h-full bg-accent transition-[width] duration-200" style={{ width: queue?.length ? `${(pos / queue.length) * 100}%` : "0%" }} />
      </div>

      <div className="flex-1 min-h-0 w-full overflow-y-auto flex flex-col items-center justify-center px-6 py-8">
        {err && <p className="text-danger text-[13px]">{err}</p>}
        {!queue && !err && <p className="text-t3 text-[13px]">加载中…</p>}
        {finished && (
          <div className="flex flex-col items-center gap-3 text-center">
            <b className="text-[20px] font-semibold">{done ? "今天的复习完成了" : "现在没有要复习的词"}</b>
            <p className="m-0 text-[13px] text-t2 max-w-[360px] leading-[1.7]">
              {done ? `本次复习了 ${done} 张卡片。` : "新收藏的词第二天开始出现,每天最多引入 20 个新词;记得越牢,间隔越长。"}
            </p>
            <button className="btn primary mt-2" onClick={() => onClose(done)}>返回</button>
          </div>
        )}
        {card && (
          <div className="w-full max-w-[560px] flex flex-col items-center gap-5">
            <div className="flex items-baseline gap-3">
              <b className="text-[34px] font-semibold tracking-tight selectable">{card.lemma}</b>
              {card.is_new && <span className="text-[11px] text-accenttx">新词</span>}
            </div>
            <div className="flex items-center gap-2 h-5">
              {shown && card.phonetic && <span className="text-[13px] text-t3">/{card.phonetic}/</span>}
              <button className="border-none bg-transparent text-[12px] text-t3 hover:text-t1" onClick={() => speak(card.lemma)}>发音</button>
            </div>
            {card.examples.length > 0 && (
              <div className="w-full flex flex-col gap-2">
                {card.examples.map((ex, i) => (
                  <p key={i} className="m-0 text-[14px] leading-[1.7] italic text-t2 pl-3 border-l-2 border-line selectable">
                    “{(shown ? ex : mask(ex, card.lemma)).slice(0, 260)}{ex.length > 260 ? "…" : ""}”
                  </p>
                ))}
              </div>
            )}
            {shown ? (
              <p className="m-0 w-full text-[15px] leading-[1.7] text-t1 bg-surface2 rounded-xl px-4 py-3 selectable">{card.definition || "(无释义)"}</p>
            ) : (
              <button className="btn primary !h-9 !px-5 mt-2" onClick={() => setShown(true)}>显示释义 <span className="font-normal opacity-70 ml-1">空格</span></button>
            )}
          </div>
        )}
      </div>

      <div className="h-[76px] flex-none flex items-center gap-3">
        {card && shown && GRADES.map((g) => (
          <button key={g.grade} className={"btn !h-10 !px-5 !text-[14px] " + g.cls} disabled={busy} onClick={() => grade(g.grade)}>
            {g.label} <span className="font-normal text-t3 ml-1.5">{g.key}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
