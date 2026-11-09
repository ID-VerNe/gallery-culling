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
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, OnceLock};

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
    mtime: u64,
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
