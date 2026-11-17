# 13: 原生观感的 Tauri 实现路径调研

Type: research (AFK)
Status: resolved
Blocked by: 12

## Question

工单 12 定了 macOS 原生视觉语言。在 Tauri 2 + WKWebView 下如何落地、代价多大:NSVisualEffectView 材质(`macOSPrivateApi` + 透明窗口 + `window-vibrancy` crate,对快捷窗/主窗/设置窗分别的可行性与副作用,如圆角、阴影、拖动、性能);CSS `AccentColor` 与 `prefers-color-scheme` 在 WKWebView 中的支持与实时跟随;统一工具栏与红绿灯位置(`titleBarStyle: Overlay`、`trafficLightPosition`);设置改独立窗口与原生菜单栏快捷键(⌘, / ⌘K / ⌘I)的接线方式。给出每项的推荐做法与已知坑。

## Answer

详见 [../research/13-native-look.md](../research/13-native-look.md)。结论:

- **材质**:用 Tauri 内置 `windowEffects`(内部就是 window-vibrancy 0.8.1),不直接引 crate;tauri 2.12.1+ 透明不再需要 `macOSPrivateApi`(已核 CHANGELOG),所以没有私有 API / App Store 顾虑。main/settings 用 `sidebar`(跟随激活态),quick 用 `popover` + `active`(不用 `hudWindow`,它恒为深色)。`html/body` 透明,工具栏/侧栏/检查器透明透出材质,文档区涂实底;CSS backdrop-filter 只能模糊页面内内容。透明和效果放进 `tauri.macos.conf.json`,避免 Windows 包露出透明底。圆角和阴影交给系统(不设 radius),性能代价低。
- **强调色**:CSS `AccentColor` / `-apple-system-control-accent` 在第三方 WKWebView 里有「总是蓝色」的 WebKit bug 记录 → 不依赖。改为 Rust objc2 读 `NSColor.controlAccentColor`(转 sRGB),在窗口获得焦点(或 `NSSystemColorsDidChangeNotification`)时 emit `accent-changed`,前端写入 `--accent`,失败回落 `#0a7aff` / `#0a84ff`。
- **亮暗**:改成三态偏好 system/light/dark,由 Rust 权威调用 `set_theme(None|Some)`(会同时改变 NSWindow 外观、材质、红绿灯和 `prefers-color-scheme`);前端只用 matchMedia 镜像 `data-theme`,可以删掉 localStorage `v3-dark` 和 `theme-changed`。⌘L 在浅/深之间切,「跟随系统」通过菜单/设置恢复。
- **工具栏**:2.12.5 支持 `trafficLightPosition`(需 Overlay + decorations,只能创建时设置)。52pt 工具栏取 y≈19、x≈20,左让位约 78pt,spike 截图校准;drag-region 要逐个元素标注;全屏时去掉让位。
- **设置窗口与菜单**:`settings` 窗口懒创建,CloseRequested → prevent_close + hide 实现单实例;需改 vite input 和 capability windows。自定义应用菜单(⌘, 设置 / ⌘K 文章库 / ⌘I 检查器 / ⌘L 深色 / 外观三态),**必须自带编辑菜单**,否则 ⌘C/⌘V 失效;把 JS keydown 里的同名组合键删掉,防止双触发;菜单事件路由到当前 key window。主窗也建议改成 close→hide。
- 未联网核实项已在报告中逐条标注;建议先做半天 spike(材质 + 红绿灯对齐 + set_theme 同步 + accent 实测)。
