// prompt 组装(工单 06 协议实测版 + v0.2 多语言/自定义 prompt)
// 结构:style 段(默认英文,可被 prefs.custom_prompt 整体替换,支持 {from}/{to} 占位)
//      + protocol 段(应用强制附加,保证 <s>/<t> 协议管线完整,用户不可移除)
//      + 术语表段(有术语才出现)
// 方向编码:A2B;A/B 为语言代码(zh/en/ja/ko/fr/de/es/ru)或 "~显示名"(自定义语言,如 en2~泰语)

pub fn direction_parts(direction: &str) -> (String, String) {
    let (a, b) = direction.split_once('2').unwrap_or(("en", "zh"));
    (seg_name(a, "the source language"), seg_name(b, "the target language"))
}

fn seg_name(seg: &str, fallback: &str) -> String {
    if let Some(name) = seg.strip_prefix('~') {
        let t = name.trim();
        if !t.is_empty() {
            return t.to_string();
        }
        return fallback.to_string();
    }
    lang_name(seg).map(str::to_string).unwrap_or_else(|| fallback.to_string())
}

fn lang_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "zh" => "Simplified Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        "ru" => "Russian",
        _ => return None,
    })
}

fn default_style_prompt(from: &str, to: &str) -> String {
    format!(
        "You are a professional {from}→{to} technical-document translator.\n\n\
         Style rules:\n\
         1. Translate faithfully and completely; do not add explanations, prefaces, or closing remarks.\n\
         2. Keep proper nouns and product names in the source language unless they have a well-established {to} translation.\n\
         3. Punctuation follows {to} conventions.",
        from = from,
        to = to,
    )
}

fn protocol_block() -> &'static str {
    "Protocol (mandatory):\n\
     - Input segments are wrapped as <s id=\"N\">…</s>. For every segment output exactly one <t id=\"N\">…</t> with the same id, in the same order; none may be missing.\n\
     - Preserve Markdown structure exactly: heading levels, lists, bold/italic, links, tables, quotes, and blank-line layout.\n\
     - Never translate code blocks, inline code, URLs, file paths, commands, or variable names; keep them verbatim.\n\
     - Output the translated segments only — no explanations of any kind.\n\
     - Segments labeled \"Reference context\" are for context only; never translate or output them."
}

pub fn system_prompt(from: &str, to: &str, terms: &[(String, String)], custom: Option<&str>) -> String {
    let style = match custom.map(str::trim) {
        Some(t) if !t.is_empty() => t.replace("{from}", from).replace("{to}", to),
        _ => default_style_prompt(from, to),
    };
    let mut s = style;
    s.push_str("\n\n");
    s.push_str(protocol_block());
    if !terms.is_empty() {
        s.push_str("\n\nGlossary (always use these exact translations; keep the original term if the translation says to keep it):\n");
        for (t, tr) in terms {
            s.push_str(&format!("- {t} → {tr}\n"));
        }
    }
    s
}

pub fn user_msg(title: &str, prev: Option<&str>, blocks: &[&str]) -> String {
    let mut s = format!("Document title: {title} (context only)\n");
    if let Some(prev) = prev {
        s.push_str(&format!("\nReference context (do NOT translate or output):\n{prev}\n"));
    }
    s.push_str(&format!("\nTranslate the following {} segments:\n\n", blocks.len()));
    for (i, b) in blocks.iter().enumerate() {
        s.push_str(&format!("<s id=\"{}\">{}</s>\n", i + 1, b));
    }
    // 与实测脚本一致:片段间以换行连接,结尾无额外空行
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_prompt_is_english_protocol_shape() {
        let (from, to) = direction_parts("en2zh");
        let s = system_prompt(&from, &to, &[], None);
        assert!(s.starts_with("You are a professional English→Simplified Chinese technical-document translator."));
        assert!(s.contains("<s id=\"N\">…</s>"));
        assert!(s.contains("<t id=\"N\">…</t>"));
        assert!(s.contains("\"Reference context\""));
        assert!(!s.contains("Glossary"));
    }

    #[test]
    fn glossary_in_english_header() {
        let (from, to) = direction_parts("en2zh");
        let s = system_prompt(&from, &to, &[("hydration".into(), "水合".into())], None);
        assert!(s.contains("Glossary (always use these exact translations"));
        assert!(s.contains("- hydration → 水合\n"));
    }

    #[test]
    fn custom_prompt_replaces_style_keeps_protocol() {
        let (from, to) = direction_parts("en2zh");
        let s = system_prompt(&from, &to, &[], Some("Casual tone. Translate {from} into {to}."));
        assert!(s.starts_with("Casual tone. Translate English into Simplified Chinese."));
        assert!(!s.contains("You are a professional"));
        assert!(s.contains("Protocol (mandatory):"));
    }

    #[test]
    fn custom_prompt_blank_falls_back_to_default() {
        let (from, to) = direction_parts("en2zh");
        let s = system_prompt(&from, &to, &[], Some("   \n  "));
        assert!(s.starts_with("You are a professional English→Simplified Chinese"));
    }

    #[test]
    fn direction_parts_known_codes() {
        assert_eq!(direction_parts("zh2en"), ("Simplified Chinese".into(), "English".into()));
        assert_eq!(direction_parts("en2zh"), ("English".into(), "Simplified Chinese".into()));
        assert_eq!(direction_parts("ja2ko"), ("Japanese".into(), "Korean".into()));
    }

    #[test]
    fn direction_parts_custom_and_fallback() {
        assert_eq!(direction_parts("en2~泰语"), ("English".into(), "泰语".into()));
        assert_eq!(direction_parts("~Latin2fr"), ("Latin".into(), "French".into()));
        // 旧数据之外的未知编码回落中性占位
        assert_eq!(direction_parts("xx2yy"), ("the source language".into(), "the target language".into()));
        // 无分隔符回落默认方向
        assert_eq!(direction_parts("bogus"), ("English".into(), "Simplified Chinese".into()));
    }

    #[test]
    fn user_msg_matches_english_scaffold() {
        let u = user_msg("Test", Some("prev text"), &["a", "b"]);
        assert!(u.starts_with("Document title: Test (context only)\n"));
        assert!(u.contains("\nReference context (do NOT translate or output):\nprev text\n"));
        assert!(u.contains("\nTranslate the following 2 segments:\n\n<s id=\"1\">a</s>\n<s id=\"2\">b</s>\n"));
    }
}
