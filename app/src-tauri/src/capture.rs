// 区域截图(v0.4,走系统自带工具):
// macOS = `screencapture -i`(原生十字框选,写临时文件,不碰剪贴板);
// Windows = 截图工具 `ms-screenclip:`(结果只进剪贴板 → 监视剪贴板序号取图;会覆盖用户剪贴板)。
// 阻塞调用,放独立线程;返回 PNG 编码字节,用户取消 → Ok(None)。
use anyhow::{anyhow, Result};

/// 系统拒绝截屏(macOS 未授「屏幕录制」):flow 据此显示权限引导,而不是当成用户取消
#[derive(Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct NeedScreenPermission;

impl std::fmt::Display for NeedScreenPermission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("没有屏幕录制权限")
    }
}

impl std::error::Error for NeedScreenPermission {}

/// RGBA8 像素 → PNG(Windows 剪贴板取到的是解码后的像素)
#[cfg_attr(not(windows), allow(dead_code))]
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
        return Err(anyhow!("截图数据异常"));
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| anyhow!("PNG 编码失败:{e}"))?;
        writer.write_image_data(rgba).map_err(|e| anyhow!("PNG 编码失败:{e}"))?;
    }
    Ok(out)
}

/// `superseded`:又按了一次热键 / 发起了别的流程 → 放弃等待(Windows 轮询剪贴板时检查)
#[cfg(target_os = "macos")]
pub fn capture_region<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _superseded: &dyn Fn() -> bool) -> Result<Option<Vec<u8>>> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let path = std::env::temp_dir().join(format!("yidu-shot-{}-{nanos}.png", std::process::id()));
    // -i 交互框选(Esc 取消 → 不产生文件);-x 不播快门声
    let out = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-i", "-x", "-t", "png"])
        .arg(&path)
        .output()
        .map_err(|e| anyhow!("无法启动系统截图:{e}"))?;
    let bytes = std::fs::read(&path).ok().filter(|b| !b.is_empty());
    let _ = std::fs::remove_file(&path);
    if bytes.is_none() {
        // 实测:没有「屏幕录制」权限时框选照常出现,但松手后 stderr 报 `could not create image from rect`、不产生文件;
        // 用户按 Esc 取消则 stderr 为空。前者要引导授权,后者静默
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.contains("could not create image") {
            return Err(NeedScreenPermission.into());
        }
        return Ok(None);
    }
    Ok(bytes)
}

#[cfg(windows)]
pub fn capture_region<R: tauri::Runtime>(app: &tauri::AppHandle<R>, superseded: &dyn Fn() -> bool) -> Result<Option<Vec<u8>>> {
    use std::time::{Duration, Instant};
    use tauri_plugin_clipboard_manager::ClipboardExt;
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

    let before = unsafe { GetClipboardSequenceNumber() };
    std::process::Command::new("explorer.exe")
        .arg("ms-screenclip:")
        .spawn()
        .map_err(|e| anyhow!("无法启动系统截图工具:{e}"))?;
    // 截图工具没有「取消」信号:等到剪贴板出现新图片为止,60 秒无结果视为取消
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(150));
        if superseded() {
            return Ok(None);
        }
        if unsafe { GetClipboardSequenceNumber() } == before {
            continue;
        }
        std::thread::sleep(Duration::from_millis(120)); // 等图片数据写完
        if let Ok(img) = app.clipboard().read_image() {
            return encode_png(img.rgba(), img.width(), img.height()).map(Some);
        }
        // 序号变了但不是图片(用户期间复制了别的)→ 继续等
    }
    Ok(None)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn capture_region<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _superseded: &dyn Fn() -> bool) -> Result<Option<Vec<u8>>> {
    Err(anyhow!("此平台暂不支持截图翻译"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_roundtrip_keeps_pixels() {
        let rgba: Vec<u8> = vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 128];
        let png_bytes = encode_png(&rgba, 2, 2).unwrap();
        assert_eq!(&png_bytes[..8], b"\x89PNG\r\n\x1a\n");
        let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes)).read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (2, 2));
        assert_eq!(&buf[..info.buffer_size()], &rgba[..]);
    }

    #[test]
    fn png_rejects_bad_dimensions() {
        assert!(encode_png(&[0; 8], 2, 2).is_err());
        assert!(encode_png(&[], 0, 0).is_err());
    }
}
