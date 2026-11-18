// markdown 切块(v0.3 §2.2 块模型):
// - 所有顶层节点都成块,不丢弃(v0.2 丢 `---`、脚注、链接定义);节点之间的非空白文本(如引用式链接定义)也成直通块
// - 列表 / 引用 / 表格整体一块翻译;列表超 LIST_SPLIT_CHARS 才按顶层项拆,拆开的项带同一 group,渲染时合回一个列表
// - 直通不译:代码(围栏 / 缩进)、HTML 块、hr、脚注定义、引用式链接定义(raw)
// - 每块记录与前一块之间的原文分隔文本 sep:按序拼回 `sep + src` 即原文结构
// - 纯文本粘贴(§2.2.5):按 md 语法密度判定;纯文本时段内单换行转硬换行、行首 md 记号转义
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// 列表超过这么多字符才按顶层项拆(约 1200 字,spec §2.2.1)
pub const LIST_SPLIT_CHARS: usize = 1200;

#[derive(Debug, Clone, PartialEq)]
pub enum BlockKind {
    Heading,
    Paragraph,
    List,
    Quote,
    Table,
    Code,
    Html,
    Hr,
    Footnote,
    /// 节点间的其他原文(引用式链接定义等),直通
    Raw,
}

impl BlockKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockKind::Heading => "heading",
            BlockKind::Paragraph => "p",
            BlockKind::List => "list",
            BlockKind::Quote => "quote",
            BlockKind::Table => "table",
            BlockKind::Code => "code",
            BlockKind::Html => "html",
            BlockKind::Hr => "hr",
            BlockKind::Footnote => "footnote",
            BlockKind::Raw => "definition",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "heading" => BlockKind::Heading,
            "list" => BlockKind::List,
            "quote" => BlockKind::Quote,
            "table" => BlockKind::Table,
            "code" => BlockKind::Code,
            "html" => BlockKind::Html,
            "hr" => BlockKind::Hr,
            "footnote" => BlockKind::Footnote,
            "definition" => BlockKind::Raw,
            _ => BlockKind::Paragraph,
        }
    }

    /// 是否送模型翻译(否 = 直通,建库即 done、译文 = 原文)
    pub fn translatable(&self) -> bool {
        matches!(self, BlockKind::Heading | BlockKind::Paragraph | BlockKind::List | BlockKind::Quote | BlockKind::Table)
    }
}

#[derive(Debug, Clone)]
pub struct Block {
    pub kind: BlockKind,
    pub src: String,
    pub hash: String,
    /// 与前一块之间的原文分隔(首块 = 文首空白)
    pub sep: String,
    /// 大列表拆开的项共享 group(= 原列表的顶层序号);其他块 None
    pub group: Option<i64>,
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

pub fn md_options() -> Options {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts
}

/// 一个顶层节点:种类 + 字节区间 + (列表时)顶层项区间
struct TopNode {
    kind: BlockKind,
    start: usize,
    end: usize,
    items: Vec<(usize, usize)>,
}

fn top_nodes(md: &str) -> Vec<TopNode> {
    let mut out: Vec<TopNode> = Vec::new();
    let mut depth = 0usize;
    let mut cur: Option<TopNode> = None;
    let mut item_start: Option<usize> = None;
    for (ev, r) in Parser::new_ext(md, md_options()).into_offset_iter() {
        match ev {
            Event::Start(tag) => {
                if depth == 0 {
                    let kind = match tag {
                        Tag::Heading { .. } => BlockKind::Heading,
                        Tag::List(_) => BlockKind::List,
                        Tag::BlockQuote(_) => BlockKind::Quote,
                        Tag::Table(_) => BlockKind::Table,
                        Tag::CodeBlock(_) => BlockKind::Code,
                        Tag::HtmlBlock => BlockKind::Html,
                        Tag::FootnoteDefinition(_) => BlockKind::Footnote,
                        _ => BlockKind::Paragraph,
                    };
                    cur = Some(TopNode { kind, start: r.start, end: r.end, items: Vec::new() });
                } else if depth == 1 && matches!(tag, Tag::Item) {
                    item_start = Some(r.start);
                }
                depth += 1;
            }
            Event::End(end) => {
                depth = depth.saturating_sub(1);
                if depth == 1 && matches!(end, TagEnd::Item) {
                    if let (Some(s), Some(n)) = (item_start.take(), cur.as_mut()) {
                        n.items.push((s, r.end));
                    }
                }
                if depth == 0 {
                    if let Some(mut n) = cur.take() {
                        n.end = n.end.max(r.end);
                        out.push(n);
                    }
                }
            }
            Event::Rule if depth == 0 => out.push(TopNode { kind: BlockKind::Hr, start: r.start, end: r.end, items: Vec::new() }),
            // 极少数无包裹的顶层 html
            Event::Html(_) if depth == 0 => out.push(TopNode { kind: BlockKind::Html, start: r.start, end: r.end, items: Vec::new() }),
            _ => {}
        }
    }
    out
}

/// 末尾去空白后的切片终点
fn trimmed_end(md: &str, start: usize, end: usize) -> usize {
    start + md[start..end].trim_end().len()
}

pub fn split_blocks(md: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut cursor = 0usize; // 上一块(去尾空白)之后的位置
    let push = |blocks: &mut Vec<Block>, cursor: &mut usize, kind: BlockKind, s: usize, e: usize, group: Option<i64>| {
        let e = trimmed_end(md, s, e);
        if e <= s {
            return;
        }
        let gap = &md[*cursor..s];
        // 节点之间的非空白原文(引用式链接定义等):单独成直通块,保证不丢
        let sep = if gap.trim().is_empty() {
            gap.to_string()
        } else {
            let lead = gap.len() - gap.trim_start().len();
            let raw_s = *cursor + lead;
            let raw_e = trimmed_end(md, raw_s, s);
            blocks.push(Block {
                kind: BlockKind::Raw,
                src: md[raw_s..raw_e].to_string(),
                hash: normalized_hash(&md[raw_s..raw_e]),
                sep: md[*cursor..raw_s].to_string(),
                group: None,
            });
            md[raw_e..s].to_string()
        };
        blocks.push(Block { kind, src: md[s..e].to_string(), hash: normalized_hash(&md[s..e]), sep, group });
        *cursor = e;
    };
    for (i, n) in top_nodes(md).into_iter().enumerate() {
        if n.kind == BlockKind::List && n.end - n.start > LIST_SPLIT_CHARS && n.items.len() > 1 {
            for (s, e) in n.items {
                push(&mut blocks, &mut cursor, BlockKind::List, s, e, Some(i as i64));
            }
        } else {
            push(&mut blocks, &mut cursor, n.kind, n.start, n.end, None);
        }
    }
    // 文末残余非空白(末尾的链接定义)
    let tail = &md[cursor..];
    if !tail.trim().is_empty() {
        let lead = tail.len() - tail.trim_start().len();
        let s = cursor + lead;
        let e = trimmed_end(md, s, md.len());
        blocks.push(Block { kind: BlockKind::Raw, src: md[s..e].to_string(), hash: normalized_hash(&md[s..e]), sep: md[cursor..s].to_string(), group: None });
    }
    blocks
}

/// 按序拼回:`sep + text`
#[cfg(test)]
pub fn reassemble<'a>(parts: impl IntoIterator<Item = (&'a str, &'a str)>) -> String {
    parts.into_iter().map(|(sep, t)| format!("{sep}{t}")).collect()
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
        .map(|l| l.trim().trim_start_matches(['#', '>', '\\']).trim().chars().take(24).collect())
        .unwrap_or_else(|| "未命名".into())
}

// ---------- 纯文本判定与归一化(§2.2.5) ----------

fn re(s: &'static str, cell: &'static OnceLock<Regex>) -> &'static Regex {
    cell.get_or_init(|| Regex::new(s).unwrap())
}

/// 是否像 markdown:有围栏 / 链接 / 行内码 / 表格 / 加粗即判 md;否则看行首 md 记号占非空行比例
pub fn looks_like_markdown(text: &str) -> bool {
    static STRONG: OnceLock<Regex> = OnceLock::new();
    static LINE: OnceLock<Regex> = OnceLock::new();
    let strong = re(r"(?m)^\s*(```|~~~)|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|^\s*\|.+\|\s*$|\*\*[^*\n]+\*\*", &STRONG);
    if strong.is_match(text) {
        return true;
    }
    let line = re(r"^\s{0,3}(#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s|>)", &LINE);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return true;
    }
    let md_lines = lines.iter().filter(|l| line.is_match(l)).count();
    // 段内单换行很多、md 记号很少 → 纯文本(诗、地址、邮件)
    let soft_breaks = text.split("\n\n").filter(|p| p.trim().lines().count() > 1).count();
    if md_lines == 0 {
        return soft_breaks == 0;
    }
    md_lines * 5 >= lines.len()
}

/// 纯文本 → 等价 markdown:行首 md 记号转义,段内单换行转硬换行(行尾 `\`)
pub fn plain_to_markdown(text: &str) -> String {
    static LEAD: OnceLock<Regex> = OnceLock::new();
    // 编号行转义句点(`1\.`),其他记号前加反斜杠(`\#` `\>` `\-`)
    let lead = re(r"^(\s*)(?:(\d+)([.)])|([#>])|([-*+])(\s|$))", &LEAD);
    text.replace("\r\n", "\n")
        .split("\n\n")
        .map(|para| {
            let lines: Vec<String> = para
                .lines()
                .map(|l| {
                    lead.replace(l, |c: &regex::Captures| {
                        let ind = &c[1];
                        if let (Some(n), Some(p)) = (c.get(2), c.get(3)) {
                            format!("{ind}{}\\{}", n.as_str(), p.as_str())
                        } else if let Some(m) = c.get(4) {
                            format!("{ind}\\{}", m.as_str())
                        } else {
                            format!("{ind}\\{}{}", &c[5], c.get(6).map_or("", |m| m.as_str()))
                        }
                    })
                    .to_string()
                })
                .collect();
            lines.join("\\\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::signature;

    fn kinds(md: &str) -> Vec<&'static str> {
        split_blocks(md).iter().map(|b| b.kind.as_str()).collect()
    }

    #[test]
    fn splits_basic_doc() {
        let md = "# Title\n\nFirst para.\n\nSecond para with [link](https://a.com).\n\n```rust\nfn main() {}\n```\n";
        let blocks = split_blocks(md);
        assert_eq!(kinds(md), vec!["heading", "p", "p", "code"]);
        assert_eq!(blocks[0].src, "# Title");
        assert_eq!(blocks[1].sep, "\n\n");
        assert!(blocks[3].src.contains("fn main()"));
    }

    #[test]
    fn small_list_is_one_block() {
        let md = "Intro:\n\n- one\n- two\n  - nested\n- three\n\nOutro.\n";
        assert_eq!(kinds(md), vec!["p", "list", "p"]);
        assert_eq!(split_blocks(md)[1].src, "- one\n- two\n  - nested\n- three");
    }

    #[test]
    fn large_list_splits_into_group() {
        let item = format!("- {}\n", "word ".repeat(60).trim_end());
        let md = format!("Intro.\n\n{}\nOutro.\n", item.repeat(6));
        let blocks = split_blocks(&md);
        let items: Vec<&Block> = blocks.iter().filter(|b| b.kind == BlockKind::List).collect();
        assert_eq!(items.len(), 6);
        assert!(items.iter().all(|b| b.group == Some(1)));
        assert_eq!(items[1].sep, "\n");
    }

    #[test]
    fn plain_text_by_blank_lines() {
        let md = "hello world\nsecond line still same para\n\nsecond paragraph here\n\nthird";
        let blocks = split_blocks(md);
        assert_eq!(blocks.len(), 3);
        assert!(blocks.iter().all(|b| b.kind == BlockKind::Paragraph));
    }

    #[test]
    fn nothing_dropped_and_passthrough_kinds() {
        let md = "Intro.\n\n---\n\nSee the spec[^1] and the [guide][g].\n\n[^1]: The official spec.\n\n[g]: https://guide.dev\n\n<details>\n<summary>x</summary>\n</details>\n\n> quote\n";
        assert_eq!(kinds(md), vec!["p", "hr", "p", "footnote", "definition", "html", "quote"]);
        let passthrough: Vec<bool> = split_blocks(md).iter().map(|b| b.kind.translatable()).collect();
        assert_eq!(passthrough, vec![true, false, true, false, false, false, true]);
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

    // ---- 工单 04 原型样例集(proto-md/roundtrip.mjs)移植:拼回结构一致 10/10 ----

    const CORPUS: &[(&str, &str)] = &[
        ("嵌套列表", "Steps:\n\n1. Install the CLI\n   - macOS: `brew install foo`\n   - Linux: see [docs](https://a.dev/linux)\n2. Run `foo init`\n3. Done\n"),
        ("松散列表", "- First item has a paragraph.\n\n  And a second paragraph.\n\n- Second item.\n"),
        ("表格", "| Option | Default | Notes |\n|---|:---:|---|\n| `timeout` | 30 | in seconds |\n| `retries` | 3 | |\n"),
        ("引用嵌套", "> Note: this is important.\n>\n> - point one\n> - point two\n>\n> > nested quote\n"),
        ("分隔线", "Intro paragraph.\n\n---\n\nAfter the break.\n\n***\n\nEnd.\n"),
        ("HTML 块", "<details>\n<summary>Click to expand</summary>\n\nHidden text inside details.\n\n</details>\n"),
        ("脚注与引用链接", "See the spec[^1] and the [guide][g].\n\n[^1]: The official spec, 2024 edition.\n\n[g]: https://guide.dev\n"),
        ("任务列表", "- [x] Write tests\n- [ ] Update `README.md`\n"),
        ("尖括号源文", "Close the tag with </t> and open with <s id=\"1\"> in XML examples.\n"),
        ("编号续接", "3. third\n4. fourth\n\nInterruption.\n\n5. fifth\n"),
    ];

    #[test]
    fn corpus_reassembles_with_same_structure() {
        for (name, md) in CORPUS {
            let blocks = split_blocks(md);
            let back = reassemble(blocks.iter().map(|b| (b.sep.as_str(), b.src.as_str())));
            assert_eq!(back.trim_end(), md.trim_end(), "{name}: 拼回文本不一致");
            assert_eq!(signature(&back), signature(md), "{name}: 拼回结构不一致");
        }
    }

    #[test]
    fn corpus_lists_stay_whole() {
        // v0.2 把列表按项拆、逐块渲染 → 嵌套 / 松散 / 任务 / 续接编号全部走样
        for (name, md) in CORPUS {
            for b in split_blocks(md) {
                if b.kind == BlockKind::List {
                    assert!(b.group.is_none(), "{name}: 小列表不应被拆");
                }
            }
        }
    }

    // ---- 纯文本 ----

    #[test]
    fn plain_text_detection() {
        assert!(!looks_like_markdown("Roses are red\nViolets are blue\n\nLine A\nLine B"));
        assert!(looks_like_markdown("# Title\n\n- a\n- b\n"));
        assert!(looks_like_markdown("See [docs](https://x.dev) for `npm ci`."));
        assert!(looks_like_markdown("Just one sentence."));
    }

    #[test]
    fn plain_text_normalization() {
        let md = plain_to_markdown("Roses are red\nViolets are blue\n\n# not a heading\n1. not a list");
        assert_eq!(md, "Roses are red\\\nViolets are blue\n\n\\# not a heading\\\n1\\. not a list");
        let sig = signature(&md);
        assert!(sig.headings.is_empty() && sig.lists.is_empty(), "转义后不应再出现标题 / 列表");
    }
}
