// prompt 组装(工单 06,逐字移植 proto/scripts/protocol-test.mjs 实测版本)
// 方向参数化:from/to 显示名映射;术语表来自 glossary,为空则整段省略

fn lang_name(code: &str) -> &'static str {
    match code {
        "zh" => "简体中文",
        "en" => "英语",
        _ => "原文",
    }
}

pub fn direction_parts(direction: &str) -> (&'static str, &'static str) {
    match direction {
        "zh2en" => ("zh", "en"),
        _ => ("en", "zh"),
    }
}

pub fn system_prompt(from: &str, to: &str, terms: &[(String, String)]) -> String {
    let mut s = format!(
        "你是一名专业的{}→{}技术文档翻译。\n\n规则:\n\
         1. 只输出译文。不要输出任何解释、前言、结语(例如\"以下是译文\")。\n\
         2. 输入被分成带编号的片段 <s id=\"N\">…</s>。对每个片段,输出\n\
         <t id=\"N\">…</t>,id 与输入一一对应,顺序一致,数量一致,一个不漏。\n\
         3. 保持 Markdown 语法完全不变:标题层级、列表、粗斜体、链接、表格、引用、空行结构原样保留。\n\
         4. 代码块、行内代码 `…`、URL、文件路径、命令、变量名一律原样保留,不翻译。\n\
         5. 专有名词/产品名若无通用简体中文译名,保留原文。\n\
         6. 标点遵循{to_name}习惯(用全角标点)。\n\
         7. \"上文参考\"标记的部分只用于理解语境,禁止翻译或输出。",
        lang_name(from),
        lang_name(to),
        to_name = lang_name(to),
    );
    if !terms.is_empty() {
        s.push_str("\n\n术语表(必须使用以下固定译法;若术语保持原文则原样保留):\n");
        for (t, tr) in terms {
            s.push_str(&format!("- {t} → {tr}\n"));
        }
    }
    s
}

pub fn user_msg(title: &str, prev: Option<&str>, blocks: &[&str]) -> String {
    let mut s = format!("文档标题:{title}(供理解语境)\n");
    if let Some(prev) = prev {
        s.push_str(&format!("\n上文参考(勿翻译、勿输出):\n{prev}\n"));
    }
    s.push_str(&format!("\n请翻译以下 {} 个片段:\n\n", blocks.len()));
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
    fn system_matches_protocol_shape() {
        let s = system_prompt("en", "zh", &[]);
        assert!(s.starts_with("你是一名专业的英语→简体中文技术文档翻译。"));
        assert!(s.contains("<s id=\"N\">…</s>"));
        assert!(s.contains("7. \"上文参考\"标记的部分只用于理解语境,禁止翻译或输出。"));
        assert!(!s.contains("术语表"));
    }

    #[test]
    fn system_with_terms() {
        let s = system_prompt("en", "zh", &[("hydration".into(), "水合".into())]);
        assert!(s.contains("术语表(必须使用以下固定译法;若术语保持原文则原样保留):\n- hydration → 水合\n"));
    }

    #[test]
    fn user_msg_matches_script() {
        let u = user_msg("Test", Some("上文译文"), &["a", "b"]);
        assert!(u.starts_with("文档标题:Test(供理解语境)\n"));
        assert!(u.contains("\n上文参考(勿翻译、勿输出):\n上文译文\n"));
        assert!(u.contains("\n请翻译以下 2 个片段:\n\n<s id=\"1\">a</s>\n<s id=\"2\">b</s>\n"));
    }
}
