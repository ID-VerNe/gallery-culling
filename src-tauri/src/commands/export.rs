//! 批量导出：暂存 -> 提交 -> 清单落盘。
//!
//! 策略 3：先全部拷进临时目录，全部成功才改名进目标目录；用户中途取消则
//! 删除临时目录，目标目录**零新增文件**。
//!
//! 契约：`ExportOutcome` 的字段名（尤其 `cancelled`）是与前端约定死的，
//! 改名会静默破坏前端读数。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Emitter, State};

use crate::lumen;
use crate::models::ExportItem;

use super::{blocking, now_epoch_secs, AppState, ProgressThrottle};

/// `export-progress` 事件负载。
#[derive(Clone, serde::Serialize)]
pub struct ExportProgress {
    pub processed: usize,
    pub total: usize,
    /// 当前项名称（`ExportItem.base_name`），供 UI 显示"正在导出 xxx"
    pub current: String,
}


/// 请求取消正在进行的导出（幂等）。取消后目标目录不会残留半成品。
#[tauri::command]
pub fn cancel_export_cmd(state: State<'_, AppState>) -> Result<(), String> {
    state.export_cancel.store(true, Ordering::SeqCst);
    Ok(())
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
    /// "copied" | "rendered" | "skipped" | "failed" | "cancelled"
    ///
    /// 说明：方案文档把取值限定为 `copied|overwritten|skipped|failed`。本项目
    /// 默认**不覆盖**目标同名文件（一律 skipped），覆盖由用户显式勾选
    /// `overwrite` 开启；即便开启，条目级也只记 `copied`/`rendered` ——
    /// 「这批有没有可能覆盖」是批次级事实，记在清单顶层的 `overwrite` 上。
    /// 取消会把已暂存但未搬迁的项如实标为 `cancelled`（否则清单会谎称它们
    /// 被复制了）。故实际出现的是这五种。
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 目标目录 == 源文件父目录时的拒绝文案。
///
/// 与前端 `exportMessages.buildValidationMessage` **逐字一致**：两处都拦，
/// 用户无论从哪一层被挡下都看到同一句话，不会以为是两个不同的问题。
pub const TARGET_IS_SOURCE_MSG: &str = "导出目标不能是源照片所在目录，请另选一个目标文件夹";

/// 成片模式的渲染参数（清单留档 + 传给渲染器）。
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderManifest<'a> {
    pub format: &'a str,
    pub quality: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_edge: Option<u32>,
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
    /// "copy" | "render" —— 同一份清单要能区分这批文件是拷来的还是渲出来的。
    mode: &'a str,
    include_jpg: bool,
    include_raw: bool,
    /// 本批是否在「覆盖同名文件」模式下运行。
    ///
    /// 只记批次级意图，不逐项记「这一项是否真的替换了旧文件」：条目级的
    /// `result` 仍是 `copied`/`rendered`，用户关心的是「这批有没有可能覆盖」。
    /// `false` 时**不序列化**，保持旧清单形状不变（老版本读得懂新文件）。
    #[serde(skip_serializing_if = "is_false")]
    overwrite: bool,
    /// 仅成片模式出现；复制模式为 `None` 且不序列化（保持旧清单形状不变）。
    #[serde(skip_serializing_if = "Option::is_none")]
    render: Option<RenderManifest<'a>>,
    items: &'a [ExportManifestItem],
}

/// 清单文件名（与临时目录前缀同为点开头，避免被当作正常照片）。
pub const EXPORT_MANIFEST_NAME: &str = ".gallery-export.json";
/// 临时目录前缀：`target/.gallery-export-tmp-<uuid>/`。
pub const EXPORT_TMP_PREFIX: &str = ".gallery-export-tmp-";

/// 暂存到临时目录、等待原子搬迁的一个文件。
struct StagedFile {
    tmp: PathBuf,
    dst: PathBuf,
    /// 对应 `manifest` 中那一项的下标，搬迁失败/取消时回写结果。
    manifest_idx: usize,
}

/// 导出累积器：把"写临时目录"与"原子搬迁"两个阶段的账分开记。
struct ExportStaging {
    outcome: ExportOutcome,
    manifest: Vec<ExportManifestItem>,
    staged: Vec<StagedFile>,
    /// 清单里「成功」那一项的 `result` 取值。
    ///
    /// 复制用 `copied`、渲染用 `rendered` —— 刻意不复用同一个词：用户在清单里
    /// 要能一眼看出这批文件是原样拷来的，还是按 `.lumen` 重新渲出来的。
    success_result: &'static str,
}

impl Default for ExportStaging {
    fn default() -> Self {
        Self {
            outcome: ExportOutcome::default(),
            manifest: Vec::new(),
            staged: Vec::new(),
            success_result: "copied",
        }
    }
}

impl ExportStaging {
    /// 把一个源文件预备进临时目录（**不碰目标名**）。
    ///
    /// - 源不存在 → 跳过（沿用既有"只复制存在文件"语义）；
    /// - 目标已存在同名文件且 `overwrite == false` → 计入 `skipped`，**不覆盖**
    ///   （保护用户已有文件）；`overwrite == true` 时照常暂存，替换发生在提交阶段；
    /// - `fs::copy` 失败 → 计入 `failed`。
    ///
    /// 注意：`overwrite` 只影响「要不要暂存」，**不影响取消语义** —— 暂存阶段
    /// 从不碰目标目录里的既有文件，所以取消依然是零污染。
    fn stage(&mut self, src: &Path, tmp_dir: &Path, target_dir: &Path, overwrite: bool) {
        if !src.exists() {
            return;
        }
        let Some(name) = src.file_name() else {
            return;
        };
        let dst = target_dir.join(name);
        let src_str = src.to_string_lossy().to_string();
        let dst_str = dst.to_string_lossy().to_string();
        if dst.exists() && !overwrite {
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
                    result: self.success_result.to_string(),
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

    /// 登记一个**已由外部渲染器写好**的临时文件（成片模式）。
    ///
    /// 与 `stage` 的差别：不复制，文件已在 `tmp`。调用方必须先确认 `tmp.is_file()`
    /// —— 渲染器返回 Ok 却没写盘是真实存在的情况（磁盘满、输出路径被拒），
    /// 那种情况绝不能算作已导出。
    fn stage_rendered(&mut self, src: &Path, tmp: &Path, dst: &Path) {
        let manifest_idx = self.manifest.len();
        self.staged.push(StagedFile {
            tmp: tmp.to_path_buf(),
            dst: dst.to_path_buf(),
            manifest_idx,
        });
        self.manifest.push(ExportManifestItem {
            src: src.to_string_lossy().to_string(),
            dst: dst.to_string_lossy().to_string(),
            result: self.success_result.to_string(),
            error: None,
        });
    }

    /// 记一条失败（同时写 outcome 与 manifest，避免两处口径不一致）。
    fn record_failure(&mut self, src: &Path, dst: &Path, reason: String) {
        let src_str = src.to_string_lossy().to_string();
        self.outcome.failed.push(ExportFailure {
            path: src_str.clone(),
            reason: reason.clone(),
        });
        self.manifest.push(ExportManifestItem {
            src: src_str,
            dst: dst.to_string_lossy().to_string(),
            result: "failed".to_string(),
            error: Some(reason),
        });
    }

    /// 提交阶段：把临时目录里暂存的文件**逐个原子搬迁**到目标名（同卷 rename）。
    ///
    /// 覆盖模式下这里会替换目标目录里的同名文件：`fs::rename` 在 Unix 是
    /// `rename(2)`、在 Windows 是带 `MOVEFILE_REPLACE_EXISTING` 的 `MoveFileEx`，
    /// 两者都原子地替换已存在的目标，不会出现「删了旧的、新的还没到」的空窗。
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
            self.manifest[f.manifest_idx].error = Some("导出已取消，未搬迁到目标目录".to_string());
        }
    }
}

/// `skip_serializing_if` 需要 `fn(&bool) -> bool`；`std::ops::Not::not` 收的是
/// 值而不是引用，直接用会类型不匹配。
fn is_false(b: &bool) -> bool {
    !*b
}

/// 写导出清单（best-effort：清单写失败不影响导出结果，只打日志）。
fn write_export_manifest(
    target_dir: &Path,
    started_at: u64,
    status: &str,
    mode: &str,
    render: Option<RenderManifest<'_>>,
    include_jpg: bool,
    include_raw: bool,
    overwrite: bool,
    items: &[ExportManifestItem],
) {
    let manifest = ExportManifest {
        version: 1,
        started_at,
        finished_at: now_epoch_secs(),
        status,
        mode,
        include_jpg,
        include_raw,
        overwrite,
        render,
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
    overwrite: Option<bool>,
) -> Result<ExportOutcome, String> {
    let cancel = state.export_cancel.clone();
    cancel.store(false, Ordering::SeqCst); // 复位上一轮遗留的取消标志
    let app_for_progress = app.clone();
    // 缺省 false：老前端不传这个键时必须保持「从不覆盖」的旧行为。
    let overwrite = overwrite.unwrap_or(false);

    blocking("批量导出任务异常", move || {
        let mut throttle = ProgressThrottle::new();
        export_items(
            items,
            Path::new(&target_folder),
            include_raw,
            include_jpg,
            overwrite,
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
/// `overwrite` 为 true 时目标目录里的同名文件会在提交阶段被替换；false（默认）
/// 时一律计入 `skipped` 且不动旧文件。
///
/// `cancel` 为协作式取消标志；`on_progress` 形如 `(processed, total, current)`。
pub fn export_items(
    items: Vec<ExportItem>,
    target_folder: &Path,
    include_raw: bool,
    include_jpg: bool,
    overwrite: bool,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(usize, usize, &str),
) -> Result<ExportOutcome, String> {
    fs::create_dir_all(target_folder).map_err(|e| format!("创建目标导出目录失败: {}", e))?;

    // 自检：canonicalize 归一化大小写 / 短名 / `..` / 尾斜杠后逐项比较，
    // 不自己写字符串比较（Windows 下路径规范化必须交给 OS）。
    let target_canon =
        fs::canonicalize(target_folder).map_err(|e| format!("无法解析目标导出目录: {}", e))?;
    for item in &items {
        for src_str in [&item.jpg_path, &item.raw_path].into_iter().flatten() {
            let src = Path::new(src_str);
            if let Some(parent) = src.parent() {
                if let Ok(parent_canon) = fs::canonicalize(parent) {
                    if parent_canon == target_canon {
                        return Err(TARGET_IS_SOURCE_MSG.to_string());
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
                staging.stage(Path::new(jpg_path_str), &tmp_dir, target_folder, overwrite);
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
                    staging.stage(src, &tmp_dir, target_folder, overwrite);
                    // 检查点③：RAW 复制后
                    if cancel.load(Ordering::SeqCst) {
                        cancelled = true;
                        break 'outer;
                    }
                    // Also copy matching .xmp if exists
                    let xmp_src = src.with_extension("xmp");
                    if xmp_src.exists() {
                        staging.stage(&xmp_src, &tmp_dir, target_folder, overwrite);
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
            "copy",
            None,
            include_jpg,
            include_raw,
            overwrite,
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
        "copy",
        None,
        include_jpg,
        include_raw,
        overwrite,
        &staging.manifest,
    );
    on_progress(total, total, "");
    Ok(staging.outcome)
}

/// 成片渲染导出的**纯实现**（不含 tauri 命令属性，可直接被单测调用）。
///
/// `render` 是**注入的渲染器**：生产环境是 `lumen::export_photo`，单测是写固定
/// 字节的假实现。这样 R1–R9 全部能在没有 LUMEN 的机器上验证 —— 调色管线本身
/// 的正确性由 LUMEN 负责，宿主只对「文件有没有正确落地」负责。
///
/// 与 `export_items` 共享同一套收尾策略（临时目录 + 原子搬迁 + 取消零污染），
/// 差异只在「怎么产出临时文件」：复制是 `fs::copy`，成片是调渲染器。
pub fn render_export_items(
    items: Vec<ExportItem>,
    target_folder: &Path,
    format: &str,
    quality: u8,
    long_edge: Option<u32>,
    overwrite: bool,
    cancel: &AtomicBool,
    mut render: impl FnMut(&Path, &Path) -> Result<(), String>,
    mut on_progress: impl FnMut(usize, usize, &str),
) -> Result<ExportOutcome, String> {
    fs::create_dir_all(target_folder).map_err(|e| format!("创建目标导出目录失败: {}", e))?;

    // 与复制同款自检：目标 == 源目录时，output 会落回源目录，同名就可能覆盖原片。
    // 命中即整体拒绝 —— 一张都不渲。
    let target_canon =
        fs::canonicalize(target_folder).map_err(|e| format!("无法解析目标导出目录: {}", e))?;
    for item in &items {
        // 源优先取 RAW（与前端 `groupPath()` = `raw.path || jpg.path` 一致）
        for src_str in [&item.raw_path, &item.jpg_path].into_iter().flatten() {
            let src = Path::new(src_str);
            if let Some(parent) = src.parent() {
                if let Ok(parent_canon) = fs::canonicalize(parent) {
                    if parent_canon == target_canon {
                        return Err(TARGET_IS_SOURCE_MSG.to_string());
                    }
                }
            }
        }
    }

    let started_at = now_epoch_secs();
    // 临时目录建在目标目录**内部**，保证同卷，`rename` 才是原子的。
    let tmp_dir = target_folder.join(format!("{}{}", EXPORT_TMP_PREFIX, uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建导出临时目录失败: {}", e))?;

    let total = items.len();
    let mut staging = ExportStaging {
        success_result: "rendered",
        ..Default::default()
    };
    let mut cancelled = false;

    for (idx, item) in items.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        on_progress(idx, total, item.base_name.as_str());

        // 源：优先 RAW，其次 JPG。两者都没有 → 如实记失败。
        // 不静默跳过：用户勾了这张却什么都没得到，必须能看见原因。
        let Some(src) = item
            .raw_path
            .as_deref()
            .or(item.jpg_path.as_deref())
            .map(Path::new)
        else {
            let dst = target_folder.join(format!("{}.{}", item.base_name, format));
            staging.record_failure(
                Path::new(&item.base_name),
                &dst,
                "该项没有可用的源文件路径".to_string(),
            );
            continue;
        };
        let dst = target_folder.join(format!("{}.{}", item.base_name, format));
        if !src.exists() {
            staging.record_failure(src, &dst, "源文件不存在".to_string());
            continue;
        }
        // 目标同名且**不覆盖**：计入 skipped 且不调用渲染器 —— 渲染一张注定被
        // 丢弃的图在大图上是几秒到几十秒的纯浪费。覆盖模式下必须照常渲染，
        // 否则「调色 → 再导出」永远拿不到新版本。
        if dst.exists() && !overwrite {
            staging.outcome.skipped += 1;
            staging.manifest.push(ExportManifestItem {
                src: src.to_string_lossy().to_string(),
                dst: dst.to_string_lossy().to_string(),
                result: "skipped".to_string(),
                error: None,
            });
            continue;
        }

        let tmp = tmp_dir.join(format!("{}.{}", item.base_name, format));
        match render(src, &tmp) {
            Ok(()) => {
                // 渲染器说成功但没写盘（磁盘满 / 输出被拒）：绝不能算已导出。
                if tmp.is_file() {
                    staging.stage_rendered(src, &tmp, &dst);
                } else {
                    staging.record_failure(src, &dst, "渲染器返回成功但未写出文件".to_string());
                }
            }
            Err(e) => staging.record_failure(src, &dst, e),
        }

        // 检查点：每张渲完再看一次取消（单张大图可能耗时数十秒）
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
    }

    let render_meta = RenderManifest {
        format,
        quality,
        long_edge,
    };

    if cancelled {
        let _ = fs::remove_dir_all(&tmp_dir);
        staging.mark_cancelled();
        staging.outcome.cancelled = true;
        write_export_manifest(
            target_folder,
            started_at,
            "cancelled",
            "render",
            Some(render_meta),
            false,
            false,
            overwrite,
            &staging.manifest,
        );
        on_progress(total, total, "");
        return Ok(staging.outcome);
    }

    // 提交阶段与复制一致：到这里视为已提交，不再响应取消。
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
        "render",
        Some(render_meta),
        false,
        false,
        overwrite,
        &staging.manifest,
    );
    on_progress(total, total, "");
    Ok(staging.outcome)
}

/// 成片渲染导出命令（薄封装：读设置 → 定位引擎 → 阻塞线程跑纯实现）。
///
/// `too_many_arguments` 豁免：这八个参数是**前端 IPC 的契约**（Tauri 按名取键，
/// `src/services/api.ts` 逐个透传）。拆成结构体会同时改前端的调用形状，收益只是
/// 让 lint 闭嘴；真正的参数收敛发生在下方纯实现 `render_export_items` 里。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn batch_render_export_cmd(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    items: Vec<ExportItem>,
    target_folder: String,
    format: String,
    quality: Option<u8>,
    long_edge: Option<u32>,
    overwrite: Option<bool>,
) -> Result<ExportOutcome, String> {
    // 白名单：UI 只暴露这三种。放行任意扩展名会让渲染器收到它不支持的目标格式，
    // 报错发生在渲染中途而不是调用前。
    if !matches!(format.as_str(), "jpg" | "tif" | "dng") {
        return Err(format!("不支持的成片格式: {}", format));
    }

    let settings = state.db.load_settings()?;
    // 引擎不可用 → 立即失败，**绝不静默回退到复制**。
    // 用户要的是调色成片，悄悄给他一堆未调色的原片是最糟的结果。
    let exe = super::require_lumen(&settings)?;

    let quality = quality.unwrap_or(92);
    // 缺省 false：老前端不传这个键时必须保持「从不覆盖」的旧行为。
    let overwrite = overwrite.unwrap_or(false);
    let cancel = state.export_cancel.clone();
    cancel.store(false, Ordering::SeqCst); // 复位上一轮遗留的取消标志
    let app_for_progress = app.clone();

    blocking("渲染导出任务异常", move || {
        let mut throttle = ProgressThrottle::new();
        render_export_items(
            items,
            Path::new(&target_folder),
            &format,
            quality,
            long_edge,
            overwrite,
            &cancel,
            |src, out| {
                lumen::export_photo(
                    &exe,
                    &src.to_string_lossy(),
                    &out.to_string_lossy(),
                    quality,
                    long_edge,
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            },
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
}

/// 导出逻辑的单测（FE-07 从 commands.rs 的 `mod tests` 归位到此）。
///
/// 与被测物同模块：`export_items` 与清单常量都在本文件。断言口径
/// （拒绝同目录 / 跳过同名 / 失败记账 / 取消零污染 / 预置文件不动）
/// 与迁移前逐字一致。
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

    /// 只给 RAW 的项（成片模式的典型输入：从 RAW 渲染）。
    fn item_with_raw(base_name: &str, raw: &Path) -> ExportItem {
        ExportItem {
            base_name: base_name.to_string(),
            jpg_path: None,
            raw_path: Some(raw.to_string_lossy().to_string()),
        }
    }

    /// 读回清单 JSON。
    fn read_manifest(dir: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(dir.join(EXPORT_MANIFEST_NAME)).unwrap()).unwrap()
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
        let res = export_items(items, &dir, false, true, false, &no_cancel, |_, _, _| {});

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
            export_items(items, &dst_dir, false, true, false, &no_cancel, |_, _, _| {}).expect("不应报错");

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

    /// 覆盖模式：同名文件被**替换**（而非 skipped），且清单记下 `overwrite: true`。
    ///
    /// 这条守的是「调色 → 导出 → 再调 → 再导出」—— 没有它，第二次导出全部
    /// skipped，用户拿到的仍是上一版。
    #[test]
    fn export_overwrite_replaces_existing_same_name_file() {
        let src_dir = unique_dir("ow_src");
        let dst_dir = unique_dir("ow_dst");

        let src_jpg = src_dir.join("IMG_0002.jpg");
        fs::write(&src_jpg, b"SRC-NEW-VERSION").unwrap();

        let dst_jpg = dst_dir.join("IMG_0002.jpg");
        fs::write(&dst_jpg, b"EXISTING-OLD").unwrap();

        let items = vec![item_with_jpg(&src_jpg)];
        let no_cancel = AtomicBool::new(false);
        let outcome = export_items(items, &dst_dir, false, true, true, &no_cancel, |_, _, _| {})
            .expect("不应报错");

        assert_eq!(outcome.exported, 1, "覆盖模式下应计入已导出");
        assert_eq!(outcome.skipped, 0, "覆盖模式下不该再记 skipped");
        assert!(outcome.failed.is_empty(), "不应有失败");
        assert_eq!(
            fs::read(&dst_jpg).unwrap(),
            b"SRC-NEW-VERSION",
            "同名文件必须被新内容替换"
        );
        assert!(
            !dir_entries(&dst_dir)
                .iter()
                .any(|n| n.starts_with(EXPORT_TMP_PREFIX)),
            "提交后不得残留临时目录"
        );
        // 清单是事后追责的唯一凭据：必须能看出这批是覆盖模式跑的
        assert_eq!(read_manifest(&dst_dir)["overwrite"], true);

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
        let outcome = export_items(items, &dst_dir, false, true, false, &no_cancel, |_, _, _| {})
            .expect("整体不应报错");

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
            export_items(items, &dst_dir, false, true, false, &no_cancel, |_, _, _| {}).expect("不应报错");

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
        assert_eq!(
            fs::read(dst_dir.join("IMG_0007.jpg")).unwrap(),
            b"CONTENT-7"
        );

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
        let outcome = export_items(items, &dst_dir, false, true, false, &cancel, |idx, _, _| {
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
        let outcome = export_items(items, &dst_dir, false, true, false, &cancel, |idx, _, _| {
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

    // ---- 成片渲染导出（R1–R9）----
    //
    // 全部用注入的假渲染器：调色管线的正确性由 LUMEN 负责，宿主只对
    // 「文件有没有正确落地、账有没有记对」负责。这样这些用例不需要真引擎。

    /// 造一套「源目录 + 目标目录 + N 个 RAW」。
    fn render_fixture(tag: &str, names: &[&str]) -> (PathBuf, PathBuf, Vec<ExportItem>) {
        let src = unique_dir(&format!("{}_src", tag));
        let dst = unique_dir(&format!("{}_dst", tag));
        let items = names
            .iter()
            .map(|n| {
                let p = src.join(format!("{}.CR2", n));
                fs::write(&p, format!("RAW-{}", n)).unwrap();
                item_with_raw(n, &p)
            })
            .collect();
        (src, dst, items)
    }

    /// 写一个固定字节的「渲染结果」，模拟真渲染器。
    fn fake_render(_src: &Path, out: &Path) -> Result<(), String> {
        fs::write(out, b"RENDERED").map_err(|e| e.to_string())
    }

    /// R1：两项渲染成功 → exported=2、目标字节 = 渲染器写入值、清单 mode/result 正确、无 tmp。
    #[test]
    fn render_exports_items_and_writes_manifest() {
        let (src, dst, items) = render_fixture("r1", &["IMG_A", "IMG_B"]);
        let no_cancel = AtomicBool::new(false);

        let outcome = render_export_items(
            items,
            &dst,
            "jpg",
            92,
            None,
            false,
            &no_cancel,
            fake_render,
            |_, _, _| {},
        )
        .expect("不应报错");

        assert_eq!(outcome.exported, 2);
        assert_eq!(outcome.skipped, 0);
        assert!(outcome.failed.is_empty());
        assert!(!outcome.cancelled);

        assert_eq!(fs::read(dst.join("IMG_A.jpg")).unwrap(), b"RENDERED");
        assert_eq!(fs::read(dst.join("IMG_B.jpg")).unwrap(), b"RENDERED");

        let json = read_manifest(&dst);
        assert_eq!(json["mode"], "render");
        assert_eq!(json["status"], "completed");
        assert_eq!(json["render"]["format"], "jpg");
        assert_eq!(json["render"]["quality"], 92);
        assert!(
            json["render"].get("longEdge").is_none(),
            "longEdge 为 None 时清单不应出现该键"
        );
        let items_json = json["items"].as_array().unwrap();
        assert_eq!(items_json.len(), 2);
        assert_eq!(items_json[0]["result"], "rendered", "不得复用 copied");
        assert!(
            !dir_entries(&dst)
                .iter()
                .any(|n| n.starts_with(EXPORT_TMP_PREFIX)),
            "提交后不得残留临时目录"
        );

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    /// R2：单张失败不影响其余 → 成功的照常提交，失败进 failed 明细。
    #[test]
    fn render_reports_failure_and_continues() {
        let (src, dst, items) = render_fixture("r2", &["IMG_A", "IMG_B", "IMG_C"]);
        let no_cancel = AtomicBool::new(false);

        let outcome = render_export_items(
            items,
            &dst,
            "jpg",
            92,
            None,
            false,
            &no_cancel,
            |_src, out| {
                if out.to_string_lossy().contains("IMG_B") {
                    return Err("渲染器崩了".to_string());
                }
                fs::write(out, b"RENDERED").map_err(|e| e.to_string())
            },
            |_, _, _| {},
        )
        .expect("整体不应报错");

        assert_eq!(outcome.exported, 2, "另外两张必须照常导出");
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.failed[0].reason.contains("渲染器崩了"));
        assert!(dst.join("IMG_A.jpg").exists());
        assert!(dst.join("IMG_C.jpg").exists());
        assert!(!dst.join("IMG_B.jpg").exists());

        let json = read_manifest(&dst);
        assert_eq!(json["status"], "failed");
        let failed_item = json["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["result"] == "failed")
            .expect("清单里应有 failed 项");
        assert_eq!(failed_item["error"], "渲染器崩了");

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    /// R3：渲染器返回 Ok 但没写文件 → 必须记 failed，绝不算 exported。
    #[test]
    fn render_counts_ok_without_file_as_failure() {
        let (src, dst, items) = render_fixture("r3", &["IMG_A"]);
        let no_cancel = AtomicBool::new(false);

        let outcome = render_export_items(
            items,
            &dst,
            "jpg",
            92,
            None,
            false,
            &no_cancel,
            |_src, _out| Ok(()), // 谎报成功，什么都不写
            |_, _, _| {},
        )
        .expect("整体不应报错");

        assert_eq!(outcome.exported, 0, "没写盘就不能算已导出");
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.failed[0].reason.contains("未写出文件"));
        assert!(!dst.join("IMG_A.jpg").exists());

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    /// R4：首张渲完置位取消 → cancelled=true、目标零成片、无 tmp、清单记 cancelled。
    #[test]
    fn render_cancel_leaves_target_clean() {
        let (src, dst, items) = render_fixture("r4", &["IMG_A", "IMG_B"]);
        let cancel = AtomicBool::new(false);
        let cancel_ref = &cancel;

        let outcome = render_export_items(
            items,
            &dst,
            "jpg",
            92,
            None,
            false,
            &cancel,
            |_src, out| {
                fs::write(out, b"RENDERED").map_err(|e| e.to_string())?;
                cancel_ref.store(true, Ordering::SeqCst);
                Ok(())
            },
            |_, _, _| {},
        )
        .expect("取消不是错误");

        assert!(outcome.cancelled);
        assert_eq!(outcome.exported, 0, "取消时不得搬迁任何文件");
        assert!(!dst.join("IMG_A.jpg").exists(), "取消后目标目录不得出现成片");
        assert!(!dst.join("IMG_B.jpg").exists());
        let entries = dir_entries(&dst);
        assert!(
            !entries.iter().any(|n| n.starts_with(EXPORT_TMP_PREFIX)),
            "取消后必须删除临时目录，实际残留: {:?}",
            entries
        );
        assert_eq!(read_manifest(&dst)["status"], "cancelled");

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    /// R5：目标已存在同名 → skipped=1、渲染器**不被调用**、原文件字节不变。
    #[test]
    fn render_skips_existing_without_calling_renderer() {
        let (src, dst, items) = render_fixture("r5", &["IMG_A"]);
        fs::write(dst.join("IMG_A.jpg"), b"USER-ORIGINAL").unwrap();

        let mut called = false;
        let no_cancel = AtomicBool::new(false);
        let outcome = render_export_items(
            items,
            &dst,
            "jpg",
            92,
            None,
            false,
            &no_cancel,
            |_src, out| {
                called = true;
                fs::write(out, b"RENDERED").map_err(|e| e.to_string())
            },
            |_, _, _| {},
        )
        .expect("不应报错");

        assert_eq!(outcome.exported, 0);
        assert_eq!(outcome.skipped, 1);
        assert!(!called, "同名已存在时不应浪费时间去渲染");
        assert_eq!(
            fs::read(dst.join("IMG_A.jpg")).unwrap(),
            b"USER-ORIGINAL",
            "用户已有文件不得被覆盖"
        );

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    /// 覆盖模式：同名目标**照常渲染并替换**（否则「再导出」永远拿不到新版）。
    #[test]
    fn render_overwrite_rerenders_and_replaces_existing() {
        let (src, dst, items) = render_fixture("r5b", &["IMG_A"]);
        fs::write(dst.join("IMG_A.jpg"), b"USER-OLD-RENDER").unwrap();

        let mut called = false;
        let no_cancel = AtomicBool::new(false);
        let outcome = render_export_items(
            items,
            &dst,
            "jpg",
            92,
            None,
            true,
            &no_cancel,
            |_src, out| {
                called = true;
                fs::write(out, b"RENDERED-NEW").map_err(|e| e.to_string())
            },
            |_, _, _| {},
        )
        .expect("不应报错");

        assert_eq!(outcome.exported, 1);
        assert_eq!(outcome.skipped, 0);
        assert!(called, "覆盖模式必须真的重新渲染，不能跳过");
        assert_eq!(
            fs::read(dst.join("IMG_A.jpg")).unwrap(),
            b"RENDERED-NEW",
            "旧成片必须被新渲染结果替换"
        );
        assert_eq!(read_manifest(&dst)["overwrite"], true);

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    /// R6：目标 == 源目录 → 整体拒绝，文案精确，渲染器一次都没被调用。
    #[test]
    fn render_rejects_target_equal_to_source_dir() {
        let (src, _dst, items) = render_fixture("r6", &["IMG_A"]);
        let mut called = false;
        let no_cancel = AtomicBool::new(false);

        let res = render_export_items(
            items,
            &src, // 目标就是源目录
            "jpg",
            92,
            None,
            false,
            &no_cancel,
            |_s, _o| {
                called = true;
                Ok(())
            },
            |_, _, _| {},
        );

        assert!(res.is_err(), "目标==源目录时必须整体拒绝");
        assert_eq!(res.unwrap_err(), TARGET_IS_SOURCE_MSG);
        assert!(!called, "拒绝发生在渲染之前");

        let _ = fs::remove_dir_all(&src);
    }

    /// R7：空 items 不 panic 且账目全零；源缺失如实记失败。
    #[test]
    fn render_handles_empty_and_missing_source() {
        let src = unique_dir("r7_src");
        let dst = unique_dir("r7_dst");
        let no_cancel = AtomicBool::new(false);

        // 空批次
        let empty = render_export_items(
            Vec::new(),
            &dst,
            "jpg",
            92,
            None,
            false,
            &no_cancel,
            fake_render,
            |_, _, _| {},
        )
        .expect("空批次不应报错");
        assert_eq!(empty.exported, 0);
        assert!(empty.failed.is_empty());
        assert!(!empty.cancelled);

        // 源文件不存在
        let missing = src.join("NOPE.CR2");
        let outcome = render_export_items(
            vec![item_with_raw("NOPE", &missing)],
            &dst,
            "jpg",
            92,
            None,
            false,
            &no_cancel,
            fake_render,
            |_, _, _| {},
        )
        .expect("整体不应报错");
        assert_eq!(outcome.exported, 0);
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.failed[0].reason.contains("源文件不存在"));

        // 连源路径都没有的项
        let no_path = ExportItem {
            base_name: "NO_PATH".to_string(),
            jpg_path: None,
            raw_path: None,
        };
        let outcome = render_export_items(
            vec![no_path],
            &dst,
            "jpg",
            92,
            None,
            false,
            &no_cancel,
            fake_render,
            |_, _, _| {},
        )
        .expect("整体不应报错");
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.failed[0].reason.contains("没有可用的源文件路径"));

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    /// R9：原子性 —— 渲染器收到的 output 必须在临时目录内，且提交前目标不存在。
    #[test]
    fn render_writes_into_tmp_before_commit() {
        let (src, dst, items) = render_fixture("r9", &["IMG_A"]);
        let final_dst = dst.join("IMG_A.jpg");
        let mut seen_outputs: Vec<PathBuf> = Vec::new();
        let mut target_existed_during_render = true;
        let no_cancel = AtomicBool::new(false);

        let outcome = render_export_items(
            items,
            &dst,
            "jpg",
            92,
            None,
            false,
            &no_cancel,
            |_s, out| {
                seen_outputs.push(out.to_path_buf());
                target_existed_during_render = final_dst.exists();
                fs::write(out, b"RENDERED").map_err(|e| e.to_string())
            },
            |_, _, _| {},
        )
        .expect("不应报错");

        assert_eq!(outcome.exported, 1);
        assert_eq!(seen_outputs.len(), 1);
        let parent = seen_outputs[0].parent().unwrap();
        assert!(
            parent
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(EXPORT_TMP_PREFIX),
            "渲染输出必须落在临时目录内，实际: {:?}",
            seen_outputs[0]
        );
        assert!(
            !target_existed_during_render,
            "提交前目标文件不得存在（否则就是边渲边覆盖）"
        );
        assert!(final_dst.exists(), "提交后目标文件必须存在");

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }
}
