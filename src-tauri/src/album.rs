//! 选片集（`.galleryalbum`）：跨目录的「这批照片的清单」。
//!
//! 与「目录会话」（`db.rs` 的 `sessions` 表）**不是一回事**：会话记「上次看到
//! 哪」，选片集记「这批照片是哪些」。婚礼/活动摄影师分多张卡、多个目录导入，
//! 最后要合成一个精选集交给修图师 —— 会话做不到跨目录，选片集可以。
//!
//! 格式（`application` + `version` 双校验，防止误开别的 JSON）：
//!
//! ```json
//! {
//!   "application": "Gallery Culling album",
//!   "version": 1,
//!   "documents": [
//!     { "source": "wedding/DSC04339.ARW", "rating": 3, "flag": "pick", "label": "Red" }
//!   ]
//! }
//! ```
//!
//! 三条硬约束，都是为了避免有人把它当图库用：
//! - **≤2000 张 / ≤128MB**（照抄 LUMEN 的边界）；
//! - **相对路径优先**（相对 album 文件所在目录），跨盘/不同子树时退回绝对路径；
//! - **原子写**（temp + rename），写一半断电不会毁掉上一份。
//!
//! 打开时**逐条 stat、缺失只报告不阻塞**：一次外拍的照片散在几个盘上是常态，
//! 少一张不该让整本打不开。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const ALBUM_APPLICATION: &str = "Gallery Culling album";
pub const ALBUM_VERSION: u32 = 1;
pub const ALBUM_MAX_DOCUMENTS: usize = 2000;
pub const ALBUM_MAX_BYTES: u64 = 128 * 1024 * 1024;

/// 选片集里的一条：`source` 是相对（或绝对）路径，其余是当时记下的状态。
///
/// `rating`/`flag`/`label` 一律**原样存取**：album 是用户手里的文件，可能被
/// 手改过。归一化（非法旗标当 `none`）留给前端边界层，与 `cullstore` 同口径 ——
/// 读侧做两套归一化只会让「谁说了算」变模糊。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumDoc {
    pub source: String,
    #[serde(default)]
    pub rating: u8,
    #[serde(default)]
    pub flag: String,
    #[serde(default)]
    pub label: String,
}

/// 磁盘上的完整结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlbumFile {
    pub application: String,
    pub version: u32,
    pub documents: Vec<AlbumDoc>,
}

/// 打开后的一条：路径已解析成绝对路径，`exists` 是打开那一刻的事实。
///
/// `rating/flag/label` 在 `resolve_documents` 里先填文件里记的快照，
/// 命令层随后用**磁盘状态**覆盖存在的那些（XMP 是本应用的唯一真值，见
/// ADR-001/003）；缺失的文件没有磁盘状态可读，保留快照即可 —— 报告里说
/// 「它原来是 3 星 / 已标」比什么都不说有用。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDoc {
    /// 文件里记的原始值（相对或绝对），保留给 UI 显示「它原来记的是哪个」。
    pub source: String,
    /// 解析后的绝对路径（不保证存在）。
    pub path: String,
    pub exists: bool,
    /// 存在的文件才填真实值；缺失时是 0。
    pub size: u64,
    /// 秒级 mtime（与扫描结果同口径）。
    pub mtime: u64,
    pub rating: u8,
    pub flag: String,
    pub label: String,
}

/// 把绝对路径转成「相对 album 目录」的形式；做不到就保留绝对路径。
///
/// 只用 `strip_prefix`（祖先关系），不拼 `..`：`..` 只在 album 与照片的相对
/// 位置不变时成立，用户把 album 拖到别处就全废；而「同子树」是最常见的摆放
/// （album 放在拍摄目录根部），跨盘/跨子树退回绝对路径是 LUMEN 同款取舍。
pub fn album_source(album_dir: &Path, photo: &Path) -> String {
    match photo.strip_prefix(album_dir) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.to_string_lossy().to_string(),
        _ => photo.to_string_lossy().to_string(),
    }
}

/// 把 `source` 解析成绝对路径：绝对路径原样返回，相对路径按 album 目录展开。
pub fn resolve_source(album_dir: &Path, source: &str) -> PathBuf {
    let p = Path::new(source);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        album_dir.join(p)
    }
}

/// 校验文档数量（写之前与读之后都要过，前端不该是唯一的守门人）。
pub fn check_document_count(n: usize) -> Result<(), String> {
    if n > ALBUM_MAX_DOCUMENTS {
        return Err(format!(
            "选片集最多 {} 张，当前 {} 张。选片集是「清单」不是图库，再多请拆成多个。",
            ALBUM_MAX_DOCUMENTS, n
        ));
    }
    Ok(())
}

/// 校验文件体积（读之前）。纯函数，便于用假数字测边界而不造 128MB 文件。
pub fn check_file_size(bytes: u64) -> Result<(), String> {
    if bytes > ALBUM_MAX_BYTES {
        return Err(format!(
            "选片集文件过大（{} MB，上限 {} MB）",
            bytes / (1024 * 1024),
            ALBUM_MAX_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// 原子写：先写 `<name>.tmp` 再 rename 覆盖。
///
/// 不建父目录：路径来自「另存为」对话框，目录一定已存在；悄悄建目录会让
/// 「保存到不存在的盘」变成静默成功。
pub fn write_album(path: &Path, docs: &[AlbumDoc]) -> Result<(), String> {
    check_document_count(docs.len())?;
    let payload = AlbumFile {
        application: ALBUM_APPLICATION.to_string(),
        version: ALBUM_VERSION,
        documents: docs.to_vec(),
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化失败: {e}"))?;
    check_file_size(json.len() as u64)?;

    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| format!("选片集路径非法: {}", path.display()))?;
    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入临时文件失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp); // 别把半成品留在用户目录里
        format!("替换选片集失败: {e}")
    })?;
    Ok(())
}

/// 读：体积 → 解析 → application/version/数量 三道校验。
pub fn read_album(path: &Path) -> Result<Vec<AlbumDoc>, String> {
    let bytes = fs::metadata(path).map_err(|e| format!("读取选片集失败: {e}"))?.len();
    check_file_size(bytes)?;

    let text = fs::read_to_string(path).map_err(|e| format!("读取选片集失败: {e}"))?;
    let parsed: AlbumFile =
        serde_json::from_str(&text).map_err(|e| format!("不是有效的选片集文件: {e}"))?;

    if parsed.application != ALBUM_APPLICATION {
        return Err(format!(
            "不是本应用的选片集（application = {:?}）",
            parsed.application
        ));
    }
    if parsed.version != ALBUM_VERSION {
        return Err(format!(
            "选片集版本 {} 不受支持（当前支持 {}）",
            parsed.version, ALBUM_VERSION
        ));
    }
    check_document_count(parsed.documents.len())?;
    Ok(parsed.documents)
}

/// 逐条 stat：缺失只标 `exists=false`，绝不中断。
pub fn resolve_documents(album_path: &Path, docs: &[AlbumDoc]) -> Vec<ResolvedDoc> {
    let dir = album_path.parent().unwrap_or_else(|| Path::new("."));
    docs.iter()
        .map(|d| {
            let resolved = resolve_source(dir, &d.source);
            let meta = fs::metadata(&resolved).ok().filter(|m| m.is_file());
            ResolvedDoc {
                source: d.source.clone(),
                exists: meta.is_some(),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                mtime: meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                path: resolved.to_string_lossy().to_string(),
                rating: d.rating,
                flag: d.flag.clone(),
                label: d.label.clone(),
            }
        })
        .collect()
}

/// 把「当前这批照片」转成文档：路径相对化 + 状态原样带上。
pub fn to_documents(album_path: &Path, items: &[(PathBuf, u8, String, String)]) -> Vec<AlbumDoc> {
    let dir = album_path.parent().unwrap_or_else(|| Path::new("."));
    items
        .iter()
        .map(|(p, rating, flag, label)| AlbumDoc {
            source: album_source(dir, p),
            rating: *rating,
            flag: flag.clone(),
            label: label.clone(),
        })
        .collect()
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
            "gallery_album_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn doc(src: &str, rating: u8, flag: &str, label: &str) -> AlbumDoc {
        AlbumDoc {
            source: src.to_string(),
            rating,
            flag: flag.to_string(),
            label: label.to_string(),
        }
    }

    #[test]
    fn round_trip_keeps_every_field() {
        let dir = scratch("rt");
        let album = dir.join("pick.galleryalbum");
        let docs = vec![
            doc("a/1.ARW", 5, "pick", "Red"),
            doc("b/2.JPG", 0, "none", ""),
            doc("c/3.ARW", 2, "reject", "Purple"),
        ];
        write_album(&album, &docs).unwrap();
        assert_eq!(read_album(&album).unwrap(), docs);
    }

    #[test]
    fn write_leaves_no_tmp_and_replaces_previous() {
        let dir = scratch("atomic");
        let album = dir.join("a.galleryalbum");
        write_album(&album, &[doc("one.ARW", 1, "pick", "")]).unwrap();
        write_album(&album, &[doc("two.ARW", 2, "reject", "Blue")]).unwrap();

        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.galleryalbum".to_string()], "不得残留 tmp");

        let back = read_album(&album).unwrap();
        assert_eq!(back.len(), 1, "覆盖写必须整份替换，不是追加");
        assert_eq!(back[0].source, "two.ARW");
    }

    #[test]
    fn source_is_relative_when_photo_is_under_album_dir() {
        let dir = scratch("rel");
        let album = dir.join("shoot.galleryalbum");
        let photo = dir.join("wedding").join("DSC1.ARW");
        // 期望值用 Path 拼，别写死分隔符
        let want = Path::new("wedding").join("DSC1.ARW");
        assert_eq!(album_source(&dir, &photo), want.to_string_lossy());
        // 解析回来必须是同一个绝对路径
        assert_eq!(resolve_source(&dir, &want.to_string_lossy()), photo);
    }

    #[test]
    fn source_is_absolute_when_not_under_album_dir() {
        let dir = scratch("abs");
        let elsewhere = scratch("abs_other");
        let album = dir.join("a.galleryalbum");
        let photo = elsewhere.join("DSC2.ARW");
        let source = album_source(&dir, &photo);
        assert!(Path::new(&source).is_absolute(), "跨子树必须退回绝对路径");
        assert_eq!(resolve_source(&dir, &source), photo);
    }

    #[test]
    fn read_rejects_foreign_json() {
        let dir = scratch("foreign");
        let p = dir.join("x.json");
        fs::write(
            &p,
            r#"{"application":"Something Else","version":1,"documents":[]}"#,
        )
        .unwrap();
        let err = read_album(&p).expect_err("别的应用的文件必须拒绝");
        assert!(err.contains("不是本应用的选片集"), "实际: {err}");
    }

    #[test]
    fn read_rejects_unsupported_version() {
        let dir = scratch("ver");
        let p = dir.join("x.galleryalbum");
        fs::write(
            &p,
            format!(
                r#"{{"application":"{}","version":2,"documents":[]}}"#,
                ALBUM_APPLICATION
            ),
        )
        .unwrap();
        let err = read_album(&p).expect_err("未来版本必须拒绝而不是猜");
        assert!(err.contains("版本 2 不受支持"), "实际: {err}");
    }

    #[test]
    fn read_rejects_too_many_documents() {
        let dir = scratch("many");
        let p = dir.join("x.galleryalbum");
        let docs: Vec<AlbumDoc> = (0..=ALBUM_MAX_DOCUMENTS)
            .map(|i| doc(&format!("{i}.ARW"), 0, "none", ""))
            .collect();
        let payload = AlbumFile {
            application: ALBUM_APPLICATION.to_string(),
            version: ALBUM_VERSION,
            documents: docs,
        };
        fs::write(&p, serde_json::to_string(&payload).unwrap()).unwrap();
        let err = read_album(&p).expect_err("超量必须拒绝");
        assert!(err.contains("最多 2000 张"), "实际: {err}");
    }

    #[test]
    fn write_rejects_too_many_documents() {
        let dir = scratch("write_many");
        let docs: Vec<AlbumDoc> = (0..=ALBUM_MAX_DOCUMENTS)
            .map(|i| doc(&format!("{i}.ARW"), 0, "none", ""))
            .collect();
        let err = write_album(&dir.join("a.galleryalbum"), &docs).expect_err("超量必须拒绝");
        assert!(err.contains("最多 2000 张"), "实际: {err}");
    }

    #[test]
    fn size_limit_boundary() {
        assert!(check_file_size(ALBUM_MAX_BYTES).is_ok(), "刚好等于上限应放行");
        let err = check_file_size(ALBUM_MAX_BYTES + 1).expect_err("超 1 字节就该拒绝");
        assert!(err.contains("过大"), "实际: {err}");
    }

    #[test]
    fn resolve_reports_missing_without_blocking_others() {
        let dir = scratch("missing");
        let album = dir.join("a.galleryalbum");
        let present = dir.join("here.ARW");
        fs::write(&present, b"x").unwrap();
        let docs = vec![
            doc("here.ARW", 4, "pick", "Green"),
            doc("gone.ARW", 0, "none", ""),
        ];
        let out = resolve_documents(&album, &docs);
        assert_eq!(out.len(), 2, "缺失项也要留在结果里（要能列出来）");
        assert!(out[0].exists);
        assert!(!out[1].exists);
        assert!(out[1].path.ends_with("gone.ARW"));
    }

    #[test]
    fn resolve_accepts_absolute_source() {
        let dir = scratch("absdoc");
        let album = dir.join("a.galleryalbum");
        let other = scratch("absdoc_other").join("x.ARW");
        fs::write(&other, b"x").unwrap();
        let docs = vec![doc(&other.to_string_lossy(), 1, "pick", "")];
        let out = resolve_documents(&album, &docs);
        assert!(out[0].exists, "绝对路径必须能直接解析");
        assert_eq!(PathBuf::from(&out[0].path), other);
    }

    #[test]
    fn empty_album_round_trips() {
        let dir = scratch("empty");
        let album = dir.join("e.galleryalbum");
        write_album(&album, &[]).unwrap();
        assert!(read_album(&album).unwrap().is_empty());
    }

    #[test]
    fn to_documents_relativizes_and_keeps_state() {
        let dir = scratch("todocs");
        let album = dir.join("a.galleryalbum");
        let items = vec![
            (
                dir.join("sub").join("a.ARW"),
                3u8,
                "pick".to_string(),
                "Red".to_string(),
            ),
            (
                dir.join("b.JPG"),
                0u8,
                "none".to_string(),
                String::new(),
            ),
        ];
        let docs = to_documents(&album, &items);
        assert_eq!(docs[0].source, Path::new("sub").join("a.ARW").to_string_lossy());
        assert_eq!(docs[0].rating, 3);
        assert_eq!(docs[0].flag, "pick");
        assert_eq!(docs[0].label, "Red");
        assert_eq!(docs[1].source, "b.JPG");
    }

    #[test]
    fn missing_fields_default_to_empty() {
        let dir = scratch("defaults");
        let p = dir.join("x.galleryalbum");
        fs::write(
            &p,
            format!(
                r#"{{"application":"{}","version":1,"documents":[{{"source":"a.ARW"}}]}}"#,
                ALBUM_APPLICATION
            ),
        )
        .unwrap();
        let docs = read_album(&p).unwrap();
        assert_eq!(docs[0].rating, 0);
        assert_eq!(docs[0].flag, "", "缺省空串，由前端归一化成 none");
        assert_eq!(docs[0].label, "");
    }
}
