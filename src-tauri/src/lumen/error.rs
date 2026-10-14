//! LUMEN 错误分类。
//!
//! 与 lumen-cli 交互的全部失败模式都收敛到这里，消息面向最终用户，
//! 中文句式对齐 `luminar.rs`。

use std::fmt;

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
    /// 磁盘 IO 失败（缓存目录创建 / rename 等）
    Io(String),
    /// 等待应答超时（A 通道）—— 子进程还活着，只是没在期限内回话
    Timeout,
    /// sidecar 子进程已退出（stdout 关闭 / 通道断开）。
    ///
    /// 必须与 `Timeout` 区分：超时可重试同一进程，而进程已死只能重启 sidecar。
    /// 二者若混为一谈，崩溃会被当成"慢"，触发一次注定也失败的 run_lumen。
    ProcessExited,
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
            LumenError::Io(m) => write!(f, "LUMEN RAW 预览缓存写入失败: {}", m),
            LumenError::Timeout => write!(f, "LUMEN RAW 响应超时，请重试"),
            LumenError::ProcessExited => write!(f, "LUMEN RAW 引擎进程已退出，请重启引擎"),
        }
    }
}

impl std::error::Error for LumenError {}
