//! models façade（issue #145）：三域 DTO 的公开路径统一入口，本文件只做导航。
//!
//! 拆分前 19 类型 / 332 行集中于此；按域拆到 `models/{photo,settings,lumen}.rs` 后，
//! 公开路径 `crate::models::X` 与拆分前**完全一致**（全 crate 35 处引用点零改动）。
//! 类型本体逐字搬移：不改字段名 / 序列化 / 常量值 / 出厂 6 条语义。

mod lumen;
mod photo;
mod settings;

pub use lumen::*;
pub use photo::*;
pub use settings::*;
