//! lumen-cli 可执行文件定位。
//!
//! 候选路径优先级：设置里显式指定的路径 > PATH > 打包 sidecar。
//! 全部是纯函数，环境目录由参数或 current_exe 注入，便于测试。

use std::path::{Path, PathBuf};

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
    let output = crate::proc::silent("where").arg(name).output().ok()?;
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

/// 打包态候选路径（纯函数，顺序即优先级）。
///
/// Windows 的 Tauri v2 把 `bundle.resources` 原样落到**安装目录**（`resource_dir`
/// 与 exe 同目录），所以 `binaries/lumen-cli/**` 实际在
/// `<exe_dir>/binaries/lumen-cli/lumen-cli.exe`（`installer.nsi` 实证）。
/// `resources/` 两条是其它平台的资源目录布局与历史布局回退。
pub fn bundled_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    vec![
        exe_dir
            .join("binaries")
            .join("lumen-cli")
            .join("lumen-cli.exe"),
        exe_dir
            .join("resources")
            .join("lumen-cli")
            .join("lumen-cli.exe"),
        exe_dir
            .join("resources")
            .join("binaries")
            .join("lumen-cli")
            .join("lumen-cli.exe"),
    ]
}

/// 探测随包分发的 sidecar（打包态候选 + 开发态 cwd 路径）。
pub(super) fn find_bundled_lumen_cli() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?;
    let packaged = bundled_candidates(exe_dir.parent()?);
    if let Some(found) = first_existing(&packaged) {
        return Some(found);
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

/// issue #68：Windows 安装器把 resources 落到 `<exe_dir>/binaries/lumen-cli/`，
/// 这条必须排第一，否则安装版永远发现不了随包引擎。
#[test]
fn bundled_candidates_prefers_windows_installer_layout() {
    let dir = tmp("pkg_win");
    let exe = dir
        .join("binaries")
        .join("lumen-cli")
        .join("lumen-cli.exe");
    std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
    std::fs::write(&exe, b"x").unwrap();

    let candidates = bundled_candidates(&dir);
    assert_eq!(
        candidates.first(),
        Some(&exe),
        "安装器落点 binaries/lumen-cli 必须是第一候选"
    );
    assert_eq!(first_existing(&candidates), Some(exe));
    let _ = std::fs::remove_dir_all(&dir);
}

/// 没有安装器布局时回退到 `resources/` 布局。
#[test]
fn bundled_candidates_falls_back_to_resources_layout() {
    let dir = tmp("pkg_res");
    let exe = dir
        .join("resources")
        .join("lumen-cli")
        .join("lumen-cli.exe");
    std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
    std::fs::write(&exe, b"x").unwrap();

    let candidates = bundled_candidates(&dir);
    assert_eq!(
        first_existing(&candidates),
        Some(exe),
        "缺安装器布局时应回退 resources/lumen-cli"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

}
