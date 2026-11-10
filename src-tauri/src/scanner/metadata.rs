//! EXIF / XMP 元数据读取。
//!
//! 与目录遍历分开：本模块只回答「一张照片有什么元数据」，
//! 不关心它从哪个目录来。

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::models::ExifData;

/// 按「**配对 JPG 优先、主路径兜底**」读一组照片的 EXIF。
///
/// 这个顺序是 ADR-010 修订后全项目唯一的读法：JPG 是 1.5MB 而 RAW 是 25MB，
/// 实测读 EXIF 差 80 倍（0.14 ms/张 vs 11.1 ms/张）。扫描路径（`scanner.rs`）
/// 与选片集（`album::resolve_documents`）早就统一到这一顺序，水印没有理由
/// 另立一套。
///
/// 两条路径都读不出来才返回 `None` —— **不编空壳**。调用方要能区分
/// 「没参数」与「文件读不出」。
pub fn read_exif_preferring_jpg(jpg: Option<&Path>, raw: Option<&Path>) -> Option<ExifData> {
    if let Some(j) = jpg {
        if let Some(data) = read_exif_metadata(j) {
            return Some(data);
        }
    }
    raw.and_then(read_exif_metadata)
}

/// 底层入口：打开照片并解析 EXIF 容器（issue #144 所称 open_reader）。
///
/// 三处读法共享这一步：EXIF 字段（`read_exif_metadata`）、水印顺序
/// （`read_exif_preferring_jpg`）、缩略图（`thumbnail.rs` 的方向角与内嵌
/// 缩略图）。只负责「打开 + 解析」，不关心字段语义 —— 缩略图要 IFD1 偏移、
/// 方向角要单个 tag，语义不同，不得并主函数。
pub fn open_exif_reader(file_path: &Path) -> Option<exif::Exif> {
    let file = File::open(file_path).ok()?;
    let mut bufreader = BufReader::new(file);
    exif::Reader::new().read_from_container(&mut bufreader).ok()
}

/// Read EXIF metadata from an image file
pub fn read_exif_metadata(file_path: &Path) -> Option<ExifData> {
    let exif = open_exif_reader(file_path)?;

    let mut data = ExifData::default();

    // Shutter speed
    if let Some(field) = exif.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY) {
        if let exif::Value::Rational(ref vals) = field.value {
            if let Some(val) = vals.first() {
                if val.denom != 0 {
                    let sec = val.num as f64 / val.denom as f64;
                    if sec >= 1.0 {
                        data.shutter_speed = Some(format!("{:.1}s", sec));
                    } else {
                        let denom = (val.denom as f64 / val.num as f64).round() as u32;
                        data.shutter_speed = Some(format!("1/{}", denom));
                    }
                }
            }
        }
    }

    // Aperture
    if let Some(field) = exif.get_field(exif::Tag::FNumber, exif::In::PRIMARY) {
        if let exif::Value::Rational(ref vals) = field.value {
            if let Some(val) = vals.first() {
                if val.denom != 0 {
                    let f = val.num as f64 / val.denom as f64;
                    data.aperture = Some(format!("f/{:.1}", f));
                }
            }
        }
    }

    // ISO
    if let Some(field) = exif.get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY) {
        data.iso = Some(field.display_value().to_string());
    }

    // Focal length
    if let Some(field) = exif.get_field(exif::Tag::FocalLength, exif::In::PRIMARY) {
        if let exif::Value::Rational(ref vals) = field.value {
            if let Some(val) = vals.first() {
                if val.denom != 0 {
                    let fl = val.num as f64 / val.denom as f64;
                    data.focal_length = Some(format!("{:.0}mm", fl));
                }
            }
        }
    }

    // Capture Date / Time
    if let Some(field) = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
        data.date_time = Some(exif_clean(field));
    } else if let Some(field) = exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
        data.date_time = Some(exif_clean(field));
    }

    // Camera Make & Model
    if let Some(field) = exif.get_field(exif::Tag::Make, exif::In::PRIMARY) {
        data.camera_make = Some(exif_clean(field));
    }
    if let Some(field) = exif.get_field(exif::Tag::Model, exif::In::PRIMARY) {
        data.camera_model = Some(exif_clean(field));
    }

    // Lens Model
    if let Some(field) = exif.get_field(exif::Tag::LensModel, exif::In::PRIMARY) {
        data.lens_model = Some(exif_clean(field));
    }

    // Orientation (1..=8)
    if let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        if let Some(val) = field.value.get_uint(0) {
            data.orientation = Some(val);
        }
    }

    Some(data)
}

/// EXIF 字段取文本值：剥掉 kam 引号再 trim 空白。
///
/// `exif` crate 的 `display_value()` 对字符串字段会返回带引号的形式
/// (`"Canon"`，而 Make/Model/LensModel 常常还在引号前后留空格)。这五处
/// 清洗逻辑逐字重复，抽出来只为让「什么样的值算干净」有一处定义。
fn exif_clean(field: &exif::Field) -> String {
    field
        .display_value()
        .to_string()
        .trim_matches('"')
        .trim()
        .to_string()
}

/// 测试夹具：带单个 `Make` 条目的最小 TIFF/EXIF 容器（little-endian）。
///
/// 只服务 issue #144 的回落/优先用例 —— 断言「读没读到、从哪条路径读到」，
/// 不关心字段值本身，故一个 ASCII tag 足够。`Make` ≤3 字符可内联（≤4 字节），
/// 免掉偏移计算。
#[cfg(test)]
pub(crate) fn exif_test_blob(make: &str) -> Vec<u8> {
    assert!(make.len() <= 3, "Make 须 ≤3 字符才能内联");
    let mut v = Vec::new();
    v.extend_from_slice(b"II"); // little-endian
    v.extend_from_slice(&42u16.to_le_bytes()); // TIFF magic
    v.extend_from_slice(&8u32.to_le_bytes()); // IFD0 紧跟 8 字节头
    v.extend_from_slice(&1u16.to_le_bytes()); // 1 条目
    v.extend_from_slice(&0x010Fu16.to_le_bytes()); // Make
    v.extend_from_slice(&2u16.to_le_bytes()); // ASCII
    v.extend_from_slice(&(make.len() as u32 + 1).to_le_bytes()); // 含 NUL
    let mut val = [0u8; 4];
    val[..make.len()].copy_from_slice(make.as_bytes());
    v.extend_from_slice(&val); // 内联值（补 0 即 NUL 结尾）
    v.extend_from_slice(&0u32.to_le_bytes()); // 下一 IFD = 0
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gallery_exif_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 裁决的契约：坏 JPG + 好 RAW → 回落 RAW（issue #144）。
    #[test]
    fn helper_falls_back_to_raw_when_jpg_corrupt() {
        let dir = scratch("fb");
        let jpg = dir.join("p.jpg");
        let raw = dir.join("p.ARW");
        std::fs::write(&jpg, b"this is not an image").unwrap();
        std::fs::write(&raw, exif_test_blob("RAW")).unwrap();

        let got = read_exif_preferring_jpg(Some(&jpg), Some(&raw))
            .expect("坏 JPG 必须回落 RAW，不该拿到 None");
        assert_eq!(got.camera_make.as_deref(), Some("RAW"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 好 JPG 在场时不读 RAW —— 0.14ms vs 11ms 的顺序契约。
    #[test]
    fn helper_prefers_jpg_when_both_readable() {
        let dir = scratch("pref");
        let jpg = dir.join("p.jpg");
        let raw = dir.join("p.ARW");
        std::fs::write(&jpg, exif_test_blob("JPG")).unwrap();
        std::fs::write(&raw, exif_test_blob("RAW")).unwrap();

        let got = read_exif_preferring_jpg(Some(&jpg), Some(&raw)).unwrap();
        assert_eq!(got.camera_make.as_deref(), Some("JPG"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两路都读不出才 None —— 不编空壳。
    #[test]
    fn helper_returns_none_when_nothing_readable() {
        let dir = scratch("none");
        let jpg = dir.join("p.jpg"); // 不存在
        let raw = dir.join("p.ARW"); // 不存在
        assert!(
            read_exif_preferring_jpg(Some(&jpg), Some(&raw)).is_none(),
            "两路都在盘上缺失时必须 None"
        );
        assert!(read_exif_preferring_jpg(None, None).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
