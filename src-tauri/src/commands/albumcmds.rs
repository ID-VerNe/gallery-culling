//! 选片集（`.galleryalbum`）的读写命令（FR-10）。
//!
//! 命令层只做三件事：参数校验（路径必须是绝对路径）、把输入转成
//! `album::AlbumDoc`、把结果整理成前端要的形状。格式与原子写都在
//! `crate::album` 里，那里是单一真值。

use std::path::Path;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::blocking;
use crate::album;

/// 保存时的一条输入：路径由前端给（扫描结果里的绝对路径）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumItemInput {
    /// 主路径（RAW 优先）。写 XMP、打开原片都以它为准。
    pub path: String,
    /// 配对 JPG。分目录摆放是常态，所以单独给一条而不是从前面的路径猜。
    #[serde(default)]
    pub jpg_path: Option<String>,
    #[serde(default)]
    pub rating: u8,
    #[serde(default)]
    pub flag: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSaveResult {
    pub path: String,
    pub saved: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumOpenResult {
    pub path: String,
    pub entries: Vec<album::ResolvedDoc>,
    /// 缺失张数（`entries` 里仍保留，UI 负责列出来）。
    pub missing: usize,
}

/// 把输入转成文档。相对路径直接拒绝 —— 相对「谁」是歧义的，
/// 前端手上永远有绝对路径（扫描结果），没有理由放宽。
pub fn build_documents(
    album_path: &Path,
    items: &[AlbumItemInput],
) -> Result<Vec<album::AlbumDoc>, String> {
    let mut pairs: Vec<album::AlbumEntryInput> = Vec::with_capacity(items.len());
    for it in items {
        let p = PathBuf::from(&it.path);
        if !p.is_absolute() {
            return Err(format!("选片集只接受绝对路径，收到: {}", it.path));
        }
        // 配对 JPG 与主路径同一条规矩：相对路径在这里就是错误数据，
        // 悄悄丢掉会让「打开后黑框」变成一个没有线索的谜。
        let jpg = match it.jpg_path.as_deref() {
            Some(s) if !s.trim().is_empty() => {
                let q = PathBuf::from(s);
                if !q.is_absolute() {
                    return Err(format!("选片集只接受绝对路径，收到: {s}"));
                }
                Some(q)
            }
            _ => None,
        };
        pairs.push(album::AlbumEntryInput {
            path: p,
            jpg,
            rating: it.rating,
            flag: it.flag.clone(),
            label: it.label.clone(),
        });
    }
    Ok(album::to_documents(album_path, &pairs))
}

pub(crate) fn save_album_impl(
    path: &str,
    items: &[AlbumItemInput],
) -> Result<AlbumSaveResult, String> {
    let target = PathBuf::from(path);
    if path.trim().is_empty() {
        return Err("未指定选片集路径".to_string());
    }
    let docs = build_documents(&target, items)?;
    album::write_album(&target, &docs)?;
    Ok(AlbumSaveResult {
        path: target.to_string_lossy().to_string(),
        saved: docs.len(),
    })
}

pub(crate) fn open_album_impl(path: &str) -> Result<AlbumOpenResult, String> {
    let target = PathBuf::from(path);
    if path.trim().is_empty() {
        return Err("未指定选片集路径".to_string());
    }
    let docs = album::read_album(&target)?;
    let mut entries = album::resolve_documents(&target, &docs);
    apply_disk_state(&mut entries);
    let missing = entries.iter().filter(|e| !e.exists).count();
    Ok(AlbumOpenResult {
        path: target.to_string_lossy().to_string(),
        entries,
        missing,
    })
}

/// 用**磁盘状态**覆盖存在的那些条目。
///
/// 为什么不用文件里记的快照：本应用的评级/旗标/色标唯一真值是 XMP +
/// `.gallerycull.json`（ADR-001/003）。显示 album 里的旧快照会让界面和文件
/// 互相矛盾 —— 用户看到 3 星、XMP 里是 1 星，接着改一次就把「3 星」当真。
///
/// 快照仍然有用：缺失的文件没有磁盘状态可读，保留快照才能报告「它原来是几星」。
/// 另外按目录缓存 `cullstore`，2000 张散在几个目录时不会重复读 JSON。
///
/// **刻意不读 EXIF**：实测 `exif` crate 对 ARW 是**整文件读取**（9.4 ms/张 ≈
/// 读 25 MB，156 张 1.5 s、2000 张 19 s，见 `real_album_open_smoke`）。选片集
/// 的验收标准是「相对路径 / 换机可开 / 缺失列出 / ≤2000 / 原子写」，不含相机
/// 参数；为它把打开时间拉长两个数量级不值得。
/// 代价（必须在界面上说出来，不能静默）：底栏不显示 ISO/快门，查询语法里的
/// `iso:` / `camera:` 等条件不会命中 —— 前端 `ThumbnailGrid` 的
/// `queryExifUnavailable` 会明确提示。要补的话见 ADR-010「后续」。
fn apply_disk_state(entries: &mut [album::ResolvedDoc]) {
    use std::collections::HashMap;
    let mut stores: HashMap<PathBuf, crate::cullstore::Store> = HashMap::new();

    for e in entries.iter_mut().filter(|e| e.exists) {
        let p = PathBuf::from(&e.path);
        let dir = p.parent().unwrap_or(Path::new(".")).to_path_buf();
        let store = stores.entry(dir.clone()).or_insert_with(|| crate::cullstore::load(&dir));
        let base = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let entry = store.get(&base);
        let xmp_path = crate::xmp::get_xmp_path(&p);
        // 侧边栏**存在**与**读得出**是两件事：`read_xmp_full` 对空文件/坏 XML
        // 也返回 None，但文件确实在，导出时的文件计数与宫格角标都按「在不在」算。
        e.has_xmp = xmp_path.is_file();

        match crate::xmp::read_xmp_full(&xmp_path) {
            Some(m) => {
                e.rating = m.rating;
                e.flag = crate::cullstore::resolve_flag(
                    m.rejected,
                    crate::xmp::legacy_flag_from_label(&m.label),
                    entry,
                );
                e.label = m.label.clone();
                // 调色基线必须一起带回来：面板显示全 0 时用户点保存就会把
                // 真实调色覆盖成 0。与扫描路径共用同一份提取逻辑。
                e.tone = crate::scanner::extract_tone_from_xmp(&m);
            }
            None => {
                e.rating = 0;
                e.flag = crate::cullstore::resolve_flag(false, "none", entry);
                e.label = String::new();
                e.tone = None;
            }
        }
    }
}

#[tauri::command]
pub async fn save_album_cmd(
    path: String,
    items: Vec<AlbumItemInput>,
) -> Result<AlbumSaveResult, String> {
    blocking("保存选片集任务异常", move || {
        save_album_impl(&path, &items)
    })
    .await
}

#[tauri::command]
pub async fn open_album_cmd(path: String) -> Result<AlbumOpenResult, String> {
    blocking("打开选片集任务异常", move || open_album_impl(&path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gallery_albumcmd_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn item(p: &Path, rating: u8, flag: &str, label: &str) -> AlbumItemInput {
        AlbumItemInput {
            path: p.to_string_lossy().to_string(),
            jpg_path: None,
            rating,
            flag: flag.to_string(),
            label: label.to_string(),
        }
    }

    fn pair(raw: &Path, jpg: &Path, rating: u8) -> AlbumItemInput {
        AlbumItemInput {
            path: raw.to_string_lossy().to_string(),
            jpg_path: Some(jpg.to_string_lossy().to_string()),
            rating,
            flag: "pick".to_string(),
            label: String::new(),
        }
    }

    #[test]
    fn save_then_open_round_trips() {
        let dir = scratch("rt");
        let album_path = dir.join("pick.galleryalbum");
        let photo = dir.join("a.ARW");
        std::fs::write(&photo, b"x").unwrap();

        let saved = save_album_impl(
            &album_path.to_string_lossy(),
            &[item(&photo, 5, "pick", "Red")],
        )
        .expect("保存应成功");
        assert_eq!(saved.saved, 1);

        // 文件里记的是**快照**（保存那一刻的状态）
        let snapshot = crate::album::read_album(&album_path).unwrap();
        assert_eq!(snapshot[0].rating, 5);
        assert_eq!(snapshot[0].flag, "pick");
        assert_eq!(snapshot[0].label, "Red");
        assert_eq!(snapshot[0].source, "a.ARW", "同子树必须存相对路径");

        // 打开时显示的是**磁盘状态**（没有 XMP → 0 / none / 空）
        let opened = open_album_impl(&album_path.to_string_lossy()).expect("打开应成功");
        assert_eq!(opened.entries.len(), 1);
        assert!(opened.entries[0].exists);
        assert_eq!(opened.entries[0].rating, 0, "磁盘没有评级就该是 0");
        assert_eq!(opened.entries[0].flag, "none");
        assert_eq!(opened.entries[0].label, "");
        assert_eq!(opened.missing, 0);
        assert!(opened.entries[0].size > 0, "存在的文件必须带上 size");
    }

    #[test]
    fn open_prefers_disk_state_over_snapshot() {
        let dir = scratch("disk");
        let album_path = dir.join("a.galleryalbum");
        let photo = dir.join("b.ARW");
        std::fs::write(&photo, b"x").unwrap();
        // 磁盘上真实状态：4 星 + 蓝标；album 里记的是 1 星 + 无标
        crate::xmp::write_xmp(&photo, 4, "none", Some("Blue")).unwrap();

        save_album_impl(
            &album_path.to_string_lossy(),
            &[item(&photo, 1, "pick", "")],
        )
        .unwrap();

        let opened = open_album_impl(&album_path.to_string_lossy()).unwrap();
        assert_eq!(opened.entries[0].rating, 4, "显示必须以 XMP 为准");
        assert_eq!(opened.entries[0].label, "Blue");
    }

    #[test]
    fn missing_entries_keep_their_snapshot() {
        let dir = scratch("snapshot");
        let album_path = dir.join("a.galleryalbum");
        let gone = dir.join("gone.ARW");
        save_album_impl(
            &album_path.to_string_lossy(),
            &[item(&gone, 3, "pick", "Green")],
        )
        .unwrap();

        let opened = open_album_impl(&album_path.to_string_lossy()).unwrap();
        assert!(!opened.entries[0].exists);
        // 没有磁盘可读 → 报告里还能说「它原来是 3 星 / 已标」
        assert_eq!(opened.entries[0].rating, 3);
        assert_eq!(opened.entries[0].flag, "pick");
        assert_eq!(opened.entries[0].label, "Green");
    }

    #[test]
    fn open_counts_missing_but_keeps_them() {
        let dir = scratch("missing");
        let album_path = dir.join("a.galleryalbum");
        let here = dir.join("here.ARW");
        std::fs::write(&here, b"x").unwrap();
        let gone = dir.join("gone.ARW");
        save_album_impl(
            &album_path.to_string_lossy(),
            &[item(&here, 1, "pick", ""), item(&gone, 0, "none", "")],
        )
        .unwrap();

        let opened = open_album_impl(&album_path.to_string_lossy()).unwrap();
        assert_eq!(opened.entries.len(), 2, "缺失项也要列出来");
        assert_eq!(opened.missing, 1);
    }

    #[test]
    fn relative_input_path_is_rejected() {
        let dir = scratch("rel");
        let album_path = dir.join("a.galleryalbum");
        let err = save_album_impl(
            &album_path.to_string_lossy(),
            &[AlbumItemInput {
                path: "a.ARW".to_string(),
                jpg_path: None,
                rating: 0,
                flag: "none".to_string(),
                label: String::new(),
            }],
        )
        .expect_err("相对路径必须拒绝");
        assert!(err.contains("只接受绝对路径"), "实际: {err}");
    }

    #[test]
    fn relative_paired_jpg_is_rejected_too() {
        let dir = scratch("reljpg");
        let album_path = dir.join("a.galleryalbum");
        let raw = dir.join("a.ARW");
        std::fs::write(&raw, b"x").unwrap();
        let err = save_album_impl(
            &album_path.to_string_lossy(),
            &[AlbumItemInput {
                path: raw.to_string_lossy().to_string(),
                jpg_path: Some("a.JPG".to_string()),
                rating: 0,
                flag: "none".to_string(),
                label: String::new(),
            }],
        )
        .expect_err("配对 JPG 的相对路径同样必须拒绝");
        assert!(err.contains("只接受绝对路径"), "实际: {err}");
    }

    #[test]
    fn reopened_album_keeps_the_jpg_pairing() {
        let dir = scratch("pairing");
        let album_path = dir.join("a.galleryalbum");
        // JPG / RAW 分目录：本应用的常规摆放
        let raw_dir = dir.join("raw");
        let jpg_dir = dir.join("jpg");
        std::fs::create_dir_all(&raw_dir).unwrap();
        std::fs::create_dir_all(&jpg_dir).unwrap();
        let raw = raw_dir.join("DSC1.ARW");
        let jpg = jpg_dir.join("DSC1.JPG");
        std::fs::write(&raw, b"r").unwrap();
        std::fs::write(&jpg, b"j").unwrap();

        save_album_impl(&album_path.to_string_lossy(), &[pair(&raw, &jpg, 2)]).unwrap();
        let opened = open_album_impl(&album_path.to_string_lossy()).unwrap();

        let e = &opened.entries[0];
        assert!(e.is_raw);
        assert_eq!(e.jpg_path.as_deref(), Some(jpg.to_string_lossy().as_ref()));
        assert!(e.jpg_exists, "打开后必须能重建 COMPLETE 组，否则 LUMEN 关掉时整屏黑框");
    }

    #[test]
    fn open_carries_the_tone_baseline_from_xmp() {
        let dir = scratch("tone");
        let album_path = dir.join("a.galleryalbum");
        let photo = dir.join("t.ARW");
        std::fs::write(&photo, b"x").unwrap();
        crate::xmp::update_xmp_tone(
            &photo,
            Some(0.65),
            Some(-20.0),
            None,
            None,
            None,
            Some(15.0),
        )
        .unwrap();

        save_album_impl(&album_path.to_string_lossy(), &[item(&photo, 0, "none", "")]).unwrap();
        let opened = open_album_impl(&album_path.to_string_lossy()).unwrap();

        // 没有基线时调色面板显示全 0，用户一点保存就把真实调色覆盖成 0
        let tone = opened.entries[0].tone.as_ref().expect("调色必须随选片集一起回来");
        assert_eq!(tone.exposure, 0.65);
        assert_eq!(tone.contrast, 15.0);
        assert_eq!(tone.tint, 0.0, "没写的参数仍是 0");
    }

    #[test]
    fn open_reports_has_xmp_from_disk() {
        let dir = scratch("hasxmp");
        let album_path = dir.join("a.galleryalbum");
        let with = dir.join("with.ARW");
        let without = dir.join("without.ARW");
        std::fs::write(&with, b"x").unwrap();
        std::fs::write(&without, b"x").unwrap();
        crate::xmp::write_xmp(&with, 3, "none", None).unwrap();

        save_album_impl(
            &album_path.to_string_lossy(),
            &[item(&with, 0, "none", ""), item(&without, 0, "none", "")],
        )
        .unwrap();
        let opened = open_album_impl(&album_path.to_string_lossy()).unwrap();
        assert!(opened.entries[0].has_xmp, "有侧边栏就该标出来（宫格角标与导出计数都靠它）");
        assert!(!opened.entries[1].has_xmp);
    }

    #[test]
    fn opening_a_foreign_file_reports_a_readable_error() {
        let dir = scratch("foreign");
        let p = dir.join("x.json");
        std::fs::write(&p, r#"{"application":"Other","version":1,"documents":[]}"#).unwrap();
        let err = open_album_impl(&p.to_string_lossy()).expect_err("必须拒绝");
        assert!(err.contains("不是本应用的选片集"), "实际: {err}");
    }

    #[test]
    fn empty_path_is_rejected() {
        assert!(save_album_impl("", &[]).is_err());
        assert!(open_album_impl("   ").is_err());
    }

    /// 真实素材冒烟：**打开一整本选片集要多久**。
    ///
    /// 为什么值得留：打开路径要为每一条读 XMP、读 EXIF、stat 配对 JPG ——
    /// 这些在合成测试里全是零成本，只有真文件才量得出「2000 张的上限下会不会
    /// 卡住界面」。EXIF 是其中最贵的一项（要开文件、解析 TIFF IFD），
    /// 而它不能省：查询语法里的 `iso:` / `camera:` 全读它。
    #[test]
    #[ignore = "需要真实素材：设置 GALLERY_REAL_RAW_DIR 后加 --ignored 运行"]
    fn real_album_open_smoke() {
        // 两种素材都收：沙箱（`<root>/pairs`）与整本真实相册（只读）。
        let pairs = match (
            std::env::var("GALLERY_REAL_RAW_DIR"),
            std::env::var("GALLERY_REAL_ALBUM_DIR"),
        ) {
            (Ok(root), _) => std::path::PathBuf::from(root).join("pairs"),
            (Err(_), Ok(album)) => std::path::PathBuf::from(album),
            _ => {
                println!("[real_album_open] 未设置 GALLERY_REAL_RAW_DIR / GALLERY_REAL_ALBUM_DIR，跳过");
                return;
            }
        };
        assert!(pairs.is_dir(), "素材目录不存在: {}", pairs.display());

        // 用真实扫描结果造一本选片集（不自己拼路径：配对该由扫描器说了算）
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let scanned = crate::scanner::scan_folders(
            pairs.to_str().unwrap(),
            Some(pairs.to_str().unwrap()),
            "filename",
            &cancel,
            |_, _, _| {},
        )
        .expect("扫描应成功");
        assert!(scanned.total_count >= 5, "素材太少，量不出什么");

        let items: Vec<AlbumItemInput> = scanned
            .groups
            .iter()
            .map(|g| AlbumItemInput {
                path: g
                    .raw
                    .as_ref()
                    .map(|f| f.path.clone())
                    .or_else(|| g.jpg.as_ref().map(|f| f.path.clone()))
                    .expect("每组至少一个文件"),
                jpg_path: g.jpg.as_ref().map(|f| f.path.clone()),
                rating: g.rating,
                flag: g.flag.clone(),
                label: g.label.clone(),
            })
            .collect();

        let dir = scratch("real_open");
        let album_path = dir.join("real.galleryalbum");
        save_album_impl(&album_path.to_string_lossy(), &items).expect("保存应成功");

        let t0 = std::time::Instant::now();
        let opened = open_album_impl(&album_path.to_string_lossy()).expect("打开应成功");
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let n = opened.entries.len().max(1);
        println!(
            "[real_album_open] {} 张 / {:.0} ms（{:.2} ms/张）/ 缺失 {}",
            opened.entries.len(),
            ms,
            ms / n as f64,
            opened.missing
        );

        assert_eq!(opened.missing, 0, "刚保存的选片集不该有缺失");
        for e in &opened.entries {
            assert!(e.exists);
            assert!(e.is_raw, "素材是 ARW，主路径必须判成 RAW");
        }
        // 出口标准：一本 156 张的选片集要能在「一次点击」的时间量级内打开。
        // 超过 1 秒就该考虑分片或后台加载。
        assert!(ms < 1000.0, "打开 156 张耗时 {ms:.0} ms，超过 1 秒");
    }
}

