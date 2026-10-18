use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

mod metadata;
pub use metadata::read_exif_metadata;

#[cfg(test)]
mod real_smoke;

use crate::cullstore::{self, Entry, Store};
use crate::models::{
    ExifData, FolderScanResult, PhotoFileInfo, PhotoGroupInfo, PhotoGroupStatus, ToneAdjustments,
    TASK_CANCELLED,
};
use crate::xmp::{
    check_sidecar_exists, flag_from_xmp, get_xmp_path, legacy_flag_from_label, read_xmp_full,
    XmpMetadata,
};

/// 旗标存储的查表顺序：RAW 文件夹优先，JPG 兜底。
///
/// 与侧边栏读取顺序一致，也与 `groupPath`（写盘优先 RAW）一致 —— 三者不一致
/// 就会出现「写进去读不出来」。
fn store_entry<'a>(
    raw_store: &'a Store,
    jpg_store: &'a Store,
    base_name: &str,
) -> Option<&'a Entry> {
    raw_store
        .get(base_name)
        .or_else(|| jpg_store.get(base_name))
}

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
            let mtime = secs_from_meta(metadata.as_ref());
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

/// 取已取到的 metadata 里的 mtime 秒数（缺省 0）。
///
/// 两处调用点都**已经**持有 `metadata`（为了同时拿 `len()`），所以这里收
/// `Option<&Metadata>` 而不是路径 —— 免得为了取时间戳再 stat 一次。
///
/// 缺省取 0 而非别的值：mtime 在本文件里只用于「同一目录内排序的次级键」，
/// 0 表示"没有时间信息"，与真实的 epoch 0 在排序上等价。
/// 注意 `db::file_mtime_secs` 用的是 **-1** 缺省且语义不同（那边判 `> 0`），
/// 两者不可合并。
fn secs_from_meta(metadata: Option<&std::fs::Metadata>) -> u64 {
    metadata
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 求 JPG / RAW 词干并集。
///
/// 旧实现用 `Vec::contains` 逐个查重 → **O(J×R)**（1 万 JPG × 1 万 RAW ≈ 10⁸ 次
/// 字符串比较，是"万张秒级加载"的正面威胁）。改用 HashSet 后降为 O(J+R)。
///
/// 并集**顺序不影响结果**：分组最终顺序由末尾的排序阶段统一决定，且所有排序
/// 比较器在键相等时都会用 `base_name` 兜底（词干唯一 → 全序严格 → 与输入顺序无关）。
fn union_stems(
    jpg_files: &HashMap<String, PhotoFileInfo>,
    raw_files: &HashMap<String, PhotoFileInfo>,
) -> Vec<String> {
    let mut seen: HashSet<&str> = jpg_files.keys().map(|s| s.as_str()).collect();
    for k in raw_files.keys() {
        seen.insert(k.as_str());
    }
    seen.into_iter().map(|s| s.to_string()).collect()
}

/// Scan a directory and collect file info.
///
/// `cancel` 是协作式取消标志：枚举循环内每个 entry 前检查一次，置位即提前收工
/// （返回部分结果；上层会在枚举后立即检查标志并短路为取消）。
fn scan_directory(
    dir_path: &Path,
    allowed_exts: &[&str],
    cancel: &AtomicBool,
) -> HashMap<String, PhotoFileInfo> {
    let mut map = HashMap::new();
    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            // 取消检查点：枚举阶段（每处理一个 entry）
            if cancel.load(Ordering::Relaxed) {
                break;
            }
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
                        let mtime = secs_from_meta(metadata.as_ref());

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

/// Scan JPG and optional RAW folder and assemble pairs.
///
/// - `cancel`：协作式取消标志。检查点位于：枚举循环内、逐组主循环每次迭代开头、
///   排序之前。**绝不在 `sort_by` 比较器内检查**——比较器会被调用 O(n log n) 次
///   且必须满足全序，在里面读 atomic 会导致排序不稳定/逻辑错乱。
/// - `report`：进度回调 `(phase, processed, total)`。phase ∈
///   `"read"`（逐组读 EXIF/XMP/精修探测）、`"sort"`（进入排序）。是否节流由调用方决定。
///
/// 取消时返回 `Err(TASK_CANCELLED)`，前端据该文案区分「取消」与「失败」。
pub fn scan_folders(
    jpg_folder: &str,
    raw_folder: Option<&str>,
    sort_order: &str,
    cancel: &AtomicBool,
    mut report: impl FnMut(&str, usize, usize),
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

    let jpg_files = scan_directory(jpg_path, JPG_EXTENSIONS, cancel);
    if cancel.load(Ordering::Relaxed) {
        return Err(TASK_CANCELLED.to_string());
    }
    let raw_files = if let Some(p) = raw_path_buf {
        if p.is_dir() {
            scan_directory(p, RAW_EXTENSIONS, cancel)
        } else {
            HashMap::new()
        }
    } else {
        HashMap::new()
    };
    if cancel.load(Ordering::Relaxed) {
        return Err(TASK_CANCELLED.to_string());
    }

    // 旗标存储：每个文件夹一份，整次扫描只读两次（不按组读）。
    // 缺失/损坏都返回空 store —— 一份坏文件绝不能把整个文件夹扫不出来。
    let jpg_store = cullstore::load(jpg_path);
    let raw_store = raw_path_buf.map(cullstore::load).unwrap_or_default();

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
        let viewer_total = jpg_files.len();
        report("read", 0, viewer_total);
        for (stem_lower, jpg_info) in jpg_files {
            // 取消检查点：逐组主循环每次迭代开头（此处是 EXIF/XMP 重 IO 所在）
            if cancel.load(Ordering::Relaxed) {
                return Err(TASK_CANCELLED.to_string());
            }
            let path_obj = Path::new(&jpg_info.path);
            let has_xmp = check_sidecar_exists(path_obj);
            let xmp_meta = if has_xmp {
                let xmp_path = get_xmp_path(path_obj);
                read_xmp_full(&xmp_path)
            } else {
                None
            };

            let base_name = path_obj
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&stem_lower)
                .to_string();

            // 评级来自 XMP；旗标以本地 store 为准，旧文件回落 `Label` 约定。
            // 注意「只有旗标、没有侧边栏」的照片：`xmp_meta` 为 None，也必须查 store，
            // 否则 pick 会在下次扫描时消失。
            let entry = store_entry(&raw_store, &jpg_store, &base_name);
            let (rating, flag) = match &xmp_meta {
                Some(m) => (
                    m.rating,
                    cullstore::resolve_flag(
                        m.rejected,
                        legacy_flag_from_label(&m.label),
                        entry,
                    ),
                ),
                None => (0, cullstore::resolve_flag(false, "none", entry)),
            };

            let mut exif = read_exif_metadata(path_obj);
            if let Some(m) = &xmp_meta {
                merge_xmp_metadata_into_exif(&mut exif, m);
            }

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
                // 色标与评级同源（XMP），无色标就是空串
                label: xmp_meta.as_ref().map(|m| m.label.clone()).unwrap_or_default(),
                has_xmp,
                exif,
                thumbnail_path: None,
            });
            report("read", groups.len(), viewer_total);
        }
    } else {
        // Pairing mode: match JPG and RAW by stem
        let all_stems = union_stems(&jpg_files, &raw_files);
        let pair_total = all_stems.len();
        report("read", 0, pair_total);

        for stem_lower in all_stems {
            // 取消检查点：逐组主循环每次迭代开头（EXIF/XMP 重 IO 所在）
            if cancel.load(Ordering::Relaxed) {
                return Err(TASK_CANCELLED.to_string());
            }
            let jpg_opt = jpg_files.get(&stem_lower).cloned();
            let raw_opt = raw_files.get(&stem_lower).cloned();

            let status = match (&jpg_opt, &raw_opt) {
                (Some(_), Some(_)) => PhotoGroupStatus::Complete,
                (Some(_), None) => PhotoGroupStatus::JpgOnly,
                (None, Some(_)) => PhotoGroupStatus::RawOnly,
                (None, None) => continue,
            };

            // Detect XMP from RAW first, then JPG
            //
            // 两条路径**各自独立判定**，不是 `if raw {} else if jpg {}`：
            // 配了 RAW 目录后 sidecar 可能仍只存在于 JPG 旁（历史评级就是这么写的），
            // 用 else 会把那份直接跳过，界面上表现为「配了 RAW 之后评的分全没了」。
            // RAW 侧优先，JPG 侧兜底；两边都没有就不动。
            let mut has_xmp = false;
            let mut rating = 0u8;
            let mut flag = "none".to_string();
            let mut xmp_meta: Option<XmpMetadata> = None;

            let read_sidecar_of = |path: &str, has_xmp: &mut bool, rating: &mut u8,
                                       flag: &mut String, xmp_meta: &mut Option<XmpMetadata>| {
                let p = Path::new(path);
                if !check_sidecar_exists(p) {
                    return;
                }
                *has_xmp = true;
                if let Some(m) = read_xmp_full(&get_xmp_path(p)) {
                    *rating = m.rating;
                    // 统一映射（Rating=-1 / Label 约定见 xmp::flag_from_xmp）
                    *flag = flag_from_xmp(&m);
                    *xmp_meta = Some(m);
                }
            };

            if let Some(raw) = &raw_opt {
                read_sidecar_of(&raw.path, &mut has_xmp, &mut rating, &mut flag, &mut xmp_meta);
            }
            // JPG 侧仅在 RAW 侧没读到时才作为兜底，避免 RAW 侧的值被覆盖
            if xmp_meta.is_none() {
                if let Some(jpg) = &jpg_opt {
                    read_sidecar_of(
                        &jpg.path,
                        &mut has_xmp,
                        &mut rating,
                        &mut flag,
                        &mut xmp_meta,
                    );
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

            // 旗标以本地 store 为准（旧文件回落 `Label` 约定）；`Rating=-1` 仍是
            // 硬信号，外部工具写的淘汰必须立刻生效。
            let flag = cullstore::resolve_flag(
                xmp_meta.as_ref().map(|m| m.rejected).unwrap_or(false),
                &flag,
                store_entry(&raw_store, &jpg_store, &base_name),
            );

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
                // RAW 侧边栏优先、JPG 兜底 —— 与评级/旗标同一条读取路径，
                // 不会出现「星级读 RAW、色标读 JPG」这种自相矛盾的组合。
                label: xmp_meta.as_ref().map(|m| m.label.clone()).unwrap_or_default(),
                has_xmp,
                exif,
                thumbnail_path: None,
            });
            report("read", groups.len(), pair_total);
        }
    }

    // Sort groups
    report("sort", groups.len(), groups.len());
    // 排序前的取消检查点（排序不产生 IO，此点仅避免"已经取消还白排"）
    if cancel.load(Ordering::Relaxed) {
        return Err(TASK_CANCELLED.to_string());
    }
    match sort_order {
        "filename" => {
            groups.sort_by_key(|g| g.base_name.to_lowercase());
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
        let no_cancel = AtomicBool::new(false);
        let res = scan_folders(
            temp_dir.to_str().unwrap(),
            None,
            "filename",
            &no_cancel,
            |_, _, _| {},
        );
        assert!(res.is_ok());
    }

    /// 造一个唯一临时子目录（进程 id + 纳秒时间戳）。
    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gallery_scan_test_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn info(name: &str) -> PhotoFileInfo {
        PhotoFileInfo {
            name: name.to_string(),
            extension: name.rsplit('.').next().unwrap_or("").to_string(),
            path: format!("/tmp/{}", name),
            size: 0,
            mtime: 0,
        }
    }

    /// N-11 回归护栏：新的 HashSet 并集必须与旧的 `Vec::contains` 逐项等价。
    /// 修复前若把 `union_stems` 回退成 Vec::contains 版，本用例仍会通过（两者等价），
    /// 它守护的是"重写配对逻辑时不得改变行为"，而不是性能本身。
    #[test]
    fn union_stems_matches_naive_vec_contains() {
        let jpg_keys = ["img_0001", "img_0002", "img_0004", "img_0005"];
        let raw_keys = ["img_0001", "img_0003", "img_0005", "img_0006"];

        let mut jpg_files: HashMap<String, PhotoFileInfo> = HashMap::new();
        for k in jpg_keys {
            jpg_files.insert(k.to_string(), info(&format!("{}.jpg", k)));
        }
        let mut raw_files: HashMap<String, PhotoFileInfo> = HashMap::new();
        for k in raw_keys {
            raw_files.insert(k.to_string(), info(&format!("{}.cr3", k)));
        }

        // 旧实现（逐项等价参照）
        let mut naive: Vec<String> = jpg_files.keys().cloned().collect();
        for k in raw_files.keys() {
            if !naive.contains(k) {
                naive.push(k.clone());
            }
        }

        let mut got = union_stems(&jpg_files, &raw_files);
        let mut want = naive;
        got.sort();
        want.sort();
        assert_eq!(got, want, "HashSet 并集必须与 Vec::contains 并集等价");

        // 且并集恰好覆盖两侧全部词干、无重复
        assert_eq!(got.len(), 6, "并集应为 6 个唯一词干");
        assert_eq!(got.iter().collect::<HashSet<_>>().len(), got.len(), "不得有重复");
    }

    /// 回归：一张照片同时有 JPG + RAW，而 sidecar **只存在于 JPG 旁**时，
    /// 星级/旗标必须仍被读到。
    ///
    /// 缺陷：XMP 解析写成 `if raw { … } else if jpg { … }`，配了 RAW 目录后
    /// JPG 旁的 sidecar 被**整个跳过**，用户此前在 JPG 侧打的分/旗标在界面上
    /// 一律变成「未打分」（e2e 实测：12 张里带 XMP 的 3 张配了 RAW 后全部丢分）。
    /// 注释本就写着 "Detect XMP from RAW first, then JPG"（意为回退），
    /// 紧接着的 EXIF 块用的也是带回退的写法。
    #[test]
    fn jpg_sidecar_is_read_even_when_a_raw_pair_exists() {
        let jpg_dir = unique_dir("xmp_jpg");
        let raw_dir = unique_dir("xmp_raw");

        fs::write(jpg_dir.join("A0001.jpg"), b"jpeg").unwrap();
        fs::write(raw_dir.join("A0001.ARW"), b"raw").unwrap();
        // sidecar 只写在 JPG 旁（RAW 旁没有）
        fs::write(
            jpg_dir.join("A0001.xmp"),
            "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
             <x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
             \x20 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
             \x20  <rdf:Description rdf:about=\"\"\n\
             \x20    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\n\
             \x20   <xmp:Rating>4</xmp:Rating>\n\
             \x20   <xmp:Label>Green</xmp:Label>\n\
             \x20  </rdf:Description>\n\
             \x20 </rdf:RDF>\n\
             </x:xmpmeta>\n",
        )
        .unwrap();
        assert!(
            !raw_dir.join("A0001.xmp").exists(),
            "前提：RAW 旁不应有 sidecar"
        );

        let cancel = AtomicBool::new(false);
        let res = scan_folders(
            jpg_dir.to_str().unwrap(),
            Some(raw_dir.to_str().unwrap()),
            "filename",
            &cancel,
            |_, _, _| {},
        )
        .expect("扫描应成功");

        let g = res
            .groups
            .iter()
            .find(|g| g.base_name == "A0001")
            .expect("应产出 A0001 组");
        assert_eq!(
            g.rating, 4,
            "配了 RAW 后 JPG 旁的星级被跳过（应为 4）"
        );
        assert_eq!(g.flag, "pick", "JPG 旁的 Label=Green 应读回 pick");
        assert!(g.has_xmp, "has_xmp 应为真");

        let _ = fs::remove_dir_all(&jpg_dir);
        let _ = fs::remove_dir_all(&raw_dir);
    }

    /// 写一份只含评级与色标的最小侧边栏（模拟旧版本 / Lightroom 写出的文件）。
    fn write_legacy_sidecar(dir: &Path, stem: &str, rating: &str, label: &str) {
        let body = format!(
            "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
             <x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
             \x20 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
             \x20  <rdf:Description rdf:about=\"\"\n\
             \x20    xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\">\n\
             \x20   <xmp:Rating>{}</xmp:Rating>\n\
             \x20   <xmp:Label>{}</xmp:Label>\n\
             \x20  </rdf:Description>\n\
             \x20 </rdf:RDF>\n\
             </x:xmpmeta>\n",
            rating, label
        );
        fs::write(dir.join(format!("{}.xmp", stem)), body).unwrap();
    }

    fn scan_one(dir: &Path) -> PhotoGroupInfo {
        let cancel = AtomicBool::new(false);
        let res = scan_folders(dir.to_str().unwrap(), None, "filename", &cancel, |_, _, _| {})
            .expect("扫描应成功");
        assert_eq!(res.groups.len(), 1, "前提：目录里只有一张照片");
        res.groups.into_iter().next().unwrap()
    }

    /// 旗标只存在本地 store、照片连侧边栏都没有时，也必须读回来。
    ///
    /// 这是 pick 从 `xmp:Label` 迁出后的核心保证：pick 不再产生 XMP 文件，
    /// 若扫描只看 XMP，用户按 P 之后重开应用就什么都没了。
    #[test]
    fn store_pick_survives_without_any_sidecar() {
        let dir = unique_dir("store_only");
        fs::write(dir.join("B0001.jpg"), b"jpeg").unwrap();
        cullstore::upsert(&dir, "B0001", "pick").expect("写旗标应成功");

        let g = scan_one(&dir);
        assert!(!g.has_xmp, "前提：这张照片没有侧边栏");
        assert_eq!(g.flag, "pick", "只有 store 时也必须读回 pick");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 本地条目 `none` 必须压住旧文件里的 `Label=Green`，且**不改写**那份文件。
    ///
    /// 旧实现只能靠「清空 Label」来清旗标 —— 那会删掉用户真正的色标。
    /// 现在清除表达为 store 里的 `none`，色标原样留在磁盘上。
    #[test]
    fn store_none_suppresses_legacy_green_label() {
        let dir = unique_dir("store_none");
        fs::write(dir.join("C0001.jpg"), b"jpeg").unwrap();
        write_legacy_sidecar(&dir, "C0001", "3", "Green");
        cullstore::upsert(&dir, "C0001", "none").expect("写 none 应成功");

        let g = scan_one(&dir);
        assert_eq!(g.flag, "none", "本地 none 必须压住旧的 Label=Green");
        assert_eq!(g.rating, 3, "评级仍来自 XMP");

        let sidecar = fs::read_to_string(dir.join("C0001.xmp")).unwrap();
        assert!(
            sidecar.contains("<xmp:Label>Green</xmp:Label>"),
            "扫描不得改写/删除用户的色标: {}",
            sidecar
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 色标必须随扫描带出：它读的就是 `xmp:Label`，与 Lightroom 双向可见。
    #[test]
    fn scan_reads_colour_label_from_sidecar() {
        let dir = unique_dir("label_read");
        fs::write(dir.join("E0001.jpg"), b"jpeg").unwrap();
        write_legacy_sidecar(&dir, "E0001", "2", "Blue");

        let g = scan_one(&dir);
        assert_eq!(g.label, "Blue", "色标应随扫描带出");
        assert_eq!(g.rating, 2, "评级不受影响");
        assert_eq!(g.flag, "none", "Blue 不属于旧 pick/reject 约定");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 没有侧边栏 = 无色标。必须是空串，不能是 `"None"`/`"null"` 之类的字符串，
    /// 否则前端色点会把"没有色标"渲染成一个灰点。
    #[test]
    fn scan_without_sidecar_has_empty_label() {
        let dir = unique_dir("label_empty");
        fs::write(dir.join("F0001.jpg"), b"jpeg").unwrap();

        let g = scan_one(&dir);
        assert_eq!(g.label, "", "无色标必须是空串");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 外部（Lightroom / LUMEN）写的 `Rating=-1` 是硬信号：不能被本地 pick 压住。
    #[test]
    fn rating_minus_one_beats_store_pick() {
        let dir = unique_dir("store_vs_reject");
        fs::write(dir.join("D0001.jpg"), b"jpeg").unwrap();
        write_legacy_sidecar(&dir, "D0001", "-1", "");
        cullstore::upsert(&dir, "D0001", "pick").expect("写 pick 应成功");

        let g = scan_one(&dir);
        assert_eq!(g.flag, "reject", "外部淘汰必须立刻生效");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 扫描主循环的取消检查点：预置取消标志 → 返回 Err(哨兵)，且不产出结果。
    #[test]
    fn scan_returns_cancelled_sentinel_when_flag_set() {
        let dir = unique_dir("cancel_read");
        fs::write(dir.join("IMG_0001.jpg"), b"jpeg").unwrap();
        fs::write(dir.join("IMG_0002.jpg"), b"jpeg").unwrap();

        let cancel = AtomicBool::new(true); // 一开始就置位
        let res = scan_folders(
            dir.to_str().unwrap(),
            None,
            "filename",
            &cancel,
            |_, _, _| {},
        );

        assert!(res.is_err(), "取消时必须返回 Err 以便前端区分取消与失败");
        assert_eq!(res.unwrap_err(), TASK_CANCELLED, "取消哨兵文案须精确匹配");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 未取消时正常返回，进度回调被调用且末次 processed == total。
    #[test]
    fn scan_reports_progress_and_completes() {
        let dir = unique_dir("progress_ok");
        fs::write(dir.join("IMG_0010.jpg"), b"jpeg").unwrap();
        fs::write(dir.join("IMG_0011.jpg"), b"jpeg").unwrap();

        let cancel = AtomicBool::new(false);
        let mut last = (String::new(), 0usize, 0usize);
        let res = scan_folders(
            dir.to_str().unwrap(),
            None,
            "filename",
            &cancel,
            |phase, processed, total| {
                last = (phase.to_string(), processed, total);
            },
        )
        .expect("未取消应成功");

        assert_eq!(res.total_count, 2);
        assert_eq!(last.1, 2, "末次 processed 应等于总数");
        assert_eq!(last.2, 2, "末次 total 应等于总数");

        let _ = fs::remove_dir_all(&dir);
    }

    /// N-11 基线测量①：1 万 × 1 万词干的并集，`Vec::contains`（旧）对比 `HashSet`（新）。
    /// 默认不跑（`cargo test --lib -- --ignored --nocapture` 才执行）。
    #[test]
    #[ignore = "基准测量：需要跑 --ignored 明确触发"]
    fn bench_union_10k_vec_contains_vs_hashset() {
        use std::time::Instant;
        const N: usize = 10_000;

        let jpg_keys: Vec<String> = (0..N).map(|i| format!("img_{:06}", i)).collect();
        let raw_keys: Vec<String> = (0..N).map(|i| format!("img_{:06}", i + N / 2)).collect();

        let t0 = Instant::now();
        let mut naive: Vec<String> = jpg_keys.clone();
        for k in &raw_keys {
            if !naive.contains(k) {
                naive.push(k.clone());
            }
        }
        let legacy = t0.elapsed();

        let mut jpg_files: HashMap<String, PhotoFileInfo> = HashMap::new();
        for k in &jpg_keys {
            jpg_files.insert(k.clone(), info(k));
        }
        let mut raw_files: HashMap<String, PhotoFileInfo> = HashMap::new();
        for k in &raw_keys {
            raw_files.insert(k.clone(), info(k));
        }
        let t1 = Instant::now();
        let fast = union_stems(&jpg_files, &raw_files);
        let new = t1.elapsed();

        assert_eq!(fast.len(), naive.len());
        println!(
            "[bench_union] Vec::contains = {:?} | HashSet = {:?} | 旧/新 = {:.1}x",
            legacy,
            new,
            legacy.as_secs_f64() / new.as_secs_f64().max(1e-9)
        );
    }

    /// N-11 基线测量②：合成 N 张假 JPG 的**串行**扫描耗时（用于判定是否值得上 rayon）。
    /// 默认不跑。
    #[test]
    #[ignore = "基准测量：需要跑 --ignored 明确触发"]
    fn bench_scan_baseline_serial() {
        use std::time::Instant;
        const N: usize = 1500;
        let dir = unique_dir("bench_scan");
        for i in 0..N {
            fs::write(dir.join(format!("IMG_{:05}.jpg", i)), b"FAKEJPEG").unwrap();
        }

        let cancel = AtomicBool::new(false);
        let t0 = Instant::now();
        let res = scan_folders(dir.to_str().unwrap(), None, "time_filename", &cancel, |_, _, _| {})
            .expect("扫描应成功");
        let elapsed = t0.elapsed();
        println!(
            "[bench_scan] N={} groups={} serial={:?} ({:.3} ms/张)",
            N,
            res.total_count,
            elapsed,
            elapsed.as_secs_f64() * 1000.0 / N as f64
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
