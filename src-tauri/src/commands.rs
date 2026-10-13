use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, State};

use crate::db::Database;
use crate::lumen::{self, LumenError, LumenStatus, PreviewVariant, PINNED_LUMEN_VERSION};
use crate::models::{
    AppSettings, ExportItem, FolderScanResult, LumenMaskResult, LumenPreviewResult,
    LumenRatingConflict, LumenRatingSync, LumenRecipe, MaskAdjustments, ToneAdjustments, ToneState,
    ToneWriteReport,
};
use crate::scanner::scan_folders;
use crate::thumbnail::{get_cache_dir, get_or_create_thumbnail};
use crate::xmp;
use crate::xmp::{flag_from_xmp, read_xmp_full, update_xmp_metadata, write_xmp};

pub struct AppState {
    pub db: Database,
    /// LUMEN RAW 常驻运行时（A 通道）：spawn 一次、握手、复用
    pub lumen: lumen::LumenRuntime,
    /// 扫描取消标志（协作式轮询）。置位后扫描在下一个安全点尽早返回。
    pub scan_cancel: Arc<AtomicBool>,
    /// 导出取消标志（协作式轮询）。置位后导出丢弃临时目录，目标目录零污染。
    pub export_cancel: Arc<AtomicBool>,
}

/// `scan-progress` 事件负载。字段名即前端读取的键（都是单词，保持小写）。
#[derive(Clone, serde::Serialize)]
pub struct ScanProgress {
    /// 阶段："enumerate" | "read" | "sort" | "done"
    pub phase: String,
    /// 当前阶段已处理数
    pub processed: usize,
    /// 当前阶段总数（枚举阶段未知时为 0）
    pub total: usize,
}

/// `export-progress` 事件负载。
#[derive(Clone, serde::Serialize)]
pub struct ExportProgress {
    pub processed: usize,
    pub total: usize,
    /// 当前项名称（`ExportItem.base_name`），供 UI 显示"正在导出 xxx"
    pub current: String,
}

/// 进度节流器。
///
/// 万张规模下每张都 `emit` 会淹掉 IPC（前端主线程忙于解码事件），因此只在
/// **阶段切换 / 首个 / 末个 / 累计 ≥32 项 / 距上次 ≥80ms** 时放行一次。
struct ProgressThrottle {
    last_emit: std::time::Instant,
    last_count: usize,
    last_phase: String,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            last_emit: std::time::Instant::now(),
            last_count: 0,
            last_phase: String::new(),
        }
    }

    fn should_emit(&mut self, phase: &str, processed: usize, total: usize) -> bool {
        let phase_changed = phase != self.last_phase.as_str();
        let due = self.last_emit.elapsed() >= Duration::from_millis(80)
            || processed.saturating_sub(self.last_count) >= 32
            || processed == 0
            || (total > 0 && processed >= total);
        if phase_changed || due {
            self.last_emit = std::time::Instant::now();
            self.last_count = processed;
            self.last_phase = phase.to_string();
            true
        } else {
            false
        }
    }
}

/// 当前 Unix 秒（清单文件用）。
fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 请求取消正在进行的扫描（幂等：没有进行中的任务时调用也安全）。
#[tauri::command]
pub fn cancel_scan_cmd(state: State<'_, AppState>) -> Result<(), String> {
    state.scan_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// 请求取消正在进行的导出（幂等）。取消后目标目录不会残留半成品。
#[tauri::command]
pub fn cancel_export_cmd(state: State<'_, AppState>) -> Result<(), String> {
    state.export_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn scan_folders_cmd(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    jpg_folder: String,
    raw_folder: Option<String>,
    sort_order: Option<String>,
) -> Result<FolderScanResult, String> {
    let sort = sort_order.unwrap_or_else(|| "time_filename".to_string());
    let cancel = state.scan_cancel.clone();
    cancel.store(false, Ordering::SeqCst); // 复位上一轮遗留的取消标志

    // 首帧进度：让 UI 立刻切到"扫描中"并显示阶段，而不是干等到枚举结束
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            phase: "enumerate".to_string(),
            processed: 0,
            total: 0,
        },
    );

    let app_for_progress = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut throttle = ProgressThrottle::new();
        scan_folders(
            &jpg_folder,
            raw_folder.as_deref(),
            &sort,
            &cancel,
            |phase, processed, total| {
                if throttle.should_emit(phase, processed, total) {
                    let _ = app_for_progress.emit(
                        "scan-progress",
                        ScanProgress {
                            phase: phase.to_string(),
                            processed,
                            total,
                        },
                    );
                }
            },
        )
    })
    .await
    .map_err(|e| format!("扫描任务异常: {}", e))??;

    // 收尾进度：UI 据此把进度条推到 100%
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            phase: "done".to_string(),
            processed: result.total_count,
            total: result.total_count,
        },
    );
    Ok(result)
}

#[tauri::command]
pub async fn get_thumbnail_cmd(file_path: String, width: Option<u32>) -> Result<String, String> {
    let target_width = width.unwrap_or(200);
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        get_or_create_thumbnail(path, target_width)
    })
    .await
    .map_err(|e| format!("生成缩略图任务异常: {}", e))?
}

#[tauri::command]
pub async fn update_rating_flag_cmd(
    state: State<'_, AppState>,
    file_path: String,
    rating: u8,
    flag: String,
    sync_xmp: bool,
) -> Result<bool, String> {
    let runtime = state.lumen.clone();
    let settings = state.db.load_settings()?;
    let db = state.db.clone();

    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if sync_xmp {
            write_xmp(path, rating, &flag)?;
        }

        // 评级同步（P1）：引擎启用时推给 LUMEN RAW。
        // 失败只记账不回滚 —— 宿主 XMP 已写成功，UI 不该因 sidecar 抖动而回退。
        if settings.lumen_enabled && lumen::should_push_rating(rating, &flag) {
            if let Some(exe) = lumen::find_lumen_cli(&settings.lumen_cli_path) {
                match runtime.push_rating(&exe, path, rating, &flag) {
                    Ok(()) => {
                        let xmp = xmp::get_xmp_path(path);
                        let _ = db.upsert_rating_sync(
                            &file_path,
                            rating,
                            &flag,
                            "host",
                            crate::db::file_mtime_secs(&xmp),
                        );
                    }
                    Err(e) => {
                        eprintln!("LUMEN RAW 评级推送失败（已忽略）: {}", e);
                    }
                }
            }
        }
        Ok(true)
    })
    .await
    .map_err(|e| format!("更新评级任务异常: {}", e))?
}

#[tauri::command]
pub async fn batch_update_metadata_cmd(
    file_paths: Vec<String>,
    lens_model: Option<String>,
    focal_length: Option<String>,
    aperture: Option<String>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let mut count = 0;
        let lens = lens_model.as_deref();
        let focal = focal_length.as_deref();
        let ap = aperture.as_deref();

        for file_path in file_paths {
            let path = Path::new(&file_path);
            if path.exists() && update_xmp_metadata(path, lens, focal, ap).is_ok() {
                count += 1;
            }
        }
        Ok(count)
    })
    .await
    .map_err(|e| format!("批量更新元数据任务异常: {}", e))?
}

#[tauri::command]
pub async fn open_in_photoshop_cmd(
    file_path: String,
    custom_ps_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let settings = state.db.load_settings().unwrap_or_default();
    let raw_ps_path = custom_ps_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(settings.photoshop_path);

    let ps_path = raw_ps_path
        .trim_matches(|c| c == '"' || c == '\'' || c == ' ')
        .to_string();

    if !Path::new(&ps_path).exists() {
        // Fallback to default app
        return open_in_default_app_cmd(file_path).await;
    }

    Command::new(&ps_path)
        .arg(&file_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 Photoshop 失败 ({}): {}", ps_path, e))?;

    Ok(true)
}

#[tauri::command]
pub async fn open_in_default_app_cmd(file_path: String) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/c", "start", "", &file_path])
            .spawn()
            .map_err(|e| format!("无法使用系统默认程序打开文件: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("无法使用系统默认程序打开文件: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("无法使用系统默认程序打开文件: {}", e))?;
    }

    Ok(true)
}

#[tauri::command]
pub async fn trash_photos_cmd(file_paths: Vec<String>) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let mut count = 0;
        for path_str in file_paths {
            let path = Path::new(&path_str);
            if path.exists() && trash::delete(path).is_ok() {
                count += 1;
            }
        }
        Ok(count)
    })
    .await
    .map_err(|e| format!("移动至回收站失败: {}", e))?
}

/// 单个文件复制失败的明细（替代原来 `.is_ok()` 静默吞掉的错误）。
#[derive(Debug, serde::Serialize, Default)]
pub struct ExportFailure {
    pub path: String,
    pub reason: String,
}

/// 批量导出结果。**这是与前端约定好的固定契约，字段名不要改。**
#[derive(Debug, serde::Serialize, Default)]
pub struct ExportOutcome {
    /// 本次真正复制成功的文件数
    pub exported: usize,
    /// 因目标已存在同名文件而跳过的文件数
    pub skipped: usize,
    /// 失败明细（原来被 `.is_ok()` 静默吞掉的错误）
    pub failed: Vec<ExportFailure>,
    /// 是否因用户取消而提前结束（字段名固定为 `cancelled`，勿改成 `canceled`）。
    /// 策略 3 下取消 = 目标目录零新增文件（临时目录被整体删除）。
    pub cancelled: bool,
}

/// 导出清单里的一项（记录每个源文件的最终处置）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifestItem {
    pub src: String,
    pub dst: String,
    /// "copied" | "skipped" | "failed" | "cancelled"
    ///
    /// 说明：方案文档把取值限定为 `copied|overwritten|skipped|failed`。本项目
    /// **从不覆盖**目标同名文件（一律 skipped），且取消会把已暂存但未搬迁的项
    /// 如实标为 `cancelled`（否则清单会谎称它们被复制了）。故在不新增"被覆盖"
    /// 取值的前提下，实际出现的是这四种。
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 写在 `target/.gallery-export.json` 的导出清单（key 为 camelCase，照 §2 形状）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportManifest<'a> {
    version: u32,
    started_at: u64,
    finished_at: u64,
    /// "completed" | "cancelled" | "failed"
    status: &'a str,
    include_jpg: bool,
    include_raw: bool,
    items: &'a [ExportManifestItem],
}

/// 清单文件名（与临时目录前缀同为点开头，避免被当作正常照片）。
const EXPORT_MANIFEST_NAME: &str = ".gallery-export.json";
/// 临时目录前缀：`target/.gallery-export-tmp-<uuid>/`。
const EXPORT_TMP_PREFIX: &str = ".gallery-export-tmp-";

/// 暂存到临时目录、等待原子搬迁的一个文件。
struct StagedFile {
    tmp: PathBuf,
    dst: PathBuf,
    /// 对应 `manifest` 中那一项的下标，搬迁失败/取消时回写结果。
    manifest_idx: usize,
}

/// 导出累积器：把"写临时目录"与"原子搬迁"两个阶段的账分开记。
#[derive(Default)]
struct ExportStaging {
    outcome: ExportOutcome,
    manifest: Vec<ExportManifestItem>,
    staged: Vec<StagedFile>,
}

impl ExportStaging {
    /// 把一个源文件预备进临时目录（**不碰目标名**）。
    ///
    /// - 源不存在 → 跳过（沿用既有"只复制存在文件"语义）；
    /// - 目标已存在同名文件 → 计入 `skipped`，**不覆盖**（保护用户已有文件）；
    /// - `fs::copy` 失败 → 计入 `failed`。
    fn stage(&mut self, src: &Path, tmp_dir: &Path, target_dir: &Path) {
        if !src.exists() {
            return;
        }
        let Some(name) = src.file_name() else {
            return;
        };
        let dst = target_dir.join(name);
        let src_str = src.to_string_lossy().to_string();
        let dst_str = dst.to_string_lossy().to_string();
        if dst.exists() {
            self.outcome.skipped += 1;
            self.manifest.push(ExportManifestItem {
                src: src_str,
                dst: dst_str,
                result: "skipped".to_string(),
                error: None,
            });
            return;
        }
        let tmp = tmp_dir.join(name);
        match fs::copy(src, &tmp) {
            Ok(_) => {
                let manifest_idx = self.manifest.len();
                self.staged.push(StagedFile {
                    tmp,
                    dst,
                    manifest_idx,
                });
                self.manifest.push(ExportManifestItem {
                    src: src_str,
                    dst: dst_str,
                    result: "copied".to_string(),
                    error: None,
                });
            }
            Err(e) => {
                self.outcome.failed.push(ExportFailure {
                    path: src_str.clone(),
                    reason: e.to_string(),
                });
                self.manifest.push(ExportManifestItem {
                    src: src_str,
                    dst: dst_str,
                    result: "failed".to_string(),
                    error: Some(e.to_string()),
                });
            }
        }
    }

    /// 提交阶段：把临时目录里暂存的文件**逐个原子搬迁**到目标名（同卷 rename）。
    fn commit(&mut self) {
        let staged = std::mem::take(&mut self.staged);
        for f in staged {
            match fs::rename(&f.tmp, &f.dst) {
                Ok(_) => self.outcome.exported += 1,
                Err(e) => {
                    self.outcome.failed.push(ExportFailure {
                        path: f.dst.to_string_lossy().to_string(),
                        reason: e.to_string(),
                    });
                    self.manifest[f.manifest_idx].result = "failed".to_string();
                    self.manifest[f.manifest_idx].error = Some(e.to_string());
                }
            }
        }
    }

    /// 取消收尾：把已暂存但未搬迁的项如实标为 `cancelled`。
    /// 文件本体随临时目录一起删除，**绝不逐个删除目标目录里的文件**
    /// （那会毁掉目标目录里本来就有、被同名覆盖过的用户文件）。
    fn mark_cancelled(&mut self) {
        let staged = std::mem::take(&mut self.staged);
        for f in staged {
            self.manifest[f.manifest_idx].result = "cancelled".to_string();
            self.manifest[f.manifest_idx].error =
                Some("导出已取消，未搬迁到目标目录".to_string());
        }
    }
}

/// 写导出清单（best-effort：清单写失败不影响导出结果，只打日志）。
fn write_export_manifest(
    target_dir: &Path,
    started_at: u64,
    status: &str,
    include_jpg: bool,
    include_raw: bool,
    items: &[ExportManifestItem],
) {
    let manifest = ExportManifest {
        version: 1,
        started_at,
        finished_at: now_epoch_secs(),
        status,
        include_jpg,
        include_raw,
        items,
    };
    match serde_json::to_vec_pretty(&manifest) {
        Ok(bytes) => {
            if let Err(e) = fs::write(target_dir.join(EXPORT_MANIFEST_NAME), bytes) {
                eprintln!("写入导出清单失败（已忽略）: {}", e);
            }
        }
        Err(e) => eprintln!("序列化导出清单失败（已忽略）: {}", e),
    }
}

#[tauri::command]
pub async fn batch_export_cmd(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    items: Vec<ExportItem>,
    target_folder: String,
    include_raw: bool,
    include_jpg: bool,
) -> Result<ExportOutcome, String> {
    let cancel = state.export_cancel.clone();
    cancel.store(false, Ordering::SeqCst); // 复位上一轮遗留的取消标志
    let app_for_progress = app.clone();

    tokio::task::spawn_blocking(move || {
        let mut throttle = ProgressThrottle::new();
        export_items(
            items,
            Path::new(&target_folder),
            include_raw,
            include_jpg,
            &cancel,
            |processed, total, current| {
                if throttle.should_emit("export", processed, total) {
                    let _ = app_for_progress.emit(
                        "export-progress",
                        ExportProgress {
                            processed,
                            total,
                            current: current.to_string(),
                        },
                    );
                }
            },
        )
    })
    .await
    .map_err(|e| format!("批量导出任务异常: {}", e))?
}

/// 批量导出的**纯实现**（不含 tauri 命令属性，可直接被单测调用）。
///
/// 进入复制循环前先做「目标目录 == 任一源文件父目录」的自检：一旦命中即
/// **整体拒绝**、不复制任何文件。否则 `target_dir` 与源同目录时
/// `fs::copy(src, dst)` 的 `src == dst` 会让 Rust 标准库**截断源文件**
/// （Unix 走 O_TRUNC 确定清零；Windows 走 CopyFileEx 可能截断或失败），
/// 即用户原始 RAW/JPG 被不可逆破坏。
///
/// **收尾策略（策略 3：临时目录 + 原子搬迁）**：全部文件先写进
/// `target/.gallery-export-tmp-<uuid>/`，全部成功后再逐个 `rename` 到 `target/`。
/// 取消时直接删除临时目录 —— 目标目录零污染，且绝不误删目标目录里本已存在的
/// 同名用户文件（这正是"取消后删除已复制文件"方案的致命缺陷）。
///
/// `cancel` 为协作式取消标志；`on_progress` 形如 `(processed, total, current)`。
pub fn export_items(
    items: Vec<ExportItem>,
    target_folder: &Path,
    include_raw: bool,
    include_jpg: bool,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(usize, usize, &str),
) -> Result<ExportOutcome, String> {
    fs::create_dir_all(target_folder)
        .map_err(|e| format!("创建目标导出目录失败: {}", e))?;

    // 自检：canonicalize 归一化大小写 / 短名 / `..` / 尾斜杠后逐项比较，
    // 不自己写字符串比较（Windows 下路径规范化必须交给 OS）。
    let target_canon = fs::canonicalize(target_folder)
        .map_err(|e| format!("无法解析目标导出目录: {}", e))?;
    for item in &items {
        for src_str in [&item.jpg_path, &item.raw_path].into_iter().flatten() {
            let src = Path::new(src_str);
            if let Some(parent) = src.parent() {
                if let Ok(parent_canon) = fs::canonicalize(parent) {
                    if parent_canon == target_canon {
                        return Err(
                            "导出目标不能是源照片所在目录，请另选一个目标文件夹".to_string(),
                        );
                    }
                }
            }
        }
    }

    let started_at = now_epoch_secs();

    // 临时目录建在目标目录**内部** → 保证与最终目标同卷，`rename` 才是原子的
    // （跨卷 rename 会退化为 copy，失去原子性）。
    let tmp_dir = target_folder.join(format!("{}{}", EXPORT_TMP_PREFIX, uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建导出临时目录失败: {}", e))?;

    let total = items.len();
    let mut staging = ExportStaging::default();
    let mut cancelled = false;

    'outer: for (idx, item) in items.iter().enumerate() {
        // 检查点①：每项迭代开头
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        on_progress(idx, total, item.base_name.as_str());

        if include_jpg {
            if let Some(jpg_path_str) = &item.jpg_path {
                staging.stage(Path::new(jpg_path_str), &tmp_dir, target_folder);
                // 检查点②：JPG 复制后
                if cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break 'outer;
                }
            }
        }

        if include_raw {
            if let Some(raw_path_str) = &item.raw_path {
                let src = Path::new(raw_path_str);
                if src.exists() {
                    staging.stage(src, &tmp_dir, target_folder);
                    // 检查点③：RAW 复制后
                    if cancel.load(Ordering::SeqCst) {
                        cancelled = true;
                        break 'outer;
                    }
                    // Also copy matching .xmp if exists
                    let xmp_src = src.with_extension("xmp");
                    if xmp_src.exists() {
                        staging.stage(&xmp_src, &tmp_dir, target_folder);
                        // 检查点④：XMP 复制后
                        if cancel.load(Ordering::SeqCst) {
                            cancelled = true;
                            break 'outer;
                        }
                    }
                }
            }
        }
    }

    if cancelled {
        // 取消：删临时目录，目标目录保持原样（零污染）
        let _ = fs::remove_dir_all(&tmp_dir);
        staging.mark_cancelled();
        staging.outcome.cancelled = true;
        write_export_manifest(
            target_folder,
            started_at,
            "cancelled",
            include_jpg,
            include_raw,
            &staging.manifest,
        );
        on_progress(total, total, "");
        return Ok(staging.outcome);
    }

    // 提交阶段：逐个原子搬迁。到这里视为已提交，不再响应取消 —— rename 是极快的
    // 元数据操作，中途停下反而制造半成品；要么全搬，要么（取消时）一个不搬。
    staging.commit();
    let _ = fs::remove_dir_all(&tmp_dir);

    let status = if staging.outcome.failed.is_empty() {
        "completed"
    } else {
        "failed"
    };
    write_export_manifest(
        target_folder,
        started_at,
        status,
        include_jpg,
        include_raw,
        &staging.manifest,
    );
    on_progress(total, total, "");
    Ok(staging.outcome)
}

#[tauri::command]
pub fn get_settings_cmd(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.db.load_settings()
}

#[tauri::command]
pub fn save_settings_cmd(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    // 换了 lumen-cli 路径 = 指向了另一个 catalog，旧的同步游标不再有意义
    // （否则冲突判定会拿旧引擎的值做基准）。清空是安全方向：最坏情况是
    // 下次同步时按"首次见到"处理，不会误覆盖。
    if let Ok(old) = state.db.load_settings() {
        if old.lumen_cli_path.trim() != settings.lumen_cli_path.trim() {
            let _ = state.db.clear_rating_sync();
            state.lumen.shutdown();
        }
    }
    state.db.save_settings(&settings)?;
    Ok(true)
}

#[tauri::command]
pub fn save_session_cmd(
    jpg_folder: String,
    raw_folder: String,
    last_index: usize,
    sort_order: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .db
        .save_session(&jpg_folder, &raw_folder, last_index, &sort_order)?;
    Ok(true)
}

#[tauri::command]
pub fn load_session_cmd(
    jpg_folder: String,
    state: State<'_, AppState>,
) -> Result<Option<(usize, String)>, String> {
    state.db.load_session(&jpg_folder)
}

#[tauri::command]
pub async fn update_tone_adjustments_cmd(
    file_path: String,
    tone: crate::models::ToneAdjustments,
) -> Result<bool, String> {
    // 兼容入口：旧调用点只需要 XMP 写入。**不要**在这里加引擎写入 ——
    // 统一管线走 apply_tone_cmd，避免两条写入路径再次分叉。
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        crate::xmp::update_xmp_tone(
            path,
            Some(tone.exposure),
            Some(tone.highlights),
            Some(tone.shadows),
            Some(tone.temperature),
            Some(tone.tint),
            Some(tone.contrast),
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("写入调色参数任务异常: {}", e))?
}

#[tauri::command]
pub async fn open_in_luminar_roundtrip_cmd(file_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(file_path);
    let edited_path = crate::luminar::edit_in_luminar(&path).await?;
    Ok(edited_path.to_string_lossy().to_string())
}

/// LUMEN RAW 集成握手状态（供前端徽标/降级判断）。
///
/// 不可用不是错误：返回 available=false + 中文 detail，前端静默降级。
#[tauri::command]
pub async fn lumen_status_cmd(state: State<'_, AppState>) -> Result<LumenStatus, String> {
    let settings = state.db.load_settings()?;
    if !settings.lumen_enabled {
        return Ok(lumen::lumen_status_from(false, None, None));
    }
    let exe = match lumen::find_lumen_cli(&settings.lumen_cli_path) {
        Some(e) => e,
        None => return Ok(state.lumen.status(false, None)),
    };

    // 已握手的运行时直接给缓存版本（零 IO）；否则问一次 --version
    let cached = state.lumen.status(true, Some(exe.clone()));
    if cached.available {
        return Ok(cached);
    }

    let exe_for_version = exe.clone();
    let version = tokio::task::spawn_blocking(move || lumen::query_version(&exe_for_version))
        .await
        .map_err(|e| format!("LUMEN 版本查询任务异常: {}", e))?;

    Ok(lumen::lumen_status_from(true, Some(exe), version))
}

/// `probe_lumen_cmd` 的返回：直接回答"这个路径能不能用"。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LumenProbeResult {
    /// 是否探测到一个可用的 lumen-cli（找到文件且能读到版本号）
    pub available: bool,
    pub version: Option<String>,
    /// 不可用时的原因（中文），供设置面板直接展示
    pub error: Option<String>,
}

/// 探测指定（或自动查找的）lumen-cli 是否可用。
///
/// 与 `lumen_status_cmd` 的关键区别：**本命令不读已保存的设置**，而是直接使用
/// 调用方传入的 `cli_path`。设置面板的「测试连接」必须能校验**输入框里尚未保存**
/// 的路径——现有 `lumen_status_cmd` 只认已落库的路径，读不到未保存值（这正是
/// M-15/N-12"改路径后引擎状态永不刷新"的根因）。
///
/// `cli_path` 为 `None`/空/全空白时，退化为现有的自动查找逻辑（打包资源 → PATH）。
/// 本实现**只调用 `lumen.rs` 的既有公开能力**，不改动该文件。
#[tauri::command]
pub async fn probe_lumen_cmd(cli_path: Option<String>) -> Result<LumenProbeResult, String> {
    probe_lumen_impl(cli_path).await
}

/// `probe_lumen_cmd` 的实现（与命令属性解耦，便于单测直接调用）。
async fn probe_lumen_impl(cli_path: Option<String>) -> Result<LumenProbeResult, String> {
    let unavailable = |msg: String| LumenProbeResult {
        available: false,
        version: None,
        error: Some(msg),
    };

    let trimmed = cli_path.unwrap_or_default();
    let trimmed = trimmed.trim().to_string();

    let exe = if trimmed.is_empty() {
        // 未指定 → 走自动查找（与 lumen_status_cmd 一致）
        match lumen::find_lumen_cli("") {
            Some(e) => e,
            None => {
                return Ok(unavailable(
                    "未找到 lumen-cli，请安装或在设置中指定路径".to_string(),
                ))
            }
        }
    } else {
        let p = PathBuf::from(&trimmed);
        if !p.is_file() {
            return Ok(unavailable(format!("路径不存在或不是文件: {}", trimmed)));
        }
        p
    };

    let exe_for_version = exe.clone();
    let version = tokio::task::spawn_blocking(move || lumen::query_version(&exe_for_version))
        .await
        .map_err(|e| format!("LUMEN 版本查询任务异常: {}", e))?;

    match version {
        Some(v) => Ok(LumenProbeResult {
            available: true,
            version: Some(v),
            error: None,
        }),
        // 找到文件但拿不到版本号（不是合法的 lumen-cli，或执行失败）
        None => Ok(unavailable(format!(
            "找到文件但无法读取版本（可能不是有效的 lumen-cli 或无法执行）: {}",
            exe.to_string_lossy()
        ))),
    }
}

/// 经 LUMEN RAW sidecar 渲染 RAW 预览（命中磁盘缓存直接返回）。
///
/// 引擎未启用/未安装 → `preview_path: None`（前端回退内嵌 JPEG 路径），
/// 仅真实渲染失败才 `Err`。
#[tauri::command]
pub async fn lumen_preview_cmd(
    file_path: String,
    width: Option<u32>,
    original: Option<bool>,
    // recipe: 调色参数 JSON 文本（如 {"adjustments":{"exposure":0.5}}），参与缓存键；
    // 不传则走 .lumen 工程里的既有状态。
    recipe: Option<String>,
    state: State<'_, AppState>,
) -> Result<LumenPreviewResult, String> {
    let settings = state.db.load_settings()?;
    // 坏 JSON 不能让预览整个失败：按"无 recipe"处理，行为退回今天。
    let recipe: Option<serde_json::Value> = recipe.and_then(|r| match serde_json::from_str(&r) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("lumen_preview_cmd: recipe JSON 解析失败，已忽略: {}", e);
            None
        }
    });
    // 原图变体不含任何编辑 → 忽略 recipe（避免为原图算两个缓存条目）
    let recipe = if original.unwrap_or(false) {
        None
    } else {
        recipe
    };
    let original = original.unwrap_or(false);
    let width = width.unwrap_or(1600).clamp(128, 1600); // sidecar 源上限 1600

    let unavailable = || LumenPreviewResult {
        preview_path: None,
        width,
        original,
        cached: false,
    };

    if !settings.lumen_enabled {
        return Ok(unavailable());
    }
    let exe = match lumen::find_lumen_cli(&settings.lumen_cli_path) {
        Some(e) => e,
        None => return Ok(unavailable()),
    };

    let src = PathBuf::from(&file_path);
    if !src.exists() {
        return Err(format!("原图片文件不存在: {}", file_path));
    }

    let src_mtime = fs::metadata(&src).and_then(|m| m.modified()).ok();
    // 兄弟 .lumen 工程：存在则把其 mtime 纳入缓存键（session 会自动拾取工程）
    let project = src.with_extension("lumen");
    let project_mtime = project
        .exists()
        .then(|| fs::metadata(&project).and_then(|m| m.modified()).ok())
        .flatten();

    let variant = if original {
        PreviewVariant::Original
    } else {
        PreviewVariant::Edited
    };
    let cache_root = get_cache_dir().join("gallery");

    let key = lumen::lumen_cache_key_with_recipe(
        &src,
        width,
        variant,
        PINNED_LUMEN_VERSION,
        src_mtime,
        project_mtime,
        recipe.as_ref(),
    );
    let was_cached = lumen::cached_preview(&cache_root, &key, width, variant).is_some();

    let runtime = state.lumen.clone();
    let inputs = lumen::PreviewCacheInputs {
        width,
        variant,
        lumen_version: PINNED_LUMEN_VERSION,
        src_mtime,
        project_mtime,
        recipe: recipe.clone(),
    };
    let rendered = tokio::task::spawn_blocking(move || {
        lumen::ensure_preview(&src, &cache_root, inputs, |_tmp, args| {
            // 调色 recipe 必须**先** edit.apply 写进 .lumen 工程再渲染：
            // render.preview 不接受 recipe 参数（真实 sidecar 实测会报
            // "unknown argument(s) for render.preview: recipe"）。
            if let Some(recipe) = &recipe {
                runtime
                    .apply_recipe(&exe, &src.to_string_lossy(), recipe)
                    .map_err(|e| LumenError::Protocol(format!("应用调色参数失败: {}", e)))?;
            }
            // A 通道优先（常驻 sidecar，热态省掉每次 ~2s 的解释器冷启动）；
            // 失败时 runtime 内部自动降级到 B 通道单发。
            runtime.render_preview(&exe, args).map(|_| ())
        })
    })
    .await
    .map_err(|e| format!("LUMEN 渲染任务异常: {}", e))?
    .map_err(|e| e.to_string())?;

    Ok(LumenPreviewResult {
        preview_path: Some(rendered.to_string_lossy().to_string()),
        width,
        original,
        cached: was_cached,
    })
}

/// 从 LUMEN RAW 拉取评级（catalog 真值）并写回宿主侧边栏。
///
/// 冲突语义（Step 8 SPEC B4）：以 `rating_sync` 游标为基准判断谁改过。
/// - 只有 LUMEN 侧变 → 写回宿主；
/// - 只有宿主变 → 不动（等宿主推给 LUMEN）；
/// - 两侧都变 → **绝不静默覆盖**，计入 conflicts 交用户裁决；
/// - 首次见到且 LUMEN 无值 → 不产生动作。
#[tauri::command]
pub async fn lumen_sync_ratings_cmd(
    state: State<'_, AppState>,
    folder: String,
) -> Result<LumenRatingSync, String> {
    let settings = state.db.load_settings()?;
    if !settings.lumen_enabled {
        return Ok(LumenRatingSync::default()); // 引擎关闭 → 零请求
    }
    let exe = match lumen::find_lumen_cli(&settings.lumen_cli_path) {
        Some(e) => e,
        None => return Ok(LumenRatingSync::default()), // 未安装 → 静默降级
    };
    let runtime = state.lumen.clone();
    let db = state.db.clone();

    tokio::task::spawn_blocking(move || {
        let folder_path = PathBuf::from(&folder);
        let entries = runtime
            .pull_ratings(&exe, &folder_path)
            .map_err(|e| format!("拉取 LUMEN RAW 评级失败: {}", e))?;

        let mut result = LumenRatingSync::default();
        for (path, lumen_rating, lumen_flag) in entries {
            let p = PathBuf::from(&path);
            if !p.exists() {
                continue;
            }
            let xmp = xmp::get_xmp_path(&p);
            let host_meta = read_xmp_full(&xmp);
            let host_rating = host_meta.as_ref().map(|m| m.rating).unwrap_or(0);
            let host_flag = host_meta
                .as_ref()
                .map(flag_from_xmp)
                .unwrap_or_else(|| "none".to_string());
            let host_mtime = crate::db::file_mtime_secs(&xmp);

            // 游标：(rating, flag, source, sidecar_mtime)。判定用 (rating, flag,
            // mtime)；source 只用于诊断，不参与决策。
            let cursor = db
                .lookup_rating_sync(&path)
                .ok()
                .flatten()
                .map(|(r, f, _source, mtime)| (r, f, mtime));

            let decision = lumen::decide_sync(
                cursor,
                (host_rating, host_flag.clone(), host_mtime),
                Some((lumen_rating, lumen_flag.clone())),
            );

            match decision {
                lumen::SyncDecision::InSync => {}
                lumen::SyncDecision::PullFromLumen => {
                    // lumen 的 reject → 宿主的 reject（Rating=-1 语义已统一）
                    write_xmp(&p, lumen_rating, &lumen_flag)?;
                    let _ = db.upsert_rating_sync(
                        &path,
                        lumen_rating,
                        &lumen_flag,
                        "lumen",
                        crate::db::file_mtime_secs(&xmp),
                    );
                    result.updated.push(path);
                }
                lumen::SyncDecision::PushToLumen => {
                    // 宿主更新 → 交给 update_rating_flag_cmd 推，不在这里覆盖
                    result.skipped += 1;
                }
                lumen::SyncDecision::Conflict => {
                    result.conflicts.push(LumenRatingConflict {
                        path,
                        host_rating,
                        host_flag,
                        lumen_rating,
                        lumen_flag,
                    });
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("评级同步任务异常: {}", e))?
}

/// 读取 LUMEN RAW 侧调色 recipe（宿主调色面板的初始态来源）。
#[tauri::command]
pub async fn lumen_get_recipe_cmd(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<LumenRecipe, String> {
    let settings = state.db.load_settings()?;
    let unavailable = || LumenRecipe {
        available: false,
        tone: ToneAdjustments::default(),
        monochrome: false,
    };
    if !settings.lumen_enabled {
        return Ok(unavailable());
    }
    let exe = match lumen::find_lumen_cli(&settings.lumen_cli_path) {
        Some(e) => e,
        None => return Ok(unavailable()),
    };

    tokio::task::spawn_blocking(move || {
        let out = lumen::run_lumen(
            &exe,
            "edit.get",
            &serde_json::json!({ "path": file_path, "full": true }),
        )
        .map_err(|e| e.to_string())?;
        let state_obj = out.get("state").cloned().unwrap_or(serde_json::Value::Null);
        Ok(LumenRecipe {
            available: true,
            tone: lumen::recipe_to_tone(&state_obj),
            monochrome: state_obj
                .get("monochrome")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        })
    })
    .await
    .map_err(|e| format!("读取 recipe 任务异常: {}", e))?
}

/// 把宿主调色面板的 6 个滑杆写入 LUMEN RAW recipe。
#[tauri::command]
pub async fn lumen_apply_recipe_cmd(
    state: State<'_, AppState>,
    file_path: String,
    recipe_json: String,
) -> Result<(), String> {
    let settings = state.db.load_settings()?;
    if !settings.lumen_enabled {
        return Err("未启用 LUMEN RAW 引擎".to_string());
    }
    let exe = lumen::find_lumen_cli(&settings.lumen_cli_path)
        .ok_or_else(|| "未找到 lumen-cli".to_string())?;
    let runtime = state.lumen.clone();

    tokio::task::spawn_blocking(move || {
        let changes: serde_json::Value =
            serde_json::from_str(&recipe_json).map_err(|e| format!("调色参数格式错误: {}", e))?;
        runtime
            .apply_recipe(&exe, &file_path, &changes)
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("应用 recipe 任务异常: {}", e))?
}

/// 探测 LUMEN RAW sidecar 的真实能力（命令表 + 内置预设 + AI 可用性）。
///
/// AI 蒙版/增强只在 GPU flavor 里存在（CPU-only 包没有 onnxruntime），
/// 前端据此提前说明，而不是等用户点下去才失败。
#[tauri::command]
pub async fn lumen_capabilities_cmd(
    state: State<'_, AppState>,
) -> Result<lumen::LumenCapabilities, String> {
    let settings = state.db.load_settings()?;
    if !settings.lumen_enabled {
        return Err("未启用 LUMEN RAW 引擎".to_string());
    }
    let exe = lumen::find_lumen_cli(&settings.lumen_cli_path)
        .ok_or_else(|| "未找到 lumen-cli".to_string())?;
    let runtime = state.lumen.clone();
    tokio::task::spawn_blocking(move || runtime.capabilities(&exe).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("能力探测任务异常: {}", e))?
}

/// 应用 LUMEN RAW 内置预设（编辑态是进程内 session，必须走 A 通道）。
#[tauri::command]
pub async fn lumen_apply_preset_cmd(
    state: State<'_, AppState>,
    file_path: String,
    name: String,
    amount: Option<u8>,
) -> Result<(), String> {
    let settings = state.db.load_settings()?;
    if !settings.lumen_enabled {
        return Err("未启用 LUMEN RAW 引擎".to_string());
    }
    let exe = lumen::find_lumen_cli(&settings.lumen_cli_path)
        .ok_or_else(|| "未找到 lumen-cli".to_string())?;
    let runtime = state.lumen.clone();
    tokio::task::spawn_blocking(move || {
        runtime
            .apply_preset(&exe, &file_path, &name, amount.unwrap_or(100))
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("应用预设任务异常: {}", e))?
}

/// 统一调色写入：**一条命令，两个落点**。
///
/// - 总是写 XMP（互操作底线，引擎挂了也不受影响）；
/// - 引擎可用时在**同一常驻进程**内 `apply_edits` → `save_project`（落盘持久，
///   否则重启后调色消失）；
/// - 引擎失败不回滚 XMP，只在报告里带 warning。
#[tauri::command]
pub async fn apply_tone_cmd(
    state: State<'_, AppState>,
    file_path: String,
    tone: ToneAdjustments,
) -> Result<ToneWriteReport, String> {
    let settings = state.db.load_settings()?;
    let path = PathBuf::from(&file_path);

    // 1) XMP（同步 IO、必做）。挪进阻塞线程池，避免同步文件写入阻塞 async 执行器。
    //    tone 的 6 个分量是 f32（Copy），先取出再 move 进闭包，保证 tone 后续仍可用。
    let (exposure, highlights, shadows, temperature, tint, contrast) = (
        tone.exposure,
        tone.highlights,
        tone.shadows,
        tone.temperature,
        tone.tint,
        tone.contrast,
    );
    tokio::task::spawn_blocking(move || {
        crate::xmp::update_xmp_tone(
            &path,
            Some(exposure),
            Some(highlights),
            Some(shadows),
            Some(temperature),
            Some(tint),
            Some(contrast),
        )
    })
    .await
    .map_err(|e| format!("调色写入任务异常: {}", e))??;
    let mut report = ToneWriteReport {
        xmp_written: true,
        ..Default::default()
    };

    if !settings.lumen_enabled {
        report
            .warnings
            .push("LUMEN RAW 引擎未启用：只写入了 XMP，预览仍用 CSS 滤镜。".to_string());
        return Ok(report);
    }
    let exe = match lumen::find_lumen_cli(&settings.lumen_cli_path) {
        Some(e) => e,
        None => {
            report
                .warnings
                .push("未找到 lumen-cli：只写入了 XMP。".to_string());
            return Ok(report);
        }
    };
    let runtime = state.lumen.clone();

    // 2) lumen：apply + save 必须同进程（编辑态是 session 态）
    let applied = tokio::task::spawn_blocking(move || {
        let changes = lumen::tone_to_recipe(&tone, true);
        let applied = runtime.apply_recipe(&exe, &file_path, &changes);
        let applied = match applied {
            Ok(v) => v,
            Err(e) => {
                return Err(format!("应用 LUMEN RAW 调色失败: {}", e));
            }
        };
        // 落盘：不 save_project 的话调色下次就消失（session 不持久）
        let project = runtime
            .save_project(&exe, &file_path)
            .map_err(|e| format!("保存 LUMEN RAW 工程失败: {}", e))?;
        Ok((applied, project))
    })
    .await
    .map_err(|e| format!("调色写入任务异常: {}", e))?;

    match applied {
        Ok((_state, project)) => {
            report.lumen_applied = true;
            report.project_path = Some(project);
        }
        Err(e) => {
            // XMP 已写成功 —— 不回滚，只如实报告
            report.warnings.push(e);
        }
    }
    Ok(report)
}

/// 统一调色读取：XMP（互操作真值）+ lumen 工程（渲染真值），并报告是否分歧。
#[tauri::command]
pub async fn get_tone_state_cmd(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<ToneState, String> {
    let settings = state.db.load_settings()?;
    let path = PathBuf::from(&file_path);
    let xmp_tone = read_xmp_tone(&xmp::get_xmp_path(&path));

    let mut result = ToneState {
        tone: xmp_tone.clone(),
        xmp_tone,
        ..Default::default()
    };

    if !settings.lumen_enabled {
        return Ok(result); // 引擎关闭 → 零请求
    }
    let exe = match lumen::find_lumen_cli(&settings.lumen_cli_path) {
        Some(e) => e,
        None => return Ok(result),
    };
    let runtime = state.lumen.clone();
    let lumen_tone =
        tokio::task::spawn_blocking(move || runtime.read_project_tone(&exe, &file_path))
            .await
            .map_err(|e| format!("读取调色状态任务异常: {}", e))?;

    match lumen_tone {
        Some(t) => {
            result.divergent = lumen::LumenRuntime::tone_diverges(&result.xmp_tone, &t);
            // 引擎可用时以 lumen 为准（它决定实际渲染），分歧另行提示
            result.tone = t.clone();
            result.lumen_tone = Some(t);
            result.lumen_available = true;
        }
        None => {
            // 没有 .lumen 工程 → 引擎是"在的但这张没调过色"，仍算可用
            result.lumen_available = true;
        }
    }
    Ok(result)
}

/// 从 XMP 读回六滑杆（缺失按 0，与滑杆零点一致）。
fn read_xmp_tone(path: &std::path::Path) -> ToneAdjustments {
    read_xmp_full(path)
        .map(|m| ToneAdjustments {
            exposure: m.exposure.unwrap_or(0.0),
            highlights: m.highlights.unwrap_or(0.0),
            shadows: m.shadows.unwrap_or(0.0),
            temperature: m.temperature.unwrap_or(0.0),
            tint: m.tint.unwrap_or(0.0),
            contrast: m.contrast.unwrap_or(0.0),
        })
        .unwrap_or_default()
}

/// 应用 AI 蒙版（仅 GPU flavor）。引擎不含模型时**明确报错**，不假装成功。
#[tauri::command]
pub async fn lumen_apply_mask_cmd(
    state: State<'_, AppState>,
    file_path: String,
    region: String,
    adjustments: MaskAdjustments,
) -> Result<LumenMaskResult, String> {
    let settings = state.db.load_settings()?;
    if !settings.lumen_enabled {
        return Err("未启用 LUMEN RAW 引擎".to_string());
    }
    let exe = lumen::find_lumen_cli(&settings.lumen_cli_path)
        .ok_or_else(|| "未找到 lumen-cli".to_string())?;
    if !lumen::detect_ai_flavor(&exe) {
        return Err(
            "当前 LUMEN RAW 是 CPU 版，不含 AI 蒙版模型。请改用 GPU 版路径（设置里指定）。"
                .to_string(),
        );
    }
    let runtime = state.lumen.clone();

    tokio::task::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let applied = runtime
            .apply_mask(&exe, &file_path, &region, &adjustments)
            .map_err(|e| e.to_string())?;
        let masks = runtime.list_masks(&exe, &file_path);
        let applied_list = applied
            .get("applied")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        Ok(LumenMaskResult {
            applied: applied_list,
            masks,
            elapsed_ms: t0.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| format!("AI 蒙版任务异常: {}", e))?
}

/// 列出工程里现有的 AI 蒙版（跨进程可读，因为 .lumen 落盘了）。
#[tauri::command]
pub async fn lumen_list_masks_cmd(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<Vec<serde_json::Value>, String> {
    let settings = state.db.load_settings()?;
    if !settings.lumen_enabled {
        return Ok(Vec::new());
    }
    let exe = match lumen::find_lumen_cli(&settings.lumen_cli_path) {
        Some(e) => e,
        None => return Ok(Vec::new()),
    };
    let runtime = state.lumen.clone();
    tokio::task::spawn_blocking(move || runtime.list_masks(&exe, &file_path))
        .await
        .map_err(|e| format!("读取蒙版任务异常: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个唯一临时子目录（进程 id + 纳秒时间戳，避免并发/重复运行撞名）。
    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gallery_export_test_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn item_with_jpg(path: &Path) -> ExportItem {
        ExportItem {
            base_name: path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            jpg_path: Some(path.to_string_lossy().to_string()),
            raw_path: None,
        }
    }

    /// 列出目录里的文件名（排序，便于断言）。
    fn dir_entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }

    /// 目标目录 == 源目录时必须整体拒绝，且**源文件字节数/内容不变**。
    /// 修复前：`fs::copy(src, src)` 会把源文件截断（清空）。
    #[test]
    fn export_rejects_target_equal_to_source_dir() {
        let dir = unique_dir("reject_same");
        let jpg = dir.join("IMG_0001.jpg");
        let payload = vec![0x41u8; 64]; // 几十字节的假 JPG
        fs::write(&jpg, &payload).unwrap();
        let before = fs::metadata(&jpg).unwrap().len();

        let items = vec![item_with_jpg(&jpg)];
        let no_cancel = AtomicBool::new(false);
        let res = export_items(items, &dir, false, true, &no_cancel, |_, _, _| {});

        assert!(res.is_err(), "目标==源目录时必须整体拒绝");
        assert_eq!(
            res.unwrap_err(),
            "导出目标不能是源照片所在目录，请另选一个目标文件夹"
        );
        assert_eq!(
            fs::metadata(&jpg).unwrap().len(),
            before,
            "源文件字节数不得改变"
        );
        assert_eq!(fs::read(&jpg).unwrap(), payload, "源文件内容不得改变");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 目标目录已存在同名（但内容不同）文件时：跳过、不覆盖、计入 skipped。
    #[test]
    fn export_skips_existing_same_name_file() {
        let src_dir = unique_dir("skip_src");
        let dst_dir = unique_dir("skip_dst");

        let src_jpg = src_dir.join("IMG_0002.jpg");
        fs::write(&src_jpg, b"SRC-CONTENT").unwrap();

        let dst_jpg = dst_dir.join("IMG_0002.jpg");
        fs::write(&dst_jpg, b"EXISTING-DIFFERENT").unwrap();

        let items = vec![item_with_jpg(&src_jpg)];
        let no_cancel = AtomicBool::new(false);
        let outcome =
            export_items(items, &dst_dir, false, true, &no_cancel, |_, _, _| {}).expect("不应报错");

        assert_eq!(outcome.exported, 0, "不应复制");
        assert_eq!(outcome.skipped, 1, "同名文件应计入 skipped");
        assert!(outcome.failed.is_empty(), "不应有失败");
        assert!(!outcome.cancelled, "未取消");
        assert_eq!(
            fs::read(&dst_jpg).unwrap(),
            b"EXISTING-DIFFERENT",
            "已存在的同名文件不得被覆盖"
        );
        // 临时目录必须已被清理
        assert!(
            !dir_entries(&dst_dir)
                .iter()
                .any(|n| n.starts_with(EXPORT_TMP_PREFIX)),
            "提交后不得残留临时目录"
        );

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dst_dir);
    }

    /// 复制失败（源是同名的目录 → `fs::copy` 报错）应计入 failed，不再静默吞掉。
    #[test]
    fn export_reports_copy_failure() {
        let src_dir = unique_dir("fail_src");
        let dst_dir = unique_dir("fail_dst");

        // 名为 IMG_0003.jpg 的目录：exists() 为真、file_name 有值，但 fs::copy 必失败。
        let bogus = src_dir.join("IMG_0003.jpg");
        fs::create_dir_all(&bogus).unwrap();

        let items = vec![item_with_jpg(&bogus)];
        let no_cancel = AtomicBool::new(false);
        let outcome =
            export_items(items, &dst_dir, false, true, &no_cancel, |_, _, _| {}).expect("整体不应报错");

        assert_eq!(outcome.exported, 0);
        assert!(!outcome.failed.is_empty(), "复制失败应计入 failed");
        assert_eq!(outcome.failed[0].path, bogus.to_string_lossy().to_string());

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dst_dir);
    }

    /// 成功导出：清单文件内容正确（version/status/includeJpg/items）。
    #[test]
    fn export_writes_manifest_on_success() {
        let src_dir = unique_dir("manifest_src");
        let dst_dir = unique_dir("manifest_dst");
        let jpg = src_dir.join("IMG_0007.jpg");
        fs::write(&jpg, b"CONTENT-7").unwrap();

        let items = vec![item_with_jpg(&jpg)];
        let no_cancel = AtomicBool::new(false);
        let outcome =
            export_items(items, &dst_dir, false, true, &no_cancel, |_, _, _| {}).expect("不应报错");

        assert_eq!(outcome.exported, 1);
        assert!(!outcome.cancelled);

        let manifest_path = dst_dir.join(EXPORT_MANIFEST_NAME);
        assert!(manifest_path.is_file(), "清单文件必须存在");
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["status"], "completed");
        assert_eq!(json["includeJpg"], true);
        assert_eq!(json["includeRaw"], false);
        assert!(json["startedAt"].is_number());
        assert!(json["finishedAt"].is_number());
        let items_json = json["items"].as_array().unwrap();
        assert_eq!(items_json.len(), 1);
        assert_eq!(items_json[0]["result"], "copied");
        assert_eq!(items_json[0]["src"], jpg.to_string_lossy().to_string());

        // 真正的目标文件也落地了
        assert_eq!(fs::read(dst_dir.join("IMG_0007.jpg")).unwrap(), b"CONTENT-7");

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dst_dir);
    }

    /// 策略 3 核心用例①：取消后**目标目录不产生任何新增文件**（临时目录被整体删除）。
    #[test]
    fn export_cancel_leaves_target_clean() {
        let src_dir = unique_dir("cancel_clean_src");
        let dst_dir = unique_dir("cancel_clean_dst");
        let jpg = src_dir.join("IMG_0008.jpg");
        fs::write(&jpg, b"CONTENT-8").unwrap();

        let items = vec![item_with_jpg(&jpg)];
        // 在第 0 项迭代开头之后立刻置位取消（通过进度回调实现）
        let cancel = AtomicBool::new(false);
        let cancel_ref = &cancel;
        let outcome = export_items(items, &dst_dir, false, true, &cancel, |idx, _, _| {
            if idx == 0 {
                cancel_ref.store(true, Ordering::SeqCst);
            }
        })
        .expect("取消不是错误，应 Ok");

        assert!(outcome.cancelled, "应标记为已取消");
        assert_eq!(outcome.exported, 0, "取消时不得搬迁任何文件");
        // 目标目录里除清单外不得有导出产物，且不得残留临时目录
        assert!(
            !dst_dir.join("IMG_0008.jpg").exists(),
            "取消后目标目录不得出现导出文件"
        );
        let entries = dir_entries(&dst_dir);
        assert!(
            !entries.iter().any(|n| n.starts_with(EXPORT_TMP_PREFIX)),
            "取消后必须删除临时目录，实际残留: {:?}",
            entries
        );
        assert!(
            !entries.iter().any(|n| n == "IMG_0008.jpg"),
            "目标目录不得新增源文件，实际: {:?}",
            entries
        );
        // 清单应记录 cancelled
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(dst_dir.join(EXPORT_MANIFEST_NAME)).unwrap()).unwrap();
        assert_eq!(json["status"], "cancelled");

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dst_dir);
    }

    /// 策略 3 核心用例②（§2 点名）：目标目录预置一个与源同名但内容不同的文件，
    /// 取消后该文件**必须原封不动**（这正是"删除已复制文件"方案的致命失败点）。
    #[test]
    fn export_cancel_preserves_preexisting_named_file() {
        let src_dir = unique_dir("cancel_preserve_src");
        let dst_dir = unique_dir("cancel_preserve_dst");

        let first = src_dir.join("IMG_0100.jpg");
        fs::write(&first, b"NEW-A").unwrap();
        let second = src_dir.join("IMG_0101.jpg");
        fs::write(&second, b"NEW-B").unwrap();

        // 目标目录里预先就有一个与第二张同名的、内容不同的文件
        let preexisting = dst_dir.join("IMG_0101.jpg");
        fs::write(&preexisting, b"USER-ORIGINAL").unwrap();

        let items = vec![item_with_jpg(&first), item_with_jpg(&second)];
        // 处理完第 0 项后取消（此时 IMG_0100 已暂存到临时目录、等待被丢弃）
        let cancel = AtomicBool::new(false);
        let cancel_ref = &cancel;
        let outcome = export_items(items, &dst_dir, false, true, &cancel, |idx, _, _| {
            if idx == 0 {
                cancel_ref.store(true, Ordering::SeqCst);
            }
        })
        .expect("取消不是错误");

        assert!(outcome.cancelled);
        assert_eq!(outcome.exported, 0);
        // 关键断言：目标目录里原有的同名文件必须还在，内容不变
        assert!(preexisting.exists(), "取消不得删除目标目录已有的同名文件");
        assert_eq!(
            fs::read(&preexisting).unwrap(),
            b"USER-ORIGINAL",
            "取消不得覆盖/删除目标目录已有的同名文件"
        );
        // 第一个文件（已暂存）不得出现在目标目录
        assert!(
            !dst_dir.join("IMG_0100.jpg").exists(),
            "暂存文件应随临时目录一起丢弃"
        );
        assert!(
            !dir_entries(&dst_dir)
                .iter()
                .any(|n| n.starts_with(EXPORT_TMP_PREFIX)),
            "取消后不得残留临时目录"
        );

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dst_dir);
    }

    /// `probe_lumen_cmd` 对不存在的路径：`available=false` 且带 `error`。
    /// 直接调用实现体（async），无需 tauri 运行时。
    #[test]
    fn probe_lumen_reports_error_for_missing_path() {
        let dir = unique_dir("probe_missing");
        let missing = dir.join("no-such-lumen-cli.exe");
        let res = tauri::async_runtime::block_on(probe_lumen_impl(Some(
            missing.to_string_lossy().to_string(),
        )))
        .expect("命令本身不应 Err（不可用走 Ok + available=false）");

        assert!(!res.available, "不存在的路径必须 available=false");
        assert!(res.version.is_none());
        let err = res.error.expect("必须带 error 说明原因");
        assert!(
            err.contains("路径不存在"),
            "必须命中「路径不存在」分支（而非其他降级理由），实际: {}",
            err
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
