//! lumen-cli 一次性调用：argv 拼装、退出码分类、spawn 边界。
//!
//! 这里只处理「跑一次就退出」的命令（A 通道 / CLI 直调）。常驻 sidecar 的
//! 长连接在 transport.rs + mcp.rs。

use std::path::Path;
use std::process::Command;

use serde_json::Value;

use super::LumenError;

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

/// 直调 CLI 子命令（非 `run` 形态）。
///
/// `lumen-cli list <query>` 自带 catalog 扫描，而 `run library.list` 走的是
/// session 图库（未 add 过时为空）——拉取评级必须用前者。
pub fn run_cli(exe: &Path, args: &[&str]) -> Result<Value, LumenError> {
    let mut cmd = Command::new(exe);
    cmd.args(args);
    exec_and_classify(&mut cmd)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use super::*;
    use crate::lumen::*;
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

}
