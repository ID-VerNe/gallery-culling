use serde::{Deserialize, Serialize};

/// 任务被用户取消时的哨兵错误文案。
///
/// `scan_folders_cmd` / `batch_export_cmd` 被取消时返回的 `Err` 字符串**精确等于**
/// 此常量（前端据此把「取消」与真实失败区分开，而不是显示一条错误 toast）。
pub const TASK_CANCELLED: &str = "任务已取消";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoFileInfo {
    pub name: String,
    pub extension: String,
    pub path: String,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExifData {
    pub shutter_speed: Option<String>,
    pub aperture: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub date_time: Option<String>,
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub orientation: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PhotoGroupStatus {
    Complete,
    JpgOnly,
    RawOnly,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoGroupInfo {
    pub id: String,
    pub base_name: String,
    pub jpg: Option<PhotoFileInfo>,
    pub raw: Option<PhotoFileInfo>,
    pub edited: Option<PhotoFileInfo>,
    pub tone: Option<ToneAdjustments>,
    pub status: PhotoGroupStatus,
    pub rating: u8,   // 0..5 stars
    pub flag: String, // "none", "pick", "reject"
    /// 色标：`""` 表示无色标，其余为 Red / Yellow / Green / Blue / Purple。
    /// 唯一真值是 XMP 的 `xmp:Label`（Lightroom 同一字段，双向可见）。
    pub label: String,
    pub has_xmp: bool,
    pub exif: Option<ExifData>,
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScanResult {
    pub groups: Vec<PhotoGroupInfo>,
    pub total_count: usize,
    pub jpg_folder: String,
    pub raw_folder: String,
    pub is_viewer_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub default_jpg_folder: String,
    pub default_raw_folder: String,
    pub photoshop_path: String,
    pub thumbnail_width: u32,
    pub sort_order: String,
    /// 是否启用 LUMEN RAW 引擎（sidecar）集成的 RAW 链路；默认关闭，零迁移风险
    pub lumen_enabled: bool,
    /// lumen-cli.exe 路径（留空 = 自动查找）
    pub lumen_cli_path: String,
    /// 宫格缩略图是否走 LUMEN RAW 渲染（默认 false = 继续用 EXIF 内嵌缩略图，
    /// 那条路近乎零成本；开开后 200px 约 0.3s/张，由用户自己权衡）
    pub lumen_grid_thumbnails: bool,
    /// 用户是否期待 AI 能力（GPU 版）。为 true 但实际指向 CPU 版时，设置页会明确
    /// 警告"你指向的是 CPU 版，AI 蒙版不可用"——能力判定本身按磁盘事实走。
    pub lumen_expect_ai: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_jpg_folder: String::new(),
            default_raw_folder: String::new(),
            photoshop_path: r"C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe"
                .to_string(),
            thumbnail_width: 200,
            sort_order: "time_filename".to_string(),
            lumen_enabled: false,
            lumen_cli_path: String::new(),
            lumen_grid_thumbnails: false,
            lumen_expect_ai: false,
        }
    }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub base_name: String,
    pub jpg_path: Option<String>,
    pub raw_path: Option<String>,
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
