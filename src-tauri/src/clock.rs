//! mtime/now 转换（issue #139）：哨兵语义的唯一真值。
//!
//! 背景：`duration_since(UNIX_EPOCH)` + 单位换算曾在 10 个函数体重复出现，
//! 哨兵 `-1 / 0 / None / MAX` 与入参 `Path / Metadata / SystemTime / Now`
//! 三维漂移。哨兵是**语义**不是默认值：`db::file_mtime_secs` 的 `-1`
//! 让 syncqueue 回放 `> updated_at`（syncqueue.rs:249）能区分「取不到」
//! 与真实 epoch 0；`mtime_tag` 的 `MAX` 让 `None` 与 epoch 0 可区分。
//! 故这里只收敛「取时长 + 换算」，哨兵由调用方显式传入，绝不硬编码。
//!
//! 入参三选一 + Now：
//! - `Path`：内部 stat（db / 缩略图缓存）
//! - `Metadata`：调用方已持有 metadata，只取时刻不二次 stat（scanner / album）
//! - `Time`：调用方已持有 `Option<SystemTime>`（lumen 缓存键）
//! - `Now`：当前时刻（各模块的 now_secs）

use std::fs::Metadata;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 时间单位：同一(Duration) 派生 secs / millis / nanos 三种计数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MtimeUnit {
    Secs,
    Millis,
    Nanos,
}

/// mtime 的取数来源。`Path` 分支会 stat，`Metadata` 分支不 stat。
pub enum MtimeInput<'a> {
    Path(&'a Path),
    Metadata(Option<&'a Metadata>),
    Time(Option<SystemTime>),
    Now,
}

/// 唯一取数点：把入参归一成「距 epoch 的 Duration」，取不到返回 None。
fn raw_duration(input: MtimeInput<'_>) -> Option<Duration> {
    match input {
        MtimeInput::Path(p) => std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok()),
        MtimeInput::Metadata(None) => None,
        MtimeInput::Metadata(Some(m)) => m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok()),
        MtimeInput::Time(None) => None,
        MtimeInput::Time(Some(t)) => t.duration_since(UNIX_EPOCH).ok(),
        MtimeInput::Now => SystemTime::now().duration_since(UNIX_EPOCH).ok(),
    }
}

/// 同一 Duration 的单位换算（u128 宽，覆盖 nanos 全程）。
fn scale(d: Duration, unit: MtimeUnit) -> u128 {
    match unit {
        MtimeUnit::Secs => d.as_secs() as u128,
        MtimeUnit::Millis => d.as_millis(),
        MtimeUnit::Nanos => d.as_nanos(),
    }
}

/// i64 通道：哨兵由调用方传入（-1 / 0 各有消费者，不合并）。
pub fn mtime_i64(input: MtimeInput<'_>, unit: MtimeUnit, sentinel: i64) -> i64 {
    raw_duration(input)
        .map(|d| scale(d, unit) as i64)
        .unwrap_or(sentinel)
}

/// u64 通道：哨兵由调用方传入（各处均为 0，保留参数防硬编码）。
pub fn mtime_u64(input: MtimeInput<'_>, unit: MtimeUnit, sentinel: u64) -> u64 {
    raw_duration(input)
        .map(|d| scale(d, unit) as u64)
        .unwrap_or(sentinel)
}

/// Option 通道：取不到即 None（FR-08 增量游标靠它区分「无文件」与 epoch 0）。
pub fn mtime_opt_i64(input: MtimeInput<'_>, unit: MtimeUnit) -> Option<i64> {
    raw_duration(input).map(|d| scale(d, unit) as i64)
}

/// u128 通道：哨兵由调用方传入（mtime_tag 用 MAX，让 None 与 epoch 0 可区分）。
pub fn mtime_u128(input: MtimeInput<'_>, unit: MtimeUnit, sentinel: u128) -> u128 {
    raw_duration(input)
        .map(|d| scale(d, unit))
        .unwrap_or(sentinel)
}

/// 当前 Unix 秒（i64 哨兵 0；清单/写盘意图时间戳用）。
pub fn now_secs_i64() -> i64 {
    mtime_i64(MtimeInput::Now, MtimeUnit::Secs, 0)
}

/// 当前 Unix 秒（u64 哨兵 0；导出清单时间戳用）。
pub fn now_secs_u64() -> u64 {
    mtime_u64(MtimeInput::Now, MtimeUnit::Secs, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// issue #139：哨兵参数生效 —— -1 / 0 各守其位，helper 不硬编码哨兵。
    #[test]
    fn i64_helper_honours_passed_sentinel() {
        let missing =
            std::env::temp_dir().join(format!("gc_clock_missing_{}_139.xmp", std::process::id()));
        let _ = fs::remove_file(&missing);
        assert_eq!(
            mtime_i64(MtimeInput::Path(&missing), MtimeUnit::Secs, -1),
            -1
        );
        assert_eq!(mtime_i64(MtimeInput::Path(&missing), MtimeUnit::Secs, 0), 0);
    }

    /// Metadata 分支不 stat：None → 哨兵；真实文件 → 秒数 > 0。
    #[test]
    fn metadata_branch_none_and_real() {
        assert_eq!(mtime_u64(MtimeInput::Metadata(None), MtimeUnit::Secs, 0), 0);
        let f = std::env::temp_dir().join(format!("gc_clock_real_{}_139.txt", std::process::id()));
        fs::write(&f, b"x").expect("建临时文件");
        let meta = fs::metadata(&f).expect("取 metadata");
        let secs = mtime_u64(MtimeInput::Metadata(Some(&meta)), MtimeUnit::Secs, 0);
        assert!(secs > 0, "真实文件 mtime 秒数必须 > 0");
        let _ = fs::remove_file(&f);
    }

    /// Path / Option / Time 三通道的哨兵：None / MAX / 真时刻。
    #[test]
    fn opt_and_tag_sentinels() {
        let missing =
            std::env::temp_dir().join(format!("gc_clock_o_{}_139.xmp", std::process::id()));
        let _ = fs::remove_file(&missing);
        assert_eq!(
            mtime_opt_i64(MtimeInput::Path(&missing), MtimeUnit::Millis),
            None
        );

        assert_eq!(
            mtime_u128(MtimeInput::Time(None), MtimeUnit::Nanos, u128::MAX),
            u128::MAX
        );
        assert_eq!(
            mtime_u128(
                MtimeInput::Time(Some(UNIX_EPOCH)),
                MtimeUnit::Nanos,
                u128::MAX
            ),
            0
        );
    }

    /// now 两通道一致且为正。
    #[test]
    fn now_channels_positive() {
        assert!(now_secs_i64() > 0);
        assert!(now_secs_u64() > 0);
    }
}
