// markdown 切块(工单 02/06):pulldown-cmark 字节区间;heading/段落/list 项为块,
// 代码块 kind=code 直通不译,表格 M1 整块(行级细化留 M2)。
// 非 md 纯文本天然按空行分块(pulldown 会解析为多个 Paragraph),同一管线。
use pulldown_cmark::{Options, Parser, Tag, TagEnd};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub enum BlockKind {
    Heading,
    Paragraph,
    List,
    Code,
    Table,
}

impl BlockKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockKind::Heading => "heading",
            BlockKind::Paragraph => "p",
            BlockKind::List => "list",
            BlockKind::Code => "code",
            BlockKind::Table => "table",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Block {
    pub kind: BlockKind,
    pub src: String,
    pub hash: String,
}

/// 规范化:去掉每行行尾空白与首尾空行,再取 sha256 —— 编辑后按哈希再对齐的依据
pub fn normalized_hash(src: &str) -> String {
    let norm: Vec<&str> = src
        .lines()
        .map(|l| l.trim_end())
        .skip_while(|l| l.is_empty())
        .collect::<Vec<_>>();
    let trimmed = &norm[..norm.iter().rposition(|l| !l.is_empty()).map(|i| i + 1).unwrap_or(0)];
    let mut h = Sha256::new();
    h.update(trimmed.join("\n"));
    format!("{:x}", h.finalize())
}

pub fn split_blocks(md: &str) -> Vec<Block> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    let mut blocks = Vec::new();
    let mut stack: Vec<(Tag, usize)> = Vec::new();
    for (ev, range) in Parser::new_ext(md, opts).into_offset_iter() {
        match ev {
            pulldown_cmark::Event::Start(tag) => stack.push((tag, range.start)),
            pulldown_cmark::Event::End(end) => {
                let Some((_tag, start)) = stack.pop() else { continue };
                let depth_after_pop = stack.len();
                let src = &md[start..range.end];
                let kind = match end {
                    TagEnd::Heading(_) => Some(BlockKind::Heading),
                    TagEnd::Paragraph => Some(BlockKind::Paragraph),
                    TagEnd::CodeBlock => Some(BlockKind::Code),
                    TagEnd::BlockQuote(_) => Some(BlockKind::Paragraph),
                    TagEnd::Table => Some(BlockKind::Table),
                    // HTML 块按代码块处理:直通不译,避免静默丢内容
                    TagEnd::HtmlBlock => Some(BlockKind::Code),
                    TagEnd::Item if depth_after_pop == 1 => Some(BlockKind::List),
                    // 顶层 List 的收尾跳过:块已按 Item 产出
                    TagEnd::List(_) => None,
                    _ => None,
                };
                // 只收顶层块(0 深度)或顶层列表项(弹出后剩 List 一层)
                let top_level = matches!(
                    end,
                    TagEnd::Heading(_)
                        | TagEnd::Paragraph
                        | TagEnd::CodeBlock
                        | TagEnd::BlockQuote(_)
                        | TagEnd::Table
                        | TagEnd::HtmlBlock
                ) && depth_after_pop == 0;
                if let Some(kind) = kind.filter(|_| top_level || matches!(end, TagEnd::Item)) {
                    blocks.push(Block {
                        kind,
                        src: src.trim_end().to_string(),
                        hash: normalized_hash(src),
                    });
                }
            }
            _ => {}
        }
    }
    blocks
}

/// 文章标题推导:首个 heading 文本,否则首行截断
pub fn derive_title(md: &str) -> String {
    for b in split_blocks(md) {
        if b.kind == BlockKind::Heading {
            let t = b.src.trim_start_matches('#').trim();
            if !t.is_empty() {
                return t.chars().take(60).collect();
            }
        }
    }
    md.lines()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().chars().take(24).collect())
        .unwrap_or_else(|| "未命名".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_basic_doc() {
        let md = "# Title\n\nFirst para.\n\nSecond para with [link](https://a.com).\n\n```rust\nfn main() {}\n```\n";
        let blocks = split_blocks(md);
        let kinds: Vec<&str> = blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["heading", "p", "p", "code"]);
        assert_eq!(blocks[0].src, "# Title");
        assert!(blocks[3].src.contains("fn main()"));
    }

    #[test]
    fn splits_list_items() {
        let md = "Intro:\n\n- one\n- two\n  - nested\n- three\n\nOutro.\n";
        let blocks = split_blocks(md);
        let kinds: Vec<&str> = blocks.iter().map(|b| b.kind.as_str()).collect();
        assert_eq!(kinds, vec!["p", "list", "list", "list", "p"]);
        assert_eq!(blocks[1].src, "- one");
        assert_eq!(blocks[2].src, "- two\n  - nested");
    }

    #[test]
    fn plain_text_by_blank_lines() {
        let md = "hello world\nsecond line still same para\n\nsecond paragraph here\n\nthird";
        let blocks = split_blocks(md);
        assert_eq!(blocks.len(), 3);
        assert!(blocks.iter().all(|b| b.kind == BlockKind::Paragraph));
    }

    #[test]
    fn table_whole_block() {
        let md = "| a | b |\n|---|---|\n| 1 | 2 |\n";
        let blocks = split_blocks(md);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, BlockKind::Table);
    }

    #[test]
    fn hash_stable_under_trailing_ws() {
        assert_eq!(normalized_hash("abc  \n\n"), normalized_hash("abc"));
        assert_ne!(normalized_hash("abc"), normalized_hash("abd"));
    }

    #[test]
    fn title_derivation() {
        assert_eq!(derive_title("# Hello\n\nbody"), "Hello");
        assert_eq!(derive_title("just a line"), "just a line");
    }
}
