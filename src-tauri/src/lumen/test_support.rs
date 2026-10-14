//! 仅供 `#[cfg(test)]` 使用的共享测试夹具。
//!
//! 随模块拆分，这些小helper 被多个子模块的测试共用（临时文件名必须跨模块
//! 唯一，否则并行测试互相删对方文件）。放在正式模块里会变成 prod 可见的死代码，
//! 因此单独成文件并整体 `#[cfg(test)]`。

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 测试用临时文件名（进程内唯一，避开并行测试互相踩）。
pub fn tmp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("lumen_test_{}_{}", std::process::id(), name))
}

/// 相对 UNIX_EPOCH 后若干秒的时间戳（缓存键测试用）。
pub fn t_plus(secs: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(secs)
}
/// 预览缓存输入的测试默认值。
pub fn ep_inputs(src_mtime: Option<SystemTime>) -> crate::lumen::cache::PreviewCacheInputs {
    crate::lumen::cache::PreviewCacheInputs {
        width: 1600,
        variant: crate::lumen::PreviewVariant::Edited,
        lumen_version: crate::lumen::PINNED_LUMEN_VERSION,
        src_mtime,
        project_mtime: None,
        recipe: None,
    }
}
