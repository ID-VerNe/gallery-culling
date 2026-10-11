use serde::{Deserialize, Serialize};

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
