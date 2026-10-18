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
    pub path: String,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumOpenResult {
    pub path: String,
    pub entries: Vec<album::ResolvedDoc>,
    /// 缺失张数（`entries` 里仍保留，UI 负责列出来）。
    pub missing: usize,
}

/// 把输入转成文档。相对路径直接拒绝 —— 相对「谁」是歧义的，
/// 前端手上永远有绝对路径（扫描结果），没有理由放宽。
pub fn build_documents(album_path: &Path, items: &[AlbumItemInput]) -> Result<Vec<album::AlbumDoc>, String> {
    let mut pairs: Vec<(PathBuf, u8, String, String)> = Vec::with_capacity(items.len());
    for it in items {
        let p = PathBuf::from(&it.path);
        if !p.is_absolute() {
            return Err(format!("选片集只接受绝对路径，收到: {}", it.path));
        }
        pairs.push((p, it.rating, it.flag.clone(), it.label.clone()));
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

        match crate::xmp::read_xmp_full(&crate::xmp::get_xmp_path(&p)) {
            Some(m) => {
                e.rating = m.rating;
                e.flag = crate::cullstore::resolve_flag(
                    m.rejected,
                    crate::xmp::legacy_flag_from_label(&m.label),
                    entry,
                );
                e.label = m.label;
            }
            None => {
                e.rating = 0;
                e.flag = crate::cullstore::resolve_flag(false, "none", entry);
                e.label = String::new();
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
            rating,
            flag: flag.to_string(),
            label: label.to_string(),
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
                rating: 0,
                flag: "none".to_string(),
                label: String::new(),
            }],
        )
        .expect_err("相对路径必须拒绝");
        assert!(err.contains("只接受绝对路径"), "实际: {err}");
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
}
