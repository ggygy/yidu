// 快捷窗缩小后的悬浮图标:单击展开;按住拖动可挪位置;翻译进行中转圈,缩小期间翻译完成亮绿点
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initNative } from "../native";
import "../styles.css";

initNative();

/** 快捷窗推来的状态:busy 翻译中 / done 缩小期间刚译完(展开即清) */
type MiniState = { busy: boolean; done: boolean };

function Mini() {
  const [st, setSt] = useState<MiniState>({ busy: false, done: false });
  const down = useRef<{ x: number; y: number; dragged: boolean } | null>(null);

  useEffect(() => {
    const un = listen<MiniState>("quick-mini-state", (e) => setSt(e.payload));
    // 首次创建时快捷窗可能已在翻译:就绪后向它要一次当前状态
    un.then(() => emitTo("quick", "quick-mini-ready", null)).catch(() => {});
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);

  const expand = () => {
    setSt((s) => ({ ...s, done: false }));
    invoke("quick_expand").catch(() => {});
  };

  return (
    <div
      className="mini-icon"
      data-busy={st.busy ? "" : undefined}
      title={st.busy ? "翻译中 · 点击展开快捷翻译" : "点击展开快捷翻译(按住可拖动)"}
      onMouseDown={(e) => { if (e.button === 0) down.current = { x: e.screenX, y: e.screenY, dragged: false }; }}
      onMouseMove={(e) => {
        const d = down.current;
        if (!d || d.dragged) return;
        // 移动超过 3px 视为拖动,交给系统拖窗;否则松开算单击
        if (Math.abs(e.screenX - d.x) + Math.abs(e.screenY - d.y) > 3) {
          d.dragged = true;
          getCurrentWindow().startDragging().catch(() => {});
        }
      }}
      onMouseUp={() => {
        const d = down.current;
        down.current = null;
        if (d && !d.dragged) expand();
      }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") expand(); }}
      role="button"
      tabIndex={0}
      aria-label="展开快捷翻译"
    >
      {/* 与应用图标同款:深色底 + 三道横线,中间一道是强调色;翻译中中线来回流动 */}
      <span className="mini-bars" aria-hidden>
        <i />
        <i className="mini-bar-accent" />
        <i />
      </span>
      {st.done && !st.busy && <span className="mini-dot" />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Mini />);
