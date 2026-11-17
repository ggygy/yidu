// v0.3 §2.7 原生观感:应用菜单(含编辑菜单)、外观三态(Rust 权威 set_theme)、系统强调色、独立设置窗口
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::commands::{self, PrefsStored};
use crate::translate::AppState;

// ---------- 外观三态 ----------

/// "system" | "light" | "dark" → set_theme 参数(None = 跟随系统)
fn theme_for(mode: &str) -> Option<Theme> {
    match mode {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

/// 对所有窗口(含之后懒创建的设置窗)应用外观;同步菜单勾选与强调色
pub fn apply_theme_mode(app: &AppHandle, mode: &str) {
    app.set_theme(theme_for(mode));
    if let Some(m) = app.try_state::<MenuState>() {
        for (item, id) in m.appearance.iter().zip(["system", "light", "dark"]) {
            let _ = item.set_checked(id == mode);
        }
    }
    // 亮暗下强调色是不同的动态色,外观变了重读一次
    refresh_accent(app);
}

/// 当前实际外观(跟随系统时读窗口的 effective theme)
fn effective_dark(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .next()
        .and_then(|w| w.theme().ok())
        .map(|t| t == Theme::Dark)
        .unwrap_or(false)
}

/// 写偏好(走 set_prefs 同一路径:落库 + 应用 + 广播 prefs-changed)
fn save_theme_mode(app: &AppHandle, mode: &str) {
    let update = PrefsStored { theme_mode: Some(mode.to_string()), ..Default::default() };
    if let Err(e) = commands::apply_prefs_update(app, &app.state::<AppState>(), update) {
        eprintln!("[译读] 保存外观失败:{e}");
    }
}

// ---------- 系统强调色 ----------

#[derive(Default)]
pub struct AccentState(pub Mutex<Option<String>>);

#[cfg(target_os = "macos")]
fn system_accent_hex() -> Option<String> {
    use objc2_app_kit::{NSColor, NSColorSpace};
    let c = NSColor::controlAccentColor();
    let c = c.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
    let ch = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Some(format!("#{:02x}{:02x}{:02x}", ch(c.redComponent()), ch(c.greenComponent()), ch(c.blueComponent())))
}

#[cfg(not(target_os = "macos"))]
fn system_accent_hex() -> Option<String> {
    None
}

pub fn current_accent() -> Option<String> {
    system_accent_hex()
}

/// 重读强调色,变了才广播 `accent-changed`(窗口获焦 / 外观变化时调用:改强调色必须切去系统设置,回来必触发获焦)
pub fn refresh_accent(app: &AppHandle) {
    let now = system_accent_hex();
    if let Some(st) = app.try_state::<AccentState>() {
        let mut last = st.0.lock().unwrap();
        if *last == now {
            return;
        }
        *last = now.clone();
    }
    let _ = app.emit("accent-changed", now);
}

// ---------- 设置窗口(懒创建 + 关闭即隐藏) ----------

pub fn show_settings(app: &AppHandle, section: Option<&str>) {
    make_regular(app);
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        if let Some(s) = section {
            let _ = app.emit_to("settings", "settings-section", s);
        }
        return;
    }
    let url = format!("settings.html#{}", section.unwrap_or("models"));
    let builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(url.into()))
        .title("设置")
        .inner_size(840.0, 600.0)
        .min_inner_size(760.0, 480.0)
        .minimizable(false)
        .maximizable(false)
        .center();
    #[cfg(target_os = "macos")]
    let builder = {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(20.0, 28.0))
            .transparent(true)
            .effects(EffectsBuilder::new().effect(Effect::Sidebar).state(EffectState::FollowsWindowActiveState).build())
    };
    match builder.build() {
        Ok(w) => {
            let w2 = w.clone();
            let app2 = app.clone();
            w.on_window_event(move |e| match e {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = w2.hide();
                    update_dock(&app2);
                }
                tauri::WindowEvent::Focused(true) => refresh_accent(&app2),
                _ => {}
            });
            let _ = w.set_focus();
        }
        Err(e) => eprintln!("[译读] 创建设置窗口失败:{e}"),
    }
}

// ---------- 应用菜单 ----------

pub struct MenuState {
    pub appearance: [CheckMenuItem<Wry>; 3],
}

/// 自定义菜单必须自带「编辑」菜单,否则 WKWebView 里 ⌘C/⌘V/⌘A 全部失效
pub fn install_menu(app: &AppHandle, mode: &str) -> tauri::Result<()> {
    let settings = MenuItemBuilder::with_id("m-settings", "设置…").accelerator("CmdOrCtrl+,").build(app)?;
    let check_update = MenuItemBuilder::with_id("m-check-update", "检查更新…").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "译读")
        .about(None)
        .separator()
        .item(&settings)
        .item(&check_update)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_doc = MenuItemBuilder::with_id("m-new", "新建翻译").accelerator("CmdOrCtrl+N").build(app)?;
    let resume = MenuItemBuilder::with_id("m-resume", "续译未完成块").accelerator("CmdOrCtrl+R").build(app)?;
    let file = SubmenuBuilder::new(app, "文件").item(&new_doc).item(&resume).separator().close_window().build()?;

    let edit = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let library = MenuItemBuilder::with_id("m-library", "文章库").accelerator("CmdOrCtrl+K").build(app)?;
    let inspector = MenuItemBuilder::with_id("m-inspector", "检查器").accelerator("CmdOrCtrl+I").build(app)?;
    let toggle_dark = MenuItemBuilder::with_id("m-toggle-dark", "切换浅色 / 深色").accelerator("CmdOrCtrl+L").build(app)?;
    let a_sys = CheckMenuItemBuilder::with_id("m-theme-system", "跟随系统").checked(mode == "system").build(app)?;
    let a_light = CheckMenuItemBuilder::with_id("m-theme-light", "浅色").checked(mode == "light").build(app)?;
    let a_dark = CheckMenuItemBuilder::with_id("m-theme-dark", "深色").checked(mode == "dark").build(app)?;
    let appearance = SubmenuBuilder::new(app, "外观").item(&a_sys).item(&a_light).item(&a_dark).build()?;
    let zoom_in = MenuItemBuilder::with_id("m-zoom-in", "放大").accelerator("CmdOrCtrl+=").build(app)?;
    let zoom_out = MenuItemBuilder::with_id("m-zoom-out", "缩小").accelerator("CmdOrCtrl+-").build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("m-zoom-reset", "实际大小").accelerator("CmdOrCtrl+0").build(app)?;
    let view = SubmenuBuilder::new(app, "显示")
        .item(&library)
        .item(&inspector)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .item(&toggle_dark)
        .item(&appearance)
        .separator()
        .fullscreen()
        .build()?;

    let quick = MenuItemBuilder::with_id("m-quick", "快捷翻译").build(app)?;
    let main = MenuItemBuilder::with_id("m-main", "主窗口").build(app)?;
    let window = SubmenuBuilder::new(app, "窗口")
        .minimize()
        .maximize()
        .separator()
        .item(&main)
        .item(&quick)
        .build()?;

    let menu = MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window]).build()?;
    app.set_menu(menu)?;
    app.manage(MenuState { appearance: [a_sys, a_light, a_dark] });
    app.on_menu_event(on_menu);
    Ok(())
}

/// 菜单事件路由。注意:app 级 on_menu_event 也会收到托盘菜单事件 —— 只处理 `m-` 前缀的 id
fn on_menu(app: &AppHandle, e: tauri::menu::MenuEvent) {
    let id = e.id().as_ref();
    match id {
        "m-settings" => show_settings(app, None),
        "m-check-update" => show_settings(app, Some("about")),
        "m-theme-system" => save_theme_mode(app, "system"),
        "m-theme-light" => save_theme_mode(app, "light"),
        "m-theme-dark" => save_theme_mode(app, "dark"),
        "m-toggle-dark" => save_theme_mode(app, if effective_dark(app) { "light" } else { "dark" }),
        "m-quick" => crate::toggle_quick(app),
        // 字号缩放(§2.5.6):发给当前有焦点的主窗 / 快捷窗,各自记忆
        "m-zoom-in" | "m-zoom-out" | "m-zoom-reset" => {
            let target = ["quick", "main"]
                .into_iter()
                .find(|l| app.get_webview_window(l).and_then(|w| w.is_focused().ok()).unwrap_or(false))
                .unwrap_or("main");
            let _ = app.emit_to(target, "menu", id.trim_start_matches("m-"));
        }
        "m-main" => crate::show_main(app, false),
        // 主窗动作:快捷窗/设置窗是 key window 时也定向到主窗(并唤出)
        "m-new" | "m-resume" | "m-library" | "m-inspector" => {
            crate::show_main(app, false);
            let _ = app.emit_to("main", "menu", id.trim_start_matches("m-"));
        }
        _ => {}
    }
}

// ---------- 快捷窗唤出(§2.4) ----------

/// 快捷窗:唤出时移到当前桌面(含全屏应用之上),而不是把用户拽回它所在的桌面
pub fn setup_quick_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(q) = app.get_webview_window("quick") {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        if let Ok(ptr) = q.ns_window() {
            // SAFETY:tauri 返回的是该窗口有效的 NSWindow 指针;setup 在主线程执行
            let win: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            let b = win.collectionBehavior();
            win.setCollectionBehavior(
                b | NSWindowCollectionBehavior::MoveToActiveSpace | NSWindowCollectionBehavior::FullScreenAuxiliary,
            );
        }
    }
    let _ = app;
}

/// Dock 图标:主窗或设置窗可见 = Regular;只剩快捷窗 = Accessory(无 Dock 图标,唤出不切桌面)
pub fn update_dock(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let vis = |l: &str| app.get_webview_window(l).and_then(|w| w.is_visible().ok()).unwrap_or(false);
        let regular = vis("main") || vis("settings");
        let _ = app.set_activation_policy(if regular { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
    }
    let _ = app;
}

pub fn make_regular(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    let _ = app;
}

/// 各显示器上记忆的相对位置(0..1,按可用区域剩余空间的比例)
#[derive(Default)]
pub struct QuickPos(pub Mutex<std::collections::HashMap<String, (f64, f64)>>);

const QUICK_POS_KEY: &str = "quick_pos";

fn monitor_key(m: &tauri::Monitor) -> String {
    let p = m.position();
    format!("{}@{},{}", m.name().cloned().unwrap_or_default(), p.x, p.y)
}

pub fn load_quick_pos(app: &AppHandle) {
    let saved = app
        .try_state::<AppState>()
        .and_then(|s| s.db.get_state(QUICK_POS_KEY).ok().flatten())
        .and_then(|j| serde_json::from_str::<std::collections::HashMap<String, (f64, f64)>>(&j).ok())
        .unwrap_or_default();
    app.manage(QuickPos(Mutex::new(saved)));
}

/// 记下快捷窗当前位置(相对其所在显示器),隐藏时调用
pub fn remember_quick_pos(app: &AppHandle) {
    let Some(q) = app.get_webview_window("quick") else { return };
    let (Ok(Some(mon)), Ok(pos), Ok(size)) = (q.current_monitor(), q.outer_position(), q.outer_size()) else { return };
    let wa = mon.work_area();
    let free_w = (wa.size.width as f64 - size.width as f64).max(1.0);
    let free_h = (wa.size.height as f64 - size.height as f64).max(1.0);
    let rel = (
        ((pos.x - wa.position.x) as f64 / free_w).clamp(0.0, 1.0),
        ((pos.y - wa.position.y) as f64 / free_h).clamp(0.0, 1.0),
    );
    if let Some(st) = app.try_state::<QuickPos>() {
        let mut m = st.0.lock().unwrap();
        m.insert(monitor_key(&mon), rel);
        if let (Some(s), Ok(j)) = (app.try_state::<AppState>(), serde_json::to_string(&*m)) {
            let _ = s.db.set_state(QUICK_POS_KEY, &j);
        }
    }
}

/// 唤出前定位:放到鼠标所在显示器;该屏记忆的相对位置(默认水平居中、偏上);越界夹回可用区域
pub fn place_quick(app: &AppHandle) {
    let Some(q) = app.get_webview_window("quick") else { return };
    let Ok(cur) = app.cursor_position() else { return };
    let Ok(Some(mon)) = app.monitor_from_point(cur.x, cur.y) else { return };
    let (Ok(pos), Ok(size)) = (q.outer_position(), q.outer_size()) else { return };
    let wa = mon.work_area();
    let (wx, wy, ww, wh) = (wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32);
    let (sw, sh) = (size.width as i32, size.height as i32);
    // 已完整在这块屏的可用区域内:不动(尊重用户上次放的位置)
    let inside = pos.x >= wx && pos.y >= wy && pos.x + sw <= wx + ww && pos.y + sh <= wy + wh;
    if inside {
        return;
    }
    let rel = app
        .try_state::<QuickPos>()
        .and_then(|st| st.0.lock().unwrap().get(&monitor_key(&mon)).copied())
        .unwrap_or((0.5, 0.18));
    let free_w = (ww - sw).max(0) as f64;
    let free_h = (wh - sh).max(0) as f64;
    let x = wx + (rel.0 * free_w).round() as i32;
    let y = wy + (rel.1 * free_h).round() as i32;
    // 窗比屏还高:先缩到可用高度,再放顶
    if sh > wh {
        let _ = q.set_size(tauri::PhysicalSize::new(size.width, wh as u32));
    }
    let _ = q.set_position(tauri::PhysicalPosition::new(x.max(wx), y.max(wy)));
}
