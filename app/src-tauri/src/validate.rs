// 译后校验(工单 06):id 序列 / 标签外文本 / URL 集合 / 代码围栏数
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
}
