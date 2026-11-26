// 热键流程编排(v0.4):划词翻译 / 截图翻译 / 划词替换。
// 取词、截图、OCR 都是阻塞的,整条流程跑在独立线程;结果经事件交给快捷窗(其 webview 常驻):
//   quick-capture       { text, origin }   填入并立即翻译(不自动入库)
//   quick-capture-busy  { origin }         截图已取到,识别中
//   quick-notice        { message, error } 没取到文本 / 失败
//   quick-permission    { kind }           缺系统权限,显示引导
//   replace-request     { text, front }    划词替换:由 webview 判定方向后回调 replace_translate(窗口不显示)
use crate::selection::{self, SelError};
use crate::{capture, ocr, permissions};
use anyhow::{anyhow, Result};
use base64::Engine;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Emitter, Manager};

/// 流程代数:新流程启动即让仍在等待的旧流程(如 Windows 等截图)放弃
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
struct Capture<'a> {
    text: &'a str,
    origin: &'a str,
}

#[derive(Serialize, Clone)]
struct Notice<'a> {
    message: &'a str,
    error: bool,
}

pub fn spawn(app: &tauri::AppHandle, action: &'static str) {
    let app = app.clone();
    std::thread::spawn(move || run(&app, action));
}

/// 唤出快捷窗(窗口操作回主线程)
fn summon(app: &tauri::AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || crate::summon_quick(&a));
}

fn notice(app: &tauri::AppHandle, message: &str, error: bool) {
    summon(app);
    let _ = app.emit_to("quick", "quick-notice", Notice { message, error });
}

fn need_permission(app: &tauri::AppHandle, kind: &str) {
    summon(app);
    let _ = app.emit_to("quick", "quick-permission", serde_json::json!({ "kind": kind }));
}

/// 取选区;失败 / 为空时已向用户反馈,返回 None
fn selection_or_report(app: &tauri::AppHandle) -> Option<String> {
    match selection::get_selection(app) {
        Ok(Some(t)) => Some(t),
        Ok(None) => {
            notice(app, "没有取到选中的文本:先选中文字,再按快捷键", false);
            None
        }
        Err(SelError::NeedAccessibility) => {
            need_permission(app, "accessibility");
            None
        }
        Err(SelError::Other(e)) => {
            notice(app, &format!("取词失败:{e}"), true);
            None
        }
    }
}

fn run(app: &tauri::AppHandle, action: &'static str) {
    let my = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let superseded = || GENERATION.load(Ordering::SeqCst) != my;
    match action {
        "selection" => {
            if let Some(text) = selection_or_report(app) {
                summon(app);
                let _ = app.emit_to("quick", "quick-capture", Capture { text: &text, origin: "selection" });
            }
        }
        "replace" => {
            if let Some(text) = selection_or_report(app) {
                let front = selection::frontmost();
                let _ = app.emit_to("quick", "replace-request", serde_json::json!({ "text": text, "front": front }));
            }
        }
        "screenshot" => {
            // 快捷窗常驻置顶,先让开再截;取消截图时若原本开着就恢复
            let was_visible = {
                let (tx, rx) = std::sync::mpsc::channel();
                let a = app.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = tx.send(crate::hide_quick(&a));
                });
                rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or(false)
            };
            if was_visible {
                std::thread::sleep(std::time::Duration::from_millis(180)); // 等窗口淡出,免得被截进去
            }
            let bytes = match capture::capture_region(app, &superseded) {
                Ok(Some(b)) => b,
                Ok(None) => {
                    if was_visible {
                        summon(app);
                    }
                    return; // 用户取消
                }
                Err(e) if e.downcast_ref::<capture::NeedScreenPermission>().is_some() => return need_permission(app, "screen"),
                Err(e) => return notice(app, &format!("截图失败:{e}"), true),
            };
            summon(app);
            let _ = app.emit_to("quick", "quick-capture-busy", serde_json::json!({ "origin": "screenshot" }));
            match tauri::async_runtime::block_on(recognize(app, bytes, "image/png".into())) {
                Ok(out) if out.text.trim().is_empty() => {
                    // 没授「屏幕录制」时系统只给桌面背景,自然识别不到字
                    if !permissions::screen_granted() {
                        need_permission(app, "screen");
                    } else {
                        notice(app, "未在截图中识别到文字", false);
                    }
                }
                Ok(out) => {
                    if let Some(note) = &out.note {
                        let _ = app.emit_to("quick", "quick-notice", Notice { message: note, error: false });
                    }
                    let _ = app.emit_to("quick", "quick-capture", Capture { text: &out.text, origin: "screenshot" });
                }
                Err(e) => notice(app, &format!("文字识别失败:{e}"), true),
            }
        }
        _ => {}
    }
}

// ---------- OCR 编排:本机引擎 / 多模态模型(失败回落本机) ----------

#[derive(Serialize, Clone, Debug)]
pub struct OcrOutput {
    pub text: String,
    /// system | model
    pub engine: String,
    /// 需要告诉用户的事(如:模型识别失败已改用本机)
    pub note: Option<String>,
}

/// 多模态模型能直接吃的图片格式(剪贴板里的 TIFF 等不行 → 走本机识别)
fn model_mime(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

async fn recognize_with_model(db: &crate::db::Db, prefs: &crate::commands::PrefsEffective, bytes: &[u8]) -> Result<String> {
    let mime = model_mime(bytes).ok_or_else(|| anyhow!("该图片格式不支持模型识别"))?;
    let mut row = match prefs.ocr_provider_id.and_then(|id| db.get_provider(id).ok()) {
        Some(r) => r,
        None => db.active_provider()?.ok_or_else(|| anyhow!("尚未配置模型"))?,
    };
    if !prefs.ocr_model.is_empty() {
        row.model = prefs.ocr_model.clone();
    }
    let provider = tauri::async_runtime::spawn_blocking(move || crate::providers::build(&row))
        .await
        .map_err(|e| anyhow!("{e}"))??;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let text = provider.transcribe_image(&b64, mime).await?;
    Ok(text.trim().to_string())
}

/// 图片字节 → 文本。引擎按偏好;模型失败自动回落本机识别并附说明
pub async fn recognize(app: &tauri::AppHandle, bytes: Vec<u8>, _mime: String) -> Result<OcrOutput> {
    let db = app.state::<crate::translate::AppState>().db.clone();
    let prefs = crate::commands::effective_prefs(&crate::commands::load_prefs(&db).map_err(|e| anyhow!(e))?);
    let mut note = None;
    if prefs.ocr_engine == "model" {
        match recognize_with_model(&db, &prefs, &bytes).await {
            Ok(text) => return Ok(OcrOutput { text, engine: "model".into(), note: None }),
            Err(e) => {
                let short: String = e.to_string().chars().take(120).collect();
                note = Some(format!("模型识别失败,已改用本机识别:{short}"));
            }
        }
    }
    let langs = ocr::langs_for_direction(&prefs.direction);
    let text = tauri::async_runtime::spawn_blocking(move || ocr::recognize_text(&bytes, &langs))
        .await
        .map_err(|e| anyhow!("{e}"))??;
    Ok(OcrOutput { text, engine: "system".into(), note })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_mime_sniffs_supported_formats() {
        assert_eq!(model_mime(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(model_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(model_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));
        assert_eq!(model_mime(b"II*\x00tiff"), None);
        assert_eq!(model_mime(b""), None);
    }
}
