// 演示输入(快捷窗「载入演示」)+ 点词卡演示释义(词典通道 M2 接入前的占位)
export const DEMO_INPUT = `Hydration mismatch: the server-rendered HTML does not match the client's first render.

Common causes:
- components touching \`window\` or \`document\` on the server
- effects mutating the DOM during sync render
- unstable keys between two renders`;

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
