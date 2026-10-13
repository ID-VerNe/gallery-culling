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
