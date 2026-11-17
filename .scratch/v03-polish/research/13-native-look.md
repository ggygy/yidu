# 13 · 原生观感的 Tauri 实现路径

> 日期:2026-11-17 · 工单 [13](../issues/13-native-look-feasibility.md) · 输入:[12-visual-language.md](12-visual-language.md)(方向 C)
> 现状基线:`tauri 2.12.5` / `tauri-runtime-wry 2.12.3` / `wry 0.57.2` / `tao 0.37.2` / `tauri-utils 2.10.2`;Cargo.lock 里已有 `window-vibrancy 0.8.1`、`objc2 0.6.5`、`objc2-app-kit 0.3.2`(tauri 的传递依赖)。开发机 macOS 27.0。
> 两窗 `main` / `quick` 已是 `titleBarStyle: "Overlay"` + `hiddenTitle: true`,未开透明;深色靠 `data-theme` + localStorage `v3-dark` + `theme-changed` 跨窗事件 + ⌘L(JS keydown);没有自定义应用菜单(走 Tauri 默认菜单),⌘, 现在打开主窗内的设置浮层。

## 核实来源与可信度标注

- **已联网核实**(读 tauri `dev` 分支源码与 CHANGELOG,2026-11-17):`WindowEffect` 枚举、`WindowEffectsConfig` 字段、`trafficLightPosition` 配置项、`macOSPrivateApi` 在 2.12.1+ 变为空操作、2.12.0 起有 Liquid Glass 效果、`WebviewWindowBuilder`/`WebviewWindow` 的相关方法名。注意:读的是 `dev` 分支,不是 2.12.5 tag,本地无 crate 源码和 node_modules,无法逐行对 tag 核对;CHANGELOG 中这些条目都标在 ≤2.12.2,故推定 2.12.5 都有。
- **已联网检索**:WebKit 的 `AccentColor` 问题(bug 254578「css AccentColor keyword is not synced」、bug 210719「-apple-system-control-accent always returns the default blue color」)。
- 其余标 **「未联网核实」** 的,是凭经验得出、需在 spike 里实测的。

---

## 1. NSVisualEffectView 材质(vibrancy)

### 结论 / 推荐

**用 Tauri 内置的 `windowEffects`,不直接引 `window-vibrancy` crate。** 内置实现本身就调用 `window-vibrancy`(lock 里的 0.8.1 就是它带进来的),配置式声明,还可以在运行时用 `WebviewWindow::set_effects` 切换,省掉自己写 raw-window-handle 的胶水。**`macOSPrivateApi` 不需要了**:CHANGELOG 2.12.1 写明 macOS 上的透明和全屏不再需要 `macos-private-api` feature 或 `macOSPrivateApi` 配置(config.rs 注释:2.12.1+ 为空操作)。所以**不再有私有 API 的 App Store 顾虑**(已联网核实,针对 dev 源码与 CHANGELOG)。

可用的 macOS 材质(`WindowEffect`,camelCase 序列化):`titlebar`、`selection`、`menu`、`popover`、`sidebar`、`headerView`、`sheet`、`windowBackground`、`hudWindow`、`fullScreenUI`、`tooltip`、`contentBackground`、`underWindowBackground`、`underPageBackground`,以及 macOS 26+ 的 `liquidGlassRegular` / `liquidGlassClear`(2.12.0 新增,另有 `interactive` 选项)。`state`:`followsWindowActiveState` | `active` | `inactive`;`radius`、`color` 只在 macOS 生效,Liquid Glass 忽略 `state`。

| 窗口 | 推荐材质 | state | 说明 |
|---|---|---|---|
| quick(置顶小窗) | `popover`(备选 `underWindowBackground`) | `active` | 置顶窗失焦时跟随 inactive 会发灰,对照 Spotlight/翻译类面板,保持 active 更自然。**不要用 `hudWindow`**:HUD 材质总是深色,与「亮暗跟随系统」冲突(未联网核实,按 AppKit 惯例) |
| main | `sidebar` | `followsWindowActiveState` | 整窗一层材质;工具栏、侧栏、检查器透出材质,文档区 CSS 实底 |
| settings | `sidebar` | `followsWindowActiveState` | 左栏透出材质,右侧分组列表区实底 `--group` 窗底色 |

### 配置示意(tauri.conf.json,main 窗)

```jsonc
{
  "label": "main",
  "titleBarStyle": "Overlay",
  "hiddenTitle": true,
  "transparent": true,                 // windowEffects 要求窗口透明
  "trafficLightPosition": { "x": 20, "y": 26 },  // 见第 4 节
  "windowEffects": {
    "effects": ["sidebar"],
    "state": "followsWindowActiveState"
    // radius 不设:有装饰窗口的圆角由系统负责(12pt),设了反而可能和窗口圆角错位(未联网核实)
  }
}
```

也可以在 Rust 里按条件开(例如做「降低透明度」开关或 macOS 版本分支):

```rust
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectState}; // 路径未联网核实;dev 源码里定义在 tauri_utils 并由 tauri 重导出
win.set_effects(WindowEffectsConfig {
    effects: vec![Effect::Sidebar],
    state: Some(EffectState::FollowsWindowActiveState),
    radius: None, color: None, ..Default::default()
})?;
```

### 「只有工具栏/侧栏/检查器半透明,文档区实底」怎么做

材质在**整个窗口的 webview 下面**,webview 透明,所以 **CSS 背景透明的地方显出材质,涂了实色的地方就是实底**:

```css
html, body, #root { background: transparent; }   /* 必须,否则整窗被 body 底色盖住 */
.toolbar, .sidebar, .inspector { background: transparent; }  /* 透出 NSVisualEffectView */
.doc      { background: var(--bgdoc); }            /* #fff / #1e1e1e 实底 */
.settings-pane { background: var(--group-bg); }
/* 系统「降低透明度」开启时 NSVisualEffectView 自己会变不透明;CSS 侧可加保险: */
@media (prefers-reduced-transparency: reduce) { .toolbar,.sidebar,.inspector { background: var(--mat-solid); } }
```

- CSS `backdrop-filter` **只能模糊 webview 内的内容,模糊不到桌面**。原型 C 的 `rgba(...)+blur(30px)` 回退只能用在两种地方:①工具栏盖住滚动中的文档区(这时 backdrop-filter 有意义);②`windowEffects` 不可用时(非 macOS / 用户关闭)。
- 一个窗口只能挂一层系统材质(配置里 `effects` 是列表,但 macOS 只取一种)。要做到工具栏用 titlebar、侧栏用 sidebar 两种不同材质,就得自己用 objc2 往 contentView 下面插多块 NSVisualEffectView,并和 webview 布局同步,**不值得**;同一层材质上叠一层很淡的 CSS 色调来区分即可。
- `prefers-reduced-transparency` 在 WKWebView 里是否可用:**未联网核实**(Safari 较新版本已支持该媒体查询)。

### 副作用与坑

- **圆角/阴影**:保留 `decorations: true`(Overlay 仍是有装饰窗口),系统窗口圆角和阴影照常。透明窗的阴影按不透明像素算,整窗铺了材质所以没问题;但**如果某个窗口只有局部铺材质**(例如以后做无装饰的浮层),阴影会只跟着不透明区域走,改材质区域后要 `set_shadow(false/true)` 才会刷新(未联网核实)。
- **首帧白闪/黑闪**:透明 webview 加载前可能闪一下。显示前已隐藏的 quick 不受影响;main 建议 `visible: false`,前端首帧渲染完再 `show()`(现在 quick 已是这个模式)(未联网核实)。
- **拖动**:材质不影响 `data-tauri-drag-region`,但透明区域**照样会接收鼠标**(webview 铺满整窗),所以工具栏空白处必须标 drag region,见第 4 节。
- **性能**:NSVisualEffectView 的 behind-window 混合由 WindowServer 合成,开销很小;代价主要是 WKWebView 变成非不透明图层,合成成本略高,大面积滚动的文档区是实色所以影响可以忽略。**尽量少用 CSS `backdrop-filter`**(在长文档滚动时是主要的 GPU 热点)。整体代价:低(未联网核实,凭经验)。
- **快捷窗置顶**:材质和 `alwaysOnTop` 不冲突。
- **Liquid Glass**:macOS 26+ 可以用 `liquidGlassRegular`,但视觉语言 12 定的是 NSVisualEffectView 材质系统,而且要兼顾 <26;v0.3 先不用,作为后续「macOS 26+ 分支」的可选项。
- **Windows 构建**:bundle targets 里有 nsis。`sidebar` 等在 Windows 上被忽略,CSS 回退要能独立成立(透明 body 在 Windows 上会露出透明底!)→ Windows 下不要设 `transparent`,或用平台专属配置 `tauri.macos.conf.json` 只在 macOS 打开透明 + 效果(**推荐**,Tauri 2 支持按平台合并配置文件,未联网核实具体合并语义,印象中是 JSON merge patch)。

**可信度**:API/配置名 高(已核源码);材质推荐与视觉效果 中(要 spike 实看);副作用 中。

---

## 2. 系统强调色:CSS `AccentColor` 在 WKWebView 里

### 结论

**不能依赖 CSS `AccentColor` / `-apple-system-control-accent`。** WebKit bug 254578(Safari 16.4)报告 `AccentColor` 总是蓝色,不反映系统强调色;bug 210719 报告 `-apple-system-control-accent` 总是返回默认蓝。WebKit 只在 Safari 打开的特定外观模式(内部 `useSystemAppearance` 一类开关)下才映射真实 `controlAccentColor`,第三方 WKWebView 拿到的是固定 `#007AFF`(这个开关机制属于未联网核实;「总是蓝色」的现象有 bug 单支撑)。这些 bug 到 2026 年是否已修:**未联网核实**,所以按「不可用」设计,写进 spike 实测。

### 推荐:Rust 读 `NSColor.controlAccentColor`,用事件下发

```toml
# Cargo.toml(版本与 lock 中现有传递依赖对齐;feature 名未联网核实)
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-app-kit = { version = "0.3", features = ["NSColor", "NSColorSpace"] }
objc2-foundation = { version = "0.3", features = ["NSNotification"] }
```

```rust
#[cfg(target_os = "macos")]
fn system_accent_hex() -> Option<String> {
    use objc2_app_kit::{NSColor, NSColorSpace};
    unsafe {
        let c = NSColor::controlAccentColor();
        let c = c.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?; // 动态色先转 sRGB
        let (r, g, b) = (c.redComponent(), c.greenComponent(), c.blueComponent());
        Some(format!("#{:02x}{:02x}{:02x}", (r*255.0).round() as u8, (g*255.0).round() as u8, (b*255.0).round() as u8))
    }
}

#[tauri::command]
fn system_accent(app: tauri::AppHandle) -> Option<String> {
    // AppKit 颜色在主线程读取最稳;用 run_on_main_thread + channel 包一层
    system_accent_hex()
}
```

**实时跟随**,两档可选:
1. **简单档(推荐 v0.3 先做)**:窗口 `WindowEvent::Focused(true)` 时重读一次,值变了就 `app.emit("accent-changed", hex)`。用户改强调色必须切到「系统设置」,回到本应用时一定会触发 focus,体验上等同实时。
2. **完整档**:`NSNotificationCenter` 观察 `NSSystemColorsDidChangeNotification`(用 `block2` 写 block 观察者;未联网核实 objc2 的具体签名),回调里 emit。

前端:

```ts
const applyAccent = (hex: string | null) =>
  document.documentElement.style.setProperty("--accent", hex ?? "");  // 空 → 回落样式表里的 #0a7aff/#0a84ff
invoke<string|null>("system_accent").then(applyAccent);
listen<string>("accent-changed", e => applyAccent(e.payload));
```

```css
:root { --accent-fallback: #0a7aff; --accent: var(--accent-fallback); }
[data-theme="dark"] { --accent-fallback: #0a84ff; }
/* accent 上的文字:系统强调色都够深,统一白字;「石墨」灰也满足 ≥4.5:1(未联网核实对比度) */
--on-accent: #fff;
```

坑:
- 强调色设为「多色」(macOS 默认)时 `controlAccentColor` 返回蓝色,正好符合预期。
- 系统强调色在亮/暗下是不同的动态色:`colorUsingColorSpace` 按**当前 appearance** 解析,所以亮暗切换时也要重读一次(挂在主题变化事件上)。
- 原生 `<input type=checkbox>` 等控件的 `accent-color` 也要显式设成 `var(--accent)`,否则 WebKit 用自己的蓝色。
- `-apple-system-*` 其他语义色(label、separator 等)同样不建议用:颜色由 12 号文档的 token 表自己掌握,亮暗更可控。

**可信度**:「CSS AccentColor 不可靠」中高(有 bug 证据,但修复状态未核);Rust 读取方案 高(NSColor API 稳定;objc2 代码细节中)。

---

## 3. 跟随系统亮/暗 + 手动覆盖(⌘L)

### 机制

- WKWebView 的 `prefers-color-scheme` 跟随**所在 NSWindow 的 effectiveAppearance**:系统切换会实时触发 `matchMedia` change,无需刷新(未联网核实,WebKit 一贯行为)。
- Tauri:窗口配置 `theme`(缺省 = 跟随系统);`WebviewWindow::set_theme(Option<Theme>)`,`None` = 回到跟随系统;`theme()` 读当前值;`WindowEvent::ThemeChanged(Theme)` / JS `getCurrentWindow().onThemeChanged`(以上方法名已核源码,JS 名未联网核实)。**`set_theme(Some(Dark))` 会设置 NSWindow.appearance,所以同时改变该窗口 webview 的 `prefers-color-scheme`、材质(vibrancy 也跟着变暗)和红绿灯/滚动条外观**——这是比单纯切 `data-theme` 好的地方:现在只切 CSS,系统材质和原生控件不会跟着变,开了 vibrancy 之后会出现「暗色页面 + 亮色材质」。
- 应用级:`AppHandle::set_theme`(一次设所有窗口,包括之后新建的窗口)。它是哪个版本加的、JS 的 `app.setTheme` 叫什么权限名:**未联网核实**;找不到就遍历 `webview_windows()` 逐个 `set_theme`。

### 推荐设计:三态偏好,Rust 为权威

```
pref.appearance: "system" | "light" | "dark"   // 存 DB prefs(替代 localStorage v3-dark)
```

1. 启动和偏好变化时,Rust 对所有窗口(含 settings)`set_theme(None | Some(Light) | Some(Dark))`。
2. 前端**不再自己决定 `data-theme`**,只镜像真实外观:

```ts
const mq = matchMedia("(prefers-color-scheme: dark)");
const sync = () => (document.documentElement.dataset.theme = mq.matches ? "dark" : "");
sync(); mq.addEventListener("change", sync);
```

   这样 `[data-theme="dark"]` 现有的 Tailwind 变体(`@custom-variant dark`)一行都不用改,跨窗事件 `theme-changed` 和 localStorage 都可以删掉(窗口外观由 NSWindow 驱动,隐藏中的 quick 也会同步)。
3. **⌘L 的语义**:在「浅 ↔ 深」之间切,并把偏好从 system 改成显式值;菜单「显示 › 外观」提供 跟随系统 / 浅色 / 深色 三个 CheckMenuItem,回到跟随系统只能通过菜单或设置页(和 Xcode、Notes 的做法一致)。
4. 迁移:老用户 `v3-dark=1` → 首次启动写入 `appearance: "dark"`,否则 `"system"`。

坑:
- `set_theme` 后到 `matchMedia` change 触发之间可能有一帧不一致(未联网核实),可以在 Rust `set_theme` 完成后再 emit 一个兜底事件。
- 阅读外观(纸色/自定义底色 `rs.theme`)是文档区的另一套主题,和窗口外观独立;要规定暗色窗口下阅读底色是否自动切到暗版本(归工单 09/12 细化)。
- 权限:如果 JS 侧调用 `setTheme`,要在 capability 里加 `core:window:allow-set-theme`(名字未联网核实);推荐走自定义 command,不需要新增 core 权限。

**可信度**:高(机制清楚),JS 侧 API 名中。

---

## 4. 统一工具栏 + 红绿灯

### 现状和可用项

- `titleBarStyle: "Overlay"` + `hiddenTitle: true`:已在用,内容延伸到标题栏下面、标题隐藏,红绿灯悬浮在内容之上。
- `trafficLightPosition`:**Tauri 2.12.5 可用**。窗口配置项 `trafficLightPosition: {x, y}`(LogicalPosition),注释写明「需要 `titleBarStyle: Overlay` 且 `decorations: true`」;Rust 侧 `WebviewWindowBuilder::traffic_light_position`(已核源码)。CHANGELOG 显示是 2.4.0 前后加入(已核 CHANGELOG 搜索结果,具体版本号中等可信)。运行时有没有 `set_traffic_light_position`:没找到,**按「只能创建时设」处理**。
- 位置语义:x/y 是**第一个按钮(关闭)左上角相对窗口左上角**的偏移(未联网核实,来自 tao 实现印象)。红绿灯按钮直径约 14pt(含点击区约 16),所以垂直居中在 52pt 工具栏的公式:`y ≈ (52 − 14) / 2 ≈ 19`,再用肉眼微调 ±1。

### 推荐

```jsonc
// main / settings
"titleBarStyle": "Overlay", "hiddenTitle": true,
"trafficLightPosition": { "x": 20, "y": 19 }     // 52pt 工具栏;spike 截图对齐中线后定值
// quick(工具栏也按 52,或者沿用较小的 44 → y≈15)
"trafficLightPosition": { "x": 16, "y": 15 }
```

```tsx
<header data-tauri-drag-region className="h-[52px] flex items-center pl-[78px] pr-3 gap-2">
  {/* 左让位:x(20) + 三个按钮及间距(≈52) + 余量 ≈ 78pt,≥ 规范中的 70 */}
  <Segmented …/>                       {/* 交互控件本身不加 drag-region */}
  <span className="flex-1" data-tauri-drag-region />
</header>
```

坑:
- **`data-tauri-drag-region` 只对带该属性的元素本身生效,不继承给子元素**(Tauri 2 行为;现有代码已经给每个空白 span/标题都单独标了,符合要求)。双击 drag region = 系统缩放(取决于用户「双击标题栏」设置,Tauri 2 已处理;未联网核实)。新版是否支持 `data-tauri-drag-region="deep"` 一类的继承写法:未联网核实,不依赖。
- drag region 需要 `core:window:allow-start-dragging` 权限,两窗都已有;**新的 settings 窗口要加进 capability 的 `windows`**。
- 全屏时系统会把红绿灯移到隐藏的标题栏里,`trafficLightPosition` 失效;退出全屏后有的版本会复位不准(tao 历史上修过多次;未联网核实 0.37 状态)→ 全屏下工具栏左边距用 `onResized` 判断 `isFullscreen()` 后去掉 78pt 让位。
- 窗口失焦时红绿灯变灰是系统行为,工具栏控件也建议跟着降低对比度(`:root[data-inactive]`,由 `Focused` 事件驱动),这样更像原生。
- 窗口未激活时点击工具栏控件,第一次点击只会激活窗口,要再点一次 → 可以给 quick 打开 `acceptFirstMouse: true`(builder 有 `accept_first_mouse`,配置项名未联网核实),置顶面板点一次就能生效。
- macOS 26+ 的系统原生工具栏变成更高的 Liquid Glass 样式;我们自绘工具栏高度固定 52,与系统应用略有差异,可以接受。

**可信度**:配置可用性 高;具体偏移数值 中(要截图校准)。

---

## 5. 独立设置窗口(⌘,)+ 原生菜单栏快捷键

### 设置窗口:预声明 + 隐藏复用(与 quick 同一套路)

```jsonc
// tauri.conf.json windows[]
{
  "label": "settings", "title": "设置", "url": "settings.html",
  "width": 720, "height": 520, "resizable": false, "minimizable": false, "maximizable": false,
  "visible": false, "center": true,
  "titleBarStyle": "Overlay", "hiddenTitle": true, "trafficLightPosition": { "x": 20, "y": 19 },
  "transparent": true, "windowEffects": { "effects": ["sidebar"], "state": "followsWindowActiveState" }
}
```

- `vite.config.ts` 的 `rollupOptions.input` 加 `settings: "settings.html"`;`capabilities/default.json` 的 `windows` 加 `"settings"`。
- window-state 插件:设置窗口是固定尺寸、居中,建议用 `WindowStateBuilder::with_denylist(&["settings"])` 排除(方法名未联网核实),否则会记住奇怪的位置。

```rust
pub fn show_settings(app: &AppHandle, section: Option<&str>) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show(); let _ = w.unminimize(); let _ = w.set_focus();
        if let Some(s) = section { let _ = app.emit_to("settings", "settings-section", s); }
    }
}

// setup 里:关闭 → 隐藏(保证单实例、再次 ⌘, 秒开)
let w = app.get_webview_window("settings").unwrap();
let w2 = w.clone();
w.on_window_event(move |e| if let tauri::WindowEvent::CloseRequested { api, .. } = e {
    api.prevent_close();
    let _ = w2.hide();
});
```

- 为什么用隐藏复用,不用每次新建:新建 webview 要 100–300ms 白屏(未联网核实具体数值),设置窗口打开频率低但期望秒开;常驻代价约一个 WKWebView 进程的内存(几十 MB)。如果在意内存,可以改成**懒创建**(第一次 ⌘, 时 `WebviewWindowBuilder::new(app,"settings",WebviewUrl::App("settings.html".into()))`,之后隐藏复用)。推荐**懒创建 + 隐藏复用**。
- 设置窗口和主窗的数据同步:沿用现有事件总线(`prefs-changed` / `providers-changed`),设置窗写入后广播,主窗/quick 已经在监听。
- 「首启无 provider 自动打开设置」:由主窗改成调用 `show_settings(Some("models"))`。
- ⌘W 在设置窗 = 关闭 = 隐藏(由 CloseRequested 统一处理)。**主窗 ⌘W 现在会真的关掉主窗**,托盘「打开主窗口」再 show 会失败 → 主窗也建议同样 prevent_close + hide(顺手修)。

### 原生菜单栏

**关键坑:一旦自定义应用菜单,必须自己放「编辑」菜单(撤销/重做/剪切/拷贝/粘贴/全选),否则 WKWebView 里 ⌘C/⌘V/⌘A 全部失效**(macOS 的这些键位是通过菜单 key equivalent 派发的)。现在能用是因为 Tauri 在 macOS 上会默认装一份菜单(未联网核实默认菜单细节,但「自定义菜单丢编辑键」是 Tauri/Electron 常见坑)。

```rust
use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder, CheckMenuItemBuilder, PredefinedMenuItem};

let app_menu = SubmenuBuilder::new(app, "译读")
    .about(None)
    .separator()
    .item(&MenuItemBuilder::with_id("settings", "设置…").accelerator("CmdOrCtrl+,").build(app)?)
    .item(&MenuItemBuilder::with_id("check-update", "检查更新…").build(app)?)
    .separator().services().separator()
    .hide().hide_others().show_all().separator().quit()
    .build()?;
let edit = SubmenuBuilder::new(app, "编辑")
    .undo().redo().separator().cut().copy().paste().select_all().build()?;
let view = SubmenuBuilder::new(app, "显示")
    .item(&MenuItemBuilder::with_id("toggle-library",   "文章库").accelerator("CmdOrCtrl+K").build(app)?)
    .item(&MenuItemBuilder::with_id("toggle-inspector", "检查器").accelerator("CmdOrCtrl+I").build(app)?)
    .separator()
    .item(&MenuItemBuilder::with_id("toggle-dark", "切换深色").accelerator("CmdOrCtrl+L").build(app)?)
    .item(&appearance_submenu /* 跟随系统 / 浅色 / 深色:CheckMenuItem,互斥自己维护 */)
    .build()?;
let window = SubmenuBuilder::new(app, "窗口")
    .minimize().maximize() /* 缩放 */ .separator()
    .item(&MenuItemBuilder::with_id("toggle-quick", "快捷翻译").build(app)?)  // 全局热键已有,菜单只显示不绑键
    .close_window().build()?;
let menu = MenuBuilder::new(app).items(&[&app_menu, &file /* 新建 ⌘N、续译 ⌘R */, &edit, &view, &window]).build()?;
app.set_menu(menu)?;
app.on_menu_event(|app, e| match e.id().as_ref() {
    "settings" => show_settings(app, None),
    "toggle-dark" => cycle_appearance(app),          // Rust 权威,见第 3 节
    id @ ("toggle-library" | "toggle-inspector") => {
        // 路由到当前 key window;快捷窗聚焦时 ⌘K 应该打开主窗再展开文章库
        let target = focused_label(app).unwrap_or("main".into());
        let _ = app.emit_to(target, "menu", id);
    }
    _ => {}
});
```

(SubmenuBuilder 上的 `.about/.services/.hide/.quit/.undo/...` 便捷方法名:凭 Tauri 2 API 印象,**未联网核实**;稳妥写法是 `PredefinedMenuItem::copy(app, None)?` 等。)

坑:
- **双触发**:菜单 accelerator 生效后,现有 `window.addEventListener("keydown")` 里的 ⌘K/⌘,/⌘L/⌘N/⌘R 可能**也会收到**(WKWebView 先拿到 keyDown,没被消费再走菜单 key equivalent;具体先后未联网核实)→ 迁移时**删掉 JS 里这些组合键**,只保留菜单一条路径;Esc、数字键 1–4 这类无修饰键仍然留在 JS。
- `⌘I` 在可编辑区域(contentEditable)里 WebKit 会当成斜体;我们的输入区是 textarea,影响不大。
- 菜单是**应用全局**的:quick 是 key window 时 ⌘K / ⌘I 应该定向到 main(并 show 它),或者在 quick 聚焦时禁用这些项(`MenuItem::set_enabled`,由 `Focused` 事件切换)。推荐:quick 聚焦时 ⌘K = 打开主窗 + 展开文章库;⌘I 禁用。
- 托盘菜单(现有 `Menu::with_items`)和应用菜单相互独立,保留不变。
- 「快捷键只出现在菜单、tooltip、设置页」(12 号文档规范)正好由原生菜单的右侧键位提示来承担。

**可信度**:总体方案 高;个别 builder 便捷方法名、key 事件先后顺序 中(未联网核实)。

---

## 落地建议(给 spec)

1. **spike(半天)**:main 窗 `transparent + windowEffects:sidebar + trafficLightPosition`,验证三件事:材质观感/文档实底、红绿灯与 52pt 工具栏中线对齐、亮暗 `set_theme` 后材质与 `prefers-color-scheme` 是否同步。再加一个 `system_accent` command 实测 `AccentColor` 与 NSColor 的差异(截图存 `research/`)。
2. 平台隔离:把透明/效果/红绿灯放进 `tauri.macos.conf.json`,避免 Windows 包露出透明底。
3. 顺序:菜单 + 外观三态(Rust 权威)→ 设置独立窗口 → 材质与 token 换皮(工单 12 的 token)→ 强调色事件。
4. 不做:直接依赖 `window-vibrancy`、`macOSPrivateApi`、多层 NSVisualEffectView、v0.3 用 Liquid Glass。

## 参考

- tauri `dev` 源码:[tauri-utils/src/config.rs](https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-utils/src/config.rs)、[tauri-utils/src/lib.rs](https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-utils/src/lib.rs)、[tauri/src/webview/webview_window.rs](https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri/src/webview/webview_window.rs)、[tauri CHANGELOG](https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri/CHANGELOG.md)
- WebKit:[Bug 254578 css AccentColor keyword is not synced](https://lists.webkit.org/pipermail/webkit-unassigned/2023-March/1095385.html)、[Bug 210719 -apple-system-control-accent always returns the default blue color](https://lists.webkit.org/pipermail/webkit-unassigned/2020-April/921357.html)、[Bug 245631](https://bugs.webkit.org/show_bug.cgi?id=245631)
- [MDN accent-color](https://developer.mozilla.org/docs/Web/CSS/accent-color)
