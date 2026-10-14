//! 缩略图缓存：目录、命名、内存索引、新鲜度校验。
//!
//! 命名规则一旦变更就会与磁盘上既有缓存失配（全部重新生成）。
//! `cache_path_for` 的格式由两条测试锁死，改动前先看它们。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use sha2::{Digest, Sha256};

/// Ensure thumbnail cache directory exists
pub fn get_cache_dir() -> PathBuf {
    // Priority: ./app_cache or AppData/Local/GalleryCulling/cache
    let project_cache = PathBuf::from("app_cache");
    if let Err(e) = fs::create_dir_all(&project_cache) {
        eprintln!(
            "Failed to create local app_cache: {}, falling back to temp_dir",
            e
        );
        let fallback = std::env::temp_dir().join("gallery_culling_cache");
        let _ = fs::create_dir_all(&fallback);
        fallback
    } else {
        project_cache
    }
}

/// 因此索引键与缓存文件名同源 —— 文件一变，键与文件名同步失效。
pub(super) fn file_fingerprint(file_path: &Path) -> (PathBuf, u64) {
    let abs_path = fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    let mtime = file_mtime_secs(file_path);
    (abs_path, mtime)
}

/// 取文件 mtime 的 Unix 秒数（缺省 0）。
///
/// 缓存新鲜度判定的输入。**必须与 `scanner::secs_from_meta` 分开**：那边收
/// 已经取好的 metadata，这边自己 stat；更重要的是缺省值语义不同 —— 这里 0
/// 表示「取不到时间戳」，与真实的 epoch 0 无法区分，因此缓存判定逻辑不接受
/// 「mtime == 0 就认为是最新的」这种写法。
pub(super) fn file_mtime_secs(file_path: &Path) -> u64 {
    fs::metadata(file_path)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        })
        .unwrap_or(0)
}

/// 用**已算好的**指纹拼出缓存文件路径（避免重复 `canonicalize`/`metadata`）。
/// 文件名格式与历史版本逐字一致（`{hash16}_{stem}_{width}_rot{orientation}.jpg`），
/// 因此不会让任何存量缓存失效。
pub(super) fn cache_path_for(
    abs_path: &Path,
    mtime: u64,
    file_path: &Path,
    width: u32,
    orientation: u32,
) -> PathBuf {
    let key = format!(
        "{}-{}-{}-{}-thumb-v2",
        abs_path.to_string_lossy(),
        mtime,
        width,
        orientation
    );
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    let stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let filename = format!("{}_{}_{}_rot{}.jpg", &hash[..16], stem, width, orientation);
    get_cache_dir().join(filename)
}

/* ------------------------------ 进程内间接索引 ------------------------------ */

/// 间接索引键：(规范化路径, mtime, 宽度)。**刻意不含 orientation** —— 缓存文件名
/// 里仍带 orientation（旋转后会重存，不能从键里去掉），但在文件内容不变（mtime 不变）
/// 时 orientation 是常量，所以用这个轻量键先查一次即可直接拿到上次算好的缓存路径。
#[derive(PartialEq, Eq, Hash, Clone, Debug)]
pub(super) struct ThumbIndexKey {
    pub(super) path: PathBuf,
    pub(super) mtime: u64,
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
