//! lumen-raw sidecar 桥接层 —— 基础设施（Step 1）。
//!
//! 职责：定位 `lumen-cli` 可执行文件、拼装一次性调用参数、分类退出码、
//! 计算预览缓存键。不包含 Tauri 命令注册与常驻 MCP（后续 Step）。
//!
//! 契约依据：`.plan/specs/step1-lumen-bridge-core-spec.md`
//! 与 `.plan/research/A-cli-bridge-comparison.md`。

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};

/// 预览变体：Edited = 应用 recipe 后的渲染；Original = 显影原片（未编辑）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewVariant {
    Edited,
    Original,
}

/// 与 lumen-cli 交互的错误分类。消息面向最终用户，中文句式对齐 `luminar.rs`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LumenError {
    /// 可执行文件不存在或进程无法启动
    NotInstalled,
    /// lumen-cli 业务错误（exit 1，已剥离 `lumen-cli: ` 前缀）
    Command(String),
    /// 参数拼装错误（exit 2 = 宿主缺陷）
    Usage(String),
    /// exit 0 但 stdout 不是合法 JSON
    Protocol(String),
    /// 其他退出码（含被信号杀死时 code 为 None 的语义由调用方包装）
    Exit(i32),
}

impl fmt::Display for LumenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LumenError::NotInstalled => write!(
                f,
                "未检测到 LUMEN RAW 引擎，请先安装 LUMEN RAW 或在设置中指定 lumen-cli.exe 路径。"
            ),
            LumenError::Command(m) => write!(f, "LUMEN RAW 执行失败: {}", m),
            LumenError::Usage(m) => {
                write!(f, "LUMEN RAW 参数错误（应用内部缺陷）: {}", m)
            }
            LumenError::Protocol(m) => {
                write!(f, "LUMEN RAW 返回了无法解析的结果: {}", m)
            }
            LumenError::Exit(code) => {
                write!(f, "LUMEN RAW 进程异常退出 (Exit Code: {})", code)
            }
        }
    }
}

impl std::error::Error for LumenError {}

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

/// 查找 lumen-cli：候选路径 → PATH（where）→ None。
pub fn find_lumen_cli(settings_path: &str) -> Option<PathBuf> {
    let local_appdata = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    let program_files = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_default();

    if let Some(found) = first_existing(&lumen_candidates(
        settings_path,
        &local_appdata,
        &program_files,
    )) {
        return Some(found);
    }
    find_in_path("lumen-cli")
}

/// 拼装 `lumen-cli run <command> <compact-json> --headless` 的参数向量。
pub fn build_run_args(command: &str, args: &Value) -> Vec<String> {
    let json = serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string());
    vec![
        "run".to_string(),
        command.to_string(),
        json,
        "--headless".to_string(),
    ]
}

/// 把一次已结束子进程的 (退出码, stdout, stderr) 分类为结果或错误。
pub fn classify_exit(code: Option<i32>, stdout: &str, stderr: &str) -> Result<Value, LumenError> {
    match code {
        // 成功：stdout 必须是合法 JSON（lumen-cli 输出美化缩进，容忍首尾空白）。
        Some(0) => {
            serde_json::from_str(stdout.trim()).map_err(|e| LumenError::Protocol(e.to_string()))
        }
        // 业务错误：剥离 `lumen-cli: ` 前缀后透出正文。
        Some(1) => {
            let msg = stderr
                .trim()
                .strip_prefix("lumen-cli: ")
                .unwrap_or(stderr.trim())
                .to_string();
            Err(LumenError::Command(if msg.is_empty() {
                "未知错误".to_string()
            } else {
                msg
            }))
        }
        // 用法错误：宿主拼参缺陷。
        Some(2) => Err(LumenError::Usage(stderr.trim().to_string())),
        // 其他退出码；None（被信号杀死）归一为 -1。
        _ => Err(LumenError::Exit(code.unwrap_or(-1))),
    }
}

/// spawn 并等待，输出交给 `classify_exit`。真实子进程边界，可注入任意命令。
pub fn exec_and_classify(cmd: &mut Command) -> Result<Value, LumenError> {
    let output = cmd.output().map_err(|_| LumenError::NotInstalled)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    classify_exit(output.status.code(), &stdout, &stderr)
}

/// 以 B 通道方式调用 lumen-cli：`exe run <command> <json> --headless`。
pub fn run_lumen(exe: &Path, command: &str, args: &Value) -> Result<Value, LumenError> {
    let mut cmd = Command::new(exe);
    cmd.args(build_run_args(command, args));
    exec_and_classify(&mut cmd)
}

/// 把可选时间戳编码进缓存键：None 与 Some(UNIX_EPOCH) 也必须可区分。
fn mtime_tag(mtime: Option<SystemTime>) -> u128 {
    match mtime {
        Some(t) => t
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(u128::MAX),
        None => u128::MAX,
    }
}

/// 计算预览缓存键：16 位小写 hex。
///
/// 输入任一变化（宽高/变体/版本/源文件 mtime/兄弟 .lumen mtime）→ key 变化。
pub fn lumen_cache_key(
    src: &Path,
    width: u32,
    variant: PreviewVariant,
    lumen_version: &str,
    src_mtime: Option<SystemTime>,
    project_mtime: Option<SystemTime>,
) -> String {
    // 相对路径 canonicalize，保证同一文件不同写法同 key。
    let abs = src.canonicalize().unwrap_or_else(|_| src.to_path_buf());
    let variant_tag = match variant {
        PreviewVariant::Edited => "edited",
        PreviewVariant::Original => "orig",
    };
    let payload = format!(
        "lumen-preview-v1|{}|{}|{}|{}|{}|{}",
        lumen_version,
        abs.display(),
        mtime_tag(src_mtime),
        mtime_tag(project_mtime),
        width,
        variant_tag
    );
    let digest = Sha256::digest(payload.as_bytes());
    // 16 位小写 hex = 前 8 字节。
    digest
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// 预览产物落盘路径：`<cache_root>/lumen/<key>_<width>[_orig]_lumen.jpg`。
pub fn preview_cache_path(
    cache_root: &Path,
    key: &str,
    width: u32,
    variant: PreviewVariant,
) -> PathBuf {
    let suffix = match variant {
        PreviewVariant::Edited => "",
        PreviewVariant::Original => "_orig",
    };
    cache_root
        .join("lumen")
        .join(format!("{}_{}{}_lumen.jpg", key, width, suffix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    /// 测试用临时文件名（进程内唯一，避开并行测试互相踩）。
    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("lumen_test_{}_{}", std::process::id(), name))
    }

    fn t_plus(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

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
    fn where_lumen_cli_missing_returns_none() {
        assert_eq!(find_in_path("definitely-not-a-real-exe-xyz-987"), None);
    }

    #[test]
    fn where_lumen_cli_parses_real_output() {
        let found = find_in_path("notepad.exe").expect("notepad.exe 应能通过 where 找到");
        assert!(found.exists(), "where 返回的路径应真实存在: {:?}", found);
    }

    // ---- B4 ----
    #[test]
    fn build_run_args_shape() {
        let args = serde_json::json!({"path": "D:/x.CR2", "size": 1600});
        let got = build_run_args("render.preview", &args);
        let expected_json = serde_json::to_string(&args).unwrap();
        assert_eq!(
            got,
            vec![
                "run".to_string(),
                "render.preview".to_string(),
                expected_json,
                "--headless".to_string()
            ],
            "参数形状必须是 run <cmd> <compact-json> --headless"
        );
    }

    // ---- B5 ----
    #[test]
    fn classify_exit_ok_parses_pretty_json() {
        let stdout = "{\n  \"ok\": true,\n  \"n\": 1\n}\n";
        let value = classify_exit(Some(0), stdout, "").expect("exit 0 + 合法 JSON");
        assert_eq!(value["ok"], serde_json::json!(true));
        assert_eq!(value["n"], serde_json::json!(1));
    }

    #[test]
    fn classify_exit_ok_invalid_json_is_protocol() {
        let err = classify_exit(Some(0), "this-is-not-json", "").expect_err("坏 JSON 应 Err");
        assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
    }

    #[test]
    fn classify_exit_1_strips_prefix() {
        let err = classify_exit(Some(1), "", "lumen-cli: file not found: D:\\x.CR2")
            .expect_err("exit 1 应 Err");
        match err {
            LumenError::Command(m) => {
                assert_eq!(
                    m, "file not found: D:\\x.CR2",
                    "应剥离 lumen-cli: 前缀并 trim"
                )
            }
            other => panic!("应分类为 Command，实际: {:?}", other),
        }
    }

    #[test]
    fn classify_exit_2_is_usage() {
        let err = classify_exit(Some(2), "", "usage: lumen-cli ...").expect_err("exit 2 应 Err");
        assert!(matches!(err, LumenError::Usage(_)), "实际: {:?}", err);
    }

    #[test]
    fn classify_exit_signal_killed() {
        let err = classify_exit(None, "", "").expect_err("信号杀死应 Err");
        assert!(matches!(err, LumenError::Exit(_)), "实际: {:?}", err);
    }

    #[test]
    fn classify_exit_unexpected_code() {
        let err = classify_exit(Some(3), "", "").expect_err("其他退出码应 Err");
        assert_eq!(err, LumenError::Exit(3));
    }

    // ---- B6 ----
    #[test]
    fn run_lumen_missing_exe_not_installed() {
        let err = run_lumen(
            Path::new(r"C:\definitely\not\a\real\lumen-cli-xyz987.exe"),
            "render.preview",
            &serde_json::json!({}),
        )
        .expect_err("exe 不存在应 Err");
        assert_eq!(err, LumenError::NotInstalled);
    }

    #[test]
    fn run_lumen_exit1_real_spawn() {
        // 真实 spawn where.exe 查找一个保证不存在的命令：where 对无匹配稳定返回 exit 1。
        let err = run_lumen(
            Path::new("where.exe"),
            "definitely-not-a-real-command-xyz-987",
            &serde_json::json!({}),
        )
        .expect_err("where 找不到模式应 exit 1 → Err");
        assert!(
            matches!(err, LumenError::Command(_)),
            "应分类为 Command，实际: {:?}",
            err
        );
    }

    // ---- B7 ----
    fn key(src: &Path, width: u32, variant: PreviewVariant, m: Option<SystemTime>) -> String {
        lumen_cache_key(src, width, variant, "1.6.0", m, m)
    }

    #[test]
    fn cache_key_is_deterministic() {
        let src = tmp("det.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let k1 = key(&src, 1600, PreviewVariant::Edited, Some(t_plus(100)));
        let k2 = key(&src, 1600, PreviewVariant::Edited, Some(t_plus(100)));
        assert_eq!(k1, k2);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_canonicalizes_relative_paths() {
        // CARGO_MANIFEST_DIR=src-tauri；夹具文件是真实存在的相对路径。
        let rel = Path::new("tests/fixtures/lumen_fixture_ok.cmd");
        let abs = rel.canonicalize().unwrap();
        assert_eq!(
            key(rel, 1600, PreviewVariant::Edited, Some(t_plus(1))),
            key(&abs, 1600, PreviewVariant::Edited, Some(t_plus(1))),
            "相对路径必须先 canonicalize，与绝对路径同 key"
        );
    }

    #[test]
    fn cache_key_changes_with_width() {
        let src = tmp("w.ARW");
        std::fs::write(&src, b"raw").unwrap();
        assert_ne!(
            key(&src, 1600, PreviewVariant::Edited, None),
            key(&src, 1200, PreviewVariant::Edited, None)
        );
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_variant() {
        let src = tmp("v.ARW");
        std::fs::write(&src, b"raw").unwrap();
        assert_ne!(
            key(&src, 1600, PreviewVariant::Edited, None),
            key(&src, 1600, PreviewVariant::Original, None)
        );
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_version() {
        let src = tmp("ver.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let a = lumen_cache_key(&src, 1600, PreviewVariant::Edited, "1.6.0", None, None);
        let b = lumen_cache_key(&src, 1600, PreviewVariant::Edited, "1.7.0", None, None);
        assert_ne!(a, b);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_src_mtime() {
        let src = tmp("m.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let a = lumen_cache_key(
            &src,
            1600,
            PreviewVariant::Edited,
            "1.6.0",
            Some(t_plus(10)),
            None,
        );
        let b = lumen_cache_key(
            &src,
            1600,
            PreviewVariant::Edited,
            "1.6.0",
            Some(t_plus(11)),
            None,
        );
        assert_ne!(a, b, "源文件 mtime 变化必须换 key");
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_project_mtime() {
        let src = tmp("p.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let none = lumen_cache_key(&src, 1600, PreviewVariant::Edited, "1.6.0", None, None);
        let some = lumen_cache_key(
            &src,
            1600,
            PreviewVariant::Edited,
            "1.6.0",
            None,
            Some(t_plus(5)),
        );
        assert_ne!(none, some, "None↔Some 必须换来 key（工程从未存 vs 已存）");
        let newer = lumen_cache_key(
            &src,
            1600,
            PreviewVariant::Edited,
            "1.6.0",
            None,
            Some(t_plus(6)),
        );
        assert_ne!(some, newer, ".lumen 被外部改过必须换 key");
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_is_hex16() {
        let src = tmp("hex.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let k = key(&src, 1600, PreviewVariant::Edited, Some(t_plus(3)));
        assert_eq!(k.len(), 16, "key 必须是 16 位，实际 {:?}", k);
        assert!(
            k.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "key 必须全小写 hex，实际 {:?}",
            k
        );
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_distinct_paths() {
        let a = tmp("dist_a.ARW");
        let b = tmp("dist_b.ARW");
        std::fs::write(&a, b"raw").unwrap();
        std::fs::write(&b, b"raw").unwrap();
        assert_ne!(
            key(&a, 1600, PreviewVariant::Edited, None),
            key(&b, 1600, PreviewVariant::Edited, None)
        );
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
    }

    // ---- B8 ----
    #[test]
    fn preview_cache_path_shape() {
        let root = tmp("cache_root");
        let p = preview_cache_path(&root, "abc123", 1600, PreviewVariant::Edited);
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "lumen");
        assert_eq!(p.parent().unwrap().parent().unwrap(), root);
        assert_eq!(p.file_name().unwrap(), "abc123_1600_lumen.jpg");

        let p2 = preview_cache_path(&root, "abc123", 1600, PreviewVariant::Original);
        assert_eq!(p2.file_name().unwrap(), "abc123_1600_orig_lumen.jpg");
    }

    // ---- B9 ----
    #[test]
    fn display_messages_are_user_facing_chinese() {
        assert!(LumenError::NotInstalled.to_string().contains("未检测到"));
        assert!(LumenError::Usage("x".into())
            .to_string()
            .contains("应用内部缺陷"));
        assert!(LumenError::Exit(7).to_string().contains("Exit Code: 7"));
    }
}
