//! 子进程静默启动：Windows 控制台窗口（黑框）抑制。
//!
//! 背景（2026-10-15 问题三）：GUI 应用 spawn **控制台子系统**的可执行文件
//! （lumen-cli.exe / where / reg / cmd …）时，Windows 会为子进程新建一个
//! 控制台窗口 —— 用户看到黑框一闪（每次调 sidecar 一次；启动 Lumen、
//! 探测引擎、同步评级等路径都会经过）。
//!
//! 抑制方式：`CREATE_NO_WINDOW`（0x08000000）进程创建标志。子进程照常拿到
//! stdin/stdout/stderr 管道，但**不分配可见控制台**。非 Windows 平台没有
//! 该标志（Unix 的 GUI spawn 本来就不弹终端），此模块退化为普通 `Command`。
//!
//! 统一入口的意义：生产侧所有 `Command::new` 都改走 `silent()`，新代码不会
//! 因为漏掉 `creation_flags` 而重新引入黑框。测试代码（fixture 脚本等）不受
//! 影响，仍可直接 `Command::new`。

use std::ffi::OsStr;
use std::process::Command;

/// `CREATE_NO_WINDOW`（winbase.h，0x08000000）。非 Windows 平台无此概念。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 构造一个「静默」子进程：Windows 上不分配新控制台（无黑框）。
///
/// 用法与 `Command::new` 完全一致（返回可继续链式 `.arg()` 的 `Command`）。
pub fn silent(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    /// IO 契约：silent() 只影响「控制台分配」，不得影响管道 IO。
    /// 用真实子进程验证 stdout 管道照常工作。
    #[test]
    fn silent_command_keeps_piped_io_working() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = silent("cmd");
            c.args(["/C", "echo", "ping"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = silent("sh");
            c.args(["-c", "echo ping"]);
            c
        };

        let out = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("silent() 构造的进程应能正常 spawn");

        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ping");
    }

    /// 退出码照常透传（CREATE_NO_WINDOW 不影响进程语义）。
    #[test]
    fn silent_command_propagates_exit_code() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = silent("cmd");
            c.args(["/C", "exit", "7"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = silent("sh");
            c.args(["-c", "exit 7"]);
            c
        };

        let out = cmd.stdout(Stdio::piped()).output().expect("spawn 失败");
        assert_eq!(out.status.code(), Some(7));
    }
}
