# 05: 前端框架与渲染方案定案

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

基于工单 01、02 的调研结论,与用户 grilling 定案:前端框架、markdown 渲染库、解析位置(前端/Rust)、块对齐的内存表示。定案后更新 CONTEXT.md 若有新术语。

## Answer

经两轮 grilling(第二轮伴随 Pencil 视觉稿)用户全部确认:

1. **前端框架**:React 19 + react-markdown@10(remark 底座 + remark-gfm)。快捷窗与主窗口是两个 Tauri window,共享同一前端栈与块行组件。
2. **解析位置**:Rust 侧 pulldown-cmark `into_offset_iter()` 切块,保真原文切片入 SQLite;前端拿到已切好的块,逐块渲染。
3. **块表示**:`{id, idx, kind, src, hash, trans, status}` 内联双语;`hash` 为规范化哈希(`*`↔`_`、软换行重排、引用链接展开归一后再算),文章更新/重译时据此再对齐、跳过未变块。
4. **产品形态修正(重要)**:快捷翻译浮窗进 P0 成为产品主体(全局快捷键、pin 置顶、菜单栏 tray、粘贴即译、剪贴板预填即"假划词"、md 渲染、存入文章库);主窗口(文章库+三视图阅读)保 P0 但实现排序靠后。快捷窗默认纯译文、可切上下对照,不做点词(保持轻);真·划词维持 P1;暗色模式 P1。
5. **视觉稿**:`visual/reader-ui.pen` 四屏(A 双语对照 / B 分栏 / C 纯译文折叠 / D 快捷浮窗)+ `visual/exports/*.png`,作为 UI 定稿视觉参考。

地图 Notes 中的 P0/P1/P2 分期已同步修订;工单 09(原型)范围已更新(含快捷窗与窗口行为)。
