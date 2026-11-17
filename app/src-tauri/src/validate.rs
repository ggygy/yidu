// 译后校验(工单 06):id 序列 / 标签外文本 / URL 集合 / 代码围栏数
// + v0.3 §2.2.4 结构签名:标题级、列表(有序 / 起始号 / 项数 / 层级 / 松散 / 任务)、表格(列 × 行)、
//   代码块数、行内码集合、URL 集合、引用 / hr / HTML / 脚注计数。块级比对原文与译文。
// 修复梯度的编排(单发/重试/串行)在 translate.rs,这里提供纯函数。

use crate::sse::Tagged;
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, PartialEq)]
pub enum Issue {
    MissingBlocks(Vec<u32>),
    ExtraOutsideText(String),
    UrlsLost(Vec<String>),
    FenceMismatch,
}

pub struct BatchOutput {
    pub blocks: Vec<Tagged>,
    pub raw: String,
}

fn t_block_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"<t id="\d+">[\s\S]*?</t>"#).unwrap())
}

fn url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"https?://\S+").unwrap())
}

/// 去掉全部 `<t id="n">…</t>` 后应无剩余文本
pub fn outside_tag_text(raw: &str) -> String {
    let stripped = t_block_re().replace_all(raw, "");
    stripped.trim().to_string()
}

pub fn url_set(text: &str) -> Vec<String> {
    let mut urls: Vec<String> = url_re()
        .find_iter(text)
        .map(|m| m.as_str().trim_end_matches(|c: char| matches!(c, ')' | '.' | ',' | ']'))
            .to_string())
        .collect();
    urls.sort();
    urls.dedup();
    urls
}

pub fn fence_count(text: &str) -> usize {
    text.matches("```").count()
}

/// 块数相同但 id 错乱时,按位置重排 id(修复梯度第 1 级)
pub fn realign_by_position(out: &[Tagged], expected_ids: &[u32]) -> Option<Vec<Tagged>> {
    if out.len() != expected_ids.len() {
        return None;
    }
    Some(
        out.iter()
            .zip(expected_ids)
            .map(|(t, &id)| Tagged { id, text: t.text.clone() })
            .collect(),
    )
}

pub fn validate(expected_ids: &[u32], out: &BatchOutput, sources: &[&str]) -> Vec<Issue> {
    let mut issues = Vec::new();
    let got: Vec<u32> = out.blocks.iter().map(|b| b.id).collect();
    if got != expected_ids {
        let missing: Vec<u32> = expected_ids
            .iter()
            .filter(|id| !got.contains(id))
            .copied()
            .collect();
        issues.push(Issue::MissingBlocks(missing));
    }
    let extra = outside_tag_text(&out.raw);
    if !extra.is_empty() {
        issues.push(Issue::ExtraOutsideText(extra.chars().take(80).collect()));
    }
    let src_urls = url_set(&sources.concat());
    if !src_urls.is_empty() {
        let out_text = out.raw.clone();
        let lost: Vec<String> = src_urls
            .into_iter()
            .filter(|u| !out_text.contains(u.as_str()))
            .collect();
        if !lost.is_empty() {
            issues.push(Issue::UrlsLost(lost));
        }
    }
    let src_fences = fence_count(&sources.concat());
    let out_fences: usize = out.blocks.iter().map(|b| fence_count(&b.text)).sum();
    if src_fences != out_fences {
        issues.push(Issue::FenceMismatch);
    }
    issues
}

// ---------- 结构签名(§2.2.4) ----------

#[derive(Debug, Default, PartialEq, Clone)]
pub struct Signature {
    pub headings: Vec<u8>,
    /// 形如 "ol3×2@0loose task"
    pub lists: Vec<String>,
    /// 形如 "3c×3r"
    pub tables: Vec<String>,
    pub code: usize,
    pub inline_code: Vec<String>,
    pub urls: Vec<String>,
    pub quotes: usize,
    pub hr: usize,
    pub html: usize,
    pub footnotes: usize,
}

struct ListFrame {
    rec: usize,
    ordered: bool,
    start: u64,
    items: usize,
    depth: usize,
    loose: bool,
    task: bool,
}

pub fn signature(md: &str) -> Signature {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};
    let mut sig = Signature::default();
    let mut lists: Vec<ListFrame> = Vec::new();
    // 父节点栈:判断「Item 直接含 Paragraph」= 松散列表
    let mut parents: Vec<bool> = Vec::new(); // true = Item
    let mut table: Option<(usize, usize)> = None;
    for ev in Parser::new_ext(md, crate::blocks::md_options()) {
        match ev {
            Event::Start(tag) => {
                let is_item = matches!(tag, Tag::Item);
                match &tag {
                    Tag::Heading { level, .. } => sig.headings.push(*level as u8),
                    Tag::List(start) => {
                        sig.lists.push(String::new());
                        lists.push(ListFrame {
                            rec: sig.lists.len() - 1,
                            ordered: start.is_some(),
                            start: start.unwrap_or(1),
                            items: 0,
                            depth: lists.len(),
                            loose: false,
                            task: false,
                        });
                    }
                    Tag::Item => {
                        if let Some(f) = lists.last_mut() {
                            f.items += 1;
                        }
                    }
                    Tag::Paragraph => {
                        if parents.last() == Some(&true) {
                            if let Some(f) = lists.last_mut() {
                                f.loose = true;
                            }
                        }
                    }
                    Tag::Table(al) => table = Some((al.len(), 0)),
                    Tag::TableHead | Tag::TableRow => {
                        if let Some(t) = table.as_mut() {
                            t.1 += 1;
                        }
                    }
                    Tag::CodeBlock(_) => sig.code += 1,
                    Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. } => sig.urls.push(dest_url.to_string()),
                    Tag::BlockQuote(_) => sig.quotes += 1,
                    Tag::HtmlBlock => sig.html += 1,
                    Tag::FootnoteDefinition(_) => sig.footnotes += 1,
                    _ => {}
                }
                parents.push(is_item);
            }
            Event::End(end) => {
                parents.pop();
                match end {
                    TagEnd::List(_) => {
                        if let Some(f) = lists.pop() {
                            sig.lists[f.rec] = format!(
                                "{}×{}@{}{}{}",
                                if f.ordered { format!("ol{}", f.start) } else { "ul".into() },
                                f.items,
                                f.depth,
                                if f.loose { " loose" } else { "" },
                                if f.task { " task" } else { "" },
                            );
                        }
                    }
                    TagEnd::Table => {
                        if let Some((c, r)) = table.take() {
                            sig.tables.push(format!("{c}c×{r}r"));
                        }
                    }
                    _ => {}
                }
            }
            Event::TaskListMarker(_) => {
                if let Some(f) = lists.last_mut() {
                    f.task = true;
                }
            }
            Event::Code(c) => sig.inline_code.push(c.trim().to_string()),
            Event::InlineHtml(_) => sig.html += 1,
            Event::Rule => sig.hr += 1,
            _ => {}
        }
    }
    sig.inline_code.sort();
    sig.urls.sort();
    sig
}

/// 原文与译文的结构差异(英文描述,直接放进重译提示;空 = 一致)
pub fn structure_diff(src: &str, out: &str) -> Vec<String> {
    let (a, b) = (signature(src), signature(out));
    let mut d = Vec::new();
    let mut cmp = |name: &str, x: String, y: String| {
        if x != y {
            d.push(format!("{name}: source {x}, yours {y}"));
        }
    };
    cmp("heading levels", format!("{:?}", a.headings), format!("{:?}", b.headings));
    cmp("lists (type×items@depth)", format!("{:?}", a.lists), format!("{:?}", b.lists));
    cmp("tables (cols×rows)", format!("{:?}", a.tables), format!("{:?}", b.tables));
    cmp("code blocks", a.code.to_string(), b.code.to_string());
    cmp("inline code", format!("{:?}", a.inline_code), format!("{:?}", b.inline_code));
    cmp("URLs", format!("{:?}", a.urls), format!("{:?}", b.urls));
    cmp("blockquotes", a.quotes.to_string(), b.quotes.to_string());
    cmp("horizontal rules", a.hr.to_string(), b.hr.to_string());
    cmp("HTML", a.html.to_string(), b.html.to_string());
    cmp("footnotes", a.footnotes.to_string(), b.footnotes.to_string());
    d
}

/// 给用户看的简短中文说明(块上「格式可能有误」的悬浮提示)
pub fn diff_summary_zh(diffs: &[String]) -> String {
    let names: Vec<&str> = diffs
        .iter()
        .map(|d| match d.split(':').next().unwrap_or("") {
            "heading levels" => "标题级别",
            "lists (type×items@depth)" => "列表结构",
            "tables (cols×rows)" => "表格行列",
            "code blocks" => "代码块",
            "inline code" => "行内代码",
            "URLs" => "链接",
            "blockquotes" => "引用",
            "horizontal rules" => "分隔线",
            "HTML" => "HTML",
            _ => "脚注",
        })
        .collect();
    format!("与原文不一致:{}", names.join("、"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(blocks: Vec<(u32, &str)>, raw: &str) -> BatchOutput {
        BatchOutput {
            blocks: blocks
                .into_iter()
                .map(|(id, text)| Tagged { id, text: text.into() })
                .collect(),
            raw: raw.into(),
        }
    }

    #[test]
    fn clean_pass() {
        let o = out(vec![(1, "甲"), (2, "乙")], "<t id=\"1\">甲</t><t id=\"2\">乙</t>");
        assert!(validate(&[1, 2], &o, &["a", "b"]).is_empty());
    }

    #[test]
    fn detects_missing_and_extra() {
        let o = out(vec![(1, "甲")], "前言<t id=\"1\">甲</t>");
        let issues = validate(&[1, 2], &o, &["a", "b"]);
        assert!(issues.contains(&Issue::MissingBlocks(vec![2])));
        assert!(issues.contains(&Issue::ExtraOutsideText("前言".into())));
    }

    #[test]
    fn url_preserved_check() {
        let src = "see [docs](https://example.com/a).";
        let o = out(
            vec![(1, "见 [文档](https://example.com/a)。")],
            "<t id=\"1\">见 [文档](https://example.com/a)。</t>",
        );
        assert!(validate(&[1], &o, &[src]).is_empty());
        let bad = out(vec![(1, "见文档。")], "<t id=\"1\">见文档。</t>");
        assert_eq!(
            validate(&[1], &bad, &[src]),
            vec![Issue::UrlsLost(vec!["https://example.com/a".into()])]
        );
    }

    #[test]
    fn fence_mismatch() {
        let o = out(vec![(1, "```rust\nfn\n```")], "<t id=\"1\">```rust\nfn\n```</t>");
        assert_eq!(validate(&[1], &o, &["plain text only"]).len(), 1);
    }

    #[test]
    fn realign_fixes_ids() {
        let blocks = vec![Tagged { id: 2, text: "甲".into() }, Tagged { id: 1, text: "乙".into() }];
        let fixed = realign_by_position(&blocks, &[1, 2]).unwrap();
        assert_eq!(fixed[0].id, 1);
        assert_eq!(fixed[0].text, "甲");
        assert!(realign_by_position(&blocks, &[1, 2, 3]).is_none());
    }

    // ---- 工单 04 原型损伤集移植:结构签名检出 10/10 ----
    #[test]
    fn damage_set_detected() {
        let damages: &[(&str, &str, &str)] = &[
            ("列表标记丢失", "- alpha `a`\n- beta\n", "alpha `a`\nbeta\n"),
            ("有序列表重编号", "3. third\n4. fourth\n", "1. third\n2. fourth\n"),
            ("嵌套层级被拍平", "- a\n  - b\n", "- a\n- b\n"),
            ("标题级别改变", "## Setup\n", "# Setup\n"),
            ("表格两行被合并", "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n", "| a | b |\n|---|---|\n| 1 3 | 2 4 |\n"),
            ("行内码反引号被去掉", "Run `npm ci` first.\n", "Run npm ci first.\n"),
            ("链接 URL 被改", "See [docs](https://a.dev/x).\n", "See [docs](https://a.dev/y).\n"),
            ("引用 > 丢失", "> quoted\n", "quoted\n"),
            ("任务勾选丢失", "- [x] done\n", "- done\n"),
            ("~~~ 围栏代码块被拆", "~~~\ncode\n~~~\n", "code\n"),
        ];
        for (name, src, out) in damages {
            assert!(!structure_diff(src, out).is_empty(), "{name} 未检出");
        }
    }

    #[test]
    fn faithful_translation_passes() {
        let src = "1. Install the CLI\n   - macOS: `brew install foo`\n   - Linux: see [docs](https://a.dev/linux)\n2. Run `foo init`\n";
        let out = "1. 安装 CLI\n   - macOS:`brew install foo`\n   - Linux:见[文档](https://a.dev/linux)\n2. 运行 `foo init`\n";
        assert!(structure_diff(src, out).is_empty(), "{:?}", structure_diff(src, out));
        let t = "| Option | Default |\n|---|---|\n| `timeout` | 30 |\n";
        let tz = "| 选项 | 默认值 |\n|---|---|\n| `timeout` | 30 |\n";
        assert!(structure_diff(t, tz).is_empty());
        assert_eq!(signature("- [x] a\n- [ ] b\n").lists, vec!["ul×2@0 task".to_string()]);
        assert_eq!(signature("- a\n\n- b\n").lists, vec!["ul×2@0 loose".to_string()]);
        assert_eq!(signature("3. a\n4. b\n").lists, vec!["ol3×2@0".to_string()]);
    }
}
