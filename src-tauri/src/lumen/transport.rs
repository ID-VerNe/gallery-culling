//! A 通道的进程边界：子进程 stdin/stdout 读写。
//!
//! stderr 单独线程丢弃 —— 绝不并入协议流（stdout 只承载协议）。
//! trait 即被测逻辑与真实 IO 的分界线：生产实现 = 进程管道，
//! 测试实现 = 内存脚本队列（见 mcp.rs 的 ScriptedTransport）。

use std::path::Path;
use std::process::Command;
use std::sync::mpsc::Receiver;
use std::sync::Mutex;

use serde_json::Value;

use super::LumenError;

/// request 的读行超时（预览 60s / 重活 600s / 其他 120s 由上层决定，这里取默认）。
pub const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// A 通道读写边界（生产实现 = stdin/stdout 线程；测试 = scripted 内存队列）。
///
/// 被测逻辑（RPC 循环）不含真实 IO —— 本 trait 即进程边界。
pub trait LineTransport: Send {
    /// 写一行（不含换行；实现负责补 `\n` 并 flush）。
    fn write_line(&self, line: &str) -> Result<(), LumenError>;
    /// 读一行，超时未果 → `Ok(None)`；传输损坏 → `Err`。
    fn read_line(&self, timeout: std::time::Duration) -> Result<Option<String>, LumenError>;
}

/// 编码一行 newline-delimited JSON-RPC 2.0 请求（紧凑，对齐 `mcp.py:97`）。
pub fn rpc_encode(method: &str, params: &Value, id: i64) -> String {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    // serde_json 默认紧凑输出；与 mcp.py:97 的 separators=(',',':') 对齐。
    let mut line = serde_json::to_string(&msg).unwrap_or_else(|_| "{}".to_string());
    line.push('\n');
    line
}

/// 崩溃重启退避：0.5s × 2^attempt，封顶 8s。
pub fn next_backoff(attempt: u32) -> std::time::Duration {
    const BASE_MS: u64 = 500;
    const CAP_MS: u64 = 8_000;
    let shifted = BASE_MS.saturating_mul(1u64 << attempt.min(31));
    std::time::Duration::from_millis(shifted.min(CAP_MS))
}

/// 自动重启次数上限（防无限风暴，A 报告 G3）。
pub const MAX_RESTARTS: u32 = 8;

/// 生产传输层：子进程 stdin（写）/ stdout（读线程 + mpsc）。
///
/// stderr 单独线程丢弃 —— 绝不并入协议流（`mcp.py:205-207` 同理：stdout 只承载协议）。
#[derive(Debug)]
pub struct ProcessTransport {
    pub(super) stdin: Mutex<Option<std::process::ChildStdin>>,
    pub(super) incoming: Receiver<Result<String, String>>,
}

impl ProcessTransport {
    /// 拉起子进程并启动读线程。args 由调用方给出（A 通道固定 `["mcp", "--headless"]`）。
    pub fn spawn(exe: &Path, args: &[&str]) -> Result<Self, LumenError> {
        use std::io::{BufRead, BufReader};

        let mut child = Command::new(exe)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|_| LumenError::NotInstalled)?;

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        // stderr：只排空不收集，防管道写满阻塞子进程
        if let Some(mut err) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut sink = Vec::new();
                let _ = std::io::Read::read_to_end(&mut err, &mut sink);
            });
        }

        let (tx, rx) = std::sync::mpsc::channel();
        if let Some(out) = stdout {
            std::thread::spawn(move || {
                // map_while：遇到 Err 即止（flatten 会在持续 Err 时死循环）
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if tx.send(Ok(line)).is_err() {
                        break; // 宿主已丢弃客户端
                    }
                }
            });
        }

        // 子进程句柄丢弃即不等待；进程由 stdin EOF 自行退出（mcp.py:102-104）
        drop(child);
        Ok(Self {
            stdin: std::sync::Mutex::new(stdin),
            incoming: rx,
        })
    }
}

impl LineTransport for ProcessTransport {
    fn write_line(&self, line: &str) -> Result<(), LumenError> {
        use std::io::Write;
        let mut guard = self
            .stdin
            .lock()
            .map_err(|_| LumenError::Io("stdin 锁中毒".into()))?;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| LumenError::Io("sidecar 已关闭".into()))?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| LumenError::Io(format!("写入 sidecar stdin 失败: {}", e)))
    }

    /// `Ok(None)` 只表示"超时尚未回话"，子进程仍活着，可重试。
    /// `Err(ProcessExited)` 表示 stdout 已关闭，子进程没了，只能重启。
    fn read_line(&self, timeout: std::time::Duration) -> Result<Option<String>, LumenError> {
        match self.incoming.recv_timeout(timeout) {
            Ok(Ok(line)) => Ok(Some(line)),
            Ok(Err(e)) => Err(LumenError::Io(e)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(None),
            // 通道断开 = 子进程 stdout 已关闭（EOF）= 进程已死。
            // 原实现与 Timeout 同返 Ok(None)，上游一律当 LumenError::Timeout 处理，
            // 于是崩溃被误判成"慢"，触发一次注定也失败的 run_lumen 而非重启 sidecar。
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err(LumenError::ProcessExited)
            }
        }
    }
}

impl Drop for ProcessTransport {
    fn drop(&mut self) {
        // 关闭 stdin → lumen-cli mcp 读到 EOF 自行退出（干净回收）
        if let Ok(mut guard) = self.stdin.lock() {
            guard.take();
        }
    }
}
