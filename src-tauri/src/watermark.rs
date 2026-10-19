//! 边框水印：在导出成片后为照片加一条等宽边框带，写上拍摄参数。
//!
//! # 为什么由宿主画，而不是让渲染器画
//!
//! 渲染器（LUMEN RAW 的 `watermark.py`）自己就有完整的水印实现，但它在
//! **headless CLI sidecar 里是双重失效**的（2026-10-19 真机实测）：
//!
//! 1. `assets/NotoSansSC.ttf` 被上游 `.gitignore` 忽略、本地根本没有，
//!    一开启水印就 `lumen-cli: cannot open resource` 直接崩；
//! 2. 补上字体后能出图，但 ARW 的 EXIF 依赖 ExifTool（`assets/exiftool/`，
//!    同样被忽略），`photo.info` 八个字段全返回空串，水印文案退化成
//!    「未记录」；
//! 3. 顺带一提，`lumen-raw/` 本身是被本项目 `.gitignore` 忽略的第三方克隆，
//!    改上游代码**进不了 git**，sidecar 又是 PyInstaller 产物（模块编译进
//!    PYZ），要让它生效得先装一套 PyInstaller + cv2 + PySide6 工具链，产出的
//!    184MB 构件同样不可版本化。
//!
//! 而宿主**本来就有 EXIF** —— `scanner` 读配对 JPG 只要 0.14 ms/张
//! （ADR-010 修订后实测，比读 RAW 快 80 倍）。所以宿主自己画是唯一
//! 可版本化、可测试、不新增依赖链的路。
//!
//! # 代价
//!
//! 导出后的 JPEG 要**再编码一次**才加得上边框。沿用用户选的质量（不是
//! 偷偷提质量），并把「二次编码」写进 UI 说明与 ADR。
//!
//! # 版式
//!
//! 首版只做**底边单条带**：宽度取照片短边的百分比（与渲染器的 8–35% 同区间），
//! 底色与字色沿用渲染器四个同名预设的 RGB，三行文案固定为
//! 「机身 · 镜头」「焦距 · 光圈 · 快门 · ISO」「拍摄时间」。

use std::path::Path;
use std::thread_local;

use ab_glyph::point;
use image::{Rgb, RgbImage};

use crate::models::ExifData;

/// 水印尺寸区间：边框占短边的百分比。
///
/// 与渲染器 `watermark.defaults()` 的 8–35% **逐字一致** —— 换过去时观感不变。
pub const SIZE_MIN: f32 = 8.0;
pub const SIZE_MAX: f32 = 35.0;

/// 四个配色预设。与渲染器 `watermark.PRESETS` 取同一组 RGB。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatermarkPreset {
    Gallery,
    Noir,
    Travel,
    Sage,
}

/// 预设名 —— 契约里只准出现这四个字。前端 select 与清单都查这张表。
pub const PRESET_NAMES: [&str; 4] = ["gallery", "noir", "travel", "sage"];

impl WatermarkPreset {
    /// 解析预设名；未知名返回 `None`（**不静默回落**到 gallery）。
    ///
    /// 拼错就当没写：让用户看见「没生效」，比悄悄换成另一种配色好查。
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "gallery" => Some(Self::Gallery),
            "noir" => Some(Self::Noir),
            "travel" => Some(Self::Travel),
            "sage" => Some(Self::Sage),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gallery => "gallery",
            Self::Noir => "noir",
            Self::Travel => "travel",
            Self::Sage => "sage",
        }
    }

    /// 边框底色。
    pub fn band_rgb(self) -> [u8; 3] {
        match self {
            Self::Gallery => [250, 249, 246],
            Self::Noir => [20, 23, 23],
            Self::Travel => [238, 231, 214],
            Self::Sage => [220, 228, 214],
        }
    }

    /// 文字色。深底配亮字、浅底配深字 —— 不匹配会让暗色预设变成不可读。
    pub fn ink_rgb(self) -> [u8; 3] {
        match self {
            Self::Gallery => [39, 43, 39],
            Self::Noir => [231, 234, 225],
            Self::Travel => [74, 71, 54],
            Self::Sage => [41, 62, 43],
        }
    }
}

/// 水印设置（去掉了 UI 关心的 `enabled`：编不编由调用方决定）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WatermarkSettings {
    pub preset: WatermarkPreset,
    pub size: f32,
}

/// 校验尺寸百分比。
///
/// 拒绝 NaN / Inf：`border_width` 会拿它做乘法和 round，
/// 非有限值会静默产出 0 像素边框 —— 图没变，用户以为加了水印。
pub fn validate_size(value: f32) -> Result<f32, String> {
    if !value.is_finite() {
        return Err("水印边框宽度必须是有限数值".to_string());
    }
    Ok(value.clamp(SIZE_MIN, SIZE_MAX))
}

/// 边框宽度（像素）= 短边 × size%。
///
/// 真机口径：802×1200 的照片、size=14 → `round(802 × 0.14) = 112`，
/// 出图 802×1312。这个算式与渲染器 `watermark.dimensions()` 逐字一致。
pub fn border_width(width: u32, height: u32, size_percent: f32) -> u32 {
    let short = width.min(height) as f32;
    (short * size_percent / 100.0).round().max(1.0) as u32
}

/// 条带版式：内边距、字号、行数。
///
/// 字号沿用渲染器 `watermark.band()` 的算式
/// `(thickness - 2*margin) / rows * 0.76`，其中 margin 是边框宽的 15%：
/// 换成另一种观感会让用户在两处之间来回切时觉得「同样的 14% 不是一回事」。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BandLayout {
    pub pad: u32,
    pub margin: u32,
    pub font_px: f32,
    pub rows: usize,
}

/// 整块文字在带内的**顶部留白**。
///
/// 居中，且两端不小于内边距 —— 顶对齐会在宽带里留出一大块死白：
/// 实测 149px 的带、3 行 90px 的字，顶对齐给出 28px / 50px 的上下留白，
/// 肉眼一看就是「字贴在下边」。带子装不下整块时退回内边距，那时居中
/// 反而会把字挤到边线上。
pub fn band_top_gap(pad: u32, block_height: f32, margin: u32) -> f32 {
    ((pad as f32 - block_height).max(2.0 * margin as f32)) / 2.0
}

pub fn band_layout(width: u32, height: u32, size_percent: f32, rows: usize) -> BandLayout {
    let pad = border_width(width, height, size_percent);
    let margin = ((pad as f32) * 0.15).round().max(3.0) as u32;
    let rows = rows.max(1);
    let font_px = (pad as f32 - 2.0 * margin as f32) / rows as f32 * 0.76;
    BandLayout {
        pad,
        margin,
        font_px,
        rows,
    }
}

/// 水印文案，固定三行。
///
/// 逐项拼接、缺项跳过；**整行都缺就整行不要**（「 · 」开头比没内容更难看）。
/// 三行都空 → 返回空 `Vec`，调用方据此判定「没什么可写的」而不加边框。
pub fn caption_lines(exif: Option<&ExifData>) -> Vec<String> {
    let Some(e) = exif else {
        return Vec::new();
    };
    let mut lines = Vec::new();

    if let Some(v) = join_parts([e.camera_model.as_deref(), e.lens_model.as_deref()]) {
        lines.push(v);
    }
    let mut tech = Vec::new();
    for v in [
        e.focal_length.as_deref(),
        e.aperture.as_deref(),
        e.shutter_speed.as_deref(),
    ] {
        push_trimmed(&mut tech, v);
    }
    push_trimmed(&mut tech, e.iso.as_deref());
    if !tech.is_empty() {
        // ISO 要带前缀单独拼，其余是相机原样写出的字符串。
        let iso = tech.pop();
        if let Some(iso) = iso {
            tech.push(format!("ISO {}", iso));
        }
        lines.push(tech.join(" · "));
    }
    push_trimmed(&mut lines, e.date_time.as_deref());
    lines
}

fn push_trimmed(lines: &mut Vec<String>, value: Option<&str>) {
    if let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) {
        lines.push(v.to_string());
    }
}

/// 用「 · 」拼一行；**全空则整个 `None`**（调用方略过该行）。
pub fn join_parts<'a>(parts: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    let s: Vec<&str> = parts
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .collect();
    if s.is_empty() {
        None
    } else {
        Some(s.join(" · "))
    }
}

// ---- 字体 ----

/// 系统字体候选，按优先级。
///
/// **刻意不打包字体文件**：不放仓库 = 无可分发物、无许可问题、安装包不涨 10MB。
/// 代价是依赖系统里有中文字体，所以下面有一条明确的回退链，链尾仍失败时
/// **返回错误让整批导出提前失败**，而不是静默出一张没有水印的图。
#[cfg(target_os = "windows")]
const FONT_CANDIDATES: &[&str] = &[
    r"C:\Windows\Fonts\msyh.ttc",    // 微软雅黑（简体中文，Win7 起必带）
    r"C:\Windows\Fonts\simhei.ttf",  // 中易黑体
    r"C:\Windows\Fonts\simsun.ttc",  // 宋体
    r"C:\Windows\Fonts\segoeui.ttf", // 拉丁兜底：中文会缺字，但比不写好
];

#[cfg(not(target_os = "windows"))]
const FONT_CANDIDATES: &[&str] = &[];

thread_local! {
    /// 只在本线程缓存一份。
    ///
    /// `batch_render_export_cmd` 的前置检查跑在命令的 async 上下文，而
    /// `render_export_items` 的循环跑在 blocking 线程上。跨线程缓存需要
    /// `Send + Sync`，`ab_glyph::FontVec` 不保证；而重复读 1MB 字体的开销
    /// 远不值得为它引入 `Arc<Mutex>`。
    static FONT: Option<ab_glyph::FontVec> = load_font();
}

/// 取链上第一个能解析出字体的文件。
fn load_font() -> Option<ab_glyph::FontVec> {
    FONT_CANDIDATES.iter().find_map(|cand| {
        // `try_from_vec` 收**拥有**的字节，且 `FontVec` 内部按 `'static` 持有；
        // `try_from_slice` 收 `&'static`，放不进来的运行时读出来的 Vec。
        ab_glyph::FontVec::try_from_vec(std::fs::read(cand).ok()?).ok()
    })
}

/// 前置检查：拿得到字体才继续。
///
/// 用它而不是让每张图各自失败 —— 200 张图各自少个水印的噪音，
/// 比一次说清「找不到字体」难查得多。
pub fn require_font() -> Result<(), String> {
    with_font(|_| ()).map(|_| ()).map_err(|_| {
        format!(
            "找不到可用的中文字体（试过 {}）。无法添加边框水印，可关闭水印后导出。",
            FONT_CANDIDATES.join("、")
        )
    })
}

fn with_font<T>(f: impl FnOnce(&ab_glyph::FontVec) -> T) -> Result<T, String> {
    FONT.with(|slot| slot.as_ref().map(f).ok_or_else(|| "字体未加载".to_string()))
}

/// 把一张已写盘的 JPEG 就地加上水印。
///
/// 返回 `true` = 真的加了边框；`false` = 没有文案可写（没 EXIF），
/// 文件原样不动。**渲染失败不影响导出本身** —— 调用方把原因记进清单的
/// `warning`，这张图照样导出去。
pub fn apply_to_file(
    path: &Path,
    settings: &WatermarkSettings,
    quality: u8,
    exif: Option<&ExifData>,
) -> Result<bool, String> {
    let lines = caption_lines(exif);
    if lines.is_empty() {
        return Ok(false);
    }
    with_font(|font| {
        let img = image::open(path)
            .map_err(|e| format!("读取成片失败 {}: {}", path.display(), e))?
            .to_rgb8();
        let (w, h) = img.dimensions();
        let layout = band_layout(w, h, settings.size, lines.len());
        let mut canvas = RgbImage::from_pixel(w, h + layout.pad, Rgb(settings.preset.band_rgb()));
        image::imageops::replace(&mut canvas, &img, 0, 0);
        drop(img);

        draw_band(&mut canvas, layout, &lines, settings.preset.ink_rgb(), font);

        write_jpeg(path, &canvas, quality)
    })??;

    Ok(true)
}

/// 按指定质量写回。
///
/// 不能用 `image::DynamicImage::save_with_format` —— 那条路的编码器是
/// 默认质量（`image` 的 `JpegEncoder` 默认 100），会把用户选的「92」悄悄
/// 变成 95 甚至 100，用户的选择就落空了。
/// 按指定质量编出 JPEG 字节。
///
/// 拆出来是为了让「质量真的传进了编码器」可测：`write_jpeg` 只写盘，
/// 而写盘的结果里唯一能观察的只有尺寸。若哪天误写成默认质量（100），
/// 只有这个函数能被测试拦住 —— 那是会把用户选的「92」悄悄变成 95+。
fn jpeg_bytes(canvas: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    use image::codecs::jpeg::JpegEncoder;
    use image::ExtendedColorType;

    let mut buf = Vec::with_capacity(canvas.len());
    let mut enc = JpegEncoder::new_with_quality(&mut buf, quality);
    enc.encode(
        canvas,
        canvas.width(),
        canvas.height(),
        ExtendedColorType::Rgb8,
    )
    .map_err(|e| format!("编码水印成片失败: {}", e))?;
    Ok(buf)
}

fn write_jpeg(path: &Path, canvas: &RgbImage, quality: u8) -> Result<(), String> {
    let bytes = jpeg_bytes(canvas, quality)?;
    std::fs::write(path, &bytes).map_err(|e| format!("写回成片失败 {}: {}", path.display(), e))
}

/// 把文案画进底边框带。
fn draw_band(
    canvas: &mut RgbImage,
    layout: BandLayout,
    lines: &[String],
    ink: [u8; 3],
    font: &ab_glyph::FontVec,
) {
    use ab_glyph::{Font, ScaleFont};

    let (canvas_w, canvas_h) = canvas.dimensions();
    let band_top = canvas_h - layout.pad;
    let avail = canvas_w as f32 - 2.0 * layout.margin as f32;
    let ink = Rgb(ink);

    // 先按版式公式取字号，再**逐次缩小直到最宽一行放得下** —— 与渲染器同策略：
    // 绝不因为文案长就把字裁掉。
    let mut px = layout.font_px;
    while px > 6.0 && line_overflows(font, lines, px, avail) {
        px -= 1.0;
    }
    let scaled = font.as_scaled(px);
    let line_h = scaled.height();
    let block_h = lines.len() as f32 * line_h;
    let top_gap = band_top_gap(layout.pad, block_h, layout.margin);

    for (i, text) in lines.iter().enumerate() {
        // 每行的**基线**：从顶部留白往下排第 i 行，再抬升到 ascender 位置。
        let row_top = band_top as f32 + top_gap + i as f32 * line_h;
        let baseline = row_top + scaled.ascent();
        let advance = text_width(&scaled, text);
        let mut pen_x = (canvas_w as f32 - advance) / 2.0; // 水平居中
        for ch in text.chars() {
            let glyph_id = scaled.glyph_id(ch);
            let glyph = glyph_id.with_scale_and_position(px, point(pen_x, baseline));
            if let Some(outlined) = font.outline_glyph(glyph) {
                let bounds = outlined.px_bounds();
                outlined.draw(|x, y, coverage| {
                    if coverage <= 0.0 {
                        return;
                    }
                    let sx = bounds.min.x + x as f32;
                    let sy = bounds.min.y + y as f32;
                    if sx < 0.0 || sy < 0.0 {
                        return;
                    }
                    let Some(pixel) = canvas.get_pixel_mut_checked(sx as u32, sy as u32) else {
                        return;
                    };
                    *pixel = blend(*pixel, ink, coverage);
                });
            }
            pen_x += scaled.h_advance(glyph_id);
        }
    }
}

/// 任一行在当前字号下是否超出可用宽度。
fn line_overflows(font: &ab_glyph::FontVec, lines: &[String], px: f32, avail: f32) -> bool {
    use ab_glyph::Font;

    let scaled = font.as_scaled(px);
    lines.iter().any(|line| text_width(&scaled, line) > avail)
}

/// 一行文字的总步进。
fn text_width<F: ab_glyph::Font>(scaled: &ab_glyph::PxScaleFont<F>, text: &str) -> f32 {
    use ab_glyph::ScaleFont;

    text.chars()
        .map(|c| scaled.h_advance(scaled.glyph_id(c)))
        .sum()
}

/// 按覆盖率把字形盖到底色上。
///
/// 不是硬阈值：阈值化会让小字号变成锯齿块，中文笔画密处糊成一团。
fn blend(below: Rgb<u8>, above: Rgb<u8>, coverage: f32) -> Rgb<u8> {
    let c = coverage.clamp(0.0, 1.0);
    let each = |b: u8, a: u8| (b as f32 + (a as f32 - b as f32) * c).round() as u8;
    Rgb([
        each(below[0], above[0]),
        each(below[1], above[1]),
        each(below[2], above[2]),
    ])
}

#[cfg(test)]
pub mod testdata {
    /// 造一张带 EXIF 的最小 JPEG（SOI + APP1/Exif + EOI）。
    ///
    /// 手工拼而不是用 `kamadak-exif` 写：那个 crate 只读不写。
    /// 导出链路的用例要用它来提供「真的读得出 ISO」的配对 JPG —— 没有它，
    /// `caption_lines` 永远拿到空串，水印接线就只能测到「没加」那一半。
    pub fn jpeg_with_iso(iso: u16) -> Vec<u8> {
        // 结构照**真实相机文件**来：IFD0 只放一个 ExifIFD 指针（0x8769），
        // 真正的标签全在 Exif 子 IFD 里。
        //
        // 一开始把所有标签平铺在 IFD0 —— 底层 `exif::Reader` 读得到（hexdump
        // 里两个字段都在），但 `get_field(tag, In::PRIMARY)` 一个都取不到。
        // 照抄真实文件的子 IFD 结构后即可读。
        //
        // RATIONAL 的 8 字节**放不进** 4 字节的值字段：值字段里放偏移，
        // 数据跟在所属 IFD 之后。这是手工造 EXIF 第二容易写错的一处。
        let exif_ifd_off = 8u32 + 2 + 12 + 4; // 头部 + 计数 + 一条 entry + next IFD
        let rational_off = exif_ifd_off + 2 + 12 + 12 + 4; // 子 IFD: 计数 + 两条 entry + next

        let mut exif_entries = Vec::new();
        exif_entries.extend_from_slice(&0x8827u16.to_be_bytes()); // ISO
        exif_entries.extend_from_slice(&3u16.to_be_bytes()); // SHORT
        exif_entries.extend_from_slice(&1u32.to_be_bytes());
        exif_entries.extend_from_slice(&iso.to_be_bytes());
        exif_entries.extend_from_slice(&[0, 0]); // padding 到 4 字节
        exif_entries.extend_from_slice(&0x829au16.to_be_bytes()); // ExposureTime
        exif_entries.extend_from_slice(&5u16.to_be_bytes()); // RATIONAL
        exif_entries.extend_from_slice(&1u32.to_be_bytes());
        exif_entries.extend_from_slice(&rational_off.to_be_bytes());

        let mut ifd0 = Vec::new();
        ifd0.extend_from_slice(&1u16.to_be_bytes()); // 1 个 entry
        ifd0.extend_from_slice(&0x8769u16.to_be_bytes()); // ExifIFDPointer
        ifd0.extend_from_slice(&4u16.to_be_bytes()); // LONG
        ifd0.extend_from_slice(&1u32.to_be_bytes());
        ifd0.extend_from_slice(&exif_ifd_off.to_be_bytes());
        ifd0.extend_from_slice(&0u32.to_be_bytes()); // 没有下一个 IFD

        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"MM\x00\x2a"); // big-endian magic
        tiff.extend_from_slice(&8u32.to_be_bytes()); // IFD0 紧跟头部
        tiff.extend_from_slice(&ifd0);
        tiff.extend_from_slice(&2u16.to_be_bytes()); // 子 IFD 计数
        tiff.extend_from_slice(&exif_entries);
        tiff.extend_from_slice(&0u32.to_be_bytes()); // 子 IFD 到此为止
        tiff.extend_from_slice(&80u32.to_be_bytes()); // RATIONAL 数据：80/8000 s
        tiff.extend_from_slice(&8000u32.to_be_bytes());

        let mut exif = Vec::new();
        exif.extend_from_slice(b"Exif\x00\x00");
        exif.extend_from_slice(&tiff);

        let mut out = Vec::new();
        out.extend_from_slice(&[0xff, 0xd8]); // SOI
                                              // APP1：长度字段算上它自己的 2 字节，载荷已含 "Exif\0\0" 头 —— 不能再写一遍。
        out.extend_from_slice(&[0xff, 0xe1]);
        out.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&exif);
        out.extend_from_slice(&[0xff, 0xd9]); // EOI
        out
    }
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::models::ExifData;

    fn exif_fixture() -> ExifData {
        ExifData {
            shutter_speed: Some("1/500".into()),
            aperture: Some("f/1.8".into()),
            iso: Some("800".into()),
            focal_length: Some("85mm".into()),
            date_time: Some("2026:09:12 17:31:02".into()),
            camera_make: Some("SONY".into()),
            camera_model: Some("ILCE-7M4".into()),
            lens_model: Some("FE 85mm F1.8".into()),
            orientation: Some(1),
        }
    }

    fn bare() -> ExifData {
        ExifData::default()
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wm_test_{}_{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ---- 预设 ----

    #[test]
    fn preset_parse_accepts_only_the_four_known_names() {
        for name in PRESET_NAMES {
            assert_eq!(
                WatermarkPreset::parse(name).map(|p| p.as_str()),
                Some(name),
                "预设 {} 应能解析",
                name
            );
        }
        // 未知名绝不静默回落：拼错了就该看得出来，而不是悄悄变成画廊白。
        assert_eq!(WatermarkPreset::parse("Gallery"), None);
        assert_eq!(WatermarkPreset::parse("gallery "), None);
        assert_eq!(WatermarkPreset::parse(""), None);
        assert_eq!(WatermarkPreset::parse("green"), None);
    }

    #[test]
    fn dark_presets_pair_with_light_ink() {
        // 暗底配亮字、浅底配深字。反了会让某个预设变成读不出来。
        let dark: Vec<_> = [WatermarkPreset::Gallery, WatermarkPreset::Noir]
            .into_iter()
            .chain([WatermarkPreset::Travel, WatermarkPreset::Sage])
            .filter(|p| p.band_rgb().iter().map(|c| *c as u32).sum::<u32>() < 300)
            .collect();
        for p in dark {
            let band = p.band_rgb().iter().map(|c| *c as u32).sum::<u32>();
            let ink = p.ink_rgb().iter().map(|c| *c as u32).sum::<u32>();
            assert!(ink > band, "{:?} 暗底配了暗字", p);
        }
    }

    // ---- 尺寸 ----

    #[test]
    fn size_is_clamped_and_non_finite_is_rejected() {
        assert_eq!(validate_size(0.0).unwrap(), SIZE_MIN);
        assert_eq!(validate_size(100.0).unwrap(), SIZE_MAX);
        assert_eq!(validate_size(14.0).unwrap(), 14.0);
        // NaN / Inf 会让 border_width 算出 0 像素边框 —— 图没变却以为加了水印。
        assert!(validate_size(f32::NAN).is_err());
        assert!(validate_size(f32::INFINITY).is_err());
    }

    #[test]
    fn border_width_uses_the_short_edge() {
        // 真机口径：802×1200、14% → 112 像素，出图 802×1312。
        assert_eq!(border_width(802, 1200, 14.0), 112);
        // 横竖不影响：短边相同时结果必须一致。
        assert_eq!(border_width(1200, 802, 14.0), 112);
        assert_eq!(border_width(1000, 1000, 20.0), 200);
        // 至少 1 像素：哪怕给一张极小图也该有边框。
        assert_eq!(border_width(16, 16, 1.0), 1);
    }

    #[test]
    fn band_layout_font_scales_with_the_band() {
        let layout = band_layout(802, 1200, 14.0, 3);
        assert_eq!(layout.pad, 112);
        let expected = (112.0 - 2.0 * layout.margin as f32) / 3.0 * 0.76;
        assert!(
            (layout.font_px - expected).abs() < 1e-4,
            "font_px {} 不等于算式 {}",
            layout.font_px,
            expected
        );
        // 边框越宽，字号越大 —— 否则宽边框里仍是小字。
        assert!(band_layout(4000, 3000, 35.0, 3).font_px > layout.font_px);
        // 行数越多，字号越小：不然三行会挤成一片。
        assert!(band_layout(802, 1200, 14.0, 6).font_px < layout.font_px);
    }

    // ---- 文案 ----

    #[test]
    fn caption_lines_are_three_fixed_rows() {
        let lines = caption_lines(Some(&exif_fixture()));
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "ILCE-7M4 · FE 85mm F1.8");
        assert_eq!(lines[1], "85mm · f/1.8 · 1/500 · ISO 800");
        assert_eq!(lines[2], "2026:09:12 17:31:02");
    }

    #[test]
    fn caption_lines_drop_rows_with_no_content() {
        // 只有机身：另两行整行消失，而不是留下「 · · 」。
        let mut e = exif_fixture();
        e.lens_model = None;
        e.focal_length = None;
        e.aperture = None;
        e.shutter_speed = None;
        e.iso = None;
        e.date_time = None;
        assert_eq!(caption_lines(Some(&e)), vec!["ILCE-7M4".to_string()]);

        // 空串与 None 同罪：EXIF 里空字符串很常见。
        let mut e = exif_fixture();
        e.camera_model = Some("   ".into());
        e.lens_model = Some("".into());
        assert_eq!(caption_lines(Some(&e)).len(), 2);
    }

    #[test]
    fn no_exif_means_no_text_and_therefore_no_border() {
        assert!(caption_lines(None).is_empty());
        assert!(caption_lines(Some(&bare())).is_empty());
    }

    // ---- 居中 ----

    #[test]
    fn band_is_vertically_centred_not_top_aligned() {
        // 真机教训：149px 的带配 3 行 90px 的字，顶对齐给出 28/50 的上下留白，
        // 肉眼一看就是「字贴在下边」。居中后两端相等。
        let gap = band_top_gap(149, 3.0 * 29.9, 26);
        assert!(
            (gap - 29.65).abs() < 0.5,
            "上留白 {} 应约为 29.65（与下留白相等）",
            gap
        );
        assert!(
            ((149.0 - gap - 89.7) - gap).abs() < 0.5,
            "上下留白不等：上 {} 下 {}",
            gap,
            149.0 - gap - 89.7
        );
    }

    #[test]
    fn band_gap_never_drops_below_the_margin() {
        // 带子装不下整块时退回内边距，别把字挤到边线上。
        assert_eq!(band_top_gap(100, 200.0, 10), 10.0);
        assert_eq!(band_top_gap(50, 40.0, 5), 5.0);
    }

    // ---- 端到端：真 JPEG 往返 ----

    /// 与目标色的最大通道差。JPEG 重编码会让纯色偏 1–2 个 LSB，
    /// 所以任何落在「压缩过」的像素上的比较都必须带容差。
    fn within(pixel: &Rgb<u8>, want: [u8; 3], tol: u8) -> bool {
        (0..3).all(|c| pixel[c].abs_diff(want[c]) <= tol)
    }

    #[test]
    fn apply_to_file_adds_a_measured_border() {
        use image::{Rgb, RgbImage};

        let dir = scratch("border");
        let file = dir.join("t.jpg");
        // 棋盘噪声：纯色图在 JPEG 下各质量体积几乎一样，噪声才能分辨
        // 「用户选的质量有没有真的传进编码器」。
        let mut canvas = RgbImage::new(802, 1200);
        for (x, y, p) in canvas.enumerate_pixels_mut() {
            let v = if (x + y) % 2 == 0 { 24 } else { 208 };
            *p = Rgb([v, v / 2, v / 3]);
        }
        canvas.save(&file).unwrap();

        let out = apply_to_file(
            &file,
            &WatermarkSettings {
                preset: WatermarkPreset::Gallery,
                size: 14.0,
            },
            92,
            Some(&exif_fixture()),
        )
        .expect("系统里应至少有一个兜底字体；没有时本用例给出可读错误");

        assert!(out, "有文案就必须真的加边框");
        let after = image::open(&file).unwrap().into_rgb8();
        // 真机口径：802×1200 → 802×1312（+112 底边）。
        assert_eq!(after.dimensions(), (802, 1312));

        // 照片本体仍在左上，没被抹黑。
        assert!(
            within(after.get_pixel(0, 0), [24, 12, 8], 10),
            "照片左上角像素被改动: {:?}",
            after.get_pixel(0, 0)
        );
        // 底边框是底色，不是照片内容的延伸。
        assert!(
            within(
                after.get_pixel(0, 1200),
                WatermarkPreset::Gallery.band_rgb(),
                3
            ),
            "边框起点像素不是底色: {:?}",
            after.get_pixel(0, 1200)
        );

        // 带内必须真的有墨 —— 否则「边框变宽了」可能只是底色延伸，
        // 字体静默失败会让这个用例假绿。
        let ink = WatermarkPreset::Gallery.ink_rgb();
        let inked_rows: Vec<u32> = (1200..1312u32)
            .filter(|y| (0..802u32).any(|x| within(after.get_pixel(x, *y), ink, 28)))
            .collect();
        assert!(
            !inked_rows.is_empty(),
            "边带内没有任何文字像素 —— 字体没画上东西（或者底色/字色撞了）"
        );

        // 文字在带内**居中**。只测纯函数 `band_top_gap` 是不够的：调用点换成
        // 顶对齐（`top_gap = margin`）时纯函数用例照样绿，而 149px 的带会
        // 退回 28/50 的上下留白 —— 这个回归只有量像素才拦得住。
        let top_gap = inked_rows[0] as i64 - 1200;
        let bottom_gap = 1311 - inked_rows[inked_rows.len() - 1] as i64;
        assert!(
            (top_gap - bottom_gap).abs() <= 6,
            "文字没在带内居中：上留白 {}、下留白 {}",
            top_gap,
            bottom_gap
        );

        // 同样的图，选的质量不同体积必须不同：写死 100 会让这一对撞上。
        canvas.save(&file).unwrap();
        apply_to_file(
            &file,
            &WatermarkSettings {
                preset: WatermarkPreset::Gallery,
                size: 14.0,
            },
            50,
            Some(&exif_fixture()),
        )
        .unwrap();
        let small = std::fs::metadata(&file).unwrap().len();
        apply_to_file(
            &file,
            &WatermarkSettings {
                preset: WatermarkPreset::Gallery,
                size: 14.0,
            },
            100,
            Some(&exif_fixture()),
        )
        .unwrap();
        let big = std::fs::metadata(&file).unwrap().len();
        assert!(
            small < big,
            "质量没有传进编码器：q50 得 {}B、q100 却 {}B",
            small,
            big
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_requested_quality_reaches_the_encoder() {
        use image::{Rgb, RgbImage};

        // 棋盘噪声：纯色图各质量的 JPEG 体积可能撞在一起，噪声才有区分度。
        let mut canvas = RgbImage::new(200, 200);
        for (x, y, p) in canvas.enumerate_pixels_mut() {
            let v = if (x + y) % 2 == 0 { 20 } else { 220 };
            *p = Rgb([v, v, v]);
        }
        let low = jpeg_bytes(&canvas, 50).unwrap();
        let mid = jpeg_bytes(&canvas, 92).unwrap();
        let high = jpeg_bytes(&canvas, 100).unwrap();
        // 质量与体积同向：写成默认 100 会让 mid 长得跟 high 一样。
        assert!(
            low.len() < mid.len() && mid.len() < high.len(),
            "质量没有真的传进编码器: 50→{}B, 92→{}B, 100→{}B",
            low.len(),
            mid.len(),
            high.len()
        );
    }

    #[test]
    fn apply_to_file_leaves_the_file_alone_without_exif() {
        use image::{Rgb, RgbImage};

        let dir = scratch("noexif");
        let file = dir.join("t.jpg");
        RgbImage::from_pixel(400, 300, Rgb([1, 2, 3]))
            .save(&file)
            .unwrap();
        let before = std::fs::read(&file).unwrap();

        let out = apply_to_file(
            &file,
            &WatermarkSettings {
                preset: WatermarkPreset::Noir,
                size: 20.0,
            },
            92,
            None,
        )
        .unwrap();
        assert!(!out, "没有文案时不该动文件");
        assert_eq!(std::fs::read(&file).unwrap(), before);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_to_file_rejects_a_nonexistent_file() {
        let dir = scratch("missing");
        let out = apply_to_file(
            &dir.join("nope.jpg"),
            &WatermarkSettings {
                preset: WatermarkPreset::Sage,
                size: 14.0,
            },
            92,
            Some(&exif_fixture()),
        );
        // 有文案 + 字体在，才会走到读图；读不到要报错而不是静默返回 false。
        assert!(out.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
