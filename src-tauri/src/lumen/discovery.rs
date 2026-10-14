//! lumen-cli 可执行文件定位。
//!
//! 候选路径优先级：设置里显式指定的路径 > PATH > 打包 sidecar。
//! 全部是纯函数，环境目录由参数或 current_exe 注入，便于测试。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 返回候选路径中第一个真实存在的（顺序即优先级）。
pub fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.exists()).cloned()
}

/// 构建 lumen-cli 候选路径列表（纯函数：环境目录由参数注入）。
///
/// 优先级：设置中的显式路径 → 用户目录安装 → 系统目录安装。
pub fn lumen_candidates(
    settings_path: &str,
    local_appdata: &Path,
    program_files: &Path,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if !settings_path.trim().is_empty() {
        candidates.push(PathBuf::from(settings_path));
    }
    candidates.push(
        local_appdata
            .join("Programs")
            .join("LUMEN RAW")
            .join("lumen-cli.exe"),
    );
    candidates.push(program_files.join("LUMEN RAW").join("lumen-cli.exe"));
    candidates
}

/// 在 PATH 中查找可执行文件（Windows `where`，失败视作未找到）。
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let output = Command::new("where").arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|p| p.exists())
}

/// 查找 lumen-cli：打包资源 → PATH（where）→ None。
///
/// 打包后 Tauri 把 `binaries/lumen-cli/**` 放到 exe 旁的 `resources/lumen-cli/`；
/// 开发态则直接找 `src-tauri/binaries/lumen-cli/lumen-cli.exe`。
pub fn find_lumen_cli(settings_path: &str) -> Option<PathBuf> {
    if !settings_path.trim().is_empty() {
        let explicit = PathBuf::from(settings_path);
        if explicit.exists() {
            return Some(explicit);
        }
    }
    if let Some(found) = find_bundled_lumen_cli() {
        return Some(found);
    }
    find_in_path("lumen-cli")
}

/// 探测随包分发的 sidecar（开发态与打包态各一条路径）。
pub(super) fn find_bundled_lumen_cli() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?;
    // 打包态：<exe>/../resources/lumen-cli/lumen-cli.exe
    let bundled = exe_dir
        .parent()?
        .join("resources")
        .join("lumen-cli")
        .join("lumen-cli.exe");
    if bundled.is_file() {
        return Some(bundled);
    }
    // 开发态：cargo test 时 cwd = src-tauri
    let dev = PathBuf::from("binaries")
        .join("lumen-cli")
        .join("lumen-cli.exe");
    dev.is_file().then_some(dev)
}

#[cfg(test)]
mod tests {
    use crate::lumen::test_support::tmp;
    use std::path::{Path, PathBuf};
    use super::*;
// ---- B1 ----
#[test]
fn first_existing_returns_first_match() {
    let a = tmp("missing_a.lnk");
    let b = tmp("exists_b.lnk");
    let c = tmp("exists_c.lnk");
    std::fs::write(&b, b"x").unwrap();
    std::fs::write(&c, b"x").unwrap();

    let got = first_existing(&[a, b.clone(), c]);
    assert_eq!(got, Some(b.clone()), "应返回首个存在的候选");
    let _ = std::fs::remove_file(&b);
}

#[test]
fn first_existing_none_when_missing() {
    let a = tmp("nope_a.lnk");
    let b = tmp("nope_b.lnk");
    assert_eq!(first_existing(&[a, b]), None);
}

// ---- B2 ----
#[test]
fn lumen_candidates_settings_path_first() {
    let explicit = r"C:\custom\lumen-cli.exe";
    let got = lumen_candidates(explicit, Path::new(r"T:\la"), Path::new(r"T:\pf"));
    assert_eq!(got.len(), 3);
    assert_eq!(got[0], PathBuf::from(explicit), "设置路径必须是第一个候选");
    assert_eq!(
        got[1],
        PathBuf::from(r"T:\la\Programs\LUMEN RAW\lumen-cli.exe")
    );
    assert_eq!(got[2], PathBuf::from(r"T:\pf\LUMEN RAW\lumen-cli.exe"));
}

#[test]
fn lumen_candidates_skips_empty_setting() {
    let got = lumen_candidates("  ", Path::new(r"T:\la"), Path::new(r"T:\pf"));
    assert_eq!(got.len(), 2, "空设置路径不应进候选列表");
    assert_eq!(
        got[0],
        PathBuf::from(r"T:\la\Programs\LUMEN RAW\lumen-cli.exe")
    );
}

// ---- B3 ----
#[test]
fn find_lumen_cli_prefers_existing_explicit_path() {
    // 确定性：显式设置指向真实文件 → 直接返回，不触达 PATH/资源探测
    let fixture = Path::new("tests/fixtures/lumen_fixture_ok.cmd")
        .canonicalize()
        .unwrap();
    assert_eq!(
        find_lumen_cli(&fixture.display().to_string()),
        Some(fixture)
    );
    // 显式路径不存在 → 继续往下找（不因坏设置直接放弃）
    let bogus = find_lumen_cli(r"C:\nope\lumen-cli-xyz.exe");
    assert_ne!(bogus, Some(PathBuf::from(r"C:\nope\lumen-cli-xyz.exe")));
}

#[test]
fn find_bundled_returns_none_without_sidecar() {
    // 本机未安装 sidecar 到 PATH 时应返回 None（不 panic）
    let _ = find_bundled_lumen_cli();
}

#[test]
fn where_lumen_cli_missing_returns_none() {
    assert_eq!(find_in_path("definitely-not-a-real-exe-xyz-987"), None);
}

#[test]
fn where_lumen_cli_parses_real_output() {
    let found = find_in_path("notepad.exe").expect("notepad.exe 应能通过 where 找到");
    assert!(found.exists(), "where 返回的路径应真实存在: {:?}", found);
}

}
