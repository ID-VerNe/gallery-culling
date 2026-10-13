use std::fs;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(test)]
use std::sync::atomic::Ordering;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

#[cfg(test)]
use crate::models::ExportItem;
use crate::db::Database;
use crate::lumen::{self, LumenError, LumenStatus, PreviewVariant, PINNED_LUMEN_VERSION};
use crate::models::{
    AppSettings, LumenMaskResult, LumenPreviewResult,
    LumenRatingConflict, LumenRatingSync, LumenRecipe, MaskAdjustments, ToneAdjustments,
};
use crate::thumbnail::get_cache_dir;
use crate::xmp;
use crate::xmp::{flag_from_xmp, read_xmp_full, write_xmp};

// ---- 子模块：按领域拆分的命令 ----
// 命名：xmprw = XMP 读写。刻意不叫 `xmp`，否则与顶层的 `use crate::xmp` 同名。
//
// `#[tauri::command]` 生成的宏带 `#[macro_export]`，落在**定义它的模块**里。
// generate_handler 在 lib.rs 里按名字找它们，`macro_rules!` 无法被 glob 带出，
// 故下面每个模块都要显式转发它自己的那组宏。
mod apps;
mod export;
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
    let version = blocking_value("LUMEN 版本查询任务异常", move || {
        lumen::query_version(&exe_for_version)
    })
    .await?;

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
    let version = blocking_value("LUMEN 版本查询任务异常", move || {
        lumen::query_version(&exe_for_version)
    })
    .await?;

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

    let Some(exe) = lumen_exe(&settings) else {
        return Ok(unavailable());
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
    let rendered = blocking("LUMEN 渲染任务异常", move || {
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
    .await?;

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
    let Some(exe) = lumen_exe(&settings) else {
        return Ok(LumenRatingSync::default()); // 不可用 → 静默降级，零请求
    };
    let runtime = state.lumen.clone();
    let db = state.db.clone();

    blocking("评级同步任务异常", move || {
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
        Ok::<_, String>(result)
    })
    .await
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
    let Some(exe) = lumen_exe(&settings) else {
        return Ok(unavailable());
    };

    blocking("读取 recipe 任务异常", move || {
        let out = lumen::run_lumen(
            &exe,
            "edit.get",
            &serde_json::json!({ "path": file_path, "full": true }),
        )
        .map_err(|e| e.to_string())?;
        let state_obj = out.get("state").cloned().unwrap_or(serde_json::Value::Null);
        Ok::<_, String>(LumenRecipe {
            available: true,
            tone: lumen::recipe_to_tone(&state_obj),
            monochrome: state_obj
                .get("monochrome")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        })
    })
    .await
}

/// 把宿主调色面板的 6 个滑杆写入 LUMEN RAW recipe。
#[tauri::command]
pub async fn lumen_apply_recipe_cmd(
    state: State<'_, AppState>,
    file_path: String,
    recipe_json: String,
) -> Result<(), String> {
    let settings = state.db.load_settings()?;
    let exe = require_lumen(&settings)?;
    let runtime = state.lumen.clone();

    blocking("应用 recipe 任务异常", move || {
        let changes: serde_json::Value =
            serde_json::from_str(&recipe_json).map_err(|e| format!("调色参数格式错误: {}", e))?;
        runtime
            .apply_recipe(&exe, &file_path, &changes)
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(())
    })
    .await
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
    let exe = require_lumen(&settings)?;
    let runtime = state.lumen.clone();
    blocking("能力探测任务异常", move || {
        runtime.capabilities(&exe).map_err(|e| e.to_string())
    })
    .await
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
    let exe = require_lumen(&settings)?;
    let runtime = state.lumen.clone();
    blocking("应用预设任务异常", move || {
        runtime
            .apply_preset(&exe, &file_path, &name, amount.unwrap_or(100))
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
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
    let exe = require_lumen(&settings)?;
    if !lumen::detect_ai_flavor(&exe) {
        return Err(
            "当前 LUMEN RAW 是 CPU 版，不含 AI 蒙版模型。请改用 GPU 版路径（设置里指定）。"
                .to_string(),
        );
    }
    let runtime = state.lumen.clone();

    blocking("AI 蒙版任务异常", move || {
        let t0 = std::time::Instant::now();
        let applied = runtime
            .apply_mask(&exe, &file_path, &region, &adjustments)
            .map_err(|e| e.to_string())?;
        let masks = runtime.list_masks(&exe, &file_path);
        let applied_list = applied
            .get("applied")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        Ok::<_, String>(LumenMaskResult {
            applied: applied_list,
            masks,
            elapsed_ms: t0.elapsed().as_millis() as u64,
        })
    })
    .await
}

/// 列出工程里现有的 AI 蒙版（跨进程可读，因为 .lumen 落盘了）。
#[tauri::command]
pub async fn lumen_list_masks_cmd(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<Vec<serde_json::Value>, String> {
    let settings = state.db.load_settings()?;
    let Some(exe) = lumen_exe(&settings) else {
        return Ok(Vec::new());
    };
    let runtime = state.lumen.clone();
    blocking_value("读取蒙版任务异常", move || {
        runtime.list_masks(&exe, &file_path)
    })
    .await
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
