//! Lightroom 目录（`.lrcat`）只读导入（FR-11）。
//!
//! 目标用户大量来自 Lightroom：「我在 LR 里已经标好了，不想重标」。这里只读
//! `Adobe_images` / `AgLibraryFile` / `AgLibraryFolder` / `AgLibraryRootFolder`
//! 四张表，取评级 / 旗标 / 色标，**不碰任何 develop 设置**。
//!
//! 三条硬约束：
//! - **只读**。`OpenFlags::READ_ONLY`，且只读打开失败时复制副本，绝不写用户的
//!   目录文件 —— 那是 LR 的数据库，写坏一次就是整库。
//! - **跳过虚拟副本**（`masterImage IS NOT NULL`）。虚拟副本是同一张底片的另一份
//!   调色，路径与主图相同，导进来只会重复覆盖。
//! - **不猜路径**。拼出来的绝对路径与当前集合对不上就是没对上，列出来交给用户，
//!   不按文件名模糊匹配（跨目录同名会套错评级，比不导更糟）。

use rusqlite::{Connection, OpenFlags};
use std::fs;
use std::path::{Path, PathBuf};

/// LR 目录里的一张照片，路径已拼成绝对路径（平台分隔符）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LrcatPhoto {
    pub path: String,
    /// 0–5。LR 用 `-1` 表示淘汰，归一到 0 星（淘汰由 `flag` 表达）。
    pub rating: u8,
    /// `pick` / `reject` / `none`。
    pub flag: String,
    /// `Red` / `Yellow` / `Green` / `Blue` / `Purple`，未知或空为 `""`。
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LrcatRead {
    /// 落在 `folders` 里的（`folders` 为空时是全部）照片，跳过虚拟副本。
    pub photos: Vec<LrcatPhoto>,
    /// 被跳过的虚拟副本数。
    pub skipped_virtual: usize,
    /// 库内总条目数（含虚拟副本、含不在 `folders` 里的），用于报告「库里有什么」。
    pub total: usize,
    /// 是否走了「复制副本」这条路（LR 正在运行 / WAL 需要恢复）。
    pub copied: bool,
}

/// 读一个 LR 目录。
///
/// `folders` 是「只关心这些目录」的白名单（归一化后比较）；传空 = 全部返回。
/// 过滤在 Rust 侧做：路径是拼出来的，SQL 里没有现成的列可比。
pub fn read_catalog(path: &Path, folders: &[String]) -> Result<LrcatRead, String> {
    if !path.is_file() {
        return Err(format!("Lightroom 目录不存在：{}", path.display()));
    }
    match read_once(path, folders) {
        Ok(r) => Ok(r),
        Err(first) => {
            // LR 正在运行时原地读必失败，两种形态：
            // ① 库被独占锁住 → SQLITE_BUSY；
            // ② WAL 里有未 checkpoint 的评级，只读打开需要写权限做恢复 →
            //    「attempt to write a readonly database」。
            // 两条都靠「连 -wal/-shm 一起复制一份再读」解决，且**绝不**对用户的
            // 目录文件做任何写操作 —— 那是 LR 的数据库，写坏一次就是整库。
            let (copy, dir) = copy_with_sidecars(path)?;
            let result = read_once(&copy, folders);
            let _ = fs::remove_dir_all(&dir);
            match result {
                Ok(mut r) => {
                    r.copied = true;
                    Ok(r)
                }
                Err(second) => Err(format!("{first}；复制副本后仍失败：{second}")),
            }
        }
    }
}

/// 复制 `.lrcat` 与它的 `-wal` / `-shm` 到临时目录。
///
/// `-wal` 必须一起带走：只复制主文件会读到「上一个 checkpoint」的状态，
/// 用户在 LR 里刚标的评级恰好还在 WAL 里。
fn copy_with_sidecars(path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "gallery_lrcat_copy_{}_{}",
        std::process::id(),
        nanos
    ));
    fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败：{e}"))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("路径没有文件名：{}", path.display()))?;
    let target = dir.join(name);
    fs::copy(path, &target).map_err(|e| format!("复制目录文件失败：{e}"))?;
    for suffix in ["-wal", "-shm"] {
        let src = with_sidecar_suffix(path, suffix);
        if src.is_file() {
            let dst = with_sidecar_suffix(&target, suffix);
            fs::copy(&src, &dst).map_err(|e| format!("复制 {suffix} 失败：{e}"))?;
        }
    }
    Ok((target, dir))
}

fn read_once(path: &Path, folders: &[String]) -> Result<LrcatRead, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开 Lightroom 目录失败：{e}"))?;
    // 四表联查：`Adobe_images` 是照片（评级/旗标/色标），`AgLibraryFile` 是文件名，
    // 后面两张拼目录。`masterImage` 非空即虚拟副本，在 Rust 侧跳过并计数。
    let mut stmt = conn
        .prepare(
            "SELECT r.absolutePath, f.pathFromRoot, lf.baseName, lf.extension,
                    i.rating, i.pick, i.colorLabels, i.masterImage
             FROM Adobe_images i
             JOIN AgLibraryFile lf ON lf.id_local = i.rootFile
             JOIN AgLibraryFolder f ON f.id_local = lf.folder
             JOIN AgLibraryRootFolder r ON r.id_local = f.rootFolder",
        )
        .map_err(|e| {
            format!("这不是 Lightroom 目录（缺 Adobe_images / AgLibraryFile 等表）：{e}")
        })?;

    let wanted: Vec<String> = folders.iter().map(|f| norm_dir(f)).collect();
    let mut photos = Vec::new();
    let mut skipped_virtual = 0usize;
    let mut total = 0usize;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                // `rating`/`pick` 在真实库里**没有类型声明**，实际存 REAL 或 NULL。
                // 用 Option<i64> 读会因 InvalidColumnType 整库读不出来。
                row.get::<_, Option<f64>>(4)?,
                row.get::<_, Option<f64>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(|e| format!("查询 Lightroom 目录失败：{e}"))?;

    for row in rows {
        let (root, sub, base, ext, rating, pick, label, master) =
            row.map_err(|e| format!("读取 Lightroom 目录行失败：{e}"))?;
        total += 1;
        if master.is_some() {
            skipped_virtual += 1;
            continue;
        }
        let p = join_photo_path(&root, &sub, &base, &ext);
        if !wanted.is_empty() && !wanted.contains(&norm_dir(&parent_of(&p))) {
            continue;
        }
        photos.push(LrcatPhoto {
            path: p,
            rating: rating_of(rating),
            flag: flag_of(pick, rating),
            label: label_of(label.as_deref().unwrap_or("")),
        });
    }

    Ok(LrcatRead {
        photos,
        skipped_virtual,
        total,
        copied: false,
    })
}

/// `absolutePath` + `pathFromRoot` + `baseName.extension`。
///
/// 两段目录都可能缺尾分隔符（`pathFromRoot` 为空是常态，根目录本身就是
/// `C:/a/`），缺了就补一个 —— 否则会拼出 `2026DSC1.ARW`。
fn join_photo_path(root: &str, sub: &str, base: &str, ext: &str) -> String {
    let mut s = String::with_capacity(root.len() + sub.len() + base.len() + ext.len() + 2);
    s.push_str(root);
    if !sub.is_empty() {
        if !s.ends_with('/') && !s.ends_with('\\') {
            s.push('/');
        }
        s.push_str(sub);
    }
    if !s.ends_with('/') && !s.ends_with('\\') {
        s.push('/');
    }
    s.push_str(base);
    s.push('.');
    s.push_str(ext);
    // LR 一律存正斜杠（含 UNC 的 `//server/share/`），落到 Windows 上要转回来，
    // 否则与本项目扫描出来的路径永远对不上。
    if cfg!(windows) {
        s = s.replace('/', "\\");
    }
    s
}

/// 目录归一化：正斜杠 + 去尾分隔符 + 小写。与前端 `normalizeDir` 同口径。
fn norm_dir(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn parent_of(path: &str) -> String {
    let n = path.replace('\\', "/");
    match n.rfind('/') {
        Some(i) if i > 0 => n[..i].to_string(),
        _ => n,
    }
}

fn rating_of(v: Option<f64>) -> u8 {
    match v {
        Some(x) if x.is_finite() && x > 0.0 => x.round().clamp(0.0, 5.0) as u8,
        _ => 0,
    }
}

/// 旗标。LR 的淘汰有两种写法：`pick = -1`（旗标）与 `rating = -1`（星级），
/// 两种都算 reject —— 只认 `pick` 会漏掉「只按了 0 星淘汰」的那批。
fn flag_of(pick: Option<f64>, rating: Option<f64>) -> String {
    let near = |v: Option<f64>, target: f64| matches!(v, Some(x) if (x - target).abs() < 0.5);
    if near(pick, -1.0) || near(rating, -1.0) {
        return "reject".to_string();
    }
    if near(pick, 1.0) {
        return "pick".to_string();
    }
    "none".to_string()
}

/// 色标。`colorLabels` 是逗号分隔的字符串，取**第一个已知色**并规范化大小写；
/// 未知色（LR 的色标名可被用户改名）忽略，不猜成某个已知色。
fn label_of(raw: &str) -> String {
    for part in raw.split(',') {
        let t = part.trim();
        if let Some(v) = crate::xmp::LABEL_VALUES
            .iter()
            .find(|v| v.eq_ignore_ascii_case(t))
        {
            return (*v).to_string();
        }
    }
    String::new()
}

fn with_sidecar_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
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
            "gallery_lrcat_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 一行测试数据。`root`/`sub` 相同的行共用 root/folder 记录，与 LR 一致。
    struct Row<'a> {
        root: &'a str,
        sub: &'a str,
        base: &'a str,
        ext: &'a str,
        rating: Option<f64>,
        pick: Option<f64>,
        label: &'a str,
        /// `Some(id)` = 虚拟副本，指向主图的 `id_local`。
        virtual_of: Option<i64>,
    }

    impl<'a> Row<'a> {
        fn new(root: &'a str, base: &'a str, ext: &'a str) -> Self {
            Self {
                root,
                sub: "",
                base,
                ext,
                rating: None,
                pick: None,
                label: "",
                virtual_of: None,
            }
        }
        fn sub(mut self, sub: &'a str) -> Self {
            self.sub = sub;
            self
        }
        fn rating(mut self, r: f64) -> Self {
            self.rating = Some(r);
            self
        }
        fn pick(mut self, p: f64) -> Self {
            self.pick = Some(p);
            self
        }
        fn label(mut self, l: &'a str) -> Self {
            self.label = l;
            self
        }
        fn virt(mut self, of: i64) -> Self {
            self.virtual_of = Some(of);
            self
        }
    }

    /// 造一个最小 LR 目录：只建导入要读的 4 张表，列类型照抄真实库
    /// （`rating`/`pick` **无类型声明**、`colorLabels` TEXT NOT NULL DEFAULT ''）。
    fn make_catalog(dir: &Path, rows: &[Row<'_>]) -> PathBuf {
        let p = dir.join("test.lrcat");
        let conn = Connection::open(&p).unwrap();
        conn.execute_batch(
            "CREATE TABLE Adobe_images (
                 id_local INTEGER PRIMARY KEY,
                 rating REAL,
                 pick REAL,
                 colorLabels TEXT NOT NULL DEFAULT '',
                 masterImage INTEGER,
                 rootFile INTEGER NOT NULL
             );
             CREATE TABLE AgLibraryFile (
                 id_local INTEGER PRIMARY KEY,
                 baseName TEXT NOT NULL DEFAULT '',
                 extension TEXT NOT NULL DEFAULT '',
                 folder INTEGER NOT NULL
             );
             CREATE TABLE AgLibraryFolder (
                 id_local INTEGER PRIMARY KEY,
                 pathFromRoot TEXT NOT NULL DEFAULT '',
                 rootFolder INTEGER NOT NULL
             );
             CREATE TABLE AgLibraryRootFolder (
                 id_local INTEGER PRIMARY KEY,
                 absolutePath TEXT NOT NULL DEFAULT ''
             );",
        )
        .unwrap();

        let mut roots: Vec<&str> = Vec::new();
        let mut folders: Vec<(&str, &str)> = Vec::new();
        for r in rows {
            if !roots.contains(&r.root) {
                roots.push(r.root);
            }
            let key = (r.root, r.sub);
            if !folders.contains(&key) {
                folders.push(key);
            }
        }
        for (i, root) in roots.iter().enumerate() {
            conn.execute(
                "INSERT INTO AgLibraryRootFolder (id_local, absolutePath) VALUES (?1, ?2)",
                rusqlite::params![i as i64 + 1, root],
            )
            .unwrap();
        }
        for (i, (root, sub)) in folders.iter().enumerate() {
            let root_id = roots.iter().position(|r| r == root).unwrap() as i64 + 1;
            conn.execute(
                "INSERT INTO AgLibraryFolder (id_local, pathFromRoot, rootFolder) VALUES (?1, ?2, ?3)",
                rusqlite::params![i as i64 + 1, sub, root_id],
            )
            .unwrap();
        }
        for (i, r) in rows.iter().enumerate() {
            let folder_id = folders
                .iter()
                .position(|(root, sub)| *root == r.root && *sub == r.sub)
                .unwrap() as i64
                + 1;
            let file_id = i as i64 + 1;
            conn.execute(
                "INSERT INTO AgLibraryFile (id_local, baseName, extension, folder) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![file_id, r.base, r.ext, folder_id],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO Adobe_images (id_local, rating, pick, colorLabels, masterImage, rootFile)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![file_id, r.rating, r.pick, r.label, r.virtual_of, file_id],
            )
            .unwrap();
        }
        p
    }

    #[test]
    fn reads_rating_pick_and_label() {
        let dir = scratch("basic");
        let cat = make_catalog(
            &dir,
            &[
                Row::new("C:/a/", "DSC1", "ARW").rating(5.0).pick(1.0).label("Red"),
                Row::new("C:/a/", "DSC2", "ARW").pick(-1.0),
                Row::new("C:/a/", "DSC3", "ARW"),
            ],
        );
        let got = read_catalog(&cat, &[]).unwrap();
        assert_eq!(got.photos.len(), 3);
        assert_eq!(got.photos[0].rating, 5);
        assert_eq!(got.photos[0].flag, "pick");
        assert_eq!(got.photos[0].label, "Red");
        assert_eq!(got.photos[1].flag, "reject");
        assert_eq!(got.photos[2].flag, "none");
        assert_eq!(got.photos[2].rating, 0);
        assert_eq!(got.total, 3);
        assert_eq!(got.skipped_virtual, 0);
        assert!(!got.copied);
    }

    #[test]
    fn virtual_copies_are_skipped_and_counted() {
        let dir = scratch("virtual");
        let cat = make_catalog(
            &dir,
            &[
                Row::new("C:/a/", "DSC1", "ARW").rating(3.0),
                Row::new("C:/a/", "DSC1", "ARW").rating(5.0).virt(1),
            ],
        );
        let got = read_catalog(&cat, &[]).unwrap();
        assert_eq!(got.photos.len(), 1, "虚拟副本不该出现");
        assert_eq!(got.photos[0].rating, 3);
        assert_eq!(got.skipped_virtual, 1);
        assert_eq!(got.total, 2);
    }

    #[test]
    fn negative_rating_maps_to_reject_even_without_pick() {
        let dir = scratch("neg_rating");
        let cat = make_catalog(&dir, &[Row::new("C:/a/", "DSC1", "ARW").rating(-1.0)]);
        let got = read_catalog(&cat, &[]).unwrap();
        assert_eq!(got.photos[0].flag, "reject");
        assert_eq!(got.photos[0].rating, 0, "-1 星不是 0 星以外的值");
    }

    #[test]
    fn rating_is_clamped_to_five() {
        let dir = scratch("clamp");
        let cat = make_catalog(&dir, &[Row::new("C:/a/", "DSC1", "ARW").rating(7.0)]);
        assert_eq!(read_catalog(&cat, &[]).unwrap().photos[0].rating, 5);
    }

    #[test]
    fn subfolder_is_joined_into_the_path() {
        let dir = scratch("sub");
        let cat = make_catalog(
            &dir,
            &[Row::new("C:/a/", "DSC1", "ARW").sub("2026/09/12/")],
        );
        let p = &read_catalog(&cat, &[]).unwrap().photos[0].path;
        assert!(p.ends_with("DSC1.ARW"), "{p}");
        assert!(p.contains("2026"), "子目录必须拼进来：{p}");
        assert!(p.contains("09"), "{p}");
        assert!(p.contains("12"), "{p}");
    }

    #[test]
    fn subfolder_without_trailing_slash_still_joins() {
        let dir = scratch("sub_noslash");
        let cat = make_catalog(&dir, &[Row::new("C:/a/", "DSC1", "ARW").sub("2026")]);
        let p = &read_catalog(&cat, &[]).unwrap().photos[0].path;
        assert!(p.ends_with("DSC1.ARW"), "{p}");
        assert!(!p.contains("2026DSC1"), "缺分隔符会拼成 2026DSC1：{p}");
    }

    #[test]
    fn folders_filter_keeps_only_matching_directories() {
        let dir = scratch("filter");
        let cat = make_catalog(
            &dir,
            &[
                Row::new("C:/a/", "DSC1", "ARW"),
                Row::new("C:/b/", "DSC2", "ARW"),
            ],
        );
        // 大小写与尾斜杠都不该影响匹配。
        let got = read_catalog(&cat, &["c:\\A\\".to_string()]).unwrap();
        assert_eq!(got.photos.len(), 1);
        assert_eq!(got.total, 2, "total 是库内总数，不受过滤影响");
    }

    #[test]
    fn empty_folders_means_no_filter() {
        let dir = scratch("nofilter");
        let cat = make_catalog(
            &dir,
            &[
                Row::new("C:/a/", "DSC1", "ARW"),
                Row::new("C:/b/", "DSC2", "ARW"),
            ],
        );
        assert_eq!(read_catalog(&cat, &[]).unwrap().photos.len(), 2);
    }

    #[test]
    fn unknown_colour_label_is_ignored() {
        let dir = scratch("bad_label");
        let cat = make_catalog(&dir, &[Row::new("C:/a/", "DSC1", "ARW").label("Teal")]);
        assert_eq!(read_catalog(&cat, &[]).unwrap().photos[0].label, "");
    }

    #[test]
    fn multi_label_takes_the_first_known() {
        let dir = scratch("multi_label");
        let cat = make_catalog(
            &dir,
            &[Row::new("C:/a/", "DSC1", "ARW").label("Teal,Green")],
        );
        assert_eq!(read_catalog(&cat, &[]).unwrap().photos[0].label, "Green");
    }

    #[test]
    fn label_case_is_normalised() {
        let dir = scratch("label_case");
        let cat = make_catalog(&dir, &[Row::new("C:/a/", "DSC1", "ARW").label("red")]);
        assert_eq!(read_catalog(&cat, &[]).unwrap().photos[0].label, "Red");
    }

    #[test]
    fn missing_tables_report_a_readable_error() {
        let dir = scratch("not_lr");
        let p = dir.join("other.lrcat");
        Connection::open(&p)
            .unwrap()
            .execute_batch("CREATE TABLE foo (id INTEGER)")
            .unwrap();
        let err = read_catalog(&p, &[]).unwrap_err();
        assert!(
            err.contains("Adobe_images") || err.contains("Lightroom"),
            "错误要说清不是 LR 目录：{err}"
        );
    }

    #[test]
    fn missing_file_reports_a_readable_error() {
        let dir = scratch("missing");
        let err = read_catalog(&dir.join("nope.lrcat"), &[]).unwrap_err();
        assert!(err.contains("不存在"), "{err}");
    }

    #[test]
    fn copy_fallback_reads_a_catalog_that_cannot_be_opened_in_place() {
        let dir = scratch("copy");
        let cat = make_catalog(&dir, &[Row::new("C:/a/", "DSC1", "ARW").rating(4.0)]);
        // 用 EXCLUSIVE 锁住，让原地只读打开必然失败（LR 运行时的常见形态）。
        let holder = Connection::open(&cat).unwrap();
        holder
            .execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;")
            .unwrap();
        let got = read_catalog(&cat, &[]);
        holder.execute_batch("ROLLBACK").unwrap();
        let got = got.expect("复制副本后应能读");
        assert_eq!(got.photos.len(), 1);
        assert_eq!(got.photos[0].rating, 4);
        assert!(got.copied, "走了复制兜底就要说出来");
    }

    /// 真实 LR 目录冒烟（`GALLERY_REAL_LRCAT`）。
    ///
    /// 单测造的库是理想 schema；真实库的 `rating`/`pick` **没有类型声明**、
    /// 路径可能是 UNC（`//server/share/...`），只有真文件能证明读得出来。
    #[test]
    #[ignore = "需要真实素材：设置 GALLERY_REAL_LRCAT 后加 --ignored 运行"]
    fn real_catalog_smoke() {
        let p = std::env::var("GALLERY_REAL_LRCAT")
            .expect("请设置 GALLERY_REAL_LRCAT 指向一个 .lrcat");
        let t0 = std::time::Instant::now();
        let got = read_catalog(Path::new(&p), &[]).expect("真实目录应能读");
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        println!(
            "[real_lrcat] {} 张 / 跳过虚拟 {} / 库内总 {} / 复制副本 {} / {:.0} ms",
            got.photos.len(),
            got.skipped_virtual,
            got.total,
            got.copied,
            ms
        );
        assert!(got.total > 0, "真实目录不该是空的");
        for photo in &got.photos {
            assert!(
                photo.path.contains('.') && (photo.path.contains('\\') || photo.path.contains('/')),
                "路径没拼对：{}",
                photo.path
            );
            assert!(photo.rating <= 5);
            assert!(
                matches!(photo.flag.as_str(), "pick" | "reject" | "none"),
                "旗标越界：{}",
                photo.flag
            );
        }
    }
}
