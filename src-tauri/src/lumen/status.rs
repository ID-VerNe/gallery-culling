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
    lumen_status_with_error(enabled, exe_found, version, None)
}

/// 同 [`lumen_status_from`]，但把「最近一次启动/握手失败」原样带进 detail。
///
/// issue #68：启动 warm-up 失败时，用户不必打开设置再去猜——状态行直接给出
/// 失败原因（例如「sidecar 已退出」），而不是只有一句泛化的「版本不匹配」。
pub fn lumen_status_with_error(
    enabled: bool,
    exe_found: Option<PathBuf>,
    version: Option<String>,
    last_error: Option<&str>,
) -> LumenStatus {
    let pinned = version.as_deref() == Some(PINNED_LUMEN_VERSION);
    let available = enabled && exe_found.is_some() && pinned;
    let mut detail = if !enabled {
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
    // 只有「找到了 exe 但仍不可用」才追加失败原因；exe 缺失时上面的文案
    // 已经包含下一步，再叠一条会重复。
    if !available && exe_found.is_some() {
        if let Some(err) = last_error {
            detail = format!("{}（最近一次启动失败：{}）", detail, err);
        }
    }
    LumenStatus {
        available,
        enabled,
        pinned_version: PINNED_LUMEN_VERSION.to_string(),
        found_version: version,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// issue #68：找到了 exe 但握手失败时，detail 必须保留具体失败原因。
    #[test]
    fn status_with_error_appends_failure_reason() {
        let status = lumen_status_with_error(
            true,
            Some(PathBuf::from(r"C:\lumen\lumen-cli.exe")),
            None,
            Some("sidecar 已退出"),
        );
        assert!(!status.available);
        assert!(
            status.detail.contains("最近一次启动失败"),
            "detail 必须标出这是启动失败: {}",
            status.detail
        );
        assert!(
            status.detail.contains("sidecar 已退出"),
            "detail 必须带上原始失败原因: {}",
            status.detail
        );
    }

    /// exe 都没找到时不再叠加失败原因（文案本身已含下一步）。
    #[test]
    fn status_without_exe_ignores_last_error() {
        let status = lumen_status_with_error(true, None, None, Some("重复的失败原因"));
        assert!(status.detail.contains("未找到 lumen-cli.exe"));
        assert!(!status.detail.contains("重复的失败原因"));
    }
}
