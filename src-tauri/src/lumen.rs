//! lumen-raw sidecar 桥接层。
//!
//! 顶层只做**门面**：子模块声明 + `pub use` 重导出。调用方（`commands.rs`
//! 与 `tests/lumen_sidecar_e2e.rs`）一律按 `lumen::Xxx` 引用，本文件不新增
//! 任何实现 —— 改模块划分不会波及外部。
//!
//! 模块职责：
//! - `discovery`    定位 lumen-cli 可执行文件
//! - `cli`          一次性调用：argv 拼装、退出码分类、spawn
//! - `transport`    常驻进程的 stdin/stdout 读写边界（trait 即进程边界）
//! - `mcp`          常驻 MCP 客户端：initialize → tools/list → tools/call
//! - `runtime`      LumenRuntime：spawn 一次、握手、复用，失败降级 B 通道
//! - `cache`        预览缓存键、路径与原子落盘
//! - `tone`         宿主调色参数 ↔ lumen recipe 互转与 recipe 哈希
//! - `tools`        MCP 工具名映射与 AI 蒙版载荷
//! - `capabilities` 命令表 + AI 模型是否在盘
//! - `sync`         双向评级同步判定
//! - `status`       版本查询与前端握手状态映射
//! - `error`        LumenError 分类

mod cache;
mod capabilities;
mod detail;
mod cli;
mod discovery;
mod error;
mod mcp;
mod runtime;
mod status;
mod sync;
#[cfg(test)]
mod test_support;
mod tone;
mod tools;
mod transport;

pub use cache::*;
pub use capabilities::*;
pub use detail::*;
pub use cli::*;
pub use discovery::*;
pub use error::LumenError;
pub use mcp::*;
pub use runtime::*;
pub use status::*;
pub use sync::*;
pub use tone::*;
pub use tools::*;
pub use transport::*;

/// 预览变体：Edited = 应用 recipe 后的渲染；Original = 显影原片（未编辑）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewVariant {
    Edited,
    Original,
}

pub const PINNED_LUMEN_VERSION: &str = "1.6.0";

/// MCP initialize 使用的 legacy 协议版本（宿主永不带 _meta，绕开 modern 分支）。
pub const LEGACY_PROTOCOL_VERSION: &str = "2024-11-05";