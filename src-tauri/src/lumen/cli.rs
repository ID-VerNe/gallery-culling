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
