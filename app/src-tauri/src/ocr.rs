// 图片 OCR(v0.4;技术路径见 research/12-image-ocr.md)
// 引擎按平台条件编译:macOS = Vision(VNRecognizeTextRequest,同步 performRequests),
// Windows = Windows.Media.Ocr。两边都只产出「带归一化包围盒的行」,阅读序整理 / 去断行 / 分段
// 在平台无关的 normalize() 里做,输出当作「非 md 粘贴文本」进现有翻译管线。
use anyhow::{anyhow, Result};

/// 识别出的一行。坐标归一化到 0..1,**原点在左上角**(各平台引擎自行换算)
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Line {
    fn mid_y(&self) -> f64 {
        self.y + self.h / 2.0
    }
    fn bottom(&self) -> f64 {
        self.y + self.h
    }
}

/// 应用语言代码(zh/en/ja/…,"~自定义名" 忽略)→ 识别语言提示。
/// 源语言明确 → 该语言 + 英文;自动 / 未知 → 空(引擎自动检测,中英优先)
pub fn langs_for_direction(direction: &str) -> Vec<String> {
    let src = direction.split('2').next().unwrap_or("");
    let known = ["zh", "en", "ja", "ko", "fr", "de", "es", "ru"];
    if !known.contains(&src) {
        return Vec::new();
    }
    let mut v = vec![src.to_string()];
    if src != "en" {
        v.push("en".into());
    }
    v
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x9FFF      // 部首 / 假名 / 汉字
        | 0xAC00..=0xD7AF    // 谚文
        | 0xF900..=0xFAFF
        | 0xFF00..=0xFFEF    // 全角标点
        | 0x20000..=0x2FA1F)
}

/// 两段文本拼接:两侧都是 CJK → 直接拼;行尾连字符断词 → 去连字符拼;否则加一个空格
fn join_text(a: &mut String, b: &str) {
    let b = b.trim();
    if b.is_empty() {
        return;
    }
    let last = a.chars().last();
    let first = b.chars().next();
    match (last, first) {
        (None, _) => {}
        (Some(l), Some(f)) if is_cjk(l) && is_cjk(f) => {}
        (Some('-'), Some(f)) if f.is_lowercase() && a.chars().rev().nth(1).is_some_and(|c| c.is_alphabetic()) => {
            a.pop();
        }
        _ => a.push(' '),
    }
    a.push_str(b);
}

/// 行首是列表 / 编号记号:即便行距很近也另起一段(不并进上一行)
fn starts_list_item(s: &str) -> bool {
    let t = s.trim_start();
    let mut it = t.chars();
    match it.next() {
        Some('•' | '·' | '●' | '○' | '■' | '▪' | '◦' | '–' | '—') => true,
        Some('-' | '*' | '+') => it.next() == Some(' '),
        Some(c) if c.is_ascii_digit() => {
            let rest = t.trim_start_matches(|c: char| c.is_ascii_digit());
            (rest.starts_with('.') || rest.starts_with(')') || rest.starts_with('、')) && rest.len() < t.len()
        }
        _ => false,
    }
}

/// 行框 → 归一化纯文本:
/// 1. 按垂直位置分「视觉行」(同一行多个框按 x 升序横向拼);
/// 2. 相邻视觉行间隙 > 0.6 倍行高(约 1.6 倍行距)→ 新段落(空行);
/// 3. 段内各行去断行拼接(CJK 无空格,拉丁加空格,连字符断词复原)。
pub fn normalize(mut lines: Vec<Line>) -> String {
    lines.retain(|l| !l.text.trim().is_empty());
    if lines.is_empty() {
        return String::new();
    }
    lines.sort_by(|a, b| a.mid_y().partial_cmp(&b.mid_y()).unwrap_or(std::cmp::Ordering::Equal));

    // 1. 视觉行
    let mut rows: Vec<Vec<Line>> = Vec::new();
    for l in lines {
        match rows.last_mut() {
            Some(row) if {
                let r = &row[0];
                (l.mid_y() - r.mid_y()).abs() < 0.5 * r.h.min(l.h)
            } =>
            {
                row.push(l)
            }
            _ => rows.push(vec![l]),
        }
    }
    struct Row {
        text: String,
        top: f64,
        bottom: f64,
        h: f64,
    }
    let rows: Vec<Row> = rows
        .into_iter()
        .map(|mut r| {
            r.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
            let mut text = String::new();
            for l in &r {
                join_text(&mut text, &l.text);
            }
            let top = r.iter().map(|l| l.y).fold(f64::MAX, f64::min);
            let bottom = r.iter().map(|l| l.bottom()).fold(f64::MIN, f64::max);
            let h = r.iter().map(|l| l.h).sum::<f64>() / r.len() as f64;
            Row { text, top, bottom, h }
        })
        .collect();

    // 2 + 3. 分段并拼接
    let mut paras: Vec<String> = Vec::new();
    let mut prev: Option<&Row> = None;
    for row in &rows {
        let new_para = match prev {
            None => true,
            Some(p) => {
                let gap = row.top - p.bottom;
                let line_h = p.h.min(row.h).max(1e-6);
                // 字号明显不同(标题 → 正文)也断段
                let size_jump = (p.h / row.h).max(row.h / p.h) > 1.35;
                gap > 0.6 * line_h || size_jump || starts_list_item(&row.text)
            }
        };
        if new_para {
            paras.push(row.text.clone());
        } else if let Some(last) = paras.last_mut() {
            join_text(last, &row.text);
        }
        prev = Some(row);
    }
    paras.join("\n\n")
}

/// 用本机引擎识别(阻塞,亚秒 ~ 2 秒;调用方放 spawn_blocking / 独立线程)。
/// `langs`:应用语言代码,空 = 自动检测(中英优先)
pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<Line>> {
    if bytes.is_empty() {
        return Err(anyhow!("图片为空"));
    }
    platform::recognize(bytes, langs)
}

/// 本机识别 + 归一化;无文字 → Ok(空串)
pub fn recognize_text(bytes: &[u8], langs: &[String]) -> Result<String> {
    Ok(normalize(recognize(bytes, langs)?))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Line;
    use anyhow::{anyhow, Result};
    use objc2::rc::{autoreleasepool, Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSRect, NSString};

    // objc2 runtime 直调 Vision(调研 12 备选路径「objc2 + 手写 msg_send」;不依赖 objc2-vision crate)
    #[link(name = "Vision", kind = "framework")]
    extern "C" {}

    fn vision_lang(code: &str) -> &'static str {
        match code {
            "zh" => "zh-Hans",
            "ja" => "ja-JP",
            "ko" => "ko-KR",
            "fr" => "fr-FR",
            "de" => "de-DE",
            "es" => "es-ES",
            "ru" => "ru-RU",
            _ => "en-US",
        }
    }

    pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<Line>> {
        autoreleasepool(|_| unsafe { recognize_inner(bytes, langs) })
    }

    unsafe fn recognize_inner(bytes: &[u8], langs: &[String]) -> Result<Vec<Line>> {
        let req_cls = AnyClass::get(c"VNRecognizeTextRequest").ok_or_else(|| anyhow!("系统不支持文字识别(Vision)"))?;
        let handler_cls = AnyClass::get(c"VNImageRequestHandler").ok_or_else(|| anyhow!("系统不支持文字识别(Vision)"))?;

        // 每次调用新建 request + handler,单线程内 构造 → 执行 → 取结果(调研 §2.4)
        let request: Retained<AnyObject> = msg_send![req_cls, new];
        let _: () = msg_send![&*request, setRecognitionLevel: 0isize]; // Accurate:CJK 只在此档可靠
        let _: () = msg_send![&*request, setUsesLanguageCorrection: false]; // 语言纠正会「修」代码标识符

        // 语言:显式列表按系统实际支持的过滤;空 / 全不支持 → 自动检测(macOS 13+),中英优先
        let supported: Vec<String> = {
            let r: Result<Retained<NSArray<NSString>>, Retained<NSError>> =
                msg_send![&*request, supportedRecognitionLanguagesAndReturnError: _];
            r.map(|a| a.iter().map(|s| s.to_string()).collect()).unwrap_or_default()
        };
        let pick = |codes: &[&str]| -> Vec<Retained<NSString>> {
            codes
                .iter()
                .map(|c| vision_lang(c))
                .filter(|l| supported.is_empty() || supported.iter().any(|s| s == l))
                .map(NSString::from_str)
                .collect()
        };
        let explicit: Vec<&str> = langs.iter().map(String::as_str).collect();
        let mut chosen = pick(&explicit);
        let auto = chosen.is_empty();
        if auto {
            chosen = pick(&["zh", "en"]);
            let responds: bool = msg_send![&*request, respondsToSelector: sel!(setAutomaticallyDetectsLanguage:)];
            if responds {
                let _: () = msg_send![&*request, setAutomaticallyDetectsLanguage: true];
            }
        }
        if !chosen.is_empty() {
            let arr = NSArray::from_retained_slice(&chosen);
            let _: () = msg_send![&*request, setRecognitionLanguages: &*arr];
        }

        // 原始编码字节直接给 Vision(ImageIO 解码,PNG / JPEG / TIFF 通吃)
        let data = NSData::with_bytes(bytes);
        let options = NSDictionary::<NSString, AnyObject>::new();
        let alloc: Allocated<AnyObject> = msg_send![handler_cls, alloc];
        let handler: Retained<AnyObject> = msg_send![alloc, initWithData: &*data, options: &*options];

        // 同步执行(不走 completion handler:后台线程无 run loop 会永不回调)
        let requests = NSArray::from_retained_slice(&[request.clone()]);
        let done: Result<(), Retained<NSError>> = msg_send![&*handler, performRequests: &*requests, error: _];
        done.map_err(|e| anyhow!("文字识别失败:{}", e.localizedDescription()))?;

        let mut lines = Vec::new();
        let results: Option<Retained<NSArray<AnyObject>>> = msg_send![&*request, results];
        if let Some(results) = results {
            for obs in results.iter() {
                let cands: Retained<NSArray<AnyObject>> = msg_send![&*obs, topCandidates: 1usize];
                let Some(best) = cands.iter().next() else { continue };
                let text: Retained<NSString> = msg_send![&*best, string];
                // 归一化坐标,原点左下 → 换成左上
                let bb: NSRect = msg_send![&*obs, boundingBox];
                lines.push(Line {
                    text: text.to_string(),
                    x: bb.origin.x,
                    y: 1.0 - (bb.origin.y + bb.size.height),
                    w: bb.size.width,
                    h: bb.size.height,
                });
            }
        }
        Ok(lines)
    }
}

#[cfg(windows)]
mod platform {
    use super::Line;
    use anyhow::{anyhow, Result};
    use windows::core::{Interface, HSTRING};
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Storage::Streams::{IRandomAccessStream, InMemoryRandomAccessStream};

    fn bcp47(code: &str) -> &'static str {
        match code {
            "zh" => "zh-Hans",
            "ja" => "ja",
            "ko" => "ko",
            "fr" => "fr",
            "de" => "de",
            "es" => "es",
            "ru" => "ru",
            _ => "en",
        }
    }

    /// 源语言明确且装了对应识别包 → 用它;否则用系统用户语言(Windows 没有多语言自动检测)
    fn engine(langs: &[String]) -> Result<OcrEngine> {
        for code in langs {
            if let Ok(lang) = Language::CreateLanguage(&HSTRING::from(bcp47(code))) {
                if OcrEngine::IsLanguageSupported(&lang).unwrap_or(false) {
                    if let Ok(e) = OcrEngine::TryCreateFromLanguage(&lang) {
                        return Ok(e);
                    }
                }
            }
        }
        OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| anyhow!("没有可用的文字识别语言包:请在「设置 → 时间和语言 → 语言」里为所需语言安装「光学字符识别」"))
    }

    pub fn recognize(bytes: &[u8], langs: &[String]) -> Result<Vec<Line>> {
        let w = |e: windows::core::Error| anyhow!("文字识别失败:{e}");
        // 编码字节 → 内存流 → 解码成 Bgra8 位图
        let stream = InMemoryRandomAccessStream::new().map_err(w)?;
        let buffer = CryptographicBuffer::CreateFromByteArray(bytes).map_err(w)?;
        stream.WriteAsync(&buffer).map_err(w)?.join().map_err(w)?;
        stream.Seek(0).map_err(w)?;
        let ras: IRandomAccessStream = stream.cast().map_err(w)?;
        let decoder = BitmapDecoder::CreateAsync(&ras).map_err(w)?.join().map_err(w)?;
        let raw = decoder.GetSoftwareBitmapAsync().map_err(w)?.join().map_err(w)?;
        let bitmap = SoftwareBitmap::ConvertWithAlpha(&raw, BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied).map_err(w)?;
        let (iw, ih) = (bitmap.PixelWidth().map_err(w)? as f64, bitmap.PixelHeight().map_err(w)? as f64);
        if iw < 1.0 || ih < 1.0 {
            return Err(anyhow!("图片为空"));
        }

        let result = engine(langs)?.RecognizeAsync(&bitmap).map_err(w)?.join().map_err(w)?;
        let mut lines = Vec::new();
        for line in result.Lines().map_err(w)? {
            let text = line.Text().map_err(w)?.to_string();
            // 行没有自己的包围盒:取各词包围盒的并
            let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for word in line.Words().map_err(w)? {
                let r = word.BoundingRect().map_err(w)?;
                x0 = x0.min(r.X as f64);
                y0 = y0.min(r.Y as f64);
                x1 = x1.max((r.X + r.Width) as f64);
                y1 = y1.max((r.Y + r.Height) as f64);
            }
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            lines.push(Line { text, x: x0 / iw, y: y0 / ih, w: (x1 - x0) / iw, h: (y1 - y0) / ih });
        }
        Ok(lines)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::Line;
    use anyhow::{anyhow, Result};

    pub fn recognize(_bytes: &[u8], _langs: &[String]) -> Result<Vec<Line>> {
        Err(anyhow!("此平台暂不支持本机文字识别"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(text: &str, x: f64, y: f64, h: f64) -> Line {
        Line { text: text.into(), x, y, w: 0.3, h }
    }

    #[test]
    fn orders_rows_top_to_bottom_and_left_to_right() {
        // 乱序给入;第二行是同一视觉行的两个框
        let out = normalize(vec![l("world", 0.5, 0.300, 0.02), l("Third line", 0.1, 0.40, 0.02), l("First", 0.1, 0.10, 0.02), l("Hello", 0.1, 0.301, 0.02)]);
        assert_eq!(out, "First\n\nHello world\n\nThird line");
    }

    #[test]
    fn joins_wrapped_lines_within_paragraph() {
        // 行距 = 1.25 倍行高(间隙 0.25h)→ 同段
        let out = normalize(vec![l("The quick brown", 0.1, 0.100, 0.02), l("fox jumps over", 0.1, 0.125, 0.02), l("the lazy dog.", 0.1, 0.150, 0.02)]);
        assert_eq!(out, "The quick brown fox jumps over the lazy dog.");
    }

    #[test]
    fn cjk_lines_join_without_space_and_mixed_with_space() {
        let out = normalize(vec![l("这是第一行文字", 0.1, 0.100, 0.02), l("接着第二行", 0.1, 0.125, 0.02)]);
        assert_eq!(out, "这是第一行文字接着第二行");
        let out = normalize(vec![l("调用 API", 0.1, 0.100, 0.02), l("失败了", 0.1, 0.125, 0.02)]);
        assert_eq!(out, "调用 API 失败了");
    }

    #[test]
    fn large_gap_starts_new_paragraph() {
        let out = normalize(vec![l("Para one.", 0.1, 0.10, 0.02), l("Para two.", 0.1, 0.16, 0.02)]);
        assert_eq!(out, "Para one.\n\nPara two.");
    }

    #[test]
    fn hyphenated_word_is_rejoined() {
        let out = normalize(vec![l("an interna-", 0.1, 0.100, 0.02), l("tional standard", 0.1, 0.125, 0.02)]);
        assert_eq!(out, "an international standard");
    }

    #[test]
    fn list_items_and_headings_stay_separate() {
        let out = normalize(vec![l("Steps", 0.1, 0.100, 0.04), l("1. Install", 0.1, 0.150, 0.02), l("2. Run", 0.1, 0.175, 0.02), l("• done", 0.1, 0.200, 0.02)]);
        assert_eq!(out, "Steps\n\n1. Install\n\n2. Run\n\n• done");
    }

    #[test]
    fn empty_and_blank_lines_yield_empty_text() {
        assert_eq!(normalize(vec![]), "");
        assert_eq!(normalize(vec![l("  ", 0.1, 0.1, 0.02)]), "");
    }

    #[test]
    fn langs_follow_direction_source() {
        assert_eq!(langs_for_direction("ja2zh"), vec!["ja", "en"]);
        assert_eq!(langs_for_direction("en2zh"), vec!["en"]);
        assert!(langs_for_direction("auto").is_empty());
        assert!(langs_for_direction("?2zh").is_empty());
        assert!(langs_for_direction("~Thai2zh").is_empty());
    }

    /// 真引擎冒烟(需要本机 OCR;`YIDU_OCR_SAMPLE=<图片路径> cargo test -- --ignored ocr_sample --nocapture`)
    #[test]
    #[ignore]
    fn ocr_sample_image() {
        let path = std::env::var("YIDU_OCR_SAMPLE").expect("设置 YIDU_OCR_SAMPLE");
        let bytes = std::fs::read(path).unwrap();
        let langs: Vec<String> = std::env::var("YIDU_OCR_LANGS").map(|l| l.split(',').map(str::to_string).collect()).unwrap_or_default();
        let text = recognize_text(&bytes, &langs).unwrap();
        println!("---OCR---\n{text}\n---END---");
        assert!(!text.trim().is_empty());
    }
}
