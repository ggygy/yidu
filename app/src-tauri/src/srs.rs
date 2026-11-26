// 生词间隔复习调度(v0.6,SM-2 变体,三档评分)。纯函数,不碰库与时钟 —— 时间由调用方传入。
// 状态即 review_state 表的列:due_at / interval_days / ease / reps / lapses。
//
// 评分:
//   Forgot 忘了   → 回到学习态:reps 归零、记一次 lapse、ease −0.20,10 分钟后再出现(当次复习内重学)
//   Hard   模糊   → ease −0.15;间隔 ×1.2(至少 1 天;新卡 1 天)
//   Good   记得   → 间隔:第 1 次 1 天、第 2 次 3 天,之后 ×ease
// ease 下限 1.3(SM-2 原值);间隔上限 365 天(生词本不需要按年排期)。
use serde::{Deserialize, Serialize};

pub const DAY: i64 = 86_400;
pub const RELEARN_SECS: i64 = 600;
pub const MIN_EASE: f64 = 1.3;
pub const DEFAULT_EASE: f64 = 2.5;
pub const MAX_INTERVAL_DAYS: f64 = 365.0;
/// 每 24 小时最多引入的新词数
pub const NEW_PER_DAY: i64 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Grade {
    Forgot,
    Hard,
    Good,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct State {
    pub due_at: i64,
    pub interval_days: f64,
    pub ease: f64,
    pub reps: i64,
    pub lapses: i64,
}

impl State {
    /// 新加入生词本的词:第二天到期
    pub fn fresh(now: i64) -> Self {
        State { due_at: now + DAY, interval_days: 0.0, ease: DEFAULT_EASE, reps: 0, lapses: 0 }
    }
}

pub fn schedule(s: State, grade: Grade, now: i64) -> State {
    let ease = if s.ease.is_finite() { s.ease.max(MIN_EASE) } else { DEFAULT_EASE };
    let interval = if s.interval_days.is_finite() { s.interval_days.max(0.0) } else { 0.0 };
    match grade {
        Grade::Forgot => State {
            due_at: now + RELEARN_SECS,
            interval_days: 0.0,
            ease: (ease - 0.20).max(MIN_EASE),
            reps: 0,
            lapses: s.lapses + 1,
        },
        Grade::Hard => {
            let next = if s.reps == 0 { 1.0 } else { (interval * 1.2).max(1.0) }.min(MAX_INTERVAL_DAYS);
            State { due_at: now + (next * DAY as f64) as i64, interval_days: next, ease: (ease - 0.15).max(MIN_EASE), reps: s.reps + 1, lapses: s.lapses }
        }
        Grade::Good => {
            let next = match s.reps {
                0 => 1.0,
                1 => 3.0,
                _ => (interval * ease).max(interval + 1.0),
            }
            .min(MAX_INTERVAL_DAYS);
            State { due_at: now + (next * DAY as f64) as i64, interval_days: next, ease, reps: s.reps + 1, lapses: s.lapses }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn fresh_card_is_due_next_day() {
        let s = State::fresh(NOW);
        assert_eq!(s.due_at, NOW + DAY);
        assert_eq!((s.reps, s.lapses), (0, 0));
    }

    #[test]
    fn good_ladder_is_1_3_then_times_ease() {
        let mut s = State::fresh(NOW);
        s = schedule(s, Grade::Good, NOW);
        assert_eq!((s.interval_days, s.reps, s.due_at), (1.0, 1, NOW + DAY));
        s = schedule(s, Grade::Good, NOW);
        assert_eq!((s.interval_days, s.reps), (3.0, 2));
        s = schedule(s, Grade::Good, NOW);
        assert_eq!(s.interval_days, 7.5); // 3 × 2.5
        assert_eq!(s.due_at, NOW + (7.5 * DAY as f64) as i64);
        assert_eq!(s.ease, DEFAULT_EASE); // Good 不动 ease
    }

    #[test]
    fn hard_grows_slowly_and_lowers_ease() {
        let s = schedule(State { due_at: 0, interval_days: 10.0, ease: 2.5, reps: 4, lapses: 0 }, Grade::Hard, NOW);
        assert_eq!(s.interval_days, 12.0);
        assert!((s.ease - 2.35).abs() < 1e-9);
        assert_eq!(s.reps, 5);
        // 新卡评「模糊」也是 1 天
        assert_eq!(schedule(State::fresh(NOW), Grade::Hard, NOW).interval_days, 1.0);
    }

    #[test]
    fn forgot_resets_to_relearn_and_counts_lapse() {
        let s = schedule(State { due_at: 0, interval_days: 30.0, ease: 2.5, reps: 6, lapses: 1 }, Grade::Forgot, NOW);
        assert_eq!(s.due_at, NOW + RELEARN_SECS);
        assert_eq!((s.interval_days, s.reps, s.lapses), (0.0, 0, 2));
        assert!((s.ease - 2.3).abs() < 1e-9);
        // 忘了之后重新从 1 天、3 天爬
        let s = schedule(s, Grade::Good, NOW);
        assert_eq!(s.interval_days, 1.0);
    }

    #[test]
    fn ease_floor_and_interval_cap_hold() {
        let mut s = State { due_at: 0, interval_days: 5.0, ease: 1.35, reps: 3, lapses: 0 };
        for _ in 0..5 {
            s = schedule(s, Grade::Hard, NOW);
        }
        assert_eq!(s.ease, MIN_EASE);
        let s = schedule(State { due_at: 0, interval_days: 300.0, ease: 2.5, reps: 9, lapses: 0 }, Grade::Good, NOW);
        assert_eq!(s.interval_days, MAX_INTERVAL_DAYS);
    }

    #[test]
    fn garbage_state_is_sanitised() {
        let s = schedule(State { due_at: 0, interval_days: f64::NAN, ease: f64::INFINITY, reps: 3, lapses: 0 }, Grade::Good, NOW);
        assert!(s.interval_days.is_finite() && s.interval_days >= 1.0);
        assert_eq!(s.ease, DEFAULT_EASE);
    }
}
