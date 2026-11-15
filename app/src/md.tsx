// 共享 markdown 渲染(react-markdown + remark-gfm)+ 点词交互(工单 01:组件树注入)
// + 术语译后高亮(工单 06 可视化:命中词下划线标记,点击弹卡)
import React, { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type WordHandler = (w: string, x: number, y: number) => void;
export type TermHit = { from: string; to: string };
export type TermHandler = (t: TermHit, x: number, y: number) => void;

// 纯文本切词:英文词加 span.w 可点(沿用原型交互)
function WordText({ text, onWord }: { text: string; onWord?: WordHandler }) {
  const parts = useMemo(
    () =>
      text.split(/(\s+)/).map((tok, i) =>
        /^\s+$/.test(tok) ? (
          <span key={i}>{tok}</span>
        ) : (
          <span
            key={i}
            className="w"
            onClick={(e) => {
              if (!onWord) return;
              e.stopPropagation();
              const clean = tok.replace(/[^A-Za-z-]/g, "").toLowerCase();
              if (clean.length > 1) onWord(clean, e.clientX, e.clientY);
            }}
          >
            {tok}
          </span>
        ),
      ),
    [text, onWord],
  );
  return <>{parts}</>;
}

// 术语高亮:按命中术语的 target 词切文本,命中片段包 span.tm
function TermText({ text, hits, onTerm }: { text: string; hits: TermHit[]; onTerm?: TermHandler }) {
  const parts = useMemo(() => {
    const targets = [...new Set(hits.map((h) => h.to))].filter(Boolean);
    if (!targets.length) return [text];
    const re = new RegExp(`(${targets.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
    return text.split(re);
  }, [text, hits]);
  if (!onTerm || parts.length <= 1) return <>{text}</>;
  return (
    <>
      {parts.map((seg, i) => {
        const hit = hits.find((h) => h.to === seg);
        if (!hit) return <span key={i}>{seg}</span>;
        return (
          <span key={i} className="tm" onClick={(e) => { e.stopPropagation(); onTerm(hit, e.clientX, e.clientY); }}>
            {seg}
          </span>
        );
      })}
    </>
  );
}

// 把 p/li/td 等文本节点替换为可点词版本;有术语命中时叠加术语高亮
function clickableComponents(onWord?: WordHandler, termHits?: TermHit[], onTerm?: TermHandler) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (tag: string) => function Clickable(props: any) {
    const { children, node: _node, ...rest } = props;
    const mapped = React.Children.map(children, (c: React.ReactNode, i: number) => {
      if (typeof c !== "string") return c;
      if (termHits?.length && onTerm) return <TermText key={i} text={c} hits={termHits} onTerm={onTerm} />;
      return <WordText key={i} text={c} onWord={onWord} />;
    });
    return React.createElement(tag, rest as never, ...(mapped ?? []));
  };
  return {
    p: wrap("p"),
    li: wrap("li"),
    td: wrap("td"),
    th: wrap("th"),
  };
}

// 代码块展示:src 是 markdown 原文(含围栏),剥出正文与语言;右上复制按钮
export function CodeBox({ src }: { src: string }) {
  const [copied, setCopied] = useState(false);
  const lines = src.split("\n");
  const first = lines[0] ?? "";
  const fenced = first.startsWith("```") || first.startsWith("~~~");
  const lang = fenced ? first.replace(/^[`~]+/, "").trim() || "code" : "text";
  const body = fenced
    ? lines.slice(1, lines.at(-1)?.trim().startsWith("```") || lines.at(-1)?.trim().startsWith("~~~") ? -1 : undefined).join("\n")
    : src;
  const copy = async () => {
    try { await navigator.clipboard.writeText(body); setCopied(true); window.setTimeout(() => setCopied(false), 1200); } catch {}
  };
  return (
    <div className="codebox">
      <div className="badge-row">
        <span className="badge">代码块 · 不翻译</span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="lang">{lang}</span>
          <button className="copy-btn" onClick={copy}>{copied ? "✓ 已复制" : "复制"}</button>
        </span>
      </div>
      <pre>{body}</pre>
    </div>
  );
}

// 通用 markdown 块渲染:onWord 存在时原文可点词;termHits+onTerm 存在时译文术语高亮
export function Md({ text, onWord, termHits, onTerm }: { text: string; onWord?: WordHandler; termHits?: TermHit[]; onTerm?: TermHandler }) {
  return <Markdown remarkPlugins={[remarkGfm]} components={clickableComponents(onWord, termHits, onTerm)}>{text}</Markdown>;
}
