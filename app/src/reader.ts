// 阅读外观:v0.3 起视觉(主题 / 字体 / 强调色 / 底色)由 §2.7 原生视觉接管,只保留译文字号与行高
// 主窗/设置窗共用(localStorage 同源共享 + "reader-changed" 事件广播);M3 将改为 ⌘± 与密度三档

export type ReaderStyle = {
  size: number;  // 主窗译文字号 px(默认 17,阶梯 reading)
  lineH: number; // 主窗译文行高
};

export const RS_DEFAULT: ReaderStyle = { size: 17, lineH: 1.85 };

export function applyReaderStyle(rs: ReaderStyle) {
  const r = document.documentElement.style;
  r.setProperty("--zh-size", `${rs.size}px`);
  r.setProperty("--zh-line", String(rs.lineH));
  try { localStorage.setItem("yidu-reader", JSON.stringify(rs)); } catch { /* 隐私模式 */ }
}

// v0.3 迁移:旧版字号阶梯以 16 为默认、含主题/字体字段 → 一次性回到新默认
const RS_MIGRATED = "yidu-reader-v03b";

export function loadReaderStyle(): ReaderStyle {
  try {
    if (localStorage.getItem(RS_MIGRATED) !== "1") {
      localStorage.setItem(RS_MIGRATED, "1");
      localStorage.removeItem("yidu-reader-v03");
      return RS_DEFAULT;
    }
    const v = JSON.parse(localStorage.getItem("yidu-reader") || "{}");
    return {
      size: typeof v.size === "number" ? Math.min(24, Math.max(13, v.size)) : RS_DEFAULT.size,
      lineH: typeof v.lineH === "number" ? Math.min(2.2, Math.max(1.5, v.lineH)) : RS_DEFAULT.lineH,
    };
  } catch { return RS_DEFAULT; }
}
