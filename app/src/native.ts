// v0.3 §2.7 原生观感(三窗共用):
// - 外观:Rust 用 set_theme 统一驱动 NSWindow 外观,前端只镜像 prefers-color-scheme → data-theme(不再自己决定亮暗)
// - 强调色:Rust 读 NSColor.controlAccentColor(get_accent / accent-changed),CSS AccentColor 在 WKWebView 恒蓝不用
// - 窗口状态:失焦 data-inactive(工具栏降对比度)、全屏 data-fullscreen(去掉红绿灯让位)
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function applyAccent(hex: string | null | undefined) {
  const r = document.documentElement.style;
  if (hex) r.setProperty("--accent-sys", hex);
  else r.removeProperty("--accent-sys"); // 回落样式表 #0a7aff / #0a84ff
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
