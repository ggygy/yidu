// 划词取词 / 回贴(v0.4):辅助功能 API 优先,取不到(Electron、部分浏览器)→ 模拟复制 + 还原剪贴板。
// 全部是阻塞调用(含若干毫秒级等待),调用方放独立线程(flow.rs)。
use anyhow::Result;

/// 取词失败的可区分原因
#[derive(Debug)]
pub enum SelError {
    /// macOS 未授予「辅助功能」权限
    NeedAccessibility,
    Other(anyhow::Error),
}

impl From<anyhow::Error> for SelError {
    fn from(e: anyhow::Error) -> Self {
        SelError::Other(e)
    }
}

/// 当前前台应用的标识(macOS = pid;Windows = 前台窗口句柄)。划词替换据此确认「回贴时还在原应用」
pub fn frontmost() -> i64 {
    platform::frontmost()
}

/// 取当前选中文本;没有选区 → Ok(None)
pub fn get_selection<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Option<String>, SelError> {
    let text = platform::get_selection(app)?;
    Ok(text.map(|t| t.trim_matches(|c| c == '\r' || c == '\n').to_string()).filter(|t| !t.trim().is_empty()))
}

/// 用 text 覆盖当前选区(写剪贴板 → 模拟粘贴 → 还原剪贴板)
pub fn paste_over_selection<R: tauri::Runtime>(app: &tauri::AppHandle<R>, text: &str) -> Result<()> {
    platform::paste_over_selection(app, text)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::SelError;
    use anyhow::{anyhow, Result};
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2::msg_send;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSWorkspace};
    use objc2_foundation::{NSArray, NSData, NSString};
    use std::ffi::c_void;
    use std::time::{Duration, Instant};

    type AXUIElementRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_secs: f32) -> i32;
        fn CGEventSourceFlagsState(state_id: i32) -> u64;
    }

    const KEY_C: CGKeyCode = 8;
    const KEY_V: CGKeyCode = 9;
    /// ⇧ ⌃ ⌥ ⌘ 四个修饰键位
    const MODIFIER_MASK: u64 = 0x0002_0000 | 0x0004_0000 | 0x0008_0000 | 0x0010_0000;

    pub fn frontmost() -> i64 {
        autoreleasepool(|_| {
            NSWorkspace::sharedWorkspace()
                .frontmostApplication()
                .map(|a| {
                    // processIdentifier 的绑定在 objc2-app-kit 里挂在 libc feature 后面,直接发消息
                    let pid: i32 = unsafe { msg_send![&*a, processIdentifier] };
                    pid as i64
                })
                .unwrap_or(0)
        })
    }

    /// 读 AX 属性(Copy 规则:返回值归我们释放)
    unsafe fn ax_copy(element: AXUIElementRef, attr: &str) -> Option<CFType> {
        let name = CFString::new(attr);
        let mut value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, name.as_concrete_TypeRef(), &mut value);
        if err != 0 || value.is_null() {
            return None;
        }
        Some(CFType::wrap_under_create_rule(value))
    }

    /// 系统级元素 → 焦点元素 → AXSelectedText
    fn ax_selected_text() -> Option<String> {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }
            let system = CFType::wrap_under_create_rule(system as CFTypeRef);
            // 目标应用卡住时别把热键线程挂死(默认超时 6s)
            AXUIElementSetMessagingTimeout(system.as_CFTypeRef() as AXUIElementRef, 0.6);
            let focused = ax_copy(system.as_CFTypeRef() as AXUIElementRef, "AXFocusedUIElement")?;
            let text = ax_copy(focused.as_CFTypeRef() as AXUIElementRef, "AXSelectedText")?;
            text.downcast::<CFString>().map(|s| s.to_string())
        }
    }

    /// 剪贴板全量快照:每个条目的 (类型, 数据)。模拟复制 / 粘贴后原样写回,图片等非文本内容也不丢
    type Snapshot = Vec<Vec<(Retained<NSString>, Retained<NSData>)>>;

    fn snapshot(pb: &NSPasteboard) -> Snapshot {
        let mut out = Vec::new();
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                let mut entry = Vec::new();
                for ty in item.types().iter() {
                    if let Some(data) = item.dataForType(&ty) {
                        entry.push((ty.clone(), data));
                    }
                }
                if !entry.is_empty() {
                    out.push(entry);
                }
            }
        }
        out
    }

    fn restore(pb: &NSPasteboard, snap: &Snapshot) {
        pb.clearContents();
        if snap.is_empty() {
            return;
        }
        let items: Vec<Retained<NSPasteboardItem>> = snap
            .iter()
            .map(|entry| {
                let item = NSPasteboardItem::new();
                for (ty, data) in entry {
                    item.setData_forType(data, ty);
                }
                item
            })
            .collect();
        let arr = NSArray::from_retained_slice(&items);
        let _: bool = unsafe { msg_send![pb, writeObjects: &*arr as *const NSArray<NSPasteboardItem> as *const AnyObject] };
    }

    /// 等用户松开热键的修饰键(⌥D 的 ⌥ 仍按着时发 ⌘C 会变成 ⌘⌥C)
    fn wait_modifiers_released(max: Duration) {
        let t0 = Instant::now();
        while t0.elapsed() < max {
            if unsafe { CGEventSourceFlagsState(CGEventSourceStateID::HIDSystemState as i32) } & MODIFIER_MASK == 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    /// 发一次 ⌘+key;事件上的修饰键强制只有 ⌘
    fn post_cmd_key(key: CGKeyCode) -> Result<()> {
        let source = || CGEventSource::new(CGEventSourceStateID::CombinedSessionState).map_err(|_| anyhow!("无法创建键盘事件源"));
        let down = CGEvent::new_keyboard_event(source()?, key, true).map_err(|_| anyhow!("无法创建键盘事件"))?;
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post(CGEventTapLocation::HID);
        let up = CGEvent::new_keyboard_event(source()?, key, false).map_err(|_| anyhow!("无法创建键盘事件"))?;
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }

    pub fn get_selection<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Result<Option<String>, SelError> {
        if !crate::permissions::accessibility_granted() {
            return Err(SelError::NeedAccessibility);
        }
        if let Some(t) = ax_selected_text().filter(|t| !t.trim().is_empty()) {
            return Ok(Some(t));
        }
        // 兜底:模拟 ⌘C,看剪贴板 changeCount 是否变化(没选区时不变 → None)
        autoreleasepool(|_| {
            let pb = NSPasteboard::generalPasteboard();
            let snap = snapshot(&pb);
            let before = pb.changeCount();
            wait_modifiers_released(Duration::from_millis(600));
            post_cmd_key(KEY_C)?;
            let t0 = Instant::now();
            let mut copied = None;
            while t0.elapsed() < Duration::from_millis(700) {
                std::thread::sleep(Duration::from_millis(20));
                if pb.changeCount() != before {
                    // 部分应用分两步写(先清空再填),稍等内容落定
                    std::thread::sleep(Duration::from_millis(40));
                    copied = pb.stringForType(unsafe { NSPasteboardTypeString }).map(|s| s.to_string());
                    break;
                }
            }
            if pb.changeCount() != before {
                restore(&pb, &snap);
            }
            Ok(copied)
        })
    }

    pub fn paste_over_selection<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, text: &str) -> Result<()> {
        autoreleasepool(|_| {
            let pb = NSPasteboard::generalPasteboard();
            let snap = snapshot(&pb);
            pb.clearContents();
            if !pb.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }) {
                restore(&pb, &snap);
                return Err(anyhow!("写入剪贴板失败"));
            }
            wait_modifiers_released(Duration::from_millis(600));
            let posted = post_cmd_key(KEY_V);
            // 目标应用读剪贴板是异步的:等它粘完再还原
            std::thread::sleep(Duration::from_millis(350));
            restore(&pb, &snap);
            posted
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// 用一次性的私有剪贴板(不碰用户的通用剪贴板)验证「快照 → 改写 → 还原」。
        /// 需要能连上系统剪贴板服务(沙箱 / 无图形会话里拿不到)→ `cargo test -- --ignored pasteboard`
        #[test]
        #[ignore]
        fn pasteboard_snapshot_restores_all_items() {
            autoreleasepool(|_| {
                let pb = NSPasteboard::pasteboardWithUniqueName();
                let ty = unsafe { NSPasteboardTypeString };
                pb.clearContents();
                assert!(pb.setString_forType(&NSString::from_str("原来的内容"), ty));
                let custom = NSString::from_str("com.yidu.test-type");
                assert!(pb.setData_forType(Some(&NSData::with_bytes(&[1, 2, 3])), &custom));
                let snap = snapshot(&pb);
                assert_eq!(snap.len(), 1);

                pb.clearContents();
                pb.setString_forType(&NSString::from_str("译文"), ty);
                assert_eq!(pb.stringForType(ty).unwrap().to_string(), "译文");

                restore(&pb, &snap);
                assert_eq!(pb.stringForType(ty).unwrap().to_string(), "原来的内容");
                assert_eq!(pb.dataForType(&custom).unwrap().to_vec(), vec![1, 2, 3]);

                // 空快照 → 还原为空剪贴板
                restore(&pb, &Vec::new());
                assert!(pb.stringForType(ty).is_none());
                let _: () = unsafe { msg_send![&*pb, releaseGlobally] };
            });
        }

        #[test]
        fn frontmost_and_permission_probes_do_not_crash() {
            let _ = frontmost();
            let st = crate::permissions::status();
            assert!(st.applicable);
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::SelError;
    use anyhow::{anyhow, Result};
    use std::time::{Duration, Instant};
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_C, VK_CONTROL, VK_LWIN, VK_MENU,
        VK_SHIFT, VK_V,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    pub fn frontmost() -> i64 {
        unsafe { GetForegroundWindow().0 as i64 }
    }

    /// UI Automation:焦点元素的 TextPattern 选区
    fn uia_selected_text() -> Option<String> {
        unsafe {
            // 本线程可能已初始化过 COM(返回 S_FALSE / RPC_E_CHANGED_MODE),都不影响后续调用
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let focused = uia.GetFocusedElement().ok()?;
            let pattern: IUIAutomationTextPattern = focused.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
            let ranges = pattern.GetSelection().ok()?;
            let n = ranges.Length().ok()?;
            let mut out = String::new();
            for i in 0..n {
                if let Ok(range) = ranges.GetElement(i) {
                    if let Ok(text) = range.GetText(-1) {
                        out.push_str(&text.to_string());
                    }
                }
            }
            Some(out)
        }
    }

    fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
            },
        }
    }

    /// 等用户松开热键的修饰键(Alt+D 的 Alt 仍按着时发 Ctrl+C 会变成 Ctrl+Alt+C)
    fn wait_modifiers_released(max: Duration) {
        let t0 = Instant::now();
        let down = |vk: VIRTUAL_KEY| unsafe { (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0 };
        while t0.elapsed() < max {
            if !down(VK_MENU) && !down(VK_SHIFT) && !down(VK_CONTROL) && !down(VK_LWIN) {
                return;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    fn send_ctrl(vk: VIRTUAL_KEY) -> Result<()> {
        let inputs = [key(VK_CONTROL, false), key(vk, false), key(vk, true), key(VK_CONTROL, true)];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err(anyhow!("模拟按键被系统拦截"));
        }
        Ok(())
    }

    pub fn get_selection<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Option<String>, SelError> {
        if let Some(t) = uia_selected_text().filter(|t| !t.trim().is_empty()) {
            return Ok(Some(t));
        }
        // 兜底:模拟 Ctrl+C,看剪贴板序号是否变化;只能还原文本(原剪贴板若是图片 / 文件会丢)
        let previous = app.clipboard().read_text().ok();
        let before = unsafe { GetClipboardSequenceNumber() };
        wait_modifiers_released(Duration::from_millis(600));
        send_ctrl(VK_C)?;
        let t0 = Instant::now();
        let mut copied = None;
        while t0.elapsed() < Duration::from_millis(700) {
            std::thread::sleep(Duration::from_millis(20));
            if unsafe { GetClipboardSequenceNumber() } != before {
                std::thread::sleep(Duration::from_millis(40));
                copied = app.clipboard().read_text().ok();
                break;
            }
        }
        if unsafe { GetClipboardSequenceNumber() } != before {
            if let Some(p) = previous {
                let _ = app.clipboard().write_text(p);
            }
        }
        Ok(copied)
    }

    pub fn paste_over_selection<R: tauri::Runtime>(app: &tauri::AppHandle<R>, text: &str) -> Result<()> {
        let previous = app.clipboard().read_text().ok();
        app.clipboard().write_text(text.to_string()).map_err(|e| anyhow!("写入剪贴板失败:{e}"))?;
        wait_modifiers_released(Duration::from_millis(600));
        let sent = send_ctrl(VK_V);
        std::thread::sleep(Duration::from_millis(350));
        if let Some(p) = previous {
            let _ = app.clipboard().write_text(p);
        }
        sent
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::SelError;
    use anyhow::{anyhow, Result};

    pub fn frontmost() -> i64 {
        0
    }
    pub fn get_selection<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Result<Option<String>, SelError> {
        Err(SelError::Other(anyhow!("此平台暂不支持划词")))
    }
    pub fn paste_over_selection<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _text: &str) -> Result<()> {
        Err(anyhow!("此平台暂不支持划词替换"))
    }
}
