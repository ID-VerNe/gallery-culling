//! 路径归一化与 canonicalize 回落的唯一真值（issue #140）。
//!
//! 背景：目录归一化曾在 `lrcat::norm_dir`（收 `&str`）与 `scanner::dirs_are_same`
//! 闭包（收 `&Path` + `to_string_lossy`）各写一份、逐字同构；canonicalize 失败
//! 回落原路径曾在 `thumbnail::cache::file_fingerprint`、`lumen::cache`、
//! `lumen::detail` 三处逐字重复。这里收敛为两个纯函数，口径只留一份。
//!
//! 故意**不**收进本模块的反例：
//! - `commands::export::prepare_export_target` 的 canonicalize 是**拒绝/报错**
//!   语义（`map_err` / `if let Ok`），失败必须冒泡成错误信息，不能回落成
//!   「等于自己」；
//! - `thumbnail.rs` 测试里对 thumb-v3 键算法的独立复算（#142 钉子），与实现
//!   同源即自证，变异网会失效。

use std::fs;
use std::path::{Path, PathBuf};

/// 目录归一化：正斜杠 + 去尾分隔符 + 小写。与前端 `normalizeDir` 同口径。
///
/// 只做字符串变换，不触达文件系统；调用方负责把 `&Path` 先 `to_string_lossy`。
pub fn normalize_dir_str(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// canonicalize 失败时回落原路径（不额外报错）。
///
/// 只服务「同一文件不同写法当同一路径用」的缓存键 / 指纹场景；调用点语义是
/// 「写法不同但指向同一文件」，不是「解析失败即错误」。导出自检等拒绝语义
/// 不得用这里（见模块 doc）。
pub fn canonicalize_or_self(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_dir_str_unifies_slashes_case_and_trailing() {
        // 反斜杠 → 正斜杠、去尾分隔符（含多个）、小写
        assert_eq!(normalize_dir_str(r"C:\Foo\Bar\"), "c:/foo/bar");
        assert_eq!(normalize_dir_str("C:/Foo/Bar//"), "c:/foo/bar");
        assert_eq!(normalize_dir_str("c:/foo/bar"), "c:/foo/bar");
        // 无尾分隔符原样（仅小写化）
        assert_eq!(normalize_dir_str(r"D:\LR\Photos"), "d:/lr/photos");
        // 空串与纯分隔符
        assert_eq!(normalize_dir_str(""), "");
        assert_eq!(normalize_dir_str("/"), "");
    }

    #[test]
    fn canonicalize_or_self_returns_canonical_for_existing() {
        let dir = std::env::temp_dir().join(format!(
            "gallery_pathutil_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        fs::write(&file, b"x").unwrap();

        // 存在：返回 canonicalize 结果（与直接调 std 逐字同）
        assert_eq!(
            canonicalize_or_self(&file),
            fs::canonicalize(&file).unwrap()
        );

        // 不存在：回落原路径，不报错
        let missing = dir.join("nope.txt");
        assert_eq!(canonicalize_or_self(&missing), missing);

        let _ = fs::remove_dir_all(&dir);
    }
}
