//! 仅供 `#[cfg(test)]` 使用的共享测试夹具。
//!
//! 随模块拆分，这些小helper 被多个子模块的测试共用（临时文件名必须跨模块
//! 唯一，否则并行测试互相删对方文件）。放在正式模块里会变成 prod 可见的死代码，
//! 因此单独成文件并整体 `#[cfg(test)]`。

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
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

// ---- issue #136：ensure_preview / ensure_detail 参数化 harness ----
//
// 四个行为（命中/成功/缺失/透传）与 tmp 命名无关，所以收敛到这里；
// 各域差异（tmp 后缀、args 检查、missing_msg）由调用方以参数传入，
// detail 的 `.jpg` 哨兵作为 `check_args` 参数保留，不在 harness 里写死。

use serde_json::Value;

use crate::lumen::LumenError;

type RenderBox = Box<dyn FnOnce(&Path, &Value) -> Result<(), LumenError>>;

/// 命中分支：`out` 已存在 → 不得调用 render，直接返回 `out`。
pub fn assert_cache_hit_skips_render(
    out: PathBuf,
    ensure: impl FnOnce(RenderBox) -> Result<PathBuf, LumenError>,
) {
    let called = Rc::new(Cell::new(false));
    let flag = Rc::clone(&called);
    let render: RenderBox = Box::new(move |_, _| {
        flag.set(true);
        Err(LumenError::Command("不应被调用".into()))
    });
    let got = ensure(render).expect("命中应直接 Ok");
    assert!(!called.get(), "缓存命中不得调用渲染边界");
    assert_eq!(got, out);
}

/// 成功分支：render 写 `expected_tmp` → `rename`，`tmp` 不残留。
/// `check_args` 负责域特化断言（如 preview 的 `size` / detail 的 `.jpg` 哨兵）。
pub fn assert_cache_success_renames(
    out: PathBuf,
    expected_tmp: PathBuf,
    check_args: impl FnOnce(&Value) + 'static,
    ensure: impl FnOnce(RenderBox) -> Result<PathBuf, LumenError>,
) {
    // 保证未命中：PID 复用 / 并行重跑可能留下上轮产物，否则命中短路会让
    // render 内的断言（尤其 detail `.jpg` 哨兵）根本不执行，变异假绿。
    let _ = std::fs::remove_file(&out);
    let _ = std::fs::remove_file(&expected_tmp);
    let expected_tmp_in_render = expected_tmp.clone();
    let render: RenderBox = Box::new(move |tmp: &Path, args: &Value| {
        assert_eq!(tmp, expected_tmp_in_render.as_path());
        check_args(args);
        std::fs::write(tmp, b"rendered").unwrap();
        Ok(())
    });
    let got = ensure(render).expect("渲染成功应 Ok");
    assert_eq!(got, out);
    assert!(out.is_file(), "最终产物应存在");
    assert!(!expected_tmp.exists(), "rename 后不得残留 tmp");
}

/// 缺失分支：render 返回 `Ok` 但不写文件 → `Protocol` 错误且带域特化文案。
/// 文案由参数传入（preview `未生成预览输出文件` / detail `未生成细节输出文件`），
/// 保证 `ensure_cached_render` 的 `missing_msg` 参数真的透传到错误里。
pub fn assert_cache_missing_output_is_protocol_error(
    expected_msg: &str,
    ensure: impl FnOnce(RenderBox) -> Result<PathBuf, LumenError>,
) {
    let render: RenderBox = Box::new(|_, _| Ok(()));
    let err = ensure(render).expect_err("输出缺失应 Err");
    assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
    assert!(
        err.to_string().contains(expected_msg),
        "错误文案应含 `{expected_msg}`，实际: {err:?}"
    );
}

/// 透传分支：render 返回 `Command` 错误 → 原样透传，最终路径不得存在。
pub fn assert_cache_propagates_error(
    out: PathBuf,
    ensure: impl FnOnce(RenderBox) -> Result<PathBuf, LumenError>,
) {
    let render: RenderBox = Box::new(|_, _| Err(LumenError::Command("lumen 炸了".into())));
    let err = ensure(render).expect_err("渲染错误应透传");
    assert!(matches!(err, LumenError::Command(_)));
    assert!(!out.exists(), "失败时最终路径不得存在");
}
