// 原型假数据 —— 一次性,验证交互用
export type BlockKind = "p" | "code" | "list";
export interface FakeBlock {
  id: number;
  kind: BlockKind;
  src: string;
  trans: string;
  term?: { from: string; to: string };
}

export const DOC = {
  title: "Tauri 2.0: Architecture Deep Dive",
  meta: ["md 文件 · 3,412 字", "31 块 · 24 已译", "术语命中 3", "今天"],
  blocks: [
    {
      id: 1,
      kind: "p",
      src: "Tauri is a framework for building fast, lightweight desktop applications with a Rust backend and a web frontend. Unlike Electron, it does not bundle a full Chromium runtime — instead it relies on the platform's native webview.",
      trans: "Tauri 是一个构建轻量、快速桌面应用的框架:后端用 Rust,前端用 Web 技术。与 Electron 不同,它并不打包完整的 Chromium 运行时,而是复用操作系统原生 webview。",
    },
    {
      id: 2,
      kind: "p",
      src: "During development the frontend talks to the Rust core over a custom IPC protocol. Streaming responses arrive through a channel, and hydration of the webview is deferred so that startup stays instant.",
      trans: "开发阶段,前端通过自定义 IPC 协议与 Rust 内核通信。流式响应经由 channel 到达;webview 的水合(hydration)被推迟执行,以保证启动瞬时完成。",
      term: { from: "hydration", to: "水合" },
    },
    {
      id: 3,
      kind: "code",
      src: `#[tauri::command]
async fn translate(text: String) -> Result<Vec<Block>, String> {
    let blocks = parse_markdown(&text);
    // 代码块不进入翻译请求,原样保留
    translate_blocks(&blocks).await
}`,
    },
    {
      id: 4,
      kind: "p",
      src: "The bundle size of a typical Tauri app is a few megabytes, and memory usage stays far below equivalent Electron apps — a good fit for tools that live quietly in the menu bar.",
      trans: "Tauri 应用的包体通常只有几 MB,内存占用也远低于同等的 Electron 应用,因此很适合安静常驻在菜单栏里的小工具。",
    },
  ] as FakeBlock[],
};

export const ARTICLES = [
  { title: "Tauri 2.0: Architecture Deep Dive", meta: "今天 · 24/31 块", kind: "MD", active: true, pinned: true },
  { title: "The Rust Async Book · Ch.3 Executors", meta: "11-10 · 已译完", kind: "MD", pinned: false },
  { title: "粘贴 · RSC 报错分析", meta: "11-09 · 12 块", kind: "粘贴", pinned: false },
  { title: "SQLite WAL Mode Explained", meta: "11-08 · 已译完", kind: "MD", pinned: false },
  { title: "粘贴 · k8s affinity 笔记", meta: "11-07 · 8 块", kind: "粘贴", pinned: false },
];

// 点词弹卡的假释义
export const WORD_DEFS: Record<string, { def: string; example: string }> = {
  streaming: {
    def: "n. 流式传输;流式处理 — 数据边到达边处理,无需等待整体完成",
    example: "Streaming responses arrive through a channel, and hydration of the webview is deferred…",
  },
  hydration: {
    def: "n. 水合;水合作用(Web 前端语境:服务端 HTML 与客户端 JS 状态的结合过程)",
    example: "…hydration of the webview is deferred so that startup stays instant.",
  },
  webview: {
    def: "n. 网页视图;内嵌浏览器引擎组件",
    example: "…it relies on the platform's native webview.",
  },
  bundle: {
    def: "v./n. 打包;应用安装包",
    example: "The bundle size of a typical Tauri app is a few megabytes…",
  },
};

// 快捷窗演示:输入 → 罐头译文(逐字流出)
export const DEMO_INPUT = `Hydration mismatch: the server-rendered HTML does not match the client's first render.

Common causes:
- components touching \`window\` or \`document\` on the server
- effects mutating the DOM during sync render
- unstable keys between two renders`;

export const DEMO_TRANS = `**水合(hydration)失败**:服务端渲染出的 HTML 与客户端首次渲染的结果不一致。

常见原因:
- 组件在服务端访问了 \`window\` 或 \`document\`
- effect 在同步渲染期间修改了 DOM
- 两次渲染之间的 key 不稳定`;
