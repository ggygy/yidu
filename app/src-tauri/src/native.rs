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
    let view = SubmenuBuilder::new(app, "显示")
        .item(&library)
        .item(&inspector)
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
        "m-main" => crate::show_main(app, false),
        // 主窗动作:快捷窗/设置窗是 key window 时也定向到主窗(并唤出)
        "m-new" | "m-resume" | "m-library" | "m-inspector" => {
            crate::show_main(app, false);
            let _ = app.emit_to("main", "menu", id.trim_start_matches("m-"));
        }
        _ => {}
    }
}
