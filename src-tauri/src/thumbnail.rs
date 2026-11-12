mod cache;

pub use cache::get_cache_dir;
use cache::{
    cache_file_fresh, cache_file_usable, cache_path_for, drop_index, file_fingerprint,
    lookup_index, remember_index, ThumbIndexKey,
};

use fast_image_resize::images::Image as FirImage;
use fast_image_resize::{PixelType, Resizer};
use image::{DynamicImage, GenericImageView, ImageFormat, RgbImage};
use std::collections::HashMap;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, OnceLock};

/// Read orientation from EXIF (default 1)
pub fn read_orientation(file_path: &Path) -> u32 {
    // 打开+解析与 EXIF 主读法共用底层入口（issue #144）；「默认 1」语义留此处。
    let Some(exif) = crate::scanner::open_exif_reader(file_path) else {
        return 1;
    };
    if let Some(field) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
        if let Some(val) = field.value.get_uint(0) {
            return val;
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

/// 取相机内嵌缩略图（IFD1）的原始 JPEG 字节。
///
/// 偏移量语义（issue #193 墓碑）：`JPEGInterchangeFormat` 是**相对 TIFF 头**的
/// 偏移，不是相对文件起点。TIFF 容器（ARW/NEF/CR2）的 TIFF 头就在文件 0 处，
/// 两种读法碰巧等价；JPEG 容器里 TIFF 头在 APP1 段内（本机样本 `Exif\0\0`
/// 之后，即 12），从文件起点 seek 会整体错位 —— 解出「长度对、内容错」的字节，
/// 调用方 `image::load_from_memory` 必然失败，静默退回整图解码（实测 2.68s/张）。
///
/// 所以直接在 `exif.buf()`（kamadak-exif 读出的 TIFF 数据）上切片：两种容器
/// 同一套算法，且省掉二次开文件。`checked_add` + `get` 同时挡住不可信 length
/// （旧实现按文件里写的 length 直接 `vec![0u8; length]` 分配）。
pub fn embedded_thumbnail_bytes(exif: &exif::Exif) -> Option<&[u8]> {
    // Some cameras store JPEG thumbnail in IFD1
    let offset = exif
        .get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let length = exif
        .get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let end = offset.checked_add(length)?;
    exif.buf().get(offset..end)
}

/// Try to extract embedded thumbnail from EXIF
pub fn try_extract_exif_thumbnail(file_path: &Path) -> Option<Vec<u8>> {
    let exif = crate::scanner::open_exif_reader(file_path)?;
    Some(embedded_thumbnail_bytes(&exif)?.to_vec())
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

/* ------------------------------ issue #107 · PB：单飞 + 并发上限 ------------------------------ */

/// 单飞键：规范化路径 + 宽度（Orientation 是缓存文件的一部分，但同一源文件
/// 宽度固定时 Orientation 不变，故不进单飞键 —— 与索引键 `ThumbIndexKey` 同款）。
#[derive(PartialEq, Eq, Hash, Clone, Debug)]
struct FlightKey {
    path: std::path::PathBuf,
    width: u32,
}

/// 解码并发上限（issue #107 · PB）：200px 缩略图解码是 CPU 密集，Tokio
/// `spawn_blocking` 默认池很大，宫格快速滚动会起几十个并发解码。取 8 并发
/// （超限排队而非拒绝）：远大于细节渲染的 1:1（761MB/张，`detail_busy = 1`）,
/// 又不至于把核打满。磁盘/索引命中不占 permit。只有真生成才占。
const THUMB_MAX_CONCURRENT: usize = 8;

type ThumbResult = Result<String, String>;

enum ThumbFlightStatus {
    Running,
    Done(Option<ThumbResult>),
}

struct ThumbFlight {
    status: Mutex<ThumbFlightStatus>,
    cvar: Condvar,
}

static THUMB_FLIGHT: OnceLock<Mutex<HashMap<FlightKey, Arc<ThumbFlight>>>> = OnceLock::new();

fn flight_map() -> &'static Mutex<HashMap<FlightKey, Arc<ThumbFlight>>> {
    THUMB_FLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 按路径单飞：同 `(路径, 宽度)` 并发调用只执行一次 `gen`，其余等待并共享
/// 领跑者的结果（语义与前端 `dedupeAsync` 的 inflight 去重同款）。
///
/// 失败也共享：并发等待者拿到同一个 `Err`，而不是排队逐个重试 —— 前端
/// 「失败不缓存、重挂可重试」的下一轮 IPC 行为不变（flight 条目已移除）。
fn run_thumbnail_flight(key: &FlightKey, gen: impl FnOnce() -> ThumbResult) -> ThumbResult {
    let (slot, is_leader) = {
        let mut map = flight_map().lock().unwrap_or_else(|e| e.into_inner());
        match map.get(key) {
            Some(existing) => (existing.clone(), false),
            None => {
                let slot = Arc::new(ThumbFlight {
                    status: Mutex::new(ThumbFlightStatus::Running),
                    cvar: Condvar::new(),
                });
                map.insert(key.clone(), slot.clone());
                (slot, true)
            }
        }
    };

    // 领跑者守卫：`gen` panic / 提前 return 都必须放醒等待者，否则它们
    // 永久等在 Condvar 上（比本功能更糟 —— 一次 panic 让该路径永久不可用）。
    struct FlightLeaderGuard {
        slot: Arc<ThumbFlight>,
        key: FlightKey,
    }
    impl Drop for FlightLeaderGuard {
        fn drop(&mut self) {
            let mut status = self.slot.status.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(*status, ThumbFlightStatus::Running) {
                *status = ThumbFlightStatus::Done(None);
                self.slot.cvar.notify_all();
                let mut map = flight_map().lock().unwrap_or_else(|e| e.into_inner());
                if map
                    .get(&self.key)
                    .is_some_and(|a| Arc::ptr_eq(a, &self.slot))
                {
                    map.remove(&self.key);
                }
            }
        }
    }

    if is_leader {
        let _guard = FlightLeaderGuard {
            slot: slot.clone(),
            key: key.clone(),
        };
        let result = gen();
        {
            let mut status = slot.status.lock().unwrap_or_else(|e| e.into_inner());
            *status = ThumbFlightStatus::Done(Some(result.clone()));
        }
        slot.cvar.notify_all();
        {
            let mut map = flight_map().lock().unwrap_or_else(|e| e.into_inner());
            if map.get(key).is_some_and(|a| Arc::ptr_eq(a, &slot)) {
                map.remove(key);
            }
        }
        result
    } else {
        let mut status = slot.status.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            match &*status {
                ThumbFlightStatus::Done(Some(r)) => return r.clone(),
                ThumbFlightStatus::Done(None) => {
                    // 永不写入的兜底：领跑者 panic 导致状态未置 Done 前已
                    // 由 leader 的守卫置 Done(None)，等待者各自落到重跑。
                    return gen();
                }
                ThumbFlightStatus::Running => {
                    status = slot.cvar.wait(status).unwrap_or_else(|e| e.into_inner());
                }
            }
        }
    }
}

struct PermitPool {
    available: Mutex<u32>,
    cvar: Condvar,
}

static THUMB_POOL: OnceLock<PermitPool> = OnceLock::new();

fn thumbnail_pool() -> &'static PermitPool {
    THUMB_POOL.get_or_init(|| PermitPool {
        available: Mutex::new(THUMB_MAX_CONCURRENT as u32),
        cvar: Condvar::new(),
    })
}

/// 拿一个解码 permit（不足则阻塞排队），运行 `gen`，离开时归还。
fn with_thumbnail_permit<R>(gen: impl FnOnce() -> R) -> R {
    let pool = thumbnail_pool();
    {
        let mut avail = pool.available.lock().unwrap_or_else(|e| e.into_inner());
        while *avail == 0 {
            avail = pool.cvar.wait(avail).unwrap_or_else(|e| e.into_inner());
        }
        *avail -= 1;
    }
    let result = gen();
    {
        let mut avail = pool.available.lock().unwrap_or_else(|e| e.into_inner());
        *avail += 1;
        pool.cvar.notify_one();
    }
    result
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
    let flight_key = FlightKey {
        path: abs_path.clone(),
        width: target_width,
    };
    // 同路径并发只让一个线程真正生成，其余等待后复用内存索引/磁盘缓存。
    run_thumbnail_flight(&flight_key, || {
        get_or_create_thumbnail_single(
            file_path,
            target_width,
            &abs_path,
            mtime,
            &read_orientation_fn,
        )
    })
}

fn get_or_create_thumbnail_single(
    file_path: &Path,
    target_width: u32,
    abs_path: &Path,
    mtime: u128,
    read_orientation_fn: &impl Fn(&Path) -> u32,
) -> Result<String, String> {
    let index_key = ThumbIndexKey {
        path: abs_path.to_path_buf(),
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
    let cache_path = cache_path_for(abs_path, mtime, file_path, target_width, orientation);

    // ③ 磁盘命中（跨进程/重启后的首访）：严格校验后回写索引。
    if cache_file_fresh(&cache_path, file_path) {
        remember_index(index_key, &cache_path);
        return Ok(cache_path.to_string_lossy().to_string());
    }

    // ④ 生成：真解码才占 permit（命中路径不占）。
    with_thumbnail_permit(|| {
        generate_thumbnail(file_path, target_width, orientation, &cache_path, index_key)
    })
}

/// 真生成：优先相机内嵌缩略图，退回整图 SIMD 缩放（原 ④ 逐字）。
fn generate_thumbnail(
    file_path: &Path,
    target_width: u32,
    orientation: u32,
    cache_path: &Path,
    index_key: ThumbIndexKey,
) -> Result<String, String> {
    if let Some(thumb_bytes) = try_extract_exif_thumbnail(file_path) {
        if let Ok(thumb_img) = image::load_from_memory(&thumb_bytes) {
            let oriented = apply_orientation(thumb_img, orientation);
            let resized = resize_simd(&oriented, target_width)?;
            resized
                .save_with_format(cache_path, ImageFormat::Jpeg)
                .map_err(|e| format!("保存缩略图缓存失败: {}", e))?;
            remember_index(index_key, cache_path);
            return Ok(cache_path.to_string_lossy().to_string());
        }
    }

    // Full image fallback with SIMD resize
    let img = image::open(file_path)
        .map_err(|e| format!("无法打开图片进行缩放 ({}): {}", file_path.display(), e))?;

    let oriented = apply_orientation(img, orientation);
    let resized = resize_simd(&oriented, target_width)?;
    resized
        .save_with_format(cache_path, ImageFormat::Jpeg)
        .map_err(|e| format!("保存缩略图缓存失败: {}", e))?;

    remember_index(index_key, cache_path);
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

    /* -------------------- issue #107 · PB：单飞 + 并发上限 -------------------- */

    /// issue #107 PB 墓碑：同路径并发只生成一次，其余共享结果。
    /// 变异：去掉单飞（每次都直接跑 `gen`）必须红（计数会 > 1）。
    #[test]
    fn thumbnail_singleflight_same_path_shares_one_generation() {
        use std::sync::atomic::AtomicUsize as AUsize;
        let counter = std::sync::Arc::new(AUsize::new(0));
        let key = FlightKey {
            path: PathBuf::from("D:/shoot/shared.CR3"),
            width: 200,
        };
        let mut handles = Vec::new();
        for _ in 0..4 {
            let c = counter.clone();
            let k = key.clone();
            handles.push(std::thread::spawn(move || {
                run_thumbnail_flight(&k, || {
                    let n = c.fetch_add(1, Ordering::SeqCst) + 1;
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    Ok(format!("thumb-{n}"))
                })
            }));
        }
        let results: Vec<String> = handles
            .into_iter()
            .map(|h| h.join().expect("thread").expect("flight result"))
            .collect();
        assert_eq!(counter.load(Ordering::SeqCst), 1, "同路径只应生成一次");
        assert!(
            results.iter().all(|v| v == "thumb-1"),
            "并发调用必须共享同一结果"
        );
    }

    /// 不同路径不得互相串扰（单飞是路径级，不是全局单飞）。
    #[test]
    fn thumbnail_singleflight_different_paths_run_independently() {
        use std::sync::atomic::AtomicUsize as AUsize;
        let counter = std::sync::Arc::new(AUsize::new(0));
        let keys = vec![
            FlightKey {
                path: PathBuf::from("D:/shoot/a.CR3"),
                width: 200,
            },
            FlightKey {
                path: PathBuf::from("D:/shoot/b.CR3"),
                width: 200,
            },
        ];
        let mut handles = Vec::new();
        for k in keys {
            let c = counter.clone();
            handles.push(std::thread::spawn(move || {
                run_thumbnail_flight(&k, || {
                    let n = c.fetch_add(1, Ordering::SeqCst) + 1;
                    std::thread::sleep(std::time::Duration::from_millis(80));
                    Ok(format!("thumb-{n}"))
                })
            }));
        }
        for h in handles {
            let _ = h.join().expect("thread");
        }
        assert_eq!(counter.load(Ordering::SeqCst), 2, "不同路径各生成一次");
    }

    /// issue #107 PB 墓碑：解码并发上限为 8（超限排队，不拒绝）。
    /// 变异：把上限改成无上限必须红（观测到的最大并发会 > 8）。
    #[test]
    fn thumbnail_decode_concurrency_is_capped() {
        use std::sync::atomic::{AtomicUsize as AUsize, Ordering as O};
        let current = std::sync::Arc::new(AUsize::new(0));
        let max_seen = std::sync::Arc::new(AUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..16 {
            let cur = current.clone();
            let max = max_seen.clone();
            handles.push(std::thread::spawn(move || {
                with_thumbnail_permit(|| {
                    let n = cur.fetch_add(1, O::SeqCst) + 1;
                    loop {
                        let m = max.load(O::SeqCst);
                        if n > m && max.compare_exchange(m, n, O::SeqCst, O::SeqCst).is_ok() {
                            break;
                        }
                        if n <= m {
                            break;
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(90));
                    cur.fetch_sub(1, O::SeqCst);
                });
            }));
        }
        for h in handles {
            h.join().expect("thread");
        }
        let peak = max_seen.load(O::SeqCst);
        // 硬编码 8 而非 `THUMB_MAX_CONCURRENT`：变异放大常量时断言必须红，
        // 否则测试会跟着常量一起放宽（无效变异）。
        assert!(peak <= 8, "并发峰值 {peak} 必须 ≤ 8");
        assert!(peak > 1, "上限应允许真实并发，而非串行");
        assert_eq!(current.load(O::SeqCst), 0, "permit 必须全部归还");
    }

    /* -------------------- issue #107 · PA：跨进程磁盘命中不重生成 -------------------- */

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// issue #107 PA 墓碑：进程内索引清空（模拟重启）后，磁盘命中不得重解码/重写盘。
    /// 用真 JPEG + 隔离目录（`GALLERY_DATA_DIR`）验证：两次结果同路径、文件 mtime 不变。
    #[test]
    fn thumbnail_disk_hit_after_restart_does_not_regenerate() {
        use std::sync::Mutex as StdMutex;
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("gfx_diskhit107_{}_{}", std::process::id(), seq));
        let data_dir = root.join("data");
        let src_dir = root.join("src");
        std::fs::create_dir_all(&src_dir).expect("create src dir");
        // 真 JPEG 源（placeholder 字节解不出图，走不完缓存路径）。
        let src = src_dir.join("photo107.jpg");
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(400, 300, image::Rgb([12, 34, 56])));
        img.save(&src).expect("save source jpg");

        let prev = std::env::var_os(crate::db::DATA_DIR_ENV);
        std::env::set_var(crate::db::DATA_DIR_ENV, &data_dir);
        // 计数闭包只为守卫：根守卫在作用域内恢复 env（panic 也恢复）。
        struct EnvGuard(Option<std::ffi::OsString>);
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                match &self.0 {
                    Some(v) => std::env::set_var(crate::db::DATA_DIR_ENV, v),
                    None => std::env::remove_var(crate::db::DATA_DIR_ENV),
                }
            }
        }
        let _guard = EnvGuard(prev);

        let first = get_or_create_thumbnail(&src, 200).expect("首次生成");
        let cache_path = PathBuf::from(&first);
        assert!(
            cache_path.starts_with(&data_dir),
            "缓存必须落在隔离目录 {}，实际 {}",
            data_dir.display(),
            cache_path.display()
        );
        let meta0 = std::fs::metadata(&cache_path).expect("cache meta");
        let mtime0 = meta0.modified().expect("cache mtime");
        let len0 = meta0.len();

        // 模拟进程重启：清掉内存索引，只剩磁盘。
        let (abs, mtime) = file_fingerprint(&src);
        drop_index(&ThumbIndexKey {
            path: abs.clone(),
            mtime,
            width: 200,
        });
        // 等跨过文件系统 mtime 粒度（秒级）：若第二次真重写，mtime 必前进。
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let second = get_or_create_thumbnail(&src, 200).expect("磁盘命中");
        assert_eq!(first, second, "磁盘命中必须返回同一缓存路径");
        let meta1 = std::fs::metadata(&cache_path).expect("cache meta after");
        assert_eq!(len0, meta1.len(), "磁盘命中不得重写文件");
        assert_eq!(
            mtime0,
            meta1.modified().expect("mtime"),
            "磁盘命中不得重生成（mtime 变了说明重写盘了）"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _: StdMutex<()> = StdMutex::new(());
    }

    /// issue #142 墓碑：同秒覆写（mtime 只前进 500ms、秒数不变）必须重新生成，
    /// 不能命中进程内索引返回旧图。基线（秒级指纹 + 索引命中只查
    /// `cache_file_usable`）下第二次调用读 0 次 orientation、返回同一路径旧字节 → 红。
    #[test]
    fn thumbnail_same_second_rewrite_regenerates() {
        use std::time::{Duration, UNIX_EPOCH};
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let seq = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("gfx_samesecond142_{}_{}", std::process::id(), seq));
        let data_dir = root.join("data");
        let src_dir = root.join("src");
        std::fs::create_dir_all(&src_dir).expect("create src dir");
        let src = src_dir.join("photo142.jpg");

        // 固定同一秒内的两个时刻：首次 +100ms，覆写后 +600ms（秒相同、纳秒不同）。
        let base = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let write_src = |rgb: image::Rgb<u8>| {
            let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(400, 300, rgb));
            img.save(&src).expect("save source jpg");
        };
        let set_mtime = |t: std::time::SystemTime| {
            std::fs::File::options()
                .write(true)
                .open(&src)
                .expect("open for set_modified")
                .set_modified(t)
                .expect("set mtime");
        };

        write_src(image::Rgb([200, 30, 30]));
        set_mtime(base + Duration::from_millis(100));

        let prev = std::env::var_os(crate::db::DATA_DIR_ENV);
        std::env::set_var(crate::db::DATA_DIR_ENV, &data_dir);
        struct EnvGuard(Option<std::ffi::OsString>);
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                match &self.0 {
                    Some(v) => std::env::set_var(crate::db::DATA_DIR_ENV, v),
                    None => std::env::remove_var(crate::db::DATA_DIR_ENV),
                }
            }
        }
        let _guard = EnvGuard(prev);

        let first = get_or_create_thumbnail(&src, 200).expect("首次生成");
        let first_bytes = std::fs::read(&first).expect("read first thumb");
        assert!(
            PathBuf::from(&first).starts_with(&data_dir),
            "缓存必须落在隔离目录 {}",
            data_dir.display()
        );

        // 同秒覆写：换像素 + mtime 只前进 500ms。
        write_src(image::Rgb([30, 200, 30]));
        set_mtime(base + Duration::from_millis(600));

        let reads = Cell::new(0u32);
        let second = get_or_create_thumbnail_with(&src, 200, |_| {
            reads.set(reads.get() + 1);
            1
        })
        .expect("覆写后生成");

        assert_eq!(
            reads.get(),
            1,
            "同秒覆写必须落到未命中分支（读一次 orientation）；索引命中读 0 次即 stale"
        );
        assert_ne!(
            second, first,
            "同秒覆写必须换缓存路径（纳秒指纹进 payload）"
        );
        let second_bytes = std::fs::read(&second).expect("read second thumb");
        assert_ne!(
            second_bytes, first_bytes,
            "同秒覆写后缩略图内容必须已换，不能返回旧字节"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 存量缓存兼容性的硬证明（issue #142 修订）：自 thumb-v3 起，指纹改纳秒、
    /// payload 后缀 `thumb-v2` → `thumb-v3`，旧缓存**有意一次性失效**（懒重生成，
    /// 论证见 PR/plan）。本测试用独立复算的 v3 算法锁住新口径，并断言它与
    /// v2 旧算法确实不同，防止有人静默回退到秒级键。
    #[test]
    fn cache_path_matches_thumb_v3_algorithm() {
        use sha2::Digest as _;
        use std::time::UNIX_EPOCH;
        let src = unique_temp_file("legacy");

        let (abs, mtime_nanos) = {
            let a = std::fs::canonicalize(&src).unwrap_or_else(|_| src.clone());
            let nanos = std::fs::metadata(&src)
                .and_then(|m| m.modified())
                .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos())
                .unwrap_or(0);
            (a, nanos)
        };
        let hash16 = |key: String| {
            let mut hasher = sha2::Sha256::new();
            hasher.update(key.as_bytes());
            format!("{:x}", hasher.finalize())
        };
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
        let v3 = {
            let key = format!(
                "{}-{}-{}-{}-thumb-v3",
                abs.to_string_lossy(),
                mtime_nanos,
                200u32,
                1u32
            );
            let hash = hash16(key);
            let filename = format!("{}_{}_{}_rot{}.jpg", &hash[..16], stem, 200u32, 1u32);
            get_cache_dir().join(filename)
        };
        let v2_legacy = {
            let mtime_secs = std::fs::metadata(&src)
                .and_then(|m| m.modified())
                .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs())
                .unwrap_or(0);
            let key = format!(
                "{}-{}-{}-{}-thumb-v2",
                abs.to_string_lossy(),
                mtime_secs,
                200u32,
                1u32
            );
            let hash = hash16(key);
            let filename = format!("{}_{}_{}_rot{}.jpg", &hash[..16], stem, 200u32, 1u32);
            get_cache_dir().join(filename)
        };

        let (abs2, mtime2) = file_fingerprint(&src);
        assert_eq!(abs2, abs);
        assert_eq!(
            cache_path_for(&abs2, mtime2, &src, 200, 1),
            v3,
            "thumb-v3 纳秒口径必须与独立复算一致"
        );
        assert_ne!(
            v3, v2_legacy,
            "thumb-v3 必须与 v2 秒级旧算法不同（有意失效，不得静默复用旧缓存）"
        );
        cleanup_temp(&src);
    }
}

/* -------------------- issue #193：内嵌缩略图偏移按 TIFF 头，不按文件起点 -------------------- */

#[cfg(test)]
mod embedded_thumbnail_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    /// 合成最小 JPEG：SOI + APP1(`Exif\0\0` + TIFF) + EOI。
    /// TIFF 布局：header 8B → IFD0@8（0 条 + next）→ IFD1@14（2 条 + next）→ blob@44。
    /// TIFF 头在文件 **12** 处（`Exif\0\0` 之后），与真机 JPEG 同构。
    fn synthetic_jpeg_with_ifd1_thumb(blob: &[u8], len_override: Option<u32>) -> Vec<u8> {
        const BLOB_OFF: usize = 44;
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II\x2a\x00");
        tiff.extend_from_slice(&8u32.to_le_bytes());
        // IFD0 @8：0 条，next 指向 IFD1
        tiff.extend_from_slice(&0u16.to_le_bytes());
        tiff.extend_from_slice(&14u32.to_le_bytes());
        // IFD1 @14：JPEGInterchangeFormat / JPEGInterchangeFormatLength
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&0x0201u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&(BLOB_OFF as u32).to_le_bytes());
        tiff.extend_from_slice(&0x0202u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&len_override.unwrap_or(blob.len() as u32).to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(tiff.len(), BLOB_OFF, "夹具布局漂移：blob 必须紧接 IFD1");
        tiff.extend_from_slice(blob);

        let mut out = Vec::new();
        out.extend_from_slice(&[0xFF, 0xD8]); // SOI
        out.extend_from_slice(&[0xFF, 0xE1]); // APP1
        let seg_len = (2 + 6 + tiff.len()) as u16;
        out.extend_from_slice(&seg_len.to_be_bytes());
        out.extend_from_slice(b"Exif\x00\x00");
        out.extend_from_slice(&tiff);
        out.extend_from_slice(&[0xFF, 0xD9]); // EOI
        out
    }

    fn write_temp(tag: &str, bytes: &[u8]) -> PathBuf {
        let seq = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("gfx_emb193_{}_{}_{}", std::process::id(), tag, seq));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(format!("{}.jpg", tag));
        std::fs::write(&path, bytes).expect("write fixture");
        path
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    }

    /// issue #193 墓碑：取出的字节必须与写入的内嵌 blob **逐字节相同**。
    /// 变异：把切片基准改回「文件起点 offset」（`&bytes[offset..]`）必须红 ——
    /// 那样会错开 `Exif\0\0` 的 12 字节，返回的是 blob 中段。
    #[test]
    fn thumb_bytes_use_tiff_base_not_file_offset() {
        let blob: Vec<u8> = b"\xff\xd8IFD1-EMBEDDED-THUMBNAIL\xff\xd9".to_vec();
        let path = write_temp("ok", &synthetic_jpeg_with_ifd1_thumb(&blob, None));

        let got = try_extract_exif_thumbnail(&path).expect("合成夹具必须能取到内嵌缩略图");
        assert_eq!(got, blob, "内嵌字节必须原样返回（偏移相对 TIFF 头）");

        cleanup(&path);
    }

    /// 越界长度不得 panic / 不得分配：返回 None，交给整图解码兜底。
    #[test]
    fn oversized_length_returns_none() {
        let blob = b"\xff\xd8tiny\xff\xd9";
        let path = write_temp(
            "overflow",
            &synthetic_jpeg_with_ifd1_thumb(blob, Some(64 * 1024 * 1024)),
        );

        assert_eq!(
            try_extract_exif_thumbnail(&path),
            None,
            "length 超出 TIFF 数据范围必须返回 None"
        );

        cleanup(&path);
    }

    /// 真机冒烟：`GALLERY_REAL_RAW_DIR=<含 ARW+JPG 的目录>` 后
    /// `cargo test --lib real_embedded_thumbnail -- --ignored --nocapture`。
    /// 断言 JPG 与 ARW 都能取到可解码的内嵌图（#193 修复前 JPG 必红）。
    #[test]
    #[ignore = "需要真实素材：设置 GALLERY_REAL_RAW_DIR 后加 --ignored 运行"]
    fn real_embedded_thumbnail_decodes_for_jpg_and_raw() {
        let Ok(dir) = std::env::var("GALLERY_REAL_RAW_DIR") else {
            println!("[real_embedded] 未设置 GALLERY_REAL_RAW_DIR，跳过");
            return;
        };
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("read real dir").flatten() {
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext != "jpg" && ext != "arw" {
                continue;
            }
            let t0 = std::time::Instant::now();
            let bytes = try_extract_exif_thumbnail(&path)
                .unwrap_or_else(|| panic!("内嵌缩略图缺失: {}", path.display()));
            let img = image::load_from_memory(&bytes)
                .unwrap_or_else(|e| panic!("内嵌缩略图解码失败 {}: {e}", path.display()));
            println!(
                "[real_embedded] {} ext={} bytes={} dims={:?} cost={:?}",
                path.file_name().unwrap().to_string_lossy(),
                ext,
                bytes.len(),
                img.dimensions(),
                t0.elapsed()
            );
            checked += 1;
            if checked >= 4 {
                break;
            }
        }
        assert!(checked > 0, "GALLERY_REAL_RAW_DIR 下没找到 jpg/arw");
    }
}
