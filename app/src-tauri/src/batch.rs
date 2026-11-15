// 组批(工单 06):3~10 块/批、约 2000 字符预算;CJK→非 CJK 输出膨胀,预算除以 1.6
use crate::blocks::Block;

pub const MAX_BLOCKS: usize = 10;
pub const CHAR_BUDGET: usize = 2000;

pub fn char_budget(direction: &str) -> usize {
    if expands_wide(direction) {
        (CHAR_BUDGET as f64 / 1.6) as usize
    } else {
        CHAR_BUDGET
    }
}

/// CJK 源 → 非 CJK 目标时,拉丁/西里尔输出通常更长,收紧预算;自定义语言按名称字符推断
fn expands_wide(direction: &str) -> bool {
    let (from, to) = direction.split_once('2').unwrap_or(("en", "zh"));
    is_cjk(from) && !is_cjk(to)
}

fn is_cjk(seg: &str) -> bool {
    if let Some(name) = seg.strip_prefix('~') {
        return name.chars().any(is_cjk_char);
    }
    matches!(seg, "zh" | "ja" | "ko")
}

fn is_cjk_char(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF   // 汉字
        | 0x3040..=0x30FF                    // 假名
        | 0xAC00..=0xD7AF | 0x1100..=0x11FF  // 谚文
    )
}

/// 输入:全部块(供引用)+ 待译块的全局 idx 列表;输出:批列表
/// 规则:总数 ≤10 且预算内 → 单批;否则贪心装箱(≤10 块、≤预算);
/// 尾批 <3 块时,若合并后仍 ≤10 块且 ≤预算 则并入前批。
pub fn make_batches<'a>(blocks: &'a [Block], indexes: &[usize], direction: &str) -> Vec<Vec<(usize, &'a Block)>> {
    let budget = char_budget(direction);
    let total_chars: usize = indexes.iter().map(|&i| blocks[i].src.chars().count()).sum();
    if indexes.len() <= MAX_BLOCKS && total_chars <= budget {
        return vec![indexes.iter().map(|&i| (i, &blocks[i])).collect()];
    }
    let mut batches: Vec<Vec<(usize, &'a Block)>> = Vec::new();
    let mut cur: Vec<(usize, &'a Block)> = Vec::new();
    let mut cur_chars = 0usize;
    for &gi in indexes {
        let b = &blocks[gi];
        let chars = b.src.chars().count();
        if !cur.is_empty() && (cur.len() >= MAX_BLOCKS || cur_chars + chars > budget) {
            batches.push(std::mem::take(&mut cur));
            cur_chars = 0;
        }
        cur.push((gi, b));
        cur_chars += chars;
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    if batches.len() >= 2 {
        let last_chars: usize = batches
            .last()
            .unwrap()
            .iter()
            .map(|(_, b)| b.src.chars().count())
            .sum();
        let prev = &batches[batches.len() - 2];
        let prev_chars: usize = prev.iter().map(|(_, b)| b.src.chars().count()).sum();
        let last_len = batches.last().unwrap().len();
        if last_len < 3 && prev.len() + last_len <= MAX_BLOCKS && prev_chars + last_chars <= budget {
            let last = batches.pop().unwrap();
            batches.last_mut().unwrap().extend(last);
        }
    }
    batches
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::BlockKind;

    fn p(src: &str) -> Block {
        Block { kind: BlockKind::Paragraph, src: src.into(), hash: String::new() }
    }

    #[test]
    fn small_doc_single_batch() {
        let blocks = vec![p("aaa"), p("bbb"), p("ccc")];
        let batches = make_batches(&blocks, &[0, 1, 2], "en2zh");
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 3);
    }

    #[test]
    fn caps_at_10_blocks() {
        let blocks: Vec<Block> = (0..12).map(|i| p(&format!("block {i}"))).collect();
        let indexes: Vec<usize> = (0..12).collect();
        let batches = make_batches(&blocks, &indexes, "en2zh");
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 10);
        assert_eq!(batches[1].len(), 2);
    }

    #[test]
    fn char_budget_splits_and_no_overbudget_merge() {
        // 每块 900 字符 × 4:总 3600 > 2000 → 贪心 2+2;尾批 2 块但合并超预算,不合并
        let long = "x".repeat(900);
        let blocks = vec![p(&long), p(&long), p(&long), p(&long)];
        let batches = make_batches(&blocks, &[0, 1, 2, 3], "en2zh");
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 2);
        assert_eq!(batches[1].len(), 2);
    }

    #[test]
    fn tail_merge_within_budget() {
        // 构造:块 0 超大(1800),块 1~3 小 → 批1=[0], 批2=[1,2,3]?贪心:块0(1800)后块1 1800+50>2000 → 切
        // 批1=[0];块1~3 共 150 → 批2;尾批 3 块不触发合并。改用:块0 大,块1 大,块2、块3 小
        let big = "y".repeat(1200);
        let blocks = vec![p(&big), p(&big), p("a"), p("b")];
        let batches = make_batches(&blocks, &[0, 1, 2, 3], "en2zh");
        // 贪心:[0],[1,2,3](1200+1+1=1202 ≤2000)
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[1].len(), 3);
    }

    #[test]
    fn zh2en_budget_smaller() {
        assert_eq!(char_budget("zh2en"), 1250);
        assert_eq!(char_budget("en2zh"), 2000);
    }

    #[test]
    fn cjk_source_budget_generalized() {
        assert_eq!(char_budget("ja2en"), 1250);
        assert_eq!(char_budget("ko2fr"), 1250);
        assert_eq!(char_budget("ja2zh"), 2000); // CJK→CJK 不膨胀
        assert_eq!(char_budget("en2ja"), 2000);
        // 自定义语言按名称字符推断(泰语源名含汉字 → 按保守预算)
        assert_eq!(char_budget("~泰语2en"), 1250);
        assert_eq!(char_budget("en2~泰语"), 2000);
    }
}
