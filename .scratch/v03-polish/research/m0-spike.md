# M0 spike · 原生观感四项实测

> 日期:2026-11-17 · 开发机 macOS 27.0(26A428)· Xcode Swift 6.4.2 · 对应 spec §2.7.9 / [13-native-look.md](13-native-look.md)
> 结论先行:**四项里三项已有实测结论,一项(材质观感)需人眼补看**;其中红绿灯一项**推翻了 13 号文档的取值公式**。

## 方法与局限

- 本机**没有 Rust 工具链**,且沙箱代理拦截 rustup / crates.io,无法 `cargo tauri dev`。改用 Swift 写一个最小 AppKit 宿主([m0-spike/spike.swift](m0-spike/spike.swift)),**直接复现 Tauri/tao/wry 在 macOS 上做的底层调用**:
  - Overlay 标题栏 = `titlebarAppearsTransparent + titleVisibility=.hidden + .fullSizeContentView`(tao 的 `TitleBarStyle::Overlay` + `hiddenTitle`);
  - `transparent + windowEffects` = 窗口 `isOpaque=false`、`backgroundColor=.clear`,contentView 底层插 `NSVisualEffectView(blendingMode: .behindWindow)`(window-vibrancy 的做法),WKWebView `drawsBackground=false`(wry 透明的做法);
  - `trafficLightPosition` = 逐行移植 tao `inset_traffic_lights`;
  - `set_theme(Some/None)` = `NSWindow.appearance = darkAqua / aqua / nil`(tao 的 `set_theme` 即设 NSWindow appearance)。
- 局限:这是「等价调用」实测,**不是 Tauri 实机**;tao 0.37 的 inset 代码按记忆移植(与仓库 Cargo.lock 版本未逐行核对)。M2 落地时应在 Tauri 实机截图复核一次(见末节清单)。
- 复现:`swiftc -O -o spike .scratch/v03-polish/research/m0-spike/spike.swift && ./spike <截图目录>`(约 6 秒后自动退出;要人眼看材质,把 `runThemeTests` 末尾的 terminate 延时调长)。

## 1. `trafficLightPosition` × 52pt 工具栏 —— ✅ 已实测,**13 号文档公式需修正**

| 配置 | 关闭按钮左缘 x | 按钮顶距窗顶 | 按钮高 | **按钮中线距窗顶** | 缩放按钮右缘 x |
|---|---|---|---|---|---|
| 默认 Overlay(不设) | 9 | 9 | 14 | 16 | 69 |
| x=20, y=15 | 20 | 6 | 14 | 13 | 80 |
| x=20, y=18 | 20 | 9 | 14 | 16 | 80 |
| x=20, y=19(13 号文档推荐值) | 20 | 10 | 14 | **17** | 80 |
| x=20, y=20 | 20 | 11 | 14 | 18 | 80 |
| x=20, y=26 | 20 | 17 | 14 | 24 | 80 |

- 规律:**按钮中线距窗顶 = y − 2**(容器高 = 14 + y,按钮在容器内底部偏上 7pt)。13 号文档按「y = 按钮上缘」推出 `y ≈ (52−14)/2 = 19`,实测中线只到 17pt,**比 52pt 工具栏中线(26)高 9pt,明显不齐**。
- **修正取值**:
  - main / settings(52pt 工具栏):`"trafficLightPosition": { "x": 20, "y": 28 }` → 中线 26。
  - quick(若工具栏 44pt):`{ "x": 16, "y": 24 }` → 中线 22;若 quick 也用 52pt 则同 main。
- **左让位**:x=20 时缩放按钮右缘在 80pt,13 号文档建议的 `pl-[78px]` 会压到绿灯;改为 **≥ 92px**(80 + 12 间距)。x=16 时右缘 76 → `pl-[88px]`。
- 窗口缩放(resize)后 tao 会在 `windowDidResize` 里重新 inset,本 spike 未覆盖,M2 实机确认一次。

## 2. `set_theme(None|Some)` → `prefers-color-scheme` 同步 —— ✅ 已实测,可行

开发机当前系统外观 = 深色。对同一窗口依次设 appearance,150ms 后在 WKWebView 里读 `matchMedia`:

| 操作 | `prefers-color-scheme: dark` | 累计 `change` 事件 |
|---|---|---|
| 初始(appearance = nil,跟随系统深色) | true | 0 |
| `darkAqua`(= `set_theme(Some(Dark))`) | true | 0(本来就是深色,不触发,正确) |
| `aqua`(= `set_theme(Some(Light))`) | **false** | **1** |
| `nil`(= `set_theme(None)`,回到跟随系统) | **true** | **2** |

- 结论:**NSWindow.appearance 一变,WKWebView 的 `prefers-color-scheme` 在 150ms 内同步,并触发 `matchMedia` change 事件**。13 号文档 §3 的「Rust 权威 + 前端只镜像 matchMedia」方案成立,`theme-changed` 事件与 localStorage `v3-dark` 可删。
- 隐藏窗口:未单独测,但 appearance 是窗口属性、与可见性无关;M2 实机顺手确认 quick 隐藏期间切换后再唤出是否已同步。
- 附带:`prefers-reduced-transparency` 媒体查询**在本机 WKWebView 可用**(`media !== 'not all'`),13 号文档中 CSS 保险写法可以直接用。

## 3. 读 `NSColor.controlAccentColor` —— ✅ API 已实测;⚠️ CSS `AccentColor` 是否跟随未能判定

| 来源 | 结果 |
|---|---|
| `NSColor.controlAccentColor` → sRGB(aqua 外观下) | `#007aff` |
| 同上(darkAqua 外观下) | `#007aff` |
| `UserDefaults AppleAccentColor` | 未设置(= 系统「多色」,即蓝) |
| WKWebView 内 CSS `color: AccentColor` | `rgb(0, 122, 255)` |
| WKWebView 内 CSS `-apple-system-control-accent` | `rgb(0, 122, 255)` |

- 结论:原生读取路径(`controlAccentColor` → `usingColorSpace(.sRGB)` → hex)**可用**,objc2 写法与 13 号文档示例一一对应(`NSColor::controlAccentColor()`、`colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())`)。**objc2 绑定本身未编译验证**(无 Rust 工具链)。
- 本机强调色就是默认蓝,**CSS `AccentColor` 恰好也是蓝,无法区分它是否真的跟随系统**。判定它需要把系统强调色改成非蓝色——这属于修改系统设置,spike 未做。
- 建议:M2 仍按 13 号文档走 Rust 读取 + `accent-changed` 事件(不依赖 CSS `AccentColor`,即使它跟随也不影响此方案);**人工补测一步**:系统设置 → 外观 → 强调色选「紫色」,重跑 spike,看 CSS 行是否仍是 `rgb(0,122,255)`,同时确认 `controlAccentColor` 变为紫色。

## 4. `windowEffects` 材质观感(sidebar / popover)—— ⚠️ 未能截图,需人眼补看

- spike 已按 tao/window-vibrancy 的做法搭好两窗(左:`sidebar` + x20/y19 红绿灯;右:`popover` + x16/y15),页面含 52pt 工具栏、红色中线、左 200pt 透出材质 + 右侧文档实底。
- `screencapture -l <windowid>` 返回 `could not create image from window`:本进程没有「屏幕录制」权限,**截图全部失败**,所以观感没有客观记录。
- 已确认的部分:透明 WKWebView 叠在 behind-window `NSVisualEffectView` 上可正常加载、`prefers-color-scheme` 正常;未见崩溃或空白。
- 需人工:运行 spike(调长退出延时),肉眼看 ① sidebar 材质在亮/暗下是否像 Finder/Notes 侧栏;② popover 材质在置顶小窗上是否发灰(13 号文档建议 quick 用 `state: active`);③ 文档区实底与材质交界是否干净。截图存本目录。

## 对 spec / 后续里程碑的影响

1. **§2.7.9 红绿灯取值改为 `{x:20, y:28}`(52pt)、quick `{x:16, y:24}`(44pt),工具栏左让位 ≥ 92px / 88px**;13 号文档 §4 的 y≈19 与 78px 作废。
2. 外观三态 Rust 权威方案:实测成立,M2 按原计划做。
3. 强调色:按原计划 Rust 读取;CSS `AccentColor` 不依赖。
4. 材质:无反证,M2 按原计划;观感需人眼补看后定 quick 用 `popover` 还是 `underWindowBackground`。

## M2 落地时 Tauri 实机复核清单

- [ ] `tauri.macos.conf.json` 放 `transparent` / `windowEffects` / `trafficLightPosition`,Windows 包不受影响
- [ ] 红绿灯 y=28 与 52pt 工具栏中线对齐(截图量)、resize 后不漂移、全屏退出后复位
- [ ] `set_theme` 后三窗(含隐藏的 quick)外观一致
- [ ] 非蓝强调色下 `accent-changed` 生效
- [ ] 材质观感截图(需授予终端/应用屏幕录制权限)
