//! photo/scan 域 DTO（issue #145 自 models.rs 拆出，纯导航搬移，语义零变化）。
//!
//! 包含：照片文件信息 / EXIF / 分组状态 / 扫描结果 / 目录模式 / 目录探测 / 导出项，
//! 以及 scan/export 取消哨兵 TASK_CANCELLED（scanner.rs 消费）。

use serde::{Deserialize, Serialize};

/// 跨域边：`PhotoGroupInfo.tone` 引用 lumen/tone 域的调色（façade 公开路径不变）。
use crate::models::ToneAdjustments;

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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
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

/// 单目录内容识别结果（#66）：只决定「这一目录当什么源用」，不参与配对口径。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderMode {
    /// 只有 JPG（含 png/webp）
    JpgOnly,
    /// 只有 RAW
    RawOnly,
    /// JPG 与 RAW 同时存在
    Mixed,
    /// 根层一张可识别的照片都没有
    Empty,
}

/// `probe_folder_cmd` 的返回：一次 `read_dir` 的扩展名计数。
///
/// 刻意**不读 EXIF/XMP、不递归**：只回答「选一个目录时两个源该怎么填」。
/// `subdir_count` 只用于「根层为空但有子目录」的可操作提示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderProbe {
    pub mode: FolderMode,
    pub jpg_count: usize,
    pub raw_count: usize,
    pub subdir_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub base_name: String,
    pub jpg_path: Option<String>,
    pub raw_path: Option<String>,
}
