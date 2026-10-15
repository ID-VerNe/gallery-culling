//! A 通道的进程边界：子进程 stdin/stdout 读写。
//!
//! stderr 单独线程丢弃 —— 绝不并入协议流（stdout 只承载协议）。
//! trait 即被测逻辑与真实 IO 的分界线：生产实现 = 进程管道，
//! 测试实现 = 内存脚本队列（见 mcp.rs 的 ScriptedTransport）。

use std::path::Path;
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

        // proc::silent：Windows 上 CREATE_NO_WINDOW —— sidecar 是控制台程序，
        // 直接 spawn 会给用户弹黑框（2026-10-15 问题三）。
        let mut child = crate::proc::silent(exe)
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

#[cfg(test)]
pub(crate) mod tests {
    use std::process::Command;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex as StdMutex;
    use super::*;
    use crate::lumen::*;
// ---- Step 4: 生产传输层 + 监督器（真实子进程） ----
pub(crate) fn line_echo_fixture() -> PathBuf {
    // 必须绝对路径（反斜杠）：cmd 会把正斜杠当开关
    Path::new("tests/fixtures/line_echo.cmd")
        .canonicalize()
        .expect("夹具应存在")
}

pub(crate) fn spawn_echo() -> ProcessTransport {
    // 直接 spawn .cmd（不经 `cmd /C`：Rust 直接执行 .cmd 稳定可用，
    // 而 `cmd /C <path>` 在 Rust 的 argv 转义下会报"系统找不到指定的路径"）
    let fixture = line_echo_fixture();
    let mut cmd = Command::new(&fixture);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().expect("夹具应可 spawn");
    // 复用 ProcessTransport 内部逻辑：手动装配测试传输
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout piped");
    if let Some(mut err) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = std::io::Read::read_to_end(&mut err, &mut sink);
        });
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if tx.send(Ok(line)).is_err() {
                break;
            }
        }
    });
    drop(child);
    // 构造与 ProcessTransport 同构的实例（字段私有，仅测试内可造）
    ProcessTransport {
        stdin: StdMutex::new(stdin),
        incoming: rx,
    }
}

#[test]
fn process_transport_roundtrip_real_process() {
    let t = spawn_echo();
    // 行式协议：换行由调用方提供（rpc_encode 已带 \n）；夹具的 set /p 需要换行才输出
    t.write_line("{\"a\":1}\n").expect("写 stdin 应成功");
    let line = t
        .read_line(std::time::Duration::from_secs(10))
        .expect("读不应报错")
        .expect("应有回显行");
    assert!(
        line.contains(r#"{"a":1}"#),
        "回显内容应包含写入行: {}",
        line
    );
}

#[test]
fn process_transport_eof_is_process_exited_not_timeout() {
    let t = spawn_echo();
    // 夹具只回显一行；不写则它一直等 set /p → 我们直接 drop stdin 让它退出
    drop(t);
    // 新起一个立刻退出的进程：cmd /C exit
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "exit"]);
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn");
    let stdout = child.stdout.take().unwrap();
    // 回收子进程：先 wait 释放句柄（stdin 仍持有 → cmd /C exit 立即返回）
    let _status = child.wait().expect("wait");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if tx.send(Ok(line)).is_err() {
                break;
            }
        }
    });
    let transport = ProcessTransport {
        stdin: StdMutex::new(None),
        incoming: rx,
    };
    // BL-02：EOF = 进程已死，必须与"超时"区分开。
    // 原实现与 Timeout 同返 Ok(None)，上游统一当 LumenError::Timeout 处理，
    // 于是崩溃被当成"慢"，触发一次注定也失败的 run_lumen 而非重启 sidecar。
    let err = transport
        .read_line(std::time::Duration::from_millis(500))
        .expect_err("子进程退出（EOF）必须报错，不能与超时混为 Ok(None)");
    assert!(
        matches!(err, LumenError::ProcessExited),
        "EOF 应报 ProcessExited，实际: {:?}",
        err
    );
}

#[test]
fn process_transport_timeout_is_none() {
    // 发送端存活但永不投递 → recv_timeout 必须超时 → Ok(None)（区别于通道断开的分支）
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let transport = ProcessTransport {
        stdin: StdMutex::new(None),
        incoming: rx,
    };
    let got = transport.read_line(std::time::Duration::from_millis(200));
    assert_eq!(got, Ok(None), "超时必须是 Ok(None)，不得挂死或 Err");
    drop(tx);
}

#[test]
fn process_transport_distinguishes_timeout_from_process_death() {
    // BL-02 的核心契约：同一个 read_line 面对"进程还活着只是慢"与"进程已死"
    // 必须给出**不同**的结果，否则上层无法决定"重试"还是"重启"。
    let (tx_live, rx_live) = std::sync::mpsc::channel::<Result<String, String>>();
    let live = ProcessTransport {
        stdin: StdMutex::new(None),
        incoming: rx_live,
    };
    assert_eq!(
        live.read_line(std::time::Duration::from_millis(120)),
        Ok(None),
        "进程存活但未回话 -> Ok(None)（可重试）"
    );

    // 发送端被丢弃 = 子进程 stdout 已关闭 = 进程已死
    let (tx_dead, rx_dead) = std::sync::mpsc::channel::<Result<String, String>>();
    let dead = ProcessTransport {
        stdin: StdMutex::new(None),
        incoming: rx_dead,
    };
    drop(tx_dead);
    assert!(
        matches!(
            dead.read_line(std::time::Duration::from_millis(120)),
            Err(LumenError::ProcessExited)
        ),
        "进程已死 -> Err(ProcessExited)（须重启而非重试）"
    );
    drop(tx_live);
}

#[test]
fn noisy_stderr_child_still_serves_protocol_cleanly() {
    // 夹具：先向 stderr 狂写 2000 行（远超 64KB 管道缓冲），再回显 stdin 一行。
    // 两条契约：(1) stdout 协议流不被 stderr 污染；(2) stderr 必须被独立排空，
    // 否则子进程阻塞在 stderr 写、协议行永远不出现。
    let script = std::env::temp_dir().join(format!("lumen_noisy_{}.cmd", std::process::id()));
    std::fs::write(
        &script,
        "@echo off\nfor /L %%i in (1,1,2000) do 1>&2 echo NOISE_NOISE_NOISE_NOISE_NOISE_NOISE\nset /p line=\necho {\"echoed\":%line%}\n",
    )
    .expect("写噪声夹具");
    let mut cmd = Command::new(&script);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().expect("噪声夹具可 spawn");
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout piped");
    if let Some(mut err) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = std::io::Read::read_to_end(&mut err, &mut sink);
        });
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if tx.send(Ok(line)).is_err() {
                break;
            }
        }
    });
    let transport = ProcessTransport {
        stdin: StdMutex::new(stdin),
        incoming: rx,
    };
    transport.write_line("{\"z\":9}\n").expect("写应成功");
    let line = transport
        .read_line(std::time::Duration::from_secs(30))
        .expect("读不应报错")
        .expect("噪声子进程仍必须吐出协议行（stderr 未阻塞）");
    assert!(
        line.contains(r#"{"z":9}"#) && !line.contains("NOISE"),
        "协议流必须干净（只含回显，不含 stderr 噪声）: {}",
        line
    );
    drop(transport);
    let _ = child.wait();
    let _ = std::fs::remove_file(&script);
}

#[test]
fn drop_closes_stdin_so_child_exits() {
    // 契约：Drop 关 stdin → 子进程读到 EOF 自行退出（mcp.py:102-104）。
    // 夹具 wait_eof.cmd 阻塞在 set /p，收到 EOF 后写标记文件。
    let marker = std::env::temp_dir().join(format!("lumen_eof_{}.txt", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let fixture = Path::new("tests/fixtures/wait_eof.cmd")
        .canonicalize()
        .expect("夹具应存在");
    let mut cmd = Command::new(&fixture);
    cmd.env("LUMEN_TEST_MARKER", &marker)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().expect("应能 spawn");
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout piped");
    if let Some(mut err) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = std::io::Read::read_to_end(&mut err, &mut sink);
        });
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if tx.send(Ok(line)).is_err() {
                break;
            }
        }
    });
    drop(child);
    let transport = ProcessTransport {
        stdin: StdMutex::new(stdin),
        incoming: rx,
    };
    drop(transport); // ← 契约本体：Drop 关 stdin
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert!(
        marker.exists(),
        "Drop 后子进程应因 stdin EOF 退出并写标记（说明 stdin 已被关闭）"
    );
    let _ = std::fs::remove_file(&marker);
}

#[test]
fn runtime_status_matrix_without_sidecar() {
    let rt = LumenRuntime::new();
    // enabled=false → 不可用且零请求
    let off = rt.status(false, None);
    assert!(!off.available && !off.enabled);
    // enabled 但无 exe → 不可用
    let no_exe = rt.status(true, None);
    assert!(!no_exe.available);
}

#[test]
fn runtime_falls_back_when_sidecar_missing() {
    // 侧信道完全不存在：A 通道必失败 → B 通道兜底同样失败 → 错误必须透出
    let rt = LumenRuntime::new();
    let err = rt
        .render_preview(
            Path::new(r"C:\definitely\not\here\lumen-cli-xyz987.exe"),
            &serde_json::json!({"path": "x.ARW"}),
        )
        .expect_err("无 sidecar 时应失败");
    assert!(matches!(err, LumenError::NotInstalled), "实际: {:?}", err);
}

#[test]
fn runtime_failure_count_stops_reconnect() {
    let rt = LumenRuntime::new();
    let exe = Path::new(r"C:\definitely\not\here\lumen-cli-xyz987.exe");
    for _ in 0..3 {
        let _ = rt.render_preview(exe, &serde_json::json!({"path": "x.ARW"}));
    }
    assert_eq!(rt.failure_count(), 3, "每次失败应累计");
}

#[test]
fn runtime_shutdown_clears_state() {
    let rt = LumenRuntime::new();
    let exe = Path::new(r"C:\definitely\not\here\lumen-cli-xyz987.exe");
    let _ = rt.render_preview(exe, &serde_json::json!({"path": "x.ARW"}));
    assert!(rt.failure_count() > 0);
    rt.shutdown();
    assert_eq!(rt.failure_count(), 0, "shutdown 应清空失败计数");
}

#[test]
fn runtime_rejects_non_mcp_child_and_counts_failure() {
    // 垃圾对端：A 通道握手失败 → 记一次失败 → B 通道兜底也失败（夹具不认 render.preview）
    let fixture = Path::new("tests/fixtures/mcp_garbage.cmd")
        .canonicalize()
        .expect("夹具应存在");
    let rt = LumenRuntime::new();
    let err = rt
        .render_preview(&fixture, &serde_json::json!({"path": "x.ARW"}))
        .expect_err("垃圾对端两条通道都应失败");
    assert!(
        matches!(err, LumenError::Protocol(_) | LumenError::Command(_)),
        "实际: {:?}",
        err
    );
    assert_eq!(rt.failure_count(), 1);
}

#[test]
fn run_cli_rejects_missing_exe() {
    // run_cli 与 run_lumen 共享 spawn 失败语义
    assert_eq!(
        run_cli(
            Path::new(
                r"C:
ope\lumen-cli-xyz.exe"
            ),
            &["list", "*"]
        ),
        Err(LumenError::NotInstalled)
    );
}

#[test]
fn tool_names_map_to_command_ids() {
    // 回归：曾把 MCP 工具名当命令 id 传给 B 通道（unknown command 'rate_photos'）
    assert_eq!(tool_to_command_id("rate_photos"), "library.rate");
    assert_eq!(tool_to_command_id("flag_photos"), "library.flag");
    assert_eq!(tool_to_command_id("render_preview"), "render.preview");
    // 未知工具兜底到一个必然存在的只读命令
    assert_eq!(tool_to_command_id("nope"), "app.status");
}

}
