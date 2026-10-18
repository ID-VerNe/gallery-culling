use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::db::Database;
use crate::lumen;
use crate::syncqueue;

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
    __cmd__lumen_detail_cmd, __tauri_command_name_lumen_detail_cmd,
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
    lumen_detail_cmd,
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
    __cmd__batch_export_cmd, __cmd__batch_render_export_cmd, __cmd__cancel_export_cmd,
    __tauri_command_name_batch_export_cmd, __tauri_command_name_batch_render_export_cmd,
    __tauri_command_name_cancel_export_cmd,
    batch_export_cmd, batch_render_export_cmd, cancel_export_cmd,
};

pub use apps::{
    __cmd__open_folder_cmd, __cmd__open_in_default_app_cmd, __cmd__open_in_photoshop_cmd,
    __cmd__trash_photos_cmd, __tauri_command_name_open_folder_cmd,
    __tauri_command_name_open_in_default_app_cmd,
    __tauri_command_name_open_in_photoshop_cmd,
    __tauri_command_name_trash_photos_cmd,
    open_folder_cmd, open_in_default_app_cmd, open_in_photoshop_cmd, trash_photos_cmd,
};
mod cullcheck;
mod xmprw;
mod xmprefresh;

pub use cullcheck::{
    __cmd__check_cull_state_cmd, __tauri_command_name_check_cull_state_cmd,
    check_cull_state_cmd,
};

pub use xmprw::{
    __cmd__batch_update_metadata_cmd, __cmd__update_rating_flag_cmd,
    __tauri_command_name_batch_update_metadata_cmd,
    __tauri_command_name_update_rating_flag_cmd,
    batch_update_metadata_cmd, update_rating_flag_cmd,
};

pub use xmprefresh::{
    __cmd__refresh_from_xmp_cmd, __cmd__resolve_xmp_conflicts_cmd,
    __tauri_command_name_refresh_from_xmp_cmd, __tauri_command_name_resolve_xmp_conflicts_cmd,
    refresh_from_xmp_cmd, resolve_xmp_conflicts_cmd,
};

pub struct AppState {
    pub db: Database,
    /// LUMEN RAW 常驻运行时（A 通道）：spawn 一次、握手、复用
    pub lumen: lumen::LumenRuntime,
    /// 扫描取消标志（协作式轮询）。置位后扫描在下一个安全点尽早返回。
    pub scan_cancel: Arc<AtomicBool>,
    /// 导出取消标志（协作式轮询）。置位后导出丢弃临时目录，目标目录零污染。
    pub export_cancel: Arc<AtomicBool>,
    /// 写盘合并队列（FR-03）：同一照片的连续改动折叠成一次落盘。
    pub sync: Arc<syncqueue::Coalescer>,
    /// 任务槽（FR-09）：扫描/导出/渲染/AI 互斥，重入返回 E_BUSY。
    pub tasks: crate::taskgate::TaskGate,
    /// 1:1 细节渲染的单飞标记（FR-05）：761MB/张，并行 3 张就是 2.3GB。
    ///
    /// 刻意**不**并进 `tasks`：那是「互斥表 + 禁用原因」的用户可见语义，
    /// 而这里是「同一时刻只渲一张」的资源上限 —— 第二个请求应当立刻
    /// `E_BUSY` 让前端队列自己排队，不该让导出按钮变灰。
    pub detail_busy: Arc<AtomicBool>,
}

impl AppState {
    /// 组装应用状态。合并队列的 sink 复用同一个数据库句柄 —— 落盘成功后由它
    /// 删除 `pending_xmp` 里那条意图。
    pub fn new(db: Database) -> Self {
        let sink = Arc::new(xmprw::DiskSink::new(db.clone()));
        Self {
            db,
            lumen: lumen::LumenRuntime::new(),
            scan_cancel: Arc::new(AtomicBool::new(false)),
            export_cancel: Arc::new(AtomicBool::new(false)),
            sync: Arc::new(syncqueue::Coalescer::new(sink)),
            tasks: crate::taskgate::TaskGate::new(),
            detail_busy: Arc::new(AtomicBool::new(false)),
        }
    }
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

