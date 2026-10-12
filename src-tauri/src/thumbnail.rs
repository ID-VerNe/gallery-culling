use fast_image_resize::images::Image as FirImage;
use fast_image_resize::{PixelType, Resizer};
use image::{DynamicImage, GenericImageView, ImageFormat, RgbImage};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

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

/// Read orientation from EXIF (default 1)
pub fn read_orientation(file_path: &Path) -> u32 {
    let file = match File::open(file_path) {
        Ok(f) => f,
        Err(_) => return 1,
    };
    let mut buf_reader = BufReader::new(file);
    let exifreader = exif::Reader::new();
    if let Ok(exif) = exifreader.read_from_container(&mut buf_reader) {
        if let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
            if let Some(val) = field.value.get_uint(0) {
                return val;
            }
        }
    }
    1
}

/// Apply physical orientation transformation to DynamicImage
pub fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// 源文件指纹：规范化绝对路径 + mtime（秒）。
///
/// 与 `cache_path_for` 用的是同一套口径（`canonicalize` + `modified().as_secs()`），
/// 因此索引键与缓存文件名同源 —— 文件一变，键与文件名同步失效。
fn file_fingerprint(file_path: &Path) -> (PathBuf, u64) {
    let abs_path = fs::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
    let mtime = fs::metadata(file_path)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        })
        .unwrap_or(0);
    (abs_path, mtime)
}

/// 用**已算好的**指纹拼出缓存文件路径（避免重复 `canonicalize`/`metadata`）。
/// 文件名格式与历史版本逐字一致（`{hash16}_{stem}_{width}_rot{orientation}.jpg`），
/// 因此不会让任何存量缓存失效。
fn cache_path_for(
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
struct ThumbIndexKey {
    path: PathBuf,
    mtime: u64,
    width: u32,
}

/// 进程内索引：`ThumbIndexKey -> 缓存文件路径`。
///
/// 目的：缓存命中时**跳过 `read_orientation`（打开文件 + 解析 EXIF）与 sha256 键
/// 哈希**。索引只在内存里、不写盘、也不改任何已有缓存文件名 —— 进程重启后自动重建，
/// 存量缓存 100% 兼容。文件一变（mtime 变）即换键，相当于自动失效。
static THUMB_INDEX: OnceLock<RwLock<HashMap<ThumbIndexKey, PathBuf>>> = OnceLock::new();

fn thumb_index() -> &'static RwLock<HashMap<ThumbIndexKey, PathBuf>> {
    THUMB_INDEX.get_or_init(|| RwLock::new(HashMap::new()))
}

fn lookup_index(key: &ThumbIndexKey) -> Option<PathBuf> {
    thumb_index().read().ok()?.get(key).cloned()
}

fn remember_index(key: ThumbIndexKey, cache_path: &Path) {
    if let Ok(mut map) = thumb_index().write() {
        map.insert(key, cache_path.to_path_buf());
    }
}

fn drop_index(key: &ThumbIndexKey) {
    if let Ok(mut map) = thumb_index().write() {
        map.remove(key);
    }
}

/// 缓存文件是否"可用"（存在且非空）。命中判定与磁盘校验共用的最低门槛。
fn cache_file_usable(cache_path: &Path) -> bool {
    fs::metadata(cache_path).map(|m| m.len() > 0).unwrap_or(false)
}

/// 磁盘命中时的严格校验：缓存比源文件新且非空（沿用历史逻辑）。
fn cache_file_fresh(cache_path: &Path, file_path: &Path) -> bool {
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

/// Try to extract embedded thumbnail from EXIF
pub fn try_extract_exif_thumbnail(file_path: &Path) -> Option<Vec<u8>> {
    let file = File::open(file_path).ok()?;
    let mut buf_reader = BufReader::new(file);
    let exifreader = exif::Reader::new();
    let exif = exifreader.read_from_container(&mut buf_reader).ok()?;

    // Some cameras store JPEG thumbnail in IFD1
    if let Some(offset_field) =
        exif.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)
    {
        if let Some(length_field) =
            exif.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)
        {
            if let (Some(offset), Some(length)) = (
                offset_field.value.get_uint(0),
                length_field.value.get_uint(0),
            ) {
                use std::io::{Read, Seek, SeekFrom};
                let mut file = File::open(file_path).ok()?;
                file.seek(SeekFrom::Start(offset as u64)).ok()?;
                let mut thumb_buf = vec![0u8; length as usize];
                if file.read_exact(&mut thumb_buf).is_ok() {
                    return Some(thumb_buf);
                }
            }
        }
    }
    None
}

/// Fast downsample using fast_image_resize SIMD
pub fn resize_simd(img: &DynamicImage, target_width: u32) -> Result<RgbImage, String> {
    let (src_w, src_h) = img.dimensions();
    if src_w == 0 || src_h == 0 {
        return Err("Invalid image dimensions".to_string());
    }

    let scale = target_width as f64 / src_w as f64;
    let target_height = ((src_h as f64 * scale).round() as u32).max(1);

    let rgb = img.to_rgb8();
    let src_bytes = rgb.into_raw();

    let src_image = FirImage::from_vec_u8(src_w, src_h, src_bytes, PixelType::U8x3)
        .map_err(|e| format!("Fir source image error: {:?}", e))?;

    let mut dst_image = FirImage::new(target_width, target_height, PixelType::U8x3);

    let mut resizer = Resizer::new();
    resizer
        .resize(&src_image, &mut dst_image, None)
        .map_err(|e| format!("Resize error: {:?}", e))?;

    let dst_bytes = dst_image.into_vec();
    RgbImage::from_raw(target_width, target_height, dst_bytes)
        .ok_or_else(|| "Failed to construct RgbImage from resized bytes".to_string())
}

/// Generate or retrieve thumbnail path with automatic orientation correction
pub fn get_or_create_thumbnail(file_path: &Path, target_width: u32) -> Result<String, String> {
    get_or_create_thumbnail_with(file_path, target_width, read_orientation)
}

/// 与 [`get_or_create_thumbnail`] 相同，但 orientation 读取可注入 —— 仅为可测试性：
/// 测试传入计数闭包，即可断言"索引命中时不再读 EXIF"（不碰 lumen.rs、不引新依赖）。
///
/// 顺序（N-09 的关键）：**先查进程内索引，命中直接返回**；只有未命中才读
/// orientation、算 sha256、走磁盘校验与生成。原实现无论命中与否都先 `read_orientation`
/// （打开文件 + 解析 EXIF），缓存命中时也白付这份成本。
fn get_or_create_thumbnail_with(
    file_path: &Path,
    target_width: u32,
    read_orientation_fn: impl Fn(&Path) -> u32,
) -> Result<String, String> {
    if !file_path.exists() {
        return Err(format!("文件不存在: {}", file_path.display()));
    }

    let (abs_path, mtime) = file_fingerprint(file_path);
    let index_key = ThumbIndexKey {
        path: abs_path.clone(),
        mtime,
        width: target_width,
    };

    // ① 间接索引命中：跳过 orientation 重读与哈希，直接返回上次算好的缓存路径。
    if let Some(cached) = lookup_index(&index_key) {
        if cache_file_usable(&cached) {
            return Ok(cached.to_string_lossy().to_string());
        }
        // 缓存被外部清理/清空：移除失效项，落到重建分支。
        drop_index(&index_key);
    }

    // ② 未命中：才读 orientation（它是缓存键的一部分，旋转后会重存，不能省略）。
    let orientation = read_orientation_fn(file_path);
    let cache_path = cache_path_for(&abs_path, mtime, file_path, target_width, orientation);

    // ③ 磁盘命中（跨进程/重启后的首访）：严格校验后回写索引。
    if cache_file_fresh(&cache_path, file_path) {
        remember_index(index_key, &cache_path);
        return Ok(cache_path.to_string_lossy().to_string());
    }

    // ④ 生成缩略图：优先相机内嵌缩略图，退回整图 SIMD 缩放。
    if let Some(thumb_bytes) = try_extract_exif_thumbnail(file_path) {
        if let Ok(thumb_img) = image::load_from_memory(&thumb_bytes) {
            let oriented = apply_orientation(thumb_img, orientation);
            let resized = resize_simd(&oriented, target_width)?;
            resized
                .save_with_format(&cache_path, ImageFormat::Jpeg)
                .map_err(|e| format!("保存缩略图缓存失败: {}", e))?;
            remember_index(index_key, &cache_path);
            return Ok(cache_path.to_string_lossy().to_string());
        }
    }

    // Full image fallback with SIMD resize
    let img = image::open(file_path)
        .map_err(|e| format!("无法打开图片进行缩放 ({}): {}", file_path.display(), e))?;

    let oriented = apply_orientation(img, orientation);
    let resized = resize_simd(&oriented, target_width)?;
    resized
        .save_with_format(&cache_path, ImageFormat::Jpeg)
        .map_err(|e| format!("保存缩略图缓存失败: {}", e))?;

    remember_index(index_key, &cache_path);
    Ok(cache_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, RgbImage};

    #[test]
    fn test_resize_simd() {
        let raw_img = RgbImage::new(400, 300);
        let dyn_img = DynamicImage::ImageRgb8(raw_img);
        let resized = resize_simd(&dyn_img, 100).expect("SIMD resize should succeed");
        assert_eq!(resized.width(), 100);
        assert_eq!(resized.height(), 75);
    }

    #[test]
    fn test_apply_orientation() {
        let raw_img = RgbImage::new(400, 300); // 400 wide, 300 high
        let dyn_img = DynamicImage::ImageRgb8(raw_img);
        // Orientation 6: Rotate 90 CW => 300 wide, 400 high
        let rotated = apply_orientation(dyn_img, 6);
        assert_eq!(rotated.width(), 300);
        assert_eq!(rotated.height(), 400);

        let resized = resize_simd(&rotated, 150).expect("Resize portrait image");
        assert_eq!(resized.width(), 150);
        assert_eq!(resized.height(), 200);
    }

    /* -------------------- N-09：缓存命中短路（不重读 orientation） -------------------- */

    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

    /// 造一个唯一的临时文件，避免并行测试互相踩索引/文件。
    fn unique_temp_file(tag: &str) -> PathBuf {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "gfx_thumb_test_{}_{}_{}",
            std::process::id(),
            tag,
            seq
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(format!("{}.jpg", tag));
        std::fs::write(&path, b"placeholder-bytes").expect("write temp file");
        path
    }

    fn cleanup_temp(path: &Path) {
        let _ = std::fs::remove_file(path);
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    }

    #[test]
    fn thumbnail_index_hit_skips_orientation_read() {
        let src = unique_temp_file("hit");
        let (abs, mtime) = file_fingerprint(&src);
        let key = ThumbIndexKey {
            path: abs,
            mtime,
            width: 200,
        };
        // 预置索引：把文件自身当作"已存在的非空缓存"，制造一次命中。
        remember_index(key.clone(), &src);

        let reads = Cell::new(0u32);
        let out = get_or_create_thumbnail_with(&src, 200, |_| {
            reads.set(reads.get() + 1);
            1
        });

        assert_eq!(reads.get(), 0, "索引命中时不得重读 orientation（EXIF）");
        assert_eq!(
            out.expect("索引命中应直接返回缓存路径"),
            src.to_string_lossy().to_string()
        );

        drop_index(&key);
        cleanup_temp(&src);
    }

    #[test]
    fn thumbnail_index_miss_reads_orientation_once() {
        let src = unique_temp_file("miss");
        let (abs, mtime) = file_fingerprint(&src);
        // 清掉可能存在的陈旧索引项，确保走未命中分支。
        drop_index(&ThumbIndexKey {
            path: abs,
            mtime,
            width: 200,
        });

        let reads = Cell::new(0u32);
        // 占位文件不是真图片：生成会失败，但"读了一次 orientation"不受返回值影响。
        let res = get_or_create_thumbnail_with(&src, 200, |_| {
            reads.set(reads.get() + 1);
            1
        });

        assert_eq!(reads.get(), 1, "未命中时必须读一次 orientation");
        assert!(res.is_err(), "占位文件无法生成缩略图，应报错");

        cleanup_temp(&src);
    }

    #[test]
    fn thumbnail_index_key_distinguishes_width_and_mtime() {
        let base = ThumbIndexKey {
            path: PathBuf::from("D:/x/a.CR3"),
            mtime: 10,
            width: 200,
        };
        let other_width = ThumbIndexKey {
            path: PathBuf::from("D:/x/a.CR3"),
            mtime: 10,
            width: 400,
        };
        let other_mtime = ThumbIndexKey {
            path: PathBuf::from("D:/x/a.CR3"),
            mtime: 11,
            width: 200,
        };
        assert_ne!(base, other_width, "宽度变化必须换键");
        assert_ne!(base, other_mtime, "源文件 mtime 变化必须换键（自动失效）");
        assert_eq!(
            base.clone(),
            ThumbIndexKey {
                path: PathBuf::from("D:/x/a.CR3"),
                mtime: 10,
                width: 200,
            }
        );
    }

    #[test]
    fn cache_path_format_is_unchanged() {
        // 重构缓存路径算法后文件名格式必须逐字不变，否则存量缓存会全部失效。
        let src = unique_temp_file("cachepath");
        let (abs, mtime) = file_fingerprint(&src);
        let p = cache_path_for(&abs, mtime, &src, 200, 6);
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(
            name.ends_with("_200_rot6.jpg"),
            "文件名须保持 <hash16>_<stem>_<w>_rot<o>.jpg，实际: {}",
            name
        );
        // 同一输入可复现（含 mtime/orientation 的确定性）。
        assert_eq!(p, cache_path_for(&abs, mtime, &src, 200, 6));
        cleanup_temp(&src);
    }

    /// 存量缓存兼容性的硬证明：用**旧算法**（重构前逐字）复算缓存文件名，断言与
    /// 重构后的 `cache_path_for` 完全一致。若不一致，说明已有缓存会被整体作废。
    #[test]
    fn cache_path_matches_legacy_algorithm() {
        use sha2::Digest as _;
        let src = unique_temp_file("legacy");

        let legacy = {
            let abs = std::fs::canonicalize(&src).unwrap_or_else(|_| src.clone());
            let mtime = std::fs::metadata(&src)
                .and_then(|m| m.modified())
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                })
                .unwrap_or(0);
            let key = format!(
                "{}-{}-{}-{}-thumb-v2",
                abs.to_string_lossy(),
                mtime,
                200u32,
                1u32
            );
            let mut hasher = sha2::Sha256::new();
            hasher.update(key.as_bytes());
            let hash = format!("{:x}", hasher.finalize());
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
            let filename = format!("{}_{}_{}_rot{}.jpg", &hash[..16], stem, 200u32, 1u32);
            get_cache_dir().join(filename)
        };

        let (abs, mtime) = file_fingerprint(&src);
        assert_eq!(
            cache_path_for(&abs, mtime, &src, 200, 1),
            legacy,
            "重构后的缓存文件名必须与旧算法逐字一致（否则存量缓存全部失效）"
        );
        cleanup_temp(&src);
    }
}
