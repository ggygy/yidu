// 阅读排版(v0.3 §2.5.6):字号 = 基准 × 缩放(⌘+ / ⌘− / ⌘0,0.8–1.5,快捷窗与主窗各自记忆,存 prefs)
// + 密度三档(紧凑 / 标准 / 宽松)。主题 / 字体 / 底色 / 强调色已由原生视觉(§2.7)接管。
import type { Prefs } from "./types";

export type Density = Prefs["density"];
export type ScaleKind = "quick" | "main";

// 基准字号(research/12 字号阶梯):快捷窗译文 15、主窗译文 17、对照原文 14.5
const BASE = { quick: { zh: 15, en: 13.5 }, main: { zh: 17, en: 14.5 } };
const DENSITY: Record<Density, { line: number; enLine: number; gap: number }> = {
  compact: { line: 1.6, enLine: 1.55, gap: 0.65 },
  standard: { line: 1.8, enLine: 1.7, gap: 1 },
  loose: { line: 2.0, enLine: 1.85, gap: 1.4 },
};

export const SCALE_MIN = 0.8;
const MIN_PX = 11;
export const SCALE_MAX = 1.5;

export function stepScale(cur: number, dir: "zoom-in" | "zoom-out" | "zoom-reset"): number {
  if (dir === "zoom-reset") return 1;
  const next = Math.round((cur + (dir === "zoom-in" ? 0.1 : -0.1)) * 10) / 10;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
}

/** 把字号 / 行高 / 块距写到 CSS 变量(--zh-size / --zh-line / --en-size / --en-line / --pair-gap) */
export function applyReading(kind: ScaleKind, scale: number, density: Density) {
  const r = document.documentElement.style;
  const d = DENSITY[density] ?? DENSITY.standard;
  const b = BASE[kind];
  // 验收 F3:缩到最小也不低于 11px(md 内行内码 / 表格另用 max(11px, …em) 兜底)
  r.setProperty("--zh-size", `${Math.max(MIN_PX, b.zh * scale).toFixed(1)}px`);
  r.setProperty("--en-size", `${Math.max(MIN_PX, b.en * scale).toFixed(1)}px`);
  r.setProperty("--zh-line", String(d.line));
  r.setProperty("--en-line", String(d.enLine));
  r.setProperty("--pair-gap", `${Math.round((kind === "main" ? 24 : 12) * d.gap * Math.max(1, scale))}px`);
}
