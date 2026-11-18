// v0.3 §2.7 原生观感(三窗共用):
// - 外观:Rust 用 set_theme 统一驱动 NSWindow 外观,前端只镜像 prefers-color-scheme → data-theme(不再自己决定亮暗)
// - 强调色:Rust 读 NSColor.controlAccentColor(get_accent / accent-changed),CSS AccentColor 在 WKWebView 恒蓝不用
// - 窗口状态:失焦 data-inactive(工具栏降对比度)、全屏 data-fullscreen(去掉红绿灯让位)
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------- 强调色对比度(验收 F4):任意系统强调色下,强调色文字与强调色底上的文字都 ≥ 4.5:1 ----------
type RGB = [number, number, number];
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a: RGB, b: RGB) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a: RGB, b: RGB, p: number): RGB => [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as RGB;
const parseHex = (h: string): RGB | null => {
  const m = /^#?([0-9a-f]{6})/i.exec(h.trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as RGB : null;
};
const BLACK: RGB = [0, 0, 0], WHITE: RGB = [255, 255, 255], INK: RGB = [29, 29, 31];
const NEED = 4.6; // 4.5 + 余量

/** 文字色 = 强调色混黑(浅)/ 混白(深)的最大比例,使其在文档面、材质与 14% 强调底上都达标 */
function textMix(a: RGB, toward: RGB, bgs: RGB[]): number {
  for (let p = 90; p >= 20; p -= 5) {
    const t = mix(a, toward, p / 100);
    if (bgs.every((bg) => ratio(t, bg) >= NEED && ratio(t, mix(a, bg, 0.14)) >= NEED)) return p;
  }
  return 20;
}

/** 强调色底:优先白字(底色混黑到达标);太亮的强调色(黄 / 橙)改用深色字 */
function fillOf(a: RGB): { p: number; on: string } {
  for (let p = 100; p >= 65; p -= 5) if (ratio(WHITE, mix(a, BLACK, p / 100)) >= NEED) return { p, on: "#ffffff" };
  return ratio(INK, a) >= NEED ? { p: 100, on: "#1d1d1f" } : { p: 65, on: "#ffffff" };
}

function tuneAccent(hex: string | null | undefined) {
  const r = document.documentElement.style;
  const light = parseHex(hex || "#0a7aff")!, dark = parseHex(hex || "#0a84ff")!;
  const fl = fillOf(light), fd = fillOf(dark);
  r.setProperty("--acc-tx", `${textMix(light, BLACK, [[255, 255, 255], [244, 244, 246]])}%`);
  r.setProperty("--acc-tx-d", `${textMix(dark, WHITE, [[30, 30, 30], [41, 41, 44]])}%`);
  r.setProperty("--acc-fill", `${fl.p}%`);
  r.setProperty("--acc-fill-d", `${fd.p}%`);
  r.setProperty("--on-accent-l", fl.on);
  r.setProperty("--on-accent-d", fd.on);
}

function applyAccent(hex: string | null | undefined) {
  const r = document.documentElement.style;
  if (hex) r.setProperty("--accent-sys", hex);
  else r.removeProperty("--accent-sys"); // 回落样式表 #0a7aff / #0a84ff
  tuneAccent(hex);
}

export function initNative() {
  const root = document.documentElement;
  if (IS_MAC) root.dataset.mac = "";
  // 透明窗口 + windowEffects 只在 macOS 配置(tauri.macos.conf.json);其他平台 body 用实底
  if (IS_MAC && IN_TAURI) root.dataset.native = "";

  const mq = matchMedia("(prefers-color-scheme: dark)");
  const sync = () => { root.dataset.theme = mq.matches ? "dark" : ""; };
  sync();
  mq.addEventListener("change", sync);

  tuneAccent(null);
  if (!IN_TAURI) return;
  invoke<string | null>("get_accent").then(applyAccent).catch(() => {});
  listen<string | null>("accent-changed", (e) => applyAccent(e.payload)).catch(() => {});

  try {
    const w = getCurrentWindow();
    w.onFocusChanged(({ payload }) => {
      if (payload) delete root.dataset.inactive;
      else root.dataset.inactive = "";
    }).catch(() => {});
    const fs = () => w.isFullscreen().then((f) => { if (f) root.dataset.fullscreen = ""; else delete root.dataset.fullscreen; }).catch(() => {});
    fs();
    w.onResized(fs).catch(() => {});
  } catch { /* 非 Tauri */ }
}
