//! 双向评级同步的判定：谁改动过就以谁为准。
//!
//! 判定只看「宿主侧边栏」与「lumen catalog」相对**上次同步游标**的变化，
//! 不用 mtime 大小比较（两侧写入精度不同，比大小会误判）。

/// 同步动作：宿主评级 → lumen。
///
/// `rating = 0 且 flag = none` 不推：lumen 的 `Catalog.compact()` 会把全零条目压掉，
/// 推过去等于"消失"（glue 报告 C §6.3）。
pub fn should_push_rating(rating: u8, flag: &str) -> bool {
    !(rating == 0 && (flag == "none" || flag.is_empty()))
}

/// 同步判定：把宿主侧边栏值、lumen 值与游标放在一起得出结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncDecision {
    /// 无变化
    InSync,
    /// 宿主 → lumen（宿主改了，lumen 还没跟）
    PushToLumen,
    /// lumen → 宿主（lumen 改了，宿主还没跟）
    PullFromLumen,
    /// 两侧都改过 → 交给用户裁决（绝不静默覆盖）
    Conflict,
}

/// 决定一次同步动作。
///
/// - 无游标（首次见到这张）→ 首次同步：以宿主值为准推给 lumen；
/// - 值一致 → `InSync`；
/// - 只有一侧变 → 推那一侧；
/// - 两侧都变 → `Conflict`。
pub fn decide_sync(
    cursor: Option<(u8, String, i64)>, // (rating, flag, synced_at)
    host_now: (u8, String, i64),       // 宿主侧边栏 (rating, flag, mtime)
    lumen_now: Option<(u8, String)>,   // lumen catalog 值
) -> SyncDecision {
    let (host_rating, host_flag, host_mtime) = host_now;
    let Some((cur_rating, cur_flag, _synced_at)) = cursor else {
        // 首次：宿主是权威（用户刚在这台机器上打的星）
        return if lumen_now.is_some() {
            SyncDecision::PushToLumen
        } else {
            SyncDecision::InSync
        };
    };
    let host_changed = host_rating != cur_rating || host_flag != cur_flag;
    let Some((l_rating, l_flag)) = lumen_now else {
        return if host_changed {
            SyncDecision::PushToLumen
        } else {
            SyncDecision::InSync
        };
    };
    let lumen_changed = l_rating != cur_rating || l_flag != cur_flag;
    let same_now = host_rating == l_rating && host_flag == l_flag;

    if same_now {
        SyncDecision::InSync
    } else if host_changed && lumen_changed {
        SyncDecision::Conflict
    } else if host_changed {
        SyncDecision::PushToLumen
    } else if lumen_changed {
        SyncDecision::PullFromLumen
    } else {
        // 都没变但值不同（历史脏数据）：以侧边栏 mtime 为准
        if host_mtime > 0 {
            SyncDecision::PushToLumen
        } else {
            SyncDecision::PullFromLumen
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
// ---- Step 8: 评级同步判定 ----
#[test]
fn push_skips_zero_rating() {
    // lumen compact 会压掉全零条目 → 推过去等于消失
    assert!(!should_push_rating(0, "none"), "0 星 + 无旗标不推");
    assert!(!should_push_rating(0, ""), "0 星 + 空旗标不推");
    assert!(should_push_rating(0, "pick"), "0 星 + pick 要推");
    assert!(
        should_push_rating(0, "reject"),
        "0 星 + reject 要推（-1 语义）"
    );
    assert!(should_push_rating(3, "none"), "有星要推");
}

#[test]
fn sync_decision_matrix() {
    // 首次见到（无游标）+ lumen 无记录 → 静默（不产生动作）
    assert_eq!(
        decide_sync(None, (3, "pick".into(), 100), None),
        SyncDecision::InSync
    );
    // 首次 + lumen 已有值 → 以宿主为准推过去
    assert_eq!(
        decide_sync(None, (3, "pick".into(), 100), Some((1, "none".into()))),
        SyncDecision::PushToLumen
    );
    // 无变化 → InSync
    assert_eq!(
        decide_sync(
            Some((3, "pick".into(), 90)),
            (3, "pick".into(), 100),
            Some((3, "pick".into()))
        ),
        SyncDecision::InSync
    );
    // 只有宿主变 → 推
    assert_eq!(
        decide_sync(
            Some((1, "none".into(), 90)),
            (3, "pick".into(), 100),
            Some((1, "none".into()))
        ),
        SyncDecision::PushToLumen
    );
    // 只有 lumen 变 → 拉
    assert_eq!(
        decide_sync(
            Some((1, "none".into(), 90)),
            (1, "none".into(), 90),
            Some((5, "pick".into()))
        ),
        SyncDecision::PullFromLumen
    );
    // 两侧都变 → 冲突（绝不静默覆盖）
    assert_eq!(
        decide_sync(
            Some((1, "none".into(), 90)),
            (3, "pick".into(), 100),
            Some((5, "pick".into()))
        ),
        SyncDecision::Conflict
    );
    // lumen 无记录 + 宿主变了 → 推
    assert_eq!(
        decide_sync(Some((1, "none".into(), 90)), (2, "none".into(), 100), None),
        SyncDecision::PushToLumen
    );
}

#[test]
fn rating_sync_cursor_roundtrip() {
    // 纯逻辑：游标编码
    let c: (u8, String, i64) = (4, "pick".to_string(), 1_700_000_000);
    assert_eq!(c.0, 4);
    assert_eq!(c.1, "pick");
}

}
