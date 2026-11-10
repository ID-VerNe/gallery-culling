//! lumen/tone 域 DTO（issue #145 自 models.rs 拆出，纯导航搬移，语义零变化）。
//!
//! 包含：调色滑杆 / AI 蒙版调色 / 预览结果 / 配方 / 评分同步与冲突 / 写入报告
//! / 统一管线读回视图 / AI 蒙版结果。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToneAdjustments {
    pub exposure: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub temperature: f32,
    pub tint: f32,
    pub contrast: f32,
}

/// AI 蒙版内的局部调色。字段是 lumen `masks[].adjustments` 的子集，
/// 包含全局滑杆没有的 dehaze / clarity / saturation。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskAdjustments {
    pub exposure: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub dehaze: f32,
    pub clarity: f32,
    pub saturation: f32,
    pub temperature: f32,
}

/// `lumen_preview_cmd` 返回：preview_path = None 表示引擎不可用（前端静默降级）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LumenPreviewResult {
    pub preview_path: Option<String>,
    pub width: u32,
    pub original: bool,
    pub cached: bool,
}

/// `lumen_get_recipe_cmd` 返回：宿主侧调色面板的初始态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LumenRecipe {
    pub available: bool,
    pub tone: ToneAdjustments,
    pub monochrome: bool,
}

/// `lumen_sync_ratings_cmd` 的结果：写回了什么、跳过了什么、哪里有冲突。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LumenRatingSync {
    /// 已从 LUMEN RAW 写回侧边栏的路径
    pub updated: Vec<String>,
    /// 宿主侧更新、等待推给 LUMEN RAW 的照片数
    pub skipped: u32,
    /// 两侧都改过 —— 交用户裁决，**不自动覆盖**
    pub conflicts: Vec<LumenRatingConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LumenRatingConflict {
    pub path: String,
    pub host_rating: u8,
    pub host_flag: String,
    pub lumen_rating: u8,
    pub lumen_flag: String,
}

/// `apply_tone_cmd` 的结果：一条写入路径的两个落点各自成功与否。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToneWriteReport {
    /// XMP 侧边栏是否写成功（互操作底线：Lightroom / Capture One / Photoshop）
    pub xmp_written: bool,
    /// LUMEN RAW 编辑态是否应用成功（引擎关闭或失败时为 false）
    pub lumen_applied: bool,
    /// 落盘的 `.lumen` 工程路径（没有则为 None）
    pub project_path: Option<String>,
    /// 非致命问题（引擎失败原因等），前端据此提示但不阻断
    pub warnings: Vec<String>,
}

/// `get_tone_state_cmd` 的结果：统一管线的读回视图。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToneState {
    /// 当前生效的调色（引擎可用时优先 lumen，因为它决定渲染）
    pub tone: ToneAdjustments,
    /// XMP 侧边栏里的调色（互操作真值）
    pub xmp_tone: ToneAdjustments,
    /// LUMEN RAW 工程里的调色（渲染真值）；没有工程时为 None
    pub lumen_tone: Option<ToneAdjustments>,
    /// 两侧不一致 —— 前端必须提示，绝不静默取舍
    pub divergent: bool,
    pub lumen_available: bool,
}

/// `lumen_apply_mask_cmd` 的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LumenMaskResult {
    /// lumen 回显的变更描述（如 ["新增蒙版 天空：去薄雾 +60"]）
    pub applied: serde_json::Value,
    /// 工程里现有的蒙版列表
    pub masks: Vec<serde_json::Value>,
    /// 实测耗时（AI 蒙版约 4s，UI 需要进度反馈）
    pub elapsed_ms: u64,
}
