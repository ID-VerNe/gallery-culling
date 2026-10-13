#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(test)]
use std::sync::atomic::Ordering;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(test)]
use crate::models::ExportItem;
use crate::db::Database;
use crate::lumen;

use crate::models::AppSettings;

// ---- 子模块：按领域拆分的命令 ----
// 命名：xmprw = XMP 读写。刻意不叫 `xmp`，否则与顶层的 `use crate::xmp` 同名。
//
// `#[tauri::command]` 生成的宏带 `#[macro_export]`，落在**定义它的模块**里。
// generate_handler 在 lib.rs 里按名字找它们，`macro_rules!` 无法被 glob 带出，
// 故下面每个模块都要显式转发它自己的那组宏。
mod apps;
mod export;
mod lumencmds;
mod tone;
mod scanner;
mod settings;
mod thumbnail;

pub use settings::{
    __cmd__get_settings_cmd, __cmd__load_session_cmd, __cmd__save_session_cmd,
    __cmd__save_settings_cmd,
    __tauri_command_name_get_settings_cmd, __tauri_command_name_load_session_cmd,
    __tauri_command_name_save_session_cmd, __tauri_command_name_save_settings_cmd,
    get_settings_cmd, load_session_cmd, save_session_cmd, save_settings_cmd,
};

pub use thumbnail::{
    __cmd__get_thumbnail_cmd, __tauri_command_name_get_thumbnail_cmd, get_thumbnail_cmd,
};

pub use scanner::{
    __cmd__cancel_scan_cmd, __cmd__scan_folders_cmd,
    __tauri_command_name_cancel_scan_cmd, __tauri_command_name_scan_folders_cmd,
    cancel_scan_cmd, scan_folders_cmd,
};

pub use lumencmds::{
    __cmd__lumen_status_cmd, __tauri_command_name_lumen_status_cmd,
    __cmd__probe_lumen_cmd, __tauri_command_name_probe_lumen_cmd,
    __cmd__lumen_preview_cmd, __tauri_command_name_lumen_preview_cmd,
    __cmd__lumen_sync_ratings_cmd, __tauri_command_name_lumen_sync_ratings_cmd,
    __cmd__lumen_get_recipe_cmd, __tauri_command_name_lumen_get_recipe_cmd,
    __cmd__lumen_apply_recipe_cmd, __tauri_command_name_lumen_apply_recipe_cmd,
    __cmd__lumen_capabilities_cmd, __tauri_command_name_lumen_capabilities_cmd,
    __cmd__lumen_apply_preset_cmd, __tauri_command_name_lumen_apply_preset_cmd,
    __cmd__lumen_apply_mask_cmd, __tauri_command_name_lumen_apply_mask_cmd,
    __cmd__lumen_list_masks_cmd, __tauri_command_name_lumen_list_masks_cmd,
    lumen_status_cmd,
    probe_lumen_cmd,
    lumen_preview_cmd,
    lumen_sync_ratings_cmd,
    lumen_get_recipe_cmd,
    lumen_apply_recipe_cmd,
    lumen_capabilities_cmd,
    lumen_apply_preset_cmd,
    lumen_apply_mask_cmd,
    lumen_list_masks_cmd,
};

pub use tone::{
    __cmd__apply_tone_cmd, __cmd__get_tone_state_cmd,
    __tauri_command_name_apply_tone_cmd, __tauri_command_name_get_tone_state_cmd,
    apply_tone_cmd, get_tone_state_cmd,
};

pub use export::{
    __cmd__batch_export_cmd, __cmd__cancel_export_cmd,
    __tauri_command_name_batch_export_cmd, __tauri_command_name_cancel_export_cmd,
    batch_export_cmd, cancel_export_cmd,
};

// 仅测试需要的实现细节：commands.rs 的 mod tests 里直接调 probe_lumen_impl
// （它刻意与命令属性解耦，就是为了能被单测直接调用）。
#[cfg(test)]
pub(crate) use lumencmds::probe_lumen_impl;

// 仅测试需要的导出实现细节：commands.rs 的 mod tests 里 6 条导出用例直接调
// `export_items` 并断言清单内容。测试与被测物同 crate，`pub(crate)` 足够。
#[cfg(test)]
pub use export::{
    export_items,
    EXPORT_MANIFEST_NAME, EXPORT_TMP_PREFIX,
};

pub use apps::{
    __cmd__open_in_default_app_cmd, __cmd__open_in_photoshop_cmd, __cmd__trash_photos_cmd,
    __tauri_command_name_open_in_default_app_cmd,
    __tauri_command_name_open_in_photoshop_cmd,
    __tauri_command_name_trash_photos_cmd,
    open_in_default_app_cmd, open_in_photoshop_cmd, trash_photos_cmd,
};
mod xmprw;

pub use xmprw::{
    __cmd__batch_update_metadata_cmd, __cmd__update_rating_flag_cmd,
    __tauri_command_name_batch_update_metadata_cmd,
    __tauri_command_name_update_rating_flag_cmd,
    batch_update_metadata_cmd, update_rating_flag_cmd,
};

pub struct AppState {
    pub db: Database,
    /// LUMEN RAW 常驻运行时（A 通道）：spawn 一次、握手、复用
    pub lumen: lumen::LumenRuntime,
    /// 扫描取消标志（协作式轮询）。置位后扫描在下一个安全点尽早返回。
    pub scan_cancel: Arc<AtomicBool>,
    /// 导出取消标志（协作式轮询）。置位后导出丢弃临时目录，目标目录零污染。
    pub export_cancel: Arc<AtomicBool>,
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

/// 把一次 `spawn_blocking` 收进统一的 JoinError→String 包装。
///
/// `msg` 是**任务描述前缀**，最终错误文本为 `"{msg}: {join_error}"` —— 与
/// 重构前逐字一致（勿改文案）。闭包的错误类型 `E` 泛型化：`lumen_preview_cmd`
/// 的闭包返回 `Result<_, LumenError>`，其余为 `Result<_, String>`。
async fn blocking<F, T, E>(msg: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(e) => Err(format!("{}: {}", msg, e)),
    }
}

/// 闭包**本身不返回 Result**（只可能因 JoinError 失败）的专用。
///
/// 覆盖 `query_version -> Option<String>` / `read_project_tone -> Option<..>` /
/// `list_masks -> Vec<Value>` —— 这三个 lumen 公开方法都不是 `Result`，
/// 硬塞进 `blocking` 需要伪造错误类型，属于投机抽象。
async fn blocking_value<F, T>(msg: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("{}: {}", msg, e))
}

/// Lumen 引擎「可用性」判定，**不可用即 Err**，两条错误文案逐字保留。
///
/// 与 `lumen_exe` 的区别只在于"说什么"：本函数用于必须走引擎路径的命令
/// （写 recipe / 探测能力 / 应用预设 / 应用蒙版），不可用就是调用失败。
fn require_lumen(settings: &AppSettings) -> Result<PathBuf, String> {
    if !settings.lumen_enabled {
        return Err("未启用 LUMEN RAW 引擎".to_string());
    }
    lumen::find_lumen_cli(&settings.lumen_cli_path).ok_or_else(|| "未找到 lumen-cli".to_string())
}

/// Lumen 引擎「可用性」判定，**不可用即 None**，降级语义由调用方自己决定。
///
/// 「引擎未启用」与「未找到 lumen-cli」在全部调用点都导向同一个后续动作
/// （放弃引擎路径），差异仅在降级文案，因此可安全合并为一次判定。
/// 调用方返回各自的 `Ok(降级值)`（status / preview / recipe / 蒙版…）。
fn lumen_exe(settings: &AppSettings) -> Option<PathBuf> {
    if !settings.lumen_enabled {
        return None;
    }
    lumen::find_lumen_cli(&settings.lumen_cli_path)
}

#[tauri::command]
pub async fn open_in_luminar_roundtrip_cmd(file_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(file_path);
    let edited_path = crate::luminar::edit_in_luminar(&path).await?;
    Ok(edited_path.to_string_lossy().to_string())
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
