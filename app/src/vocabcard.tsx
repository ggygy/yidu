// 查词卡(主窗点词 / 快捷窗划到单词):有道 → dictapi → 模型兜底;命中本地缓存即时返回
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import * as api from "./api";
import type { DictCard } from "./types";

const SOURCE_LABEL: Record<string, string> = {
  youdao: "有道词典(免费)",
  dictapi: "dictionaryapi.dev(免费)",
  model: "模型兜底",
  miss: "未收录",
};

// 点词卡:有道 → dictapi → 模型兜底;命中本地缓存即时返回
/** inline:不做浮层定位,铺在所在容器里(快捷窗划到单词时用) */
export function VocabCard({ word, x = 0, y = 0, sentence, articleId, onClose, onAdded, inline }: {
  word: string; x?: number; y?: number; sentence?: string; articleId?: number; onClose: () => void; onAdded: (n: number) => void; inline?: boolean;
}) {
  const [card, setCard] = useState<DictCard | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setCard(null);
    setErr(null);
    api.lookupWord(word).then(setCard).catch((e) => setErr(String(e)));
  }, [word]);

  const speak = () => {
    const url = card?.audio || `https://dict.youdao.com/dictvoice?type=0&audio=${encodeURIComponent(word)}`;
    new Audio(url).play().catch(() => {});
  };

  const add = async () => {
    const def = card?.senses.map((s) => `${s.pos ? s.pos + ". " : ""}${s.gloss}`).join("; ") || card?.web_trans.join(";") || "(无释义)";
    try {
      await api.vocabAdd({
        word,
        phonetic: card?.phonetic_us || "",
        definition: def.slice(0, 500),
        source: card?.source === "miss" ? "manual" : card?.source || "manual",
        sentence,
        article_id: articleId ?? null,
      });
      onAdded(1);
      onClose();
    } catch (e) { setErr(String(e)); }
  };

  const left = Math.min(x, window.innerWidth - 320);
  const top = Math.min(y + 14, window.innerHeight - 300);
  return (
    <div
      className={inline ? "selectable w-full bg-surface rounded-xl shadow-[0_0_0_0.5px_var(--border)] p-3.5" : "selectable fixed w-[300px] bg-surface rounded-xl shadow-[var(--shadow-card)] p-3.5 z-[60]"}
      style={inline ? undefined : { left: Math.max(8, left), top: Math.max(8, top) }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <b className="text-[15px] font-semibold">{word}</b>
        <span className="text-[11px] text-t3">{card?.phonetic_us ? `/${card.phonetic_us}/` : card?.phonetic_uk ? `/${card.phonetic_uk}/` : ""}</span>
        <button title="发音" onClick={speak} className="tbtn ml-auto"><Icon n="volume" size={14} /></button>
      </div>
      {!card && !err && <p className="text-[12px] text-t3 mt-2 mb-0">查询中…</p>}
      {err && <p className="text-[12px] text-t3 mt-2 mb-0">{err}</p>}
      {card && (
        <>
          <p className="text-[11px] text-t3 mt-2 mb-0">释义 · {SOURCE_LABEL[card.source] ?? card.source}{card.source === "miss" ? " · 可手动加入生词本" : ""}</p>
          {card.senses.length > 0 && (
            <p className="text-[13px] leading-[1.6] text-t2 mt-0.5 mb-0">
              {card.senses.slice(0, 5).map((s, i) => <span key={i}>{s.pos && <b className="text-t3 font-medium">{s.pos}. </b>}{s.gloss}<br /></span>)}
            </p>
          )}
          {card.web_trans.length > 0 && <p className="text-[13px] leading-[1.6] text-t2 mt-0.5 mb-0">网络释义:{card.web_trans.slice(0, 3).join(";")}</p>}
          {card.examples.length > 0 && (
            <>
              <div className="h-px bg-line my-2.5" />
              <p className="text-[11px] text-t3 m-0">词典例句</p>
              {card.examples.slice(0, 2).map((ex, i) => (
                <p key={i} className="text-[12px] italic text-t2 leading-[1.6] mt-1 mb-0">“{ex.en}”{ex.zh ? <span className="text-t3">{ex.zh}</span> : null}</p>
              ))}
            </>
          )}
          {sentence && (
            <>
              <div className="h-px bg-line my-2.5" />
              <p className="text-[11px] text-t3 m-0">本文例句</p>
              <p className="text-[12px] italic text-t2 leading-[1.6] mt-1 mb-0">“{sentence.slice(0, 220)}{sentence.length > 220 ? "…" : ""}”</p>
            </>
          )}
        </>
      )}
      <div className="flex gap-2 mt-3 justify-end">
        <button className="btn" onClick={onClose}>{inline ? "关闭" : "忽略"}</button>
        <button className="btn primary" onClick={add}>加入生词本</button>
      </div>
    </div>
  );
}
