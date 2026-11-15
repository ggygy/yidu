import { createRoot } from "react-dom/client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { DOC, ARTICLES, WORD_DEFS, type FakeBlock } from "./data";
import { Icon } from "./icons";
import "./styles.css";

type View = "interleave" | "split" | "zh";
type BlockState = "pending" | "streaming" | "done";

function useLocalFlag(key: string, init: boolean) {
  const [v, setV] = useState(() => (localStorage.getItem(key) === null ? init : localStorage.getItem(key) === "1"));
  return [v, (n: boolean) => { localStorage.setItem(key, n ? "1" : "0"); setV(n); }] as const;
}

function En({ text, onWord }: { text: string; onWord: (w: string, x: number, y: number) => void }) {
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
              e.stopPropagation();
              const clean = tok.replace(/[^A-Za-z-]/g, "").toLowerCase();
              if (clean.length > 1) onWord(clean, e.clientX, e.clientY);
            }}
          >
            {tok}
          </span>
        )
      ),
    [text, onWord]
  );
  return <p className="en">{parts}</p>;
}

function CodeBox({ code }: { code: string }) {
  return (
    <div className="codebox">
      <div className="badge-row">
        <span className="badge">代码块 · 不翻译</span>
        <span className="lang">Rust</span>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

// G1b 点词卡:免费词典 mock —— 已知词走「有道词典」;未知词延迟更久后「模型兜底」(演示回落链)
function VocabCard({ word, x, y, onClose, onAdd }: { word: string; x: number; y: number; onClose: () => void; onAdd: () => void }) {
  const known = !!WORD_DEFS[word];
  const d = WORD_DEFS[word];
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
    const t = setTimeout(() => setLoaded(true), known ? 380 : 900);
    return () => clearTimeout(t);
  }, [word, known]);
  const left = Math.min(x, window.innerWidth - 320);
  const top = Math.min(y + 14, window.innerHeight - 250);
  return (
    <div className="vocab-card" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
      <div className="h">
        <b>{word}</b>
        <span className="phon">/{known ? "ˈ" + word.slice(0, 3) : "??"}/</span>
        <button className="spk" title="发音(演示)" onClick={() => {}}>
          <Icon n="volume" size={14} />
        </button>
      </div>
      {!loaded ? (
        <p className="loading">查询中 ···</p>
      ) : (
        <>
          <p className="src">释义 · {known ? "有道词典(免费)" : "模型兜底"}</p>
          <p className="def">{d ? d.def : "释义(演示):免费词典未命中,由当前 Provider 生成。"}</p>
          <div className="div" />
          <p className="ex-label">原文例句 · 本文</p>
          <p className="ex">“{d ? d.example : "(例句取自点击位置所在块。)"}</p>
        </>
      )}
      <div className="ops">
        <button className="btn-accent" onClick={onAdd}>
          <Icon n="plus" size={12} /> 加入生词本
        </button>
        <button className="btn-ghost" onClick={onClose}>忽略</button>
      </div>
    </div>
  );
}

// 模拟流式翻译:块 1→2 逐块完成,块 4 停在 streaming(部分译文)
function useMockStream(restart: number) {
  const [states, setStates] = useState<BlockState[]>(DOC.blocks.map(() => "pending"));
  const [partial, setPartial] = useState("");
  useEffect(() => {
    setStates(DOC.blocks.map((b) => (b.kind === "code" ? "done" : "pending")));
    setPartial("");
    const timers: number[] = [];
    timers.push(window.setTimeout(() => setStates(["done", "pending", "done", "pending"]), 700));
    timers.push(window.setTimeout(() => setStates(["done", "done", "done", "pending"]), 1700));
    timers.push(window.setTimeout(() => setStates(["done", "done", "done", "streaming"]), 2400));
    const full = DOC.blocks[3].trans;
    let i = 0;
    const t0 = Date.now();
    const iv = window.setInterval(() => {
      if (Date.now() - t0 > 16000) { clearInterval(iv); return; } // 流到 2/3 处停住,展示 streaming 态;定时器要清,页面才静默
      i = Math.min(i + 2, Math.floor(full.length * 0.7));
      setPartial(full.slice(0, i));
    }, 60);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(iv);
    };
  }, [restart]);
  return { states, partial };
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className={"toggle" + (on ? " on" : "")} onClick={onClick} aria-pressed={on}><i /></button>;
}

function App() {
  const [view, setView] = useState<View>("interleave");
  const [restart, setRestart] = useState(0);
  const { states, partial } = useMockStream(restart);
  const [vocab, setVocab] = useState<{ word: string; x: number; y: number } | null>(null);
  const [vocabCount, setVocabCount] = useState(38);
  const [articles, setArticles] = useState(ARTICLES);
  const [toast, setToast] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [libOpen, setLibOpen] = useState(false);
  const [setOpen, setSetOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dark, setDark] = useLocalFlag("v3-dark", false);
  const [preset, setPreset] = useState("GLM");
  const fileRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number>(0);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "";
  }, [dark]);

  const say = (m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };

  // 快捷键:⌘N 新建 · ⌘K 文章库 · Esc 关层
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") { e.preventDefault(); setComposing(true); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setLibOpen((v) => !v); }
      if (e.key === "Escape") { setLibOpen(false); setSetOpen(false); setVocab(null); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const startTranslate = () => {
    if (!draft.trim()) return;
    setArticles((a) => [{ title: `粘贴 · ${draft.trim().slice(0, 18)}…`, meta: "刚刚 · 翻译中", kind: "粘贴", active: true, pinned: false }, ...a.map((x) => ({ ...x, active: false }))]);
    setComposing(false);
    setRestart((r) => r + 1);
    say("已开始翻译(演示:罐头流式)");
  };

  // 快捷窗「存入文章库」事件
  useEffect(() => {
    const un = listen<{ title: string }>("open-in-main", (e) => {
      setArticles((a) => [{ title: e.payload.title, meta: "刚刚 · 粘贴", kind: "粘贴", active: true, pinned: true }, ...a.map((x) => ({ ...x, active: false }))]);
      say("已加入文章库(演示:自动保存)");
    });
    return () => { un.then((f) => f()); };
  }, []);

  const word = (w: string, x: number, y: number) => setVocab({ word: w, x, y });
  const doneCount = states.filter((s) => s === "done").length + (states[3] === "streaming" ? 1 : 0);
  const progress = Math.round((doneCount / DOC.blocks.length) * 100);
  const filtered = articles.filter((a) => a.title.toLowerCase().includes(query.toLowerCase()));

  const pairInner = (b: FakeBlock, i: number, showEn: boolean) => (
    <>
      {showEn && <En text={b.src} onWord={word} />}
      {b.kind === "code" ? null : (
        <p className={"zh" + (states[i] === "streaming" ? " streaming" : "")}>
          {states[i] === "pending" ? "…" : states[i] === "streaming" ? partial : b.trans}
        </p>
      )}
    </>
  );

  return (
    <div className="app" onClick={() => setVocab(null)}>
      <div className="hairline"><i style={{ width: `${progress}%` }} /></div>

      {/* 顶栏 */}
      <header className="top">
        <button className="lib-btn" onClick={() => setLibOpen(true)}>
          <Icon n="library" /> 文章库 <kbd>⌘K</kbd>
        </button>
        <span className="sp" />
        <span className="doc-name">{DOC.title}</span>
        <span className="sp" />
        <button className="icon-btn" title="设置" onClick={() => setSetOpen(true)}><Icon n="sliders" /></button>
      </header>

      {/* 正文 */}
      <div className="content">
        <div className="col">
          <div className="doc-head">
            <h1>{DOC.title}</h1>
            <div className="meta">{DOC.meta.map((m) => <span key={m}>{m}</span>)}</div>
          </div>

          {view === "interleave" && DOC.blocks.map((b, i) =>
            b.kind === "code" ? (
              <CodeBox key={b.id} code={b.src} />
            ) : (
              <div key={b.id} className={"pair" + (b.term ? " term-row" : "")}>
                {pairInner(b, i, true)}
                {b.term && (
                  <div className="term-chip-row">
                    <span className="chip label">术语库</span>
                    <span className="chip term">{b.term.from} → {b.term.to}</span>
                  </div>
                )}
                {states[i] === "streaming" && (
                  <div className="shimmer"><div className="track"><i /></div><span>翻译中 · 流式上屏</span></div>
                )}
              </div>
            )
          )}

          {view === "split" && (
            <>
              <div className="split-head"><span>原文 · EN</span><span>译文 · ZH</span></div>
              {DOC.blocks.map((b, i) =>
                b.kind === "code" ? (
                  <div key={b.id} style={{ padding: "14px 0" }}><CodeBox code={b.src} /></div>
                ) : (
                  <div key={b.id} className="split-row">
                    <div className="cell-l"><En text={b.src} onWord={word} /></div>
                    <div className="cell-r">
                      {pairInner(b, i, false)}
                      {states[i] === "streaming" && <div className="shimmer"><div className="track"><i /></div><span>翻译中</span></div>}
                    </div>
                  </div>
                )
              )}
            </>
          )}

          {view === "zh" && DOC.blocks.map((b, i) =>
            b.kind === "code" ? (
              <CodeBox key={b.id} code={b.src} />
            ) : (
              <div key={b.id} className="pair">
                {pairInner(b, i, false)}
                <button className="orig-toggle" onClick={() => setExpanded((s) => new Set(s).add(b.id))}>
                  {expanded.has(b.id) ? "⌃ 收起原文" : "⌄ 原文"}
                </button>
                {expanded.has(b.id) && <En text={b.src} onWord={word} />}
              </div>
            )
          )}
        </div>
      </div>

      {/* 底部悬浮胶囊 */}
      <div className="capsule">
        <div className="cap-seg">
          <button title="双语对照" className={view === "interleave" ? "on" : ""} onClick={() => setView("interleave")}><Icon n="rows" size={17} /></button>
          <button title="分栏" className={view === "split" ? "on" : ""} onClick={() => setView("split")}><Icon n="cols" size={17} /></button>
          <button title="纯译文" className={view === "zh" ? "on" : ""} onClick={() => setView("zh")}><Icon n="lines" size={17} /></button>
        </div>
        <i className="cap-sep" />
        <button className="stat-btn" onClick={() => say("术语库 · 全局一张表(占位)")}>
          <Icon n="tag" size={15} /><span>术语</span><b>12</b>
        </button>
        <button className="stat-btn" onClick={() => say(`生词本 ${vocabCount} 词 · P1 复习入口(占位)`)}>
          <Icon n="bookmark" size={15} /><span>生词</span><b>{vocabCount}</b>
        </button>
        <i className="cap-sep" />
        <button className="provider-chip" onClick={() => { setSetOpen(true); }}>
          <i className="dot" />GLM-4-flash<Icon n="chev" size={12} />
        </button>
        <button className="cap-icon" title="重新翻译" onClick={() => { setRestart((r) => r + 1); say("重新翻译(演示)"); }}>
          <Icon n="refresh" size={15} />
        </button>
      </div>
      <div className="capsule-hint">点英文单词收藏 · ⌘N 新建翻译</div>

      {/* G2 库滑出层 */}
      {libOpen && (
        <>
          <div className="scrim" onClick={() => setLibOpen(false)} />
          <aside className="lib-panel" onClick={(e) => e.stopPropagation()}>
            <div className="lib-head">
              <b>文章库</b><span className="count">{articles.length}</span>
              <span className="sp" />
              <button className="lib-new" onClick={() => { setLibOpen(false); setComposing(true); }}>
                <Icon n="plus" size={13} /> 新建
              </button>
            </div>
            <div className="lib-search">
              <Icon n="search" size={14} />
              <input placeholder="搜索标题…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="lib-list">
              {filtered.map((a) => (
                <div key={a.title} className={"lib-item" + (a.active ? " active" : "")} onClick={() => { setLibOpen(false); }}>
                  <div className="meta"><span>{a.kind}</span><span>{a.meta}</span>{a.pinned && <span>置顶</span>}</div>
                  <div className="t">{a.title}</div>
                </div>
              ))}
              {filtered.length === 0 && <div style={{ padding: 8, color: "var(--t3)", fontSize: 11 }}>无匹配</div>}
            </div>
            <div className="lib-bottom">
              <button className="lib-entry" onClick={() => say("术语库 12 条(占位)")}><Icon n="tag" size={15} /> 术语库 <b>12</b></button>
              <button className="lib-entry" onClick={() => say("生词本(占位)")}><Icon n="bookmark" size={15} /> 生词本 <b>{vocabCount}</b></button>
            </div>
          </aside>
        </>
      )}

      {/* G3 全屏新建 */}
      {composing && (
        <div className="composer">
          <div className="comp-top">
            <button className="comp-cancel" onClick={() => setComposing(false)}><Icon n="x" size={14} /> 取消</button>
            <span className="comp-title">新建翻译</span>
            <span style={{ width: 64 }} />
          </div>
          <div className="comp-write">
            <div className="comp-panel">
              <textarea
                autoFocus
                value={draft}
                placeholder="粘贴要翻译的文本…(支持 markdown)"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startTranslate(); }}
                onDrop={async (e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) setDraft(await f.text());
                }}
                onDragOver={(e) => e.preventDefault()}
              />
              <div className="comp-drop" onClick={() => fileRef.current?.click()}>
                <Icon n="import" size={15} /> 拖入 .md / .txt 文件,或点击选择
              </div>
            </div>
          </div>
          <div className="comp-capsule">
            <span className="comp-count">{draft.length} 字</span>
            <button className="dir-chip" onClick={() => say("EN → 中(演示,方向可切)")}>
              <Icon n="swap" size={13} /> EN → 中
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn-ghost" onClick={() => fileRef.current?.click()}>
              <Icon n="import" size={13} /> 导入 .md
            </button>
            <button className="btn-accent" disabled={!draft.trim()} onClick={startTranslate}>
              <Icon n="sparkles" size={13} /> 翻译 <kbd style={{ background: "rgba(255,255,255,.18)", color: "#fff", borderColor: "transparent" }}>⌘↩</kbd>
            </button>
          </div>
        </div>
      )}

      {/* S 设置滑出层 */}
      {setOpen && (
        <>
          <div className="scrim" onClick={() => setSetOpen(false)} />
          <aside className="set-panel" onClick={(e) => e.stopPropagation()}>
            <div className="set-head">
              <b>设置</b>
              <button className="icon-btn" onClick={() => setSetOpen(false)}><Icon n="x" size={15} /></button>
            </div>
            <div className="set-div" />

            <div className="set-sec">
              <span className="set-label">PROVIDER</span>
              <div className="preset-row">
                {(["DeepSeek", "GLM", "OpenAI"] as const).map((p) => (
                  <button key={p} className={"preset" + (preset === p ? " on" : "")} onClick={() => { setPreset(p); say(`已切换 ${p}(演示)`); }}>{p}</button>
                ))}
                <button className={"preset" + (preset === "Ollama" ? " on" : "")} onClick={() => { setPreset("Ollama"); say("Ollama 本地 · llama3.1(演示)"); }}>
                  <i className="dot" />Ollama
                </button>
              </div>
              <div className="set-rows">
                <div className="set-row"><span className="name">Base URL</span><span className="val">open.bigmodel.cn/api/paas/v4</span></div>
                <div className="set-row"><span className="name">API Key</span><span className="val">•••••••••••·<button className="q-link" style={{ color: "var(--t2)" }} onClick={() => say("连通测试 ✓ 412 ms(演示)")}>测试</button><span className="test-ok">✓ 412 ms</span></span></div>
                <div className="set-row"><span className="name">模型</span><span className="val">glm-4-flash<Icon n="chev" size={12} /></span></div>
              </div>
            </div>

            <div className="set-sec">
              <span className="set-label">翻译</span>
              <div className="set-rows">
                <div className="set-row"><span className="name">默认方向</span><span className="val"><span className="plain">EN → 中</span><Icon n="swap" size={12} /></span></div>
                <div className="set-row"><span className="name">单词查词</span><span className="val"><span className="plain">免费词典 → 模型兜底</span><Icon n="chev" size={12} /></span></div>
                <div className="set-row"><span className="name">术语库注入</span><Toggle on={true} onClick={() => say("术语注入:开(演示)")} /></div>
                <div className="set-row"><span className="name">思考模式</span><Toggle on={false} onClick={() => say("思考模式:默认关(演示)")} /></div>
              </div>
            </div>

            <div className="set-sec">
              <span className="set-label">快捷键与浮窗</span>
              <div className="set-rows">
                <div className="set-row"><span className="name">呼出快捷窗</span><span className="val"><kbd>⌥</kbd><kbd>T</kbd></span></div>
                <div className="set-row"><span className="name">重启后显示快捷窗</span><Toggle on={false} onClick={() => say("默认不显示(演示)")} /></div>
                <div className="set-row"><span className="name">置顶(pin)默认</span><Toggle on={true} onClick={() => say("pin 默认开(演示)")} /></div>
                <div className="set-row"><span className="name">失焦自动隐藏</span><Toggle on={false} onClick={() => say("默认关 · 与 pin 互斥(演示)")} /></div>
              </div>
            </div>

            <div className="set-sec">
              <span className="set-label">外观与用量</span>
              <div className="set-rows">
                <div className="set-row"><span className="name">深色外观</span><Toggle on={dark} onClick={() => setDark(!dark)} /></div>
                <div className="set-row"><span className="name">本月用量</span><span className="val">1.24M tokens<span className="plain" style={{ fontWeight: 600 }}>≈ ¥1.86</span></span></div>
              </div>
            </div>

            <span style={{ flex: 1 }} />
            <span className="set-foot">v0.1 · 数据全部本地存储 · ⌘K 打开文章库</span>
          </aside>
        </>
      )}

      {vocab && (
        <VocabCard
          word={vocab.word}
          x={vocab.x}
          y={vocab.y}
          onClose={() => setVocab(null)}
          onAdd={() => { setVocabCount((c) => c + 1); say(`「${vocab.word}」已加入生词本(例句已关联本文)`); setVocab(null); }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.txt"
        style={{ display: "none" }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setDraft(await f.text());
          setComposing(true);
          e.target.value = "";
        }}
      />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
