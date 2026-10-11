use std::collections::HashMap;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::Path;

use crate::models::{
    ExifData, FolderScanResult, PhotoFileInfo, PhotoGroupInfo, PhotoGroupStatus, ToneAdjustments,
};
use crate::xmp::{check_sidecar_exists, flag_from_xmp, get_xmp_path, read_xmp_full, XmpMetadata};

const RAW_EXTENSIONS: &[&str] = &[
    "arw", "cr2", "cr3", "nef", "dng", "orf", "rw2", "raf", "pef", "sr2", "srf", "x3f",
];
const JPG_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];

fn find_edited_version(base_dir: &Path, stem: &str) -> Option<PhotoFileInfo> {
    let candidates = [
        format!("{}_Luminar.tif", stem),
        format!("{}_Luminar.jpg", stem),
        format!("{}_Luminar.jpeg", stem),
        format!("{}_Luminar.tiff", stem),
        format!("{}_edit.tif", stem),
        format!("{}_edit.jpg", stem),
        format!("{}_edit.jpeg", stem),
        format!("{}_edit.tiff", stem),
    ];
    for filename in candidates {
        let p = base_dir.join(&filename);
        if p.is_file() {
            let metadata = p.metadata().ok();
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = metadata
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("jpg")
                .to_lowercase();
            return Some(PhotoFileInfo {
                name: filename,
                extension: ext,
                path: p.to_string_lossy().to_string(),
                size,
                mtime,
            });
        }
    }
    None
}

fn extract_tone_from_xmp(meta: &XmpMetadata) -> Option<ToneAdjustments> {
    if meta.exposure.is_some()
        || meta.highlights.is_some()
        || meta.shadows.is_some()
        || meta.temperature.is_some()
        || meta.tint.is_some()
        || meta.contrast.is_some()
    {
        Some(ToneAdjustments {
            exposure: meta.exposure.unwrap_or(0.0),
            highlights: meta.highlights.unwrap_or(0.0),
            shadows: meta.shadows.unwrap_or(0.0),
            temperature: meta.temperature.unwrap_or(0.0),
            tint: meta.tint.unwrap_or(0.0),
            contrast: meta.contrast.unwrap_or(0.0),
        })
    } else {
        None
    }
}

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
        data.date_time = Some(
            field
                .display_value()
                .to_string()
                .trim_matches('"')
                .to_string(),
        );
    } else if let Some(field) = exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY) {
        data.date_time = Some(
            field
                .display_value()
                .to_string()
                .trim_matches('"')
                .to_string(),
        );
    }

    // Camera Make & Model
    if let Some(field) = exif.get_field(exif::Tag::Make, exif::In::PRIMARY) {
        data.camera_make = Some(
            field
                .display_value()
                .to_string()
                .trim_matches('"')
                .trim()
                .to_string(),
        );
    }
    if let Some(field) = exif.get_field(exif::Tag::Model, exif::In::PRIMARY) {
        data.camera_model = Some(
            field
                .display_value()
                .to_string()
                .trim_matches('"')
                .trim()
                .to_string(),
        );
    }

    // Lens Model
    if let Some(field) = exif.get_field(exif::Tag::LensModel, exif::In::PRIMARY) {
        data.lens_model = Some(
            field
                .display_value()
                .to_string()
                .trim_matches('"')
                .trim()
                .to_string(),
        );
    }

    // Orientation (1..=8)
    if let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        if let Some(val) = field.value.get_uint(0) {
            data.orientation = Some(val);
        }
    }

    Some(data)
}

/// Scan a directory and collect file info
fn scan_directory(dir_path: &Path, allowed_exts: &[&str]) -> HashMap<String, PhotoFileInfo> {
    let mut map = HashMap::new();
    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();
                if allowed_exts.contains(&ext_lower.as_str()) {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        let name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string();
                        let metadata = entry.metadata().ok();
                        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                        let mtime = metadata
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);

                        let info = PhotoFileInfo {
                            name,
                            extension: ext_lower,
                            path: path.to_string_lossy().to_string(),
                            size,
                            mtime,
                        };
                        map.insert(stem.to_lowercase(), info);
                    }
                }
            }
        }
    }
    map
}

/// Scan JPG and optional RAW folder and assemble pairs
pub fn scan_folders(
    jpg_folder: &str,
    raw_folder: Option<&str>,
    sort_order: &str,
) -> Result<FolderScanResult, String> {
    let jpg_path = Path::new(jpg_folder);
    if !jpg_path.is_dir() {
        return Err(format!("JPG 文件夹不存在或不是有效目录: {}", jpg_folder));
    }

    let is_viewer_mode =
        raw_folder.is_none() || raw_folder.map(|s| s.trim().is_empty()).unwrap_or(true);
    let raw_path_buf = raw_folder.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(Path::new(trimmed))
        }
    });

    let jpg_files = scan_directory(jpg_path, JPG_EXTENSIONS);
    let raw_files = if let Some(p) = raw_path_buf {
        if p.is_dir() {
            scan_directory(p, RAW_EXTENSIONS)
        } else {
            HashMap::new()
        }
    } else {
        HashMap::new()
    };

    fn merge_xmp_metadata_into_exif(exif: &mut Option<ExifData>, xmp_meta: &XmpMetadata) {
        if let Some(e) = exif.as_mut() {
            if xmp_meta.lens_model.is_some() {
                e.lens_model = xmp_meta.lens_model.clone();
            }
            if xmp_meta.focal_length.is_some() {
                e.focal_length = xmp_meta.focal_length.clone();
            }
            if xmp_meta.aperture.is_some() {
                e.aperture = xmp_meta.aperture.clone();
            }
        } else if xmp_meta.lens_model.is_some()
            || xmp_meta.focal_length.is_some()
            || xmp_meta.aperture.is_some()
        {
            *exif = Some(ExifData {
                lens_model: xmp_meta.lens_model.clone(),
                focal_length: xmp_meta.focal_length.clone(),
                aperture: xmp_meta.aperture.clone(),
                ..Default::default()
            });
        }
    }

    let mut groups: Vec<PhotoGroupInfo> = Vec::new();

    if is_viewer_mode || raw_files.is_empty() {
        // Viewer mode: only JPG files
        for (stem_lower, jpg_info) in jpg_files {
            let path_obj = Path::new(&jpg_info.path);
            let has_xmp = check_sidecar_exists(path_obj);
            let xmp_meta = if has_xmp {
                let xmp_path = get_xmp_path(path_obj);
                read_xmp_full(&xmp_path)
            } else {
                None
            };

            let (rating, flag) = if let Some(m) = &xmp_meta {
                (m.rating, flag_from_xmp(m))
            } else {
                (0, "none".to_string())
            };

            let mut exif = read_exif_metadata(path_obj);
            if let Some(m) = &xmp_meta {
                merge_xmp_metadata_into_exif(&mut exif, m);
            }
            let base_name = path_obj
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&stem_lower)
                .to_string();

            let tone = xmp_meta.as_ref().and_then(extract_tone_from_xmp);
            let edited = path_obj
                .parent()
                .and_then(|p| find_edited_version(p, &base_name));

            groups.push(PhotoGroupInfo {
                id: base_name.clone(),
                base_name,
                jpg: Some(jpg_info),
                raw: None,
                edited,
                tone,
                status: PhotoGroupStatus::JpgOnly,
                rating,
                flag,
                has_xmp,
                exif,
                thumbnail_path: None,
            });
        }
    } else {
        // Pairing mode: match JPG and RAW by stem
        let mut all_stems: Vec<String> = jpg_files.keys().cloned().collect();
        for k in raw_files.keys() {
            if !all_stems.contains(k) {
                all_stems.push(k.clone());
            }
        }

        for stem_lower in all_stems {
            let jpg_opt = jpg_files.get(&stem_lower).cloned();
            let raw_opt = raw_files.get(&stem_lower).cloned();

            let status = match (&jpg_opt, &raw_opt) {
                (Some(_), Some(_)) => PhotoGroupStatus::Complete,
                (Some(_), None) => PhotoGroupStatus::JpgOnly,
                (None, Some(_)) => PhotoGroupStatus::RawOnly,
                (None, None) => continue,
            };

            // Detect XMP from RAW first, then JPG
            let mut has_xmp = false;
            let mut rating = 0u8;
            let mut flag = "none".to_string();
            let mut xmp_meta: Option<XmpMetadata> = None;

            if let Some(raw) = &raw_opt {
                let raw_p = Path::new(&raw.path);
                if check_sidecar_exists(raw_p) {
                    has_xmp = true;
                    let xmp_path = get_xmp_path(raw_p);
                    if let Some(m) = read_xmp_full(&xmp_path) {
                        rating = m.rating;
                        // 统一映射（Rating=-1 / Label 约定见 xmp::flag_from_xmp）
                        flag = flag_from_xmp(&m);
                        xmp_meta = Some(m);
                    }
                }
            } else if let Some(jpg) = &jpg_opt {
                let jpg_p = Path::new(&jpg.path);
                if check_sidecar_exists(jpg_p) {
                    has_xmp = true;
                    let xmp_path = get_xmp_path(jpg_p);
                    if let Some(m) = read_xmp_full(&xmp_path) {
                        rating = m.rating;
                        // 统一映射（Rating=-1 / Label 约定见 xmp::flag_from_xmp）
                        flag = flag_from_xmp(&m);
                        xmp_meta = Some(m);
                    }
                }
            }

            // Read EXIF: prefer JPG (faster to read header), fallback to RAW
            let mut exif = if let Some(jpg) = &jpg_opt {
                read_exif_metadata(Path::new(&jpg.path))
            } else if let Some(raw) = &raw_opt {
                read_exif_metadata(Path::new(&raw.path))
            } else {
                None
            };
            if let Some(m) = &xmp_meta {
                merge_xmp_metadata_into_exif(&mut exif, m);
            }

            let base_name = jpg_opt
                .as_ref()
                .map(|j| {
                    Path::new(&j.path)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or(&stem_lower)
                        .to_string()
                })
                .or_else(|| {
                    raw_opt.as_ref().map(|r| {
                        Path::new(&r.path)
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or(&stem_lower)
                            .to_string()
                    })
                })
                .unwrap_or_else(|| stem_lower.clone());

            let tone = xmp_meta.as_ref().and_then(extract_tone_from_xmp);
            let edited = jpg_opt
                .as_ref()
                .and_then(|j| Path::new(&j.path).parent())
                .or_else(|| raw_opt.as_ref().and_then(|r| Path::new(&r.path).parent()))
                .and_then(|p| find_edited_version(p, &base_name));

            groups.push(PhotoGroupInfo {
                id: base_name.clone(),
                base_name,
                jpg: jpg_opt,
                raw: raw_opt,
                edited,
                tone,
                status,
                rating,
                flag,
                has_xmp,
                exif,
                thumbnail_path: None,
            });
        }
    }

    // Sort groups
    match sort_order {
        "filename" => {
            groups.sort_by(|a, b| a.base_name.to_lowercase().cmp(&b.base_name.to_lowercase()));
        }
        "rating" => {
            groups.sort_by(|a, b| {
                b.rating
                    .cmp(&a.rating)
                    .then_with(|| a.base_name.to_lowercase().cmp(&b.base_name.to_lowercase()))
            });
        }
        _ => {
            // "time_filename" default: sort by capture time if available, or mtime, then base_name
            groups.sort_by(|a, b| {
                let time_a = a
                    .exif
                    .as_ref()
                    .and_then(|e| e.date_time.as_ref())
                    .cloned()
                    .unwrap_or_else(|| {
                        a.jpg
                            .as_ref()
                            .map(|j| j.mtime.to_string())
                            .unwrap_or_default()
                    });
                let time_b = b
                    .exif
                    .as_ref()
                    .and_then(|e| e.date_time.as_ref())
                    .cloned()
                    .unwrap_or_else(|| {
                        b.jpg
                            .as_ref()
                            .map(|j| j.mtime.to_string())
                            .unwrap_or_default()
                    });

                time_a
                    .cmp(&time_b)
                    .then_with(|| a.base_name.to_lowercase().cmp(&b.base_name.to_lowercase()))
            });
        }
    }

    let total_count = groups.len();
    Ok(FolderScanResult {
        groups,
        total_count,
        jpg_folder: jpg_folder.to_string(),
        raw_folder: raw_folder.unwrap_or("").to_string(),
        is_viewer_mode,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_empty_directory() {
        let temp_dir = std::env::temp_dir();
        let res = scan_folders(temp_dir.to_str().unwrap(), None, "filename");
        assert!(res.is_ok());
    }
}
