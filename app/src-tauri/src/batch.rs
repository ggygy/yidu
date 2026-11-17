// 组批(工单 06):3~10 块/批、约 2000 字符预算;CJK→非 CJK 输出膨胀,预算除以 1.6
// v0.3 §2.6.3:首批 1 块单独先发(< 150 字补到 2 块,≤ 300 字),压首块时间;后续规则不变
use crate::blocks::Block;

pub const MAX_BLOCKS: usize = 10;
pub const CHAR_BUDGET: usize = 2000;
/// 首块不足此字数时补第 2 块
pub const FIRST_PAD_UNDER: usize = 150;
/// 首批补块后的总字数上限
pub const FIRST_MAX_CHARS: usize = 300;

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
/// 规则:首批 = 第 1 个待译块(其 < 150 字且与第 2 块合计 ≤ 300 字时带上第 2 块)单独先发;
/// 其余:总数 ≤10 且预算内 → 单批;否则贪心装箱(≤10 块、≤预算);
/// 尾批 <3 块时,若合并后仍 ≤10 块且 ≤预算 则并入前批(首批不参与合并)。
pub fn make_batches<'a>(blocks: &'a [Block], indexes: &[usize], direction: &str) -> Vec<Vec<(usize, &'a Block)>> {
    if indexes.is_empty() {
        return Vec::new();
    }
    let chars_of = |i: usize| blocks[i].src.chars().count();
    let mut first_len = 1;
    if indexes.len() >= 2 {
        let c0 = chars_of(indexes[0]);
        if c0 < FIRST_PAD_UNDER && c0 + chars_of(indexes[1]) <= FIRST_MAX_CHARS {
            first_len = 2;
        }
    }
    let first: Vec<(usize, &'a Block)> = indexes[..first_len].iter().map(|&i| (i, &blocks[i])).collect();
    let mut out = vec![first];
    out.extend(pack(blocks, &indexes[first_len..], direction));
    out
}

/// 后续批装箱(v0.2 规则)
fn pack<'a>(blocks: &'a [Block], indexes: &[usize], direction: &str) -> Vec<Vec<(usize, &'a Block)>> {
    if indexes.is_empty() {
        return Vec::new();
    }
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

    fn sizes(b: &[Vec<(usize, &Block)>]) -> Vec<usize> {
        b.iter().map(|x| x.len()).collect()
    }

    #[test]
    fn empty_input_no_batches() {
        let blocks = vec![p("a")];
        assert!(make_batches(&blocks, &[], "en2zh").is_empty());
    }

    #[test]
    fn single_block_single_batch() {
        let blocks = vec![p("only")];
        assert_eq!(sizes(&make_batches(&blocks, &[0], "en2zh")), vec![1]);
    }

    #[test]
    fn first_batch_pads_short_first_block() {
        // 首块 3 字 < 150 且与第 2 块合计 ≤ 300 → 首批 2 块;其余单批
        let blocks = vec![p("aaa"), p("bbb"), p("ccc")];
        let batches = make_batches(&blocks, &[0, 1, 2], "en2zh");
        assert_eq!(sizes(&batches), vec![2, 1]);
        assert_eq!(batches[0][0].0, 0);
        assert_eq!(batches[1][0].0, 2);
    }

    #[test]
    fn first_batch_single_when_first_block_long() {
        let long = "z".repeat(200);
        let blocks = vec![p(&long), p("b"), p("c")];
        assert_eq!(sizes(&make_batches(&blocks, &[0, 1, 2], "en2zh")), vec![1, 2]);
    }

    #[test]
    fn first_batch_no_pad_when_over_300() {
        // 首块短,但与第 2 块合计 > 300 → 不补
        let blocks = vec![p(&"a".repeat(100)), p(&"b".repeat(250)), p("c")];
        assert_eq!(sizes(&make_batches(&blocks, &[0, 1, 2], "en2zh")), vec![1, 2]);
    }

    #[test]
    fn first_batch_respects_pending_indexes() {
        // 续译:首批取第一个待译块,不是全局第 0 块
        let blocks = vec![p(&"x".repeat(400)), p(&"y".repeat(400)), p("z")];
        let batches = make_batches(&blocks, &[1, 2], "en2zh");
        assert_eq!(sizes(&batches), vec![1, 1]);
        assert_eq!(batches[0][0].0, 1);
    }

    #[test]
    fn caps_at_10_blocks() {
        // 首批 2(短块补块)+ 剩 10 块正好一批
        let blocks: Vec<Block> = (0..12).map(|i| p(&format!("block {i}"))).collect();
        let indexes: Vec<usize> = (0..12).collect();
        assert_eq!(sizes(&make_batches(&blocks, &indexes, "en2zh")), vec![2, 10]);
        let blocks: Vec<Block> = (0..14).map(|i| p(&format!("block {i}"))).collect();
        let indexes: Vec<usize> = (0..14).collect();
        // 剩 12 → 贪心 10 + 2;尾批 2 块但合并超 10 块,不合并
        assert_eq!(sizes(&make_batches(&blocks, &indexes, "en2zh")), vec![2, 10, 2]);
    }

    #[test]
    fn char_budget_splits_and_no_overbudget_merge() {
        // 首批 1 块(900 字);剩 4 × 900 = 3600 > 2000 → 贪心 2+2;尾批 2 块合并超预算,不合并
        let long = "x".repeat(900);
        let blocks = vec![p(&long), p(&long), p(&long), p(&long), p(&long)];
        assert_eq!(sizes(&make_batches(&blocks, &[0, 1, 2, 3, 4], "en2zh")), vec![1, 2, 2]);
    }

    #[test]
    fn tail_merge_within_budget() {
        // 首批 [0](1200 字);剩余:[1](1200) 后 [2,3,4] 小块 → 贪心 [1,2,3,4](1203 ≤ 2000)单批
        let big = "y".repeat(1200);
        let blocks = vec![p(&big), p(&big), p("a"), p("b"), p("c")];
        assert_eq!(sizes(&make_batches(&blocks, &[0, 1, 2, 3, 4], "en2zh")), vec![1, 4]);
        // 剩余 [1](1200),[2](1200),[3] → 贪心 [1],[2,3];尾批 2 块但合并 2401 > 2000,不合并
        let blocks = vec![p(&big), p(&big), p(&big), p("a")];
        assert_eq!(sizes(&make_batches(&blocks, &[0, 1, 2, 3], "en2zh")), vec![1, 1, 2]);
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
