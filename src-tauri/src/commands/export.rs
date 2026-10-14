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
            self.manifest[f.manifest_idx].error = Some("导出已取消，未搬迁到目标目录".to_string());
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

    blocking("批量导出任务异常", move || {
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
                        return Err(
                            "导出目标不能是源照片所在目录，请另选一个目标文件夹".to_string()
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
        let outcome = export_items(items, &dst_dir, false, true, &no_cancel, |_, _, _| {})
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
}
