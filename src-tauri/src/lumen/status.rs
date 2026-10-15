//! 版本查询与前端握手状态映射。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::PINNED_LUMEN_VERSION;

/// 前端握手用的集成状态（`lumen_status_cmd` 的纯映射来源）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LumenStatus {
    pub available: bool,
    pub enabled: bool,
    pub pinned_version: String,
    pub found_version: Option<String>,
    /// 面向用户的中文说明
    pub detail: String,
}

/// 解析 `lumen-cli --version` 输出（如 `LUMEN RAW 1.6.0`）中的语义版本号。
///
/// 只取首行第一个 `\d+\.\d+\.\d+`；垃圾输出 → None。
pub fn parse_lumen_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?;
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            let mut dots = 0;
            let mut j = i;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
                if bytes[j] == b'.' {
                    dots += 1;
                }
                j += 1;
            }
            if dots == 2 {
                let candidate = &line[start..j];
                let parts: Vec<&str> = candidate.split('.').collect();
                if parts.len() == 3 && parts.iter().all(|p| !p.is_empty()) {
                    return Some(candidate.to_string());
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

/// 查询 sidecar 版本（真实 spawn `lumen-cli --version`，解析失败 = None）。
pub fn query_version(exe: &Path) -> Option<String> {
    let output = crate::proc::silent(exe).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_lumen_version(&String::from_utf8_lossy(&output.stdout))
}

/// 握手状态纯映射：enabled × exe × version(==PINNED) → LumenStatus。
pub fn lumen_status_from(
    enabled: bool,
    exe_found: Option<PathBuf>,
    version: Option<String>,
) -> LumenStatus {
    let pinned = version.as_deref() == Some(PINNED_LUMEN_VERSION);
    let available = enabled && exe_found.is_some() && pinned;
    let detail = if !enabled {
        "未启用 LUMEN RAW 引擎集成".to_string()
    } else if exe_found.is_none() {
        "未找到 lumen-cli.exe，请安装 LUMEN RAW 或在设置中指定路径".to_string()
    } else if !pinned {
        format!(
            "LUMEN RAW 版本不匹配（需要 {}，当前 {}）",
            PINNED_LUMEN_VERSION,
            version.as_deref().unwrap_or("未知")
        )
    } else {
        "LUMEN RAW 引擎就绪".to_string()
    };
    LumenStatus {
        available,
        enabled,
        pinned_version: PINNED_LUMEN_VERSION.to_string(),
        found_version: version,
        detail,
    }
}
