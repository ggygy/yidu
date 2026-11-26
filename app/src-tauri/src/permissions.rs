// 系统权限(v0.4):macOS 的「辅助功能」(划词取词 / 模拟按键)与「屏幕录制」(截图)。
// Windows 无对应授权步骤,恒视为已授予。首次使用时由快捷窗引导(quick-permission 事件),设置页显示状态。
use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub screen: bool,
    /// 此平台是否需要用户授权(false = 不显示权限相关界面)
    pub applicable: bool,
}

pub fn status() -> PermissionStatus {
    PermissionStatus { accessibility: accessibility_granted(), screen: screen_granted(), applicable: cfg!(target_os = "macos") }
}

#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn accessibility() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }

    pub fn screen() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    /// 触发系统授权框(系统只弹一次;之后需用户自己去系统设置里勾选)并打开对应设置面板
    pub fn request(kind: &str) {
        let pane = if kind == "screen" {
            unsafe { CGRequestScreenCaptureAccess() };
            "Privacy_ScreenCapture"
        } else {
            unsafe {
                let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
                let opts = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
                AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef());
            }
            "Privacy_Accessibility"
        };
        let _ = std::process::Command::new("/usr/bin/open")
            .arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"))
            .spawn();
    }
}

pub fn accessibility_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::accessibility()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

pub fn screen_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::screen()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// kind:accessibility | screen
pub fn request(kind: &str) {
    #[cfg(target_os = "macos")]
    mac::request(kind);
    let _ = kind;
}
