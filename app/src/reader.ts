// 阅读外观:主窗/快捷窗共用(localStorage 同源共享 + "reader-changed" 事件广播)

export type ReaderTheme = "default" | "sepia" | "oled" | "custom";
export type ReaderFont = "serif" | "sans" | "kai" | "mono";
export type ReaderStyle = {
  theme: ReaderTheme;
  customBg: string; // theme=custom 时的阅读区背景色
  font: ReaderFont;
  size: number;   // 译文字号 px
  lineH: number;  // 译文行高
  gap: number;    // 块间距 px
  width: number;  // 内容宽度 px
  accent: string; // "" = 跟随主题默认
};

export const RS_FONTS: Record<ReaderFont, string> = {
  serif: '"Source Serif 4", Georgia, "Noto Serif SC", "Songti SC", serif',
  sans: '-apple-system, "Inter", "Noto Sans SC", "PingFang SC", sans-serif',
  kai: '"Kaiti SC", "STKaiti", "Kaiti", serif',
  mono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
};
export const RS_ACCENTS = ["", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899"];
export const RS_DEFAULT: ReaderStyle = { theme: "default", customBg: "#f5f0e6", font: "serif", size: 16, lineH: 1.8, gap: 10, width: 720, accent: "" };

// 十六进制亮度(0~1),custom 深底自动配浅字
function hexLuminance(hex: string): number {
  const m = hex.replace("#", "");
  if (m.length < 6) return 1;
  const r = parseInt(m.slice(0, 2), 16) / 255, g = parseInt(m.slice(2, 4), 16) / 255, b = parseInt(m.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function applyReaderStyle(rs: ReaderStyle) {
  const r = document.documentElement.style;
  r.setProperty("--zh-size", `${rs.size}px`);
  r.setProperty("--zh-line", String(rs.lineH));
  r.setProperty("--zh-font", RS_FONTS[rs.font]);
  r.setProperty("--reader-gap", `${rs.gap}px`);
  r.setProperty("--reader-w", `${rs.width}px`);
  if (rs.accent) r.setProperty("--accent", rs.accent); else r.removeProperty("--accent");
  r.removeProperty("--reader-bg"); r.removeProperty("--reader-t1");
  if (rs.theme === "sepia") { r.setProperty("--reader-bg", "#f3ecd9"); r.setProperty("--reader-t1", "#3b3226"); }
  else if (rs.theme === "oled") { r.setProperty("--reader-bg", "#000000"); r.setProperty("--reader-t1", "#e8e8ea"); }
  else if (rs.theme === "custom") {
    r.setProperty("--reader-bg", rs.customBg);
    if (hexLuminance(rs.customBg) < 0.35) r.setProperty("--reader-t1", "#e8e8ea");
  }
  localStorage.setItem("yidu-reader", JSON.stringify(rs));
}

export function loadReaderStyle(): ReaderStyle {
  try { return { ...RS_DEFAULT, ...JSON.parse(localStorage.getItem("yidu-reader") || "{}") }; } catch { return RS_DEFAULT; }
}
