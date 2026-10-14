//! EXIF / XMP 元数据读取。
//!
//! 与目录遍历分开：本模块只回答「一张照片有什么元数据」，
//! 不关心它从哪个目录来。

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use crate::models::ExifData;

/// Read EXIF metadata from an image file
pub fn read_exif_metadata(file_path: &Path) -> Option<ExifData> {
    let file = File::open(file_path).ok()?;
    let mut bufreader = BufReader::new(file);
    let exifreader = exif::Reader::new();
    let exif = exifreader.read_from_container(&mut bufreader).ok()?;

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
