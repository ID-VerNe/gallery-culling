//! 缩略图缓存：目录、命名、内存索引、新鲜度校验。
//!
//! 命名规则一旦变更就会与磁盘上既有缓存失配（全部重新生成）。
//! `cache_path_for` 的格式由两条测试锁死，改动前先看它们。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use crate::cachekey::sha256_hex16;

use crate::db::{user_home_dir, DATA_DIR_ENV};

/// 缓存落点子目录（issue #107 · PA）：与 DB 同树 `home/.galleryculling`。
const APP_DATA_SUBDIR: &str = ".galleryculling";
/// 同树下的缓存子目录：最终落点 `home/.galleryculling/cache`。
const CACHE_SUBDIR: &str = "cache";
/// 旧落点（cwd 相对）：一次性迁移的源，迁完保留原样。
const LEGACY_CACHE_DIR: &str = "app_cache";

/// 确保缩略图缓存目录存在并返回它（issue #107 · PA）。
///
/// 落点与 cwd 无关（与 #98 的 `db.rs` 同口径）：`GALLERY_DATA_DIR` 非空 →
/// `<它>/cache`（e2e 隔离）；否则 `home/.galleryculling/cache`；取不到 home →
/// `temp_dir()` 兜底。`lumencmds` 的 `gallery` 子目录自动跟随此根。
pub fn get_cache_dir() -> PathBuf {
    let data_dir = std::env::var_os(DATA_DIR_ENV)
        .map(PathBuf::from)
        .filter(|d| !d.as_os_str().is_empty());
    let home_dir = user_home_dir();
    let resolved = resolve_cache_dir(data_dir.clone(), home_dir.clone());

    // 一次性迁移：只有走默认 home 分支才把 cwd 旧缓存复制过去（与
    // `db::get_db_path` 同口径）。设置了覆盖时绝不迁移 —— 否则会把用户
    // 真实缓存灌进 e2e 隔离目录。每进程只做一次，避免每次查缓存都扫旧目录。
    if data_dir.is_none() && home_dir.is_some() {
        static MIGRATION_DONE: OnceLock<()> = OnceLock::new();
        MIGRATION_DONE.get_or_init(|| {
            migrate_legacy_cache(&resolved, &PathBuf::from(LEGACY_CACHE_DIR));
        });
    }
    resolved
}

/// 纯路径决策（issue #107 · PA，镜像 `db::resolve_db_path`）：
/// - `data_dir` 非空 → 覆盖优先：`<它>/cache`，不回落用户目录；
/// - 否则 → `home/.galleryculling/cache`；
/// - `home_dir` 取不到 → `temp_dir()/gallery_culling_cache` 兜底。
///
/// home 由调用方传入（便于单测、不硬编码盘符）。两个分支都在返回前确保
/// 目录存在，否则写缓存建不了目录；建目录失败只警告不阻断。
fn resolve_cache_dir(data_dir: Option<PathBuf>, home_dir: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = data_dir.filter(|d| !d.as_os_str().is_empty()) {
        let cache_dir = dir.join(CACHE_SUBDIR);
        if let Err(e) = fs::create_dir_all(&cache_dir) {
            eprintln!("创建缓存覆盖目录失败（{}）：{}", cache_dir.display(), e);
        }
        return cache_dir;
    }
    match home_dir {
        Some(home) => {
            let cache_dir = home.join(APP_DATA_SUBDIR).join(CACHE_SUBDIR);
            if let Err(e) = fs::create_dir_all(&cache_dir) {
                eprintln!("创建用户缓存目录失败（{}）：{}", cache_dir.display(), e);
            }
            cache_dir
        }
        None => {
            let fallback = std::env::temp_dir().join("gallery_culling_cache");
            let _ = fs::create_dir_all(&fallback);
            fallback
        }
    }
}

/// 一次性迁移 cwd 旧缓存（issue #107 · PA）：只带现格式 `*.jpg`。
///
/// 约束（与 `db::migrate_legacy_db` 同款 + 缓存特有）：
/// - 目标顶层已有现格式 `*.jpg` 时直接跳过（不合并，避免两轮缓存互灌）；
/// - 只递归复制扩展名 `jpg` 的文件（现行 `<16hex>_<stem>_<w>_rot<o>.jpg` 与
///   `gallery/lumen/*_lumen.jpg`），12926 个孤儿 `_thumb.jpeg` 因 `.jpeg`
///   扩展名天然排除，永不迁；
/// - 只复制、不移动、不覆盖已存在目标、不删源；失败只警告不阻断。
fn migrate_legacy_cache(target: &Path, legacy: &Path) {
    if !legacy.is_dir() {
        return;
    }
    if dir_has_current_jpg(target) {
        return;
    }
    if let Err(e) = fs::create_dir_all(target) {
        eprintln!(
            "迁移旧缩略图缓存：创建目标目录失败（{}）：{}",
            target.display(),
            e
        );
        return;
    }
    let mut copied = 0usize;
    copy_jpgs_recursive(legacy, target, legacy, &mut copied);
    if copied > 0 {
        eprintln!(
            "已把 {} 个旧缩略图缓存迁移到 {}（源 {} 保留）",
            copied,
            target.display(),
            legacy.display()
        );
    }
}

/// 目标顶层是否已有现格式 `*.jpg`（迁移跳过判据）。
fn dir_has_current_jpg(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        path.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jpg"))
    })
}

/// 递归复制 `src_root` 下所有 `*.jpg` 到 `target_root` 对应相对路径。
fn copy_jpgs_recursive(src_dir: &Path, target_root: &Path, src_root: &Path, copied: &mut usize) {
    let Ok(entries) = fs::read_dir(src_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let src = entry.path();
        if src.is_dir() {
            // 保持相对结构（如 gallery/lumen/）。
            if let Ok(rel) = src.strip_prefix(src_root) {
                copy_jpgs_recursive(&src, target_root, src_root, copied);
                let _ = rel;
            } else {
                copy_jpgs_recursive(&src, target_root, src_root, copied);
            }
            continue;
        }
        if !src.is_file() {
            continue;
        }
        let is_jpg = src
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jpg"));
        // 孤儿 `_thumb.jpeg` 是 `.jpeg`，本就过不了上一行；再补一条显式
        // 守卫：万一将来出现 `*_thumb.jpg` 也不迁（它不在现行命名口径里）。
        let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !is_jpg || name.ends_with("_thumb.jpg") {
            continue;
        }
        let Ok(rel) = src.strip_prefix(src_root) else {
            continue;
        };
        let dst = target_root.join(rel);
        if dst.exists() {
            continue;
        }
        if let Some(parent) = dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::copy(&src, &dst).is_ok() {
            *copied += 1;
        }
    }
}

/// 因此索引键与缓存文件名同源 —— 文件一变，键与文件名同步失效。
/// mtime 用纳秒（`u128`，与 `lumen::cache::mtime_tag` 同口径）：秒级会在
/// 同秒覆写时让键与文件名都不变，进程内索引命中直接返回旧图（issue #142）。
pub(super) fn file_fingerprint(file_path: &Path) -> (PathBuf, u128) {
    let abs_path = fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    let mtime = file_mtime_nanos(file_path);
    (abs_path, mtime)
}

/// 取文件 mtime 的 Unix 纳秒数（缺省 0）。
///
/// 缓存新鲜度判定的输入。**必须与 `scanner::secs_from_meta` 分开**：那边收
/// 已经取好的 metadata，这边自己 stat；更重要的是缺省值语义不同 —— 这里 0
/// 表示「取不到时间戳」，与真实的 epoch 0 无法区分，因此缓存判定逻辑不接受
/// 「mtime == 0 就认为是最新的」这种写法。与 `lumen::cache::mtime_tag` 的
/// `u128::MAX` 缺省不同：那是给键 payload 用的可区分哨兵，这里 0 沿用历史
/// 语义（issue #142 只改精度，不改哨兵）。
pub(super) fn file_mtime_nanos(file_path: &Path) -> u128 {
    fs::metadata(file_path)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        })
        .unwrap_or(0)
}

/// 用**已算好的**指纹拼出缓存文件路径（避免重复 `canonicalize`/`metadata`）。
/// 文件名格式与历史版本逐字一致（`{hash16}_{stem}_{width}_rot{orientation}.jpg`），
/// 但哈希输入改纳秒并升 `thumb-v3`（issue #142）：存量 `thumb-v2` 秒级缓存
/// 有意一次性失效，下次查看时懒重生成（论证见 plan/PR）。
pub(super) fn cache_path_for(
    abs_path: &Path,
    mtime: u128,
    file_path: &Path,
    width: u32,
    orientation: u32,
) -> PathBuf {
    let key = format!(
        "{}-{}-{}-{}-thumb-v3",
        abs_path.to_string_lossy(),
        mtime,
        width,
        orientation
    );
    let hash = sha256_hex16(&key);

    let stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let filename = format!("{}_{}_{}_rot{}.jpg", hash, stem, width, orientation);
    get_cache_dir().join(filename)
}

/* ------------------------------ 进程内间接索引 ------------------------------ */

/// 间接索引键：(规范化路径, mtime 纳秒, 宽度)。**刻意不含 orientation** —— 缓存文件名
/// 里仍带 orientation（旋转后会重存，不能从键里去掉），但在文件内容不变（mtime 不变）
/// 时 orientation 是常量，所以用这个轻量键先查一次即可直接拿到上次算好的缓存路径。
#[derive(PartialEq, Eq, Hash, Clone, Debug)]
pub(super) struct ThumbIndexKey {
    pub(super) path: PathBuf,
    pub(super) mtime: u128,
    pub(super) width: u32,
}

/// 进程内索引：`ThumbIndexKey -> 缓存文件路径`。
///
/// 目的：缓存命中时**跳过 `read_orientation`（打开文件 + 解析 EXIF）与 sha256 键
/// 哈希**。索引只在内存里、不写盘、也不改任何已有缓存文件名 —— 进程重启后自动重建，
/// 存量缓存 100% 兼容。文件一变（mtime 变）即换键，相当于自动失效。
static THUMB_INDEX: OnceLock<RwLock<HashMap<ThumbIndexKey, PathBuf>>> = OnceLock::new();

pub(super) fn thumb_index() -> &'static RwLock<HashMap<ThumbIndexKey, PathBuf>> {
    THUMB_INDEX.get_or_init(|| RwLock::new(HashMap::new()))
}

pub(super) fn lookup_index(key: &ThumbIndexKey) -> Option<PathBuf> {
    thumb_index().read().ok()?.get(key).cloned()
}

pub(super) fn remember_index(key: ThumbIndexKey, cache_path: &Path) {
    if let Ok(mut map) = thumb_index().write() {
        map.insert(key, cache_path.to_path_buf());
    }
}

pub(super) fn drop_index(key: &ThumbIndexKey) {
    if let Ok(mut map) = thumb_index().write() {
        map.remove(key);
    }
}

/// 缓存文件是否"可用"（存在且非空）。命中判定与磁盘校验共用的最低门槛。
pub(super) fn cache_file_usable(cache_path: &Path) -> bool {
    fs::metadata(cache_path).map(|m| m.len() > 0).unwrap_or(false)
}

/// 磁盘命中时的严格校验：缓存比源文件新且非空（沿用历史逻辑）。
pub(super) fn cache_file_fresh(cache_path: &Path, file_path: &Path) -> bool {
    if !cache_file_usable(cache_path) {
        return false;
    }
    match (
        fs::metadata(file_path).and_then(|m| m.modified()),
        fs::metadata(cache_path).and_then(|m| m.modified()),
    ) {
        (Ok(orig), Ok(cache)) => cache >= orig,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn unique_dir(tag: &str) -> PathBuf {
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "gfx_cache107_{}_{}_{}",
            std::process::id(),
            tag,
            seq
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    /// issue #107 PA 墓碑：覆盖目录优先（#81/#98 隔离），且不得顺手碰 home。
    #[test]
    fn cache_dir_override_wins_and_creates_directory() {
        let data = unique_dir("override");
        let home = unique_dir("override-home");
        let got = resolve_cache_dir(Some(data.clone()), Some(home.clone()));
        assert_eq!(got, data.join("cache"));
        assert!(got.is_dir(), "覆盖分支应确保 cache 目录存在");
        assert!(!home.exists(), "覆盖分支不得创建 home 目录（隔离失效）");
        cleanup(&data);
        cleanup(&home);
    }

    /// issue #107 PA 墓碑：默认落到 home/.galleryculling/cache（与 DB 同树 #98）。
    /// 变异：把 `home.join(".galleryculling").join("cache")` 改回相对 "app_cache" 必须红。
    #[test]
    fn cache_dir_home_branch_is_galleryculling_cache() {
        let home = unique_dir("home");
        let got = resolve_cache_dir(None, Some(home.clone()));
        let expected = home.join(".galleryculling").join("cache");
        assert_eq!(got, expected);
        assert!(got.is_dir());
        assert!(got.is_absolute(), "落点必须是绝对路径，不得随 cwd 漂移");
        cleanup(&home);
    }

    /// 空串覆盖按"未设置"处理（与 `resolve_db_path` 同口径）。
    #[test]
    fn cache_dir_empty_override_falls_back_to_home() {
        let home = unique_dir("empty-override");
        let got = resolve_cache_dir(Some(PathBuf::new()), Some(home.clone()));
        assert_eq!(got, home.join(".galleryculling").join("cache"));
        cleanup(&home);
    }

    /// 取不到 home 时回落 temp，与 cwd 无关（极端环境兜底）。
    #[test]
    fn cache_dir_no_home_falls_back_to_temp() {
        let got = resolve_cache_dir(None, None);
        let expected = std::env::temp_dir().join("gallery_culling_cache");
        assert_eq!(got, expected);
    }

    /// issue #107 PA 墓碑：`get_cache_dir()` 不得回到相对 "app_cache"。
    /// 变异：把实现改回 `PathBuf::from("app_cache")` 必须红（断言瞄准 cwd 子串）。
    #[test]
    fn cache_dir_is_not_cwd_relative() {
        let got = get_cache_dir();
        assert_ne!(got, PathBuf::from("app_cache"));
        assert_ne!(
            got.file_name().and_then(|s| s.to_str()),
            Some("app_cache"),
            "缓存目录名不得是 cwd 下的 app_cache，否则跨启动不复用（issue #107）"
        );
    }

    /// issue #107 PA 墓碑：一次性迁移只带现格式 `*.jpg`（含 gallery 子目录），
    /// 12926 个孤儿 `_thumb.jpeg` 永不迁；源保留、目标已有文件不覆盖。
    #[test]
    fn migrate_legacy_cache_copies_jpg_skips_thumb_jpeg() {
        let legacy = unique_dir("legacy");
        let target = unique_dir("target");
        std::fs::create_dir_all(legacy.join("gallery").join("lumen")).expect("create legacy dirs");
        std::fs::create_dir_all(&target).expect("create target");
        fs::write(legacy.join("abc_200_rot1.jpg"), b"thumb").expect("write jpg");
        fs::write(legacy.join("full64_IMG_thumb.jpeg"), b"orphan").expect("write jpeg");
        fs::write(
            legacy
                .join("gallery")
                .join("lumen")
                .join("k_1600_lumen.jpg"),
            b"lumen",
        )
        .expect("write lumen jpg");
        cleanup_target_note(&target);

        migrate_legacy_cache(&target, &legacy);

        assert_eq!(fs::read(target.join("abc_200_rot1.jpg")).unwrap(), b"thumb");
        assert!(
            !target.join("full64_IMG_thumb.jpeg").exists(),
            "孤儿 _thumb.jpeg（.jpeg）不得迁移"
        );
        assert_eq!(
            fs::read(
                target
                    .join("gallery")
                    .join("lumen")
                    .join("k_1600_lumen.jpg")
            )
            .unwrap(),
            b"lumen"
        );
        assert!(
            legacy.join("abc_200_rot1.jpg").exists(),
            "迁移只复制不移动，源必须保留"
        );
        cleanup(&legacy);
        cleanup(&target);
    }

    /// 目标已有现格式 `*.jpg` 时不再合并（避免两轮缓存互灌）。
    #[test]
    fn migrate_legacy_cache_skips_when_target_has_jpg() {
        let legacy = unique_dir("legacy2");
        let target = unique_dir("target2");
        std::fs::create_dir_all(&legacy).expect("create legacy");
        std::fs::create_dir_all(&target).expect("create target");
        fs::write(legacy.join("abc_200_rot1.jpg"), b"legacy").expect("write legacy");
        fs::write(target.join("existing_200_rot1.jpg"), b"new").expect("write target");
        migrate_legacy_cache(&target, &legacy);
        assert_eq!(
            fs::read(target.join("existing_200_rot1.jpg")).unwrap(),
            b"new"
        );
        assert!(
            !target.join("abc_200_rot1.jpg").exists(),
            "目标已有缓存时不得再合并旧缓存"
        );
        cleanup(&legacy);
        cleanup(&target);
    }

    fn cleanup_target_note(_p: &Path) {}

    /// issue #142 墓碑：同秒内 mtime 只差亚秒（+500ms）时指纹必须不同，
    /// 否则索引键与缓存文件名都不变，同秒覆写会命中旧缓存（stale）。
    /// 基线（`as_secs`）下两路指纹相同，本测试必红。
    #[test]
    fn fingerprint_distinguishes_same_second_mtimes() {
        use std::time::{Duration, UNIX_EPOCH};
        let dir = unique_dir("same-second");
        std::fs::create_dir_all(&dir).expect("create dir");
        let src = dir.join("photo.jpg");
        std::fs::write(&src, b"v1").expect("write v1");

        // 固定同一秒内的两个时刻：+100ms 与 +600ms，秒数相同、纳秒不同。
        let base = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let set_mtime = |t: std::time::SystemTime| {
            std::fs::File::options()
                .write(true)
                .open(&src)
                .expect("open for set_modified")
                .set_modified(t)
                .expect("set mtime");
        };

        set_mtime(base + Duration::from_millis(100));
        let fp1 = file_fingerprint(&src);
        let p1 = cache_path_for(&fp1.0, fp1.1, &src, 200, 1);

        set_mtime(base + Duration::from_millis(600));
        let fp2 = file_fingerprint(&src);
        let p2 = cache_path_for(&fp2.0, fp2.1, &src, 200, 1);

        assert_ne!(fp1, fp2, "同秒只差 500ms 的两次指纹必须不同");
        assert_ne!(p1, p2, "同秒覆写必须换缓存文件名，否则磁盘命中旧图");

        cleanup(&dir);
    }
}
