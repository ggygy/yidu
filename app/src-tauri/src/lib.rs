// 装配:window-state(禁可见性恢复)+ 全局快捷键(Rust 侧权威)+ 剪贴板 + tray + DB + 命令
mod batch;
mod blocks;
mod capture;
mod commands;
mod db;
mod dict;
mod flow;
mod keychain;
mod native;
mod ocr;
mod permissions;
mod prompt;
mod providers;
mod selection;
mod srs;
mod sse;
mod translate;
mod validate;

use anyhow::Result;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

/// ⌥T 唤出语义(§2.4.1):已在前台且有焦点 → 隐藏;否则移到当前桌面、取消最小化、激活应用、置前并聚焦
/// (v0.2 只看 is_visible:被遮挡 / 在别的桌面 / 最小化时反而把它藏起来)
pub fn toggle_quick(app: &tauri::AppHandle) {
    // 缩成图标时:⌥T / 托盘 = 展开
    if native::mini_visible(app) {
        native::expand_quick(app);
        return;
    }
    let Some(q) = app.get_webview_window("quick") else { return };
    let visible = q.is_visible().unwrap_or(false);
    let focused = q.is_focused().unwrap_or(false);
    let minimized = q.is_minimized().unwrap_or(false);
    if visible && focused && !minimized {
        native::remember_quick_pos(app);
        let _ = q.hide();
        return;
    }
    if !visible {
        native::place_quick(app);
    }
    native::update_dock(app);
    let _ = q.unminimize();
    let _ = q.show();
    let _ = q.set_focus();
    // 通知快捷窗:被唤出了(剪贴板预填「假划词」、聚焦输入框、300ms 内不触发失焦隐藏)
    let _ = app.emit_to("quick", "quick-shown", ());
}

/// 划词 / 截图流程唤出快捷窗:只显示、不隐藏(与 ⌥T 的切换语义不同),也不触发剪贴板预填(不发 quick-shown)
pub fn summon_quick(app: &tauri::AppHandle) {
    if native::mini_visible(app) {
        native::expand_quick(app);
    }
    let Some(q) = app.get_webview_window("quick") else { return };
    if !q.is_visible().unwrap_or(false) {
        native::place_quick(app);
    }
    native::update_dock(app);
    let _ = q.unminimize();
    let _ = q.show();
    let _ = q.set_focus();
}

/// 截图前先把快捷窗让开(它常驻置顶,会挡住要截的内容);返回此前是否可见
pub fn hide_quick(app: &tauri::AppHandle) -> bool {
    let Some(q) = app.get_webview_window("quick") else { return false };
    if !q.is_visible().unwrap_or(false) {
        return false;
    }
    native::remember_quick_pos(app);
    let _ = q.hide();
    true
}

/// 划词替换进行中:托盘标题显示「译…」(无窗口流程的唯一进度提示);结束后恢复热键告警标记
pub fn tray_busy(app: &tauri::AppHandle, busy: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let warn = app
        .try_state::<HotkeyState>()
        .map(|st| st.0.lock().unwrap().values().any(|s| s.error.is_some()))
        .unwrap_or(false);
    let _ = tray.set_title(if busy { Some("译…") } else if warn { Some("!") } else { None });
}

/// 全局热键动作:quick 唤出快捷窗 / selection 划词翻译 / screenshot 截图翻译 / replace 划词替换
pub const HOTKEY_ACTIONS: [&str; 4] = ["quick", "selection", "screenshot", "replace"];

fn action_label(action: &str) -> &'static str {
    match action {
        "selection" => "划词翻译",
        "screenshot" => "截图翻译",
        "replace" => "翻译并替换",
        _ => "快捷翻译",
    }
}

/// 热键注册状态(v0.3 §1:注册失败必须可见,不再只 eprintln);按动作各一份
#[derive(Default)]
pub struct HotkeyState(pub Mutex<HotkeyMap>);

pub type HotkeyMap = std::collections::BTreeMap<String, HotkeyStatus>;

#[derive(serde::Serialize, Clone, Default, Debug)]
pub struct HotkeyStatus {
    /// 当前应生效的组合键(空 = 未设置,该动作停用)
    pub accel: String,
    /// None = 已注册;Some = 注册失败原因(多半被其他应用占用)
    pub error: Option<String>,
}

const TRAY_ID: &str = "yidu-tray";

fn build_tray_menu(app: &tauri::AppHandle, statuses: &HotkeyMap) -> tauri::Result<Menu<tauri::Wry>> {
    // 待复习生词数(v0.6;安静提示,不发通知)
    let due = app
        .try_state::<translate::AppState>()
        .and_then(|st| st.db.review_count(db::now()).ok())
        .unwrap_or(0);
    let review_label = if due > 0 { format!("复习生词({due} 个待复习)") } else { "复习生词".to_string() };
    let review = MenuItem::with_id(app, "review", review_label, true, None::<&str>)?;
    let open_main = MenuItem::with_id(app, "open-main", "打开主窗口", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "toggle-quick", "快捷翻译", true, None::<&str>)?;
    let shot = MenuItem::with_id(app, "screenshot", "截图翻译", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出译读", true, None::<&str>)?;
    let failed: Vec<String> = HOTKEY_ACTIONS
        .iter()
        .filter_map(|a| statuses.get(*a).filter(|s| s.error.is_some()).map(|s| format!("{} {}", action_label(a), pretty_accel(&s.accel))))
        .collect();
    if !failed.is_empty() {
        let warn = MenuItem::with_id(
            app,
            "hotkey-fix",
            format!("⚠ 热键注册失败({}),点此改键…", failed.join("、")),
            true,
            None::<&str>,
        )?;
        let sep = PredefinedMenuItem::separator(app)?;
        let items: [&dyn tauri::menu::IsMenuItem<tauri::Wry>; 7] = [&warn, &sep, &quick, &shot, &review, &open_main, &quit];
        Menu::with_items(app, &items)
    } else {
        Menu::with_items(app, &[&open_main, &quick, &shot, &review, &quit])
    }
}

/// 重建托盘菜单(待复习数变了:评分 / 删词 / 托盘被点开时)
pub fn refresh_tray(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let map = app.try_state::<HotkeyState>().map(|st| st.0.lock().unwrap().clone()).unwrap_or_default();
    if let Ok(menu) = build_tray_menu(app, &map) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn pretty_accel(a: &str) -> String {
    a.replace("CommandOrControl", "⌘")
        .replace("Alt", "⌥")
        .replace("Shift", "⇧")
        .replace("Control", "⌃")
        .replace('+', "")
}

/// 更新某动作的热键状态:托盘标题/菜单 + 广播 `hotkey-status`(全量 map;设置页据此标红)
pub fn set_hotkey_status(app: &tauri::AppHandle, action: &str, accel: &str, error: Option<String>) {
    if let Some(e) = &error {
        eprintln!("[译读] {}热键 {accel} 注册失败(可能被占用):{e}", action_label(action));
    }
    let Some(st) = app.try_state::<HotkeyState>() else { return };
    let map = {
        let mut m = st.0.lock().unwrap();
        m.insert(action.to_string(), HotkeyStatus { accel: accel.to_string(), error });
        m.clone()
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app, &map) {
            let _ = tray.set_menu(Some(menu));
        }
        let warn = map.values().any(|s| s.error.is_some());
        let _ = tray.set_title(if warn { Some("!") } else { None::<&str> });
        let quick = map.get("quick").cloned().unwrap_or_default();
        let tip = if warn {
            "译读 · 有热键注册失败".to_string()
        } else {
            format!("译读 · {} 唤出快捷翻译", pretty_accel(&quick.accel))
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    let _ = app.emit("hotkey-status", map);
}

/// 打开主窗;settings = 改为打开独立设置窗口的「快捷窗」分区(热键改键入口)
pub fn show_main(app: &tauri::AppHandle, settings: bool) {
    if settings {
        native::show_settings(app, Some("quick"));
        return;
    }
    if let Some(m) = app.get_webview_window("main") {
        native::make_regular(app);
        let _ = m.show();
        let _ = m.unminimize();
        let _ = m.set_focus();
    }
}

/// 热键按下:quick 走唤出语义;其余三个是取词 / 截图流程(耗时,放后台线程)
fn on_hotkey(app: &tauri::AppHandle, action: &'static str) {
    if action == "quick" {
        toggle_quick(app);
    } else {
        flow::spawn(app, action);
    }
}

/// 注册某动作的热键(空 = 停用,不注册;重复注册同一键会报错,调用方先 unregister)
pub fn register_hotkey(app: &tauri::AppHandle, action: &str, accel: &str) -> Result<()> {
    if accel.is_empty() {
        return Ok(());
    }
    let action: &'static str = HOTKEY_ACTIONS.iter().copied().find(|a| *a == action).unwrap_or("quick");
    app.global_shortcut().on_shortcut(accel, move |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            on_hotkey(app, action);
        }
    })?;
    Ok(())
}

/// 改键:注销旧键(旧键可能从未注册成功,注销失败不阻断)→ 注册新键;
/// 新键失败则尽力恢复旧键并返回错误(调用方不落库,偏好保持旧值)。
pub fn reregister_hotkey(app: &tauri::AppHandle, action: &str, old: &str, new: &str) -> Result<()> {
    let gs = app.global_shortcut();
    if old == new {
        return Ok(());
    }
    if !old.is_empty() && gs.is_registered(old) {
        let _ = gs.unregister(old);
    }
    match register_hotkey(app, action, new) {
        Ok(()) => {
            set_hotkey_status(app, action, new, None);
            Ok(())
        }
        Err(e) => {
            let rollback = register_hotkey(app, action, old).err().map(|e| e.to_string());
            set_hotkey_status(app, action, old, rollback);
            Err(anyhow::anyhow!("热键 {} 注册失败(可能被其他应用或本应用其他动作占用):{e}", pretty_accel(new)))
        }
    }
}

/// 关闭即隐藏(v0.3 §1):红灯 / ⌘W 不再销毁 webview,⌥T / 托盘始终可唤回;
/// 获焦时重读系统强调色(§2.7:改强调色须去系统设置,回来必获焦)
fn hide_on_close(app: &tauri::AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let w2 = w.clone();
        let app2 = app.clone();
        w.on_window_event(move |e| match e {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if w2.label() == "quick" {
                    native::remember_quick_pos(&app2);
                }
                let _ = w2.hide();
                native::update_dock(&app2);
            }
            tauri::WindowEvent::Focused(true) => native::refresh_accent(&app2),
            _ => {}
        });
    }
}

#[cfg_attr(mobile, tauri_mobile_entry)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            WindowStateBuilder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE) // 重启不自动显示快捷窗
                .with_denylist(&["settings", "quick-mini"]) // 设置窗固定尺寸、每次居中;缩小图标跟随快捷窗定位
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build()) // 软件内更新(GitHub Releases)
        .plugin(tauri_plugin_process::init()) // 更新后 relaunch
        .setup(|app| {
            // DB
            let db = Arc::new(db::init(&app.handle())?);
            app.manage(translate::AppState {
                db: db.clone(),
                active: Arc::new(AtomicU64::new(0)),
                counter: AtomicU64::new(0),
            });
            // dev:key 走 YIDU_DEV_PROVIDER_KEY 环境变量(keychain::effective_key),
            // 不写 Keychain —— 避免 SecItemUpdate 触发系统授权弹框把 setup 卡死。

            app.manage(HotkeyState::default());
            native::load_quick_pos(app.handle());
            native::setup_quick_window(app.handle());
            app.manage(native::AccentState(std::sync::Mutex::new(native::current_accent())));

            // 关闭即隐藏:主窗与快捷窗
            hide_on_close(app.handle(), "main");
            hide_on_close(app.handle(), "quick");

            // tray:唤出主窗/快捷窗、退出(热键失败时首项为「改键」入口)
            let stored = commands::load_prefs(&db)?;
            let eff = commands::effective_prefs(&stored);
            // 热键触发的临时翻译:24h 未「存入文章库」即清理
            let _ = db.prune_ephemeral(db::now() - 24 * 3600);

            // 外观三态(Rust 权威)+ 应用菜单(macOS:自定义菜单须自带编辑菜单)
            #[cfg(target_os = "macos")]
            native::install_menu(app.handle(), &eff.theme_mode)?;
            native::apply_theme_mode(app.handle(), &eff.theme_mode);
            let menu = build_tray_menu(app.handle(), &HotkeyMap::new())?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().expect("缺少应用图标").clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open-main" => show_main(app, false),
                    "hotkey-fix" => show_main(app, true),
                    "toggle-quick" => toggle_quick(app),
                    "screenshot" => flow::spawn(app, "screenshot"),
                    "review" => {
                        show_main(app, false);
                        let _ = app.emit_to("main", "open-review", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // 待复习数随时间增长(词到期):托盘菜单每 10 分钟重建一次
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(600)).await;
                        refresh_tray(&handle);
                    }
                });
            }

            // 全局热键(可配置,存 app_state);失败 → 托盘「!」+ 菜单改键入口 + hotkey-status 事件
            for (action, accel) in commands::hotkeys_of(&eff) {
                let err = register_hotkey(app.handle(), action, &accel).err().map(|e| e.to_string());
                set_hotkey_status(app.handle(), action, &accel, err);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_articles,
            commands::get_article,
            commands::pin_article,
            commands::delete_article,
            commands::translate,
            commands::cancel_translate,
            commands::provider_list,
            commands::provider_save,
            commands::provider_delete,
            commands::provider_set_key,
            commands::provider_set_active,
            commands::provider_test,
            commands::provider_test_form,
            commands::provider_models,
            commands::provider_key_hint,
            commands::thinking_preview,
            commands::reset_block,
            commands::lookup_word,
            commands::vocab_add,
            commands::vocab_list,
            commands::vocab_examples,
            commands::vocab_delete,
            commands::glossary_list,
            commands::glossary_add,
            commands::glossary_set_enabled,
            commands::glossary_delete,
            commands::get_prefs,
            commands::set_prefs,
            commands::usage_summary,
            commands::usage_report,
            commands::hotkey_status,
            commands::get_accent,
            commands::open_settings,
            commands::quick_minimize,
            commands::quick_expand,
            commands::article_keep,
            commands::ocr_image,
            commands::permission_status,
            commands::permission_request,
            commands::replace_translate,
            commands::review_count,
            commands::review_due,
            commands::review_grade,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

/// 主窗关闭即隐藏后,点 Dock 图标应唤回主窗
#[cfg(target_os = "macos")]
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
        if !has_visible_windows {
            show_main(app, false);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn handle_run_event(_app: &tauri::AppHandle, _event: tauri::RunEvent) {}
