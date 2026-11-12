//! settings/lens 域（issue #145 自 models.rs 拆出，纯导航搬移，语义零变化）。
//!
//! 包含：AppSettings / 默认缩略图宽度常量（issue #133 唯一真值，墓碑用例随常量走）
//! / 常用手动镜头预设 LensPreset 与出厂 6 条 factory（ADR-013）。

use serde::{Deserialize, Serialize};

/// 后端默认的缩略图宽度（issue #133 的唯一真值）。
///
/// `AppSettings::default` 与 `get_thumbnail_cmd` 的 IPC 回落共用同一常量；
/// 前端默认在 `src/types/index.ts` 的 `DEFAULT_THUMBNAIL_WIDTH`，**数值必须同为 200**，
/// 两边由墓碑用例（`models::settings::thumbnail_width_tests` 与 `api.test.ts`）各自锁字面量 200。
/// 宫格宽度是独立产品值（`ThumbnailGrid` 的 `GRID_THUMB_WIDTH`），数值巧合一致但不引用本常量。
pub const DEFAULT_THUMBNAIL_WIDTH: u32 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub default_jpg_folder: String,
    pub default_raw_folder: String,
    pub photoshop_path: String,
    pub thumbnail_width: u32,
    pub sort_order: String,
    /// 是否启用 LUMEN RAW 引擎（sidecar）集成的 RAW 链路。
    ///
    /// issue #68 起 sidecar 随包分发，默认开启（首次安装即可用）；老用户显式
    /// 存下的 `false` 不强制迁移——关掉引擎始终是用户自己的选择。
    pub lumen_enabled: bool,
    /// lumen-cli.exe 路径（留空 = 自动查找）
    pub lumen_cli_path: String,
    /// 用户是否期待 AI 能力（GPU 版）。为 true 但实际指向 CPU 版时，设置页会明确
    /// 警告"你指向的是 CPU 版，AI 蒙版不可用"——能力判定本身按磁盘事实走。
    pub lumen_expect_ai: bool,
    /// 调色自动保存（issue #67）：滑杆改动停止 400ms 后自动写入 XMP / `.lumen`
    /// 工程。默认开启；settings 表**缺这个键**时也按开启（老库零迁移），
    /// 只有显式落盘 `"false"` 才是用户主动关闭。
    pub tone_auto_save: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_jpg_folder: String::new(),
            default_raw_folder: String::new(),
            photoshop_path: r"C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe"
                .to_string(),
            thumbnail_width: DEFAULT_THUMBNAIL_WIDTH,
            sort_order: "time_filename".to_string(),
            lumen_enabled: true,
            lumen_cli_path: String::new(),
            lumen_expect_ai: false,
            tone_auto_save: true,
        }
    }
}

/// 一条「常用手动镜头」快捷预设（ADR-013）。
///
/// 原先这 6 条是写死在前端的常量，用户既改不了也用不上自己的镜头；现在由用户
/// 自己维护，存在 `settings` 表的 `lens_presets` 键里。
///
/// 三个字段都是**自由文本**：镜头型号本来就千奇百怪（`APO-LANTHAR`、`NOKTON`
/// 的大小写都不统一），焦段有 `50mm` 也有 `50`，光圈有 `f/2.0` 也有 `F2`。
/// 这里不做任何格式校验 —— 它们最终是写进 XMP 的字符串，用户想写什么就写什么。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LensPreset {
    pub name: String,
    pub focal: String,
    pub aperture: String,
}

/// 出厂预设：升级用户第一次打开弹窗看到的就是这 6 条（零迁移）。
///
/// **只在「键不存在」时使用**。用户把列表删空（存成 `[]`）之后不能再塞回来，
/// 否则「删了又自己长出来」是比没有这个功能更糟的体验。
pub fn builtin_lens_presets() -> Vec<LensPreset> {
    vec![
        LensPreset {
            name: "Voigtlander APO-LANTHAR 50mm F2".to_string(),
            focal: "50mm".to_string(),
            aperture: "f/2.0".to_string(),
        },
        LensPreset {
            name: "Voigtlander NOKTON 35mm F1.2".to_string(),
            focal: "35mm".to_string(),
            aperture: "f/1.2".to_string(),
        },
        LensPreset {
            name: "TTArtisan 28mm F5.6".to_string(),
            focal: "28mm".to_string(),
            aperture: "f/5.6".to_string(),
        },
        LensPreset {
            name: "7Artisans 35mm F0.95".to_string(),
            focal: "35mm".to_string(),
            aperture: "f/0.95".to_string(),
        },
        LensPreset {
            name: "Leica Summicron-M 50mm f/2".to_string(),
            focal: "50mm".to_string(),
            aperture: "f/2.0".to_string(),
        },
        LensPreset {
            name: "Zeiss Planar T* 50mm f/1.4".to_string(),
            focal: "50mm".to_string(),
            aperture: "f/1.4".to_string(),
        },
    ]
}

#[cfg(test)]
mod thumbnail_width_tests {
    use super::*;

    /// issue #133 墓碑：后端默认权威只出现在常量定义处；
    /// `Default` 与回落的 IPC 语义共用同一常量。改常量值必红（200→201）。
    #[test]
    fn default_thumbnail_width_is_the_constant() {
        assert_eq!(DEFAULT_THUMBNAIL_WIDTH, 200);
        assert_eq!(AppSettings::default().thumbnail_width, 200);
    }
}
