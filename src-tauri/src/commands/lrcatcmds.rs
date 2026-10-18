//! Lightroom 目录（`.lrcat`）导入命令（FR-11）。
//!
//! 命令层只做参数校验与结果整形；读取、复制兜底、值映射都在 `crate::lrcat`。
//! **这里不写盘、不碰 XMP** —— 导入是「读出来给前端」，写回由前端逐张走
//! 既有的 `update_rating_flag_cmd`（这样撤销栈、写盘合并、冲突检查全部复用，
//! 不需要在导入路径上再实现一遍）。

use serde::Serialize;

use super::blocking;
use crate::lrcat::{self, LrcatPhoto};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LrcatReadResult {
    pub catalog: String,
    pub photos: Vec<LrcatPhoto>,
    pub skipped_virtual: usize,
    pub total: usize,
    /// 原地读失败、走了复制副本（LR 正在运行）。
    pub copied: bool,
}

#[tauri::command]
pub async fn read_lrcat_cmd(
    path: String,
    folders: Vec<String>,
) -> Result<LrcatReadResult, String> {
    blocking("读取 Lightroom 目录任务异常", move || {
        read_lrcat_impl(&path, &folders)
    })
    .await
}

pub(crate) fn read_lrcat_impl(path: &str, folders: &[String]) -> Result<LrcatReadResult, String> {
    // 校验放在 `_impl` 而不是命令外壳：外壳只是 tokio 包装，测试与将来的
    // 批量入口都走这里，校验留在外壳里等于「只有从 IPC 进来才检查」。
    if path.trim().is_empty() {
        return Err("未指定 Lightroom 目录".to_string());
    }
    let got = lrcat::read_catalog(std::path::Path::new(path), folders)?;
    Ok(LrcatReadResult {
        catalog: path.to_string(),
        photos: got.photos,
        skipped_virtual: got.skipped_virtual,
        total: got.total,
        copied: got.copied,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gallery_lrcatcmd_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn minimal_catalog(dir: &Path) -> PathBuf {
        let p = dir.join("min.lrcat");
        let conn = rusqlite::Connection::open(&p).unwrap();
        conn.execute_batch(
            "CREATE TABLE Adobe_images (id_local INTEGER PRIMARY KEY, rating REAL, pick REAL,
                 colorLabels TEXT NOT NULL DEFAULT '', masterImage INTEGER, rootFile INTEGER NOT NULL);
             CREATE TABLE AgLibraryFile (id_local INTEGER PRIMARY KEY, baseName TEXT NOT NULL DEFAULT '',
                 extension TEXT NOT NULL DEFAULT '', folder INTEGER NOT NULL);
             CREATE TABLE AgLibraryFolder (id_local INTEGER PRIMARY KEY, pathFromRoot TEXT NOT NULL DEFAULT '',
                 rootFolder INTEGER NOT NULL);
             CREATE TABLE AgLibraryRootFolder (id_local INTEGER PRIMARY KEY, absolutePath TEXT NOT NULL DEFAULT '');
             INSERT INTO AgLibraryRootFolder (id_local, absolutePath) VALUES (1, 'C:/shoot/');
             INSERT INTO AgLibraryFolder (id_local, pathFromRoot, rootFolder) VALUES (1, '', 1);
             INSERT INTO AgLibraryFile (id_local, baseName, extension, folder) VALUES (1, 'DSC1', 'ARW', 1);
             INSERT INTO Adobe_images (id_local, rating, pick, colorLabels, rootFile)
                 VALUES (1, 4.0, 1.0, 'Green', 1);",
        )
        .unwrap();
        p
    }

    #[test]
    fn empty_path_is_rejected() {
        let err = read_lrcat_impl("  ", &[]).unwrap_err();
        assert!(err.contains("未指定"), "{err}");
    }

    #[test]
    fn missing_catalog_is_reported() {
        let dir = scratch("missing");
        let err = read_lrcat_impl(&dir.join("nope.lrcat").to_string_lossy(), &[]).unwrap_err();
        assert!(err.contains("不存在"), "{err}");
    }

    #[test]
    fn result_carries_the_catalog_path_and_counts() {
        let dir = scratch("ok");
        let cat = minimal_catalog(&dir);
        let got = read_lrcat_impl(&cat.to_string_lossy(), &[]).unwrap();
        assert_eq!(got.catalog, cat.to_string_lossy());
        assert_eq!(got.total, 1);
        assert_eq!(got.photos.len(), 1);
        assert_eq!(got.photos[0].rating, 4);
        assert_eq!(got.photos[0].flag, "pick");
        assert_eq!(got.photos[0].label, "Green");
        assert!(!got.copied);
    }

    #[test]
    fn folders_filter_is_forwarded() {
        let dir = scratch("filter");
        let cat = minimal_catalog(&dir);
        let hit = read_lrcat_impl(&cat.to_string_lossy(), &["C:/shoot".to_string()]).unwrap();
        assert_eq!(hit.photos.len(), 1);
        let miss = read_lrcat_impl(&cat.to_string_lossy(), &["D:/other".to_string()]).unwrap();
        assert_eq!(miss.photos.len(), 0);
        assert_eq!(miss.total, 1, "total 是库内总数，不受过滤影响");
    }
}
