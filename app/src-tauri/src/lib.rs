// 装配:window-state(禁可见性恢复)+ 全局快捷键(Rust 侧权威)+ 剪贴板 + tray + DB + 命令
mod batch;
mod blocks;
mod commands;
mod db;
mod dict;
mod keychain;
mod prompt;
mod providers;
mod sse;
mod translate;
mod validate;

use anyhow::Result;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags};

/// 快捷窗唤出/隐藏(权威状态在 Rust 侧 isVisible)
pub fn toggle_quick(app: &tauri::AppHandle) {
    if let Some(q) = app.get_webview_window("quick") {
        if q.is_visible().unwrap_or(false) {
            let _ = q.hide();
        } else {
            let _ = q.show();
            let _ = q.set_focus();
            // 通知快捷窗:被唤出了(用于剪贴板预填「假划词」)
            let _ = app.emit_to("quick", "quick-shown", ());
        }
    }
}

/// 注册热键(重复注册同一键会报错,调用方先 unregister)
pub fn register_hotkey(app: &tauri::AppHandle, accel: &str) -> Result<()> {
    app.global_shortcut().on_shortcut(accel, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            toggle_quick(app);
        }
    })?;
    Ok(())
}

/// 改键:先注旧再注新;失败时回滚旧键,避免用户失去唤出能力
pub fn reregister_hotkey(app: &tauri::AppHandle, old: &str, new: &str) -> Result<()> {
    let gs = app.global_shortcut();
    if old == new {
        return Ok(());
    }
    gs.unregister(old)?;
    if let Err(e) = register_hotkey(app, new) {
        let _ = register_hotkey(app, old); // 回滚
        return Err(e);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri_mobile_entry)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            WindowStateBuilder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE) // 重启不自动显示快捷窗
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
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

            // tray:唤出主窗/快捷窗、退出
            let open_main = MenuItem::with_id(app, "open-main", "打开主窗口", true, None::<&str>)?;
            let quick = MenuItem::with_id(app, "toggle-quick", "快捷翻译", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出译读", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_main, &quick, &quit])?;
            TrayIconBuilder::with_id("yidu-tray")
                .icon(app.default_window_icon().expect("缺少应用图标").clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open-main" => {
                        if let Some(m) = app.get_webview_window("main") {
                            let _ = m.show();
                            let _ = m.set_focus();
                        }
                    }
                    "toggle-quick" => toggle_quick(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // 全局热键(默认 ⌥T,可配置,存 app_state)
            let stored = commands::load_prefs(&db)?;
            let accel = commands::effective_prefs(&stored).hotkey;
            if let Err(e) = register_hotkey(&app.handle(), &accel) {
                eprintln!("[译读] 热键 {accel} 注册失败(可能被占用):{e}");
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
