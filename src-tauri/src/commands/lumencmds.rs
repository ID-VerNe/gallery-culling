//! LUMEN RAW 引擎的全部 Tauri 命令：握手、探测、预览、评级同步、
//! recipe 读写、能力查询、AI 蒙版。
//!
//! 降级语义分两族，**不要**统一成一个带 kind 参数的 helper：
//! `require_lumen` 是不可用即 Err（必须走引擎路径的操作），
//! `lumen_exe` 是不可用即 None（调用方返回各自的 Ok(降级值)）。
//! 两者的差别是外部事实（引擎公开方法的返回类型），不是调用点口味。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::State;

use crate::cullstore;
use crate::thumbnail::get_cache_dir;
use crate::xmp;
use crate::xmp::{legacy_flag_from_label, read_xmp_full, write_xmp};
use crate::lumen::{self, LumenError, LumenStatus, PreviewVariant, PINNED_LUMEN_VERSION};
use crate::models::{
    LumenMaskResult, LumenPreviewResult, LumenRatingConflict, LumenRatingSync, LumenRecipe, MaskAdjustments,
    ToneAdjustments,
};
use super::{blocking, blocking_value, lumen_exe, require_lumen, AppState};

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
pub(crate) async fn probe_lumen_impl(cli_path: Option<String>) -> Result<LumenProbeResult, String> {
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
        // 旗标存储：本命令只作用于一个文件夹，整轮读一次即可。
        let store = cullstore::load(&folder_path);
        for (path, lumen_rating, lumen_flag) in entries {
            let p = PathBuf::from(&path);
            if !p.exists() {
                continue;
            }
            let xmp = xmp::get_xmp_path(&p);
            let host_meta = read_xmp_full(&xmp);
            let host_rating = host_meta.as_ref().map(|m| m.rating).unwrap_or(0);
            // 宿主旗标必须走与扫描相同的优先级（store 优先、Rating=-1 硬信号），
            // 否则 pick 只存在 store 里时会被误判成 none，触发无意义的拉取覆盖。
            let base_name = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let host_flag = cullstore::resolve_flag(
                host_meta.as_ref().map(|m| m.rejected).unwrap_or(false),
                host_meta
                    .as_ref()
                    .map(|m| legacy_flag_from_label(&m.label))
                    .unwrap_or("none"),
                store.get(base_name),
            );
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
                    // lumen 的 reject → 宿主的 reject（Rating=-1 语义已统一）。
                    // 色标传 None：LUMEN 的色标体系与本应用的五色不是同一套
                    // （它有 11 种语言色名），此处不动用户的 `xmp:Label`。
                    write_xmp(&p, lumen_rating, &lumen_flag, None)?;
                    // 旗标同时落到本地 store：pick 已不再写 `xmp:Label`，
                    // 只写 XMP 会让拉取来的 pick 在下次扫描时消失。
                    // 写失败不中断整轮同步（评级已落盘），只记账。
                    if let Err(e) = cullstore::upsert(
                        p.parent().unwrap_or(&folder_path),
                        base_name,
                        &lumen_flag,
                    ) {
                        eprintln!("旗标同步失败（已忽略）: {}", e);
                    }
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
    // FR-09：AI 蒙版占用 LUMEN 编辑态，与渲染导出、套用调色互斥。
    let _guard = state
        .tasks
        .try_begin(crate::taskgate::Activity::Ai)
        .map_err(|e| e.to_string())?;
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

/// `lumen_detail_cmd` 的返回。
///
/// `detail_path: None` = 引擎不可用（前端静默退回 1600 预览，不弹错）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LumenDetailResult {
    /// 全分辨率 JPEG 的本地路径。
    pub detail_path: Option<String>,
    /// 本次是否命中磁盘缓存（true = 没花那 6–8 秒）。
    pub cached: bool,
    /// 本次耗时（毫秒）；命中缓存时接近 0。
    pub elapsed_ms: u64,
}

/// 渲染 RAW 的**全分辨率**细节图（RAW-only 分组的 1:1 检查）。
///
/// 与 `lumen_preview_cmd` 的分工：
/// - 预览走 `render.preview`，被 `engine.load_image(preview_limit=1600)` 硬顶，
///   只服务「看得清构图」；
/// - 细节走 `photo.export`（省略 `long_edge` = 原生尺寸），服务「看得清对焦」。
///
/// 代价是**每张 6–8 秒、峰值 761MB**（24MP 实测，报告 §5.4），所以：
/// 1. 只在用户明确按 `Z` / 双击时触发，不做「放大超过 2.5× 自动触发」；
/// 2. 全局并发上限 1，第二个请求立刻 `E_BUSY`；
/// 3. 产物落 2GB LRU 缓存，命中直接返回。
#[tauri::command]
pub async fn lumen_detail_cmd(
    file_path: String,
    // recipe: 调色参数 JSON 文本；参与缓存键，且在导出前先 `edit.apply`。
    recipe: Option<String>,
    state: State<'_, AppState>,
) -> Result<LumenDetailResult, String> {
    let settings = state.db.load_settings()?;
    let unavailable = || LumenDetailResult {
        detail_path: None,
        cached: false,
        elapsed_ms: 0,
    };
    let Some(exe) = lumen_exe(&settings) else {
        return Ok(unavailable());
    };

    // 坏 JSON 不能让细节整体失败：按「无 recipe」处理（与预览同口径）。
    let recipe: Option<serde_json::Value> = recipe.and_then(|r| match serde_json::from_str(&r) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("lumen_detail_cmd: recipe JSON 解析失败，已忽略: {}", e);
            None
        }
    });

    let src = PathBuf::from(&file_path);
    let cache_root = get_cache_dir().join("gallery");
    let runtime = state.lumen.clone();
    let busy = state.detail_busy.clone();

    blocking("LUMEN 细节渲染任务异常", move || {
        let recipe_for_render = recipe.clone();
        detail_impl(&src, &cache_root, recipe, &busy, |_tmp, args| {
            // `_tmp` 不用：生产路径由 `run_lumen` 按 `args["output"]` 自己写盘，
            // 只有测试需要往那个路径塞固定字节（用来模拟产物）。
            // 与预览同一条约束：`photo.export` 不接受 recipe 参数，必须先把
            // 调色写进 .lumen 工程再导出，否则细节是「没调过色」的那一版。
            if let Some(recipe) = &recipe_for_render {
                runtime
                    .apply_recipe(&exe, &src.to_string_lossy(), recipe)
                    .map_err(|e| LumenError::Protocol(format!("应用调色参数失败: {}", e)))?;
            }
            lumen::run_lumen(&exe, "photo.export", args).map(|_| ())
        })
    })
    .await
}

/// 细节渲染的实现体（与 `#[tauri::command]` 解耦，便于单测直接注入渲染边界）。
///
/// `render` 拿到的是 `(tmp 路径, photo.export 参数)`：生产实现是
/// `run_lumen(exe, "photo.export", args)`，测试是写固定字节。
pub(crate) fn detail_impl<F>(
    src: &Path,
    cache_root: &Path,
    recipe: Option<serde_json::Value>,
    busy: &AtomicBool,
    render: F,
) -> Result<LumenDetailResult, String>
where
    F: FnOnce(&Path, &Value) -> Result<(), LumenError>,
{
    if !src.is_file() {
        return Err(format!("原图片文件不存在: {}", src.display()));
    }

    // 并发上限 1：761MB/张，并行 3 张就是 2.3GB（报告 §5.4 实测）。
    // 用 compare_exchange 而非 load+store —— 同一 tick 到达的两个请求里
    // 只有一个能赢，另一个立刻 E_BUSY，不会一起冲进渲染。
    if busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(format!(
            "{}: 正在生成另一张的 1:1 细节，请稍候。",
            crate::taskgate::E_BUSY
        ));
    }
    let _guard = DetailBusyGuard(busy);

    let src_mtime = fs::metadata(src).and_then(|m| m.modified()).ok();
    // 兄弟 .lumen 工程：存在则把 mtime 纳入缓存键（与预览同口径）。
    let project = src.with_extension("lumen");
    let project_mtime = project
        .exists()
        .then(|| fs::metadata(&project).and_then(|m| m.modified()).ok())
        .flatten();

    let inputs = lumen::DetailCacheInputs {
        lumen_version: PINNED_LUMEN_VERSION,
        src_mtime,
        project_mtime,
        recipe,
    };
    let key = inputs.key(src);
    // 必须在 ensure_detail **之前**判定：它返回后文件一定存在，就永远是 true。
    let cached = inputs.cache_path(cache_root, &key).is_file();

    let t0 = std::time::Instant::now();
    let out = lumen::ensure_detail(src, cache_root, inputs, render).map_err(|e| e.to_string())?;
    let elapsed_ms = t0.elapsed().as_millis() as u64;

    if !cached {
        // 只有真写了新文件才可能超预算；命中缓存不扫目录。
        let _ = lumen::evict_detail_cache(cache_root, lumen::DETAIL_CACHE_LIMIT_BYTES);
    }

    Ok(LumenDetailResult {
        detail_path: Some(out.to_string_lossy().to_string()),
        cached,
        elapsed_ms,
    })
}

/// 细节渲染的独占标记：`Drop` 复位。
///
/// 与 `taskgate` 同一条理由 —— 渲染失败 / panic / 提前 return 都必须解锁，
/// 否则一次失败就让 1:1 永久不可用（比没有这个功能更糟）。
struct DetailBusyGuard<'a>(&'a AtomicBool);

impl Drop for DetailBusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// `probe_lumen_impl` 的单测（FE-07 从 commands.rs 的 `mod tests` 归位到此）。
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gallery_detail_{}_{}_{}",
            tag,
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一个「源 RAW」：内容随意，存在即可（mtime 参与缓存键）。
    fn fake_raw(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, b"raw").unwrap();
        p
    }

    #[test]
    fn first_render_then_cache_hit() {
        let root = scratch("hit");
        let src = fake_raw(&root, "A.ARW");
        let cache = root.join("cache");
        let busy = AtomicBool::new(false);
        let mut renders = 0;

        let r1 = detail_impl(&src, &cache, None, &busy, |tmp, _args| {
            renders += 1;
            std::fs::write(tmp, b"jpg").unwrap();
            Ok(())
        })
        .expect("首次应成功");
        assert!(!r1.cached, "首次必须是真渲染");
        assert_eq!(renders, 1);
        assert!(Path::new(r1.detail_path.as_deref().unwrap()).is_file());

        let r2 = detail_impl(&src, &cache, None, &busy, |_tmp, _args| {
            renders += 1;
            Ok(())
        })
        .expect("第二次应命中");
        assert!(r2.cached, "第二次必须命中缓存");
        assert_eq!(renders, 1, "命中缓存不得调用渲染边界");
        assert_eq!(
            r1.detail_path, r2.detail_path,
            "同一张图两次必须是同一个缓存文件"
        );
    }

    #[test]
    fn busy_returns_e_busy_without_rendering() {
        let root = scratch("busy");
        let src = fake_raw(&root, "A.ARW");
        let cache = root.join("cache");
        let busy = AtomicBool::new(true); // 另一张正在渲染

        let err = detail_impl(&src, &cache, None, &busy, |_tmp, _args| {
            panic!("忙的时候不得进入渲染边界");
        })
        .expect_err("应返回 E_BUSY");
        assert!(
            err.starts_with(crate::taskgate::E_BUSY),
            "必须是 E_BUSY 前缀（前端据此区分排队与真失败），实际: {}",
            err
        );
        assert!(
            busy.load(Ordering::Acquire),
            "标记属于别人，失败路径不得把它复位"
        );
    }

    #[test]
    fn busy_released_after_success() {
        let root = scratch("release_ok");
        let src = fake_raw(&root, "A.ARW");
        let busy = AtomicBool::new(false);
        detail_impl(&src, &root.join("cache"), None, &busy, |tmp, _a| {
            std::fs::write(tmp, b"jpg").unwrap();
            Ok(())
        })
        .expect("应成功");
        assert!(!busy.load(Ordering::Acquire), "成功后必须解锁");
    }

    #[test]
    fn busy_released_after_failure() {
        let root = scratch("release_err");
        let src = fake_raw(&root, "A.ARW");
        let busy = AtomicBool::new(false);
        let err = detail_impl(&src, &root.join("cache"), None, &busy, |_tmp, _a| {
            Err(LumenError::Command("渲染炸了".into()))
        })
        .expect_err("应失败");
        assert!(err.contains("渲染炸了"), "错误应透传，实际: {}", err);
        assert!(
            !busy.load(Ordering::Acquire),
            "渲染失败也必须解锁 —— 否则一次失败让 1:1 永久不可用"
        );
    }

    #[test]
    fn missing_source_is_error_and_releases_busy() {
        let root = scratch("missing");
        let busy = AtomicBool::new(false);
        let err = detail_impl(
            &root.join("nope.ARW"),
            &root.join("cache"),
            None,
            &busy,
            |_tmp, _a| panic!("源不存在不该进入渲染边界"),
        )
        .expect_err("应报源不存在");
        assert!(err.contains("不存在"), "实际: {}", err);
        assert!(!busy.load(Ordering::Acquire));
    }

    #[test]
    fn failure_leaves_no_cache_file() {
        // 失败后重试必须重新渲染 —— 命中一个 0 字节坏图比重新渲更糟。
        let root = scratch("failcache");
        let src = fake_raw(&root, "A.ARW");
        let cache = root.join("cache");
        let busy = AtomicBool::new(false);

        let _ = detail_impl(&src, &cache, None, &busy, |_tmp, _a| {
            Err(LumenError::Command("炸".into()))
        });

        let mut rendered = false;
        detail_impl(&src, &cache, None, &busy, |tmp, _a| {
            rendered = true;
            std::fs::write(tmp, b"jpg").unwrap();
            Ok(())
        })
        .expect("重试应成功");
        assert!(rendered, "上一次失败不得留下可命中的缓存文件");
    }

    /// `probe_lumen_cmd` 对不存在的路径：`available=false` 且带 `error`。
    /// 直接调用实现体（async），无需 tauri 运行时。
    ///
    /// 路径用「进程 id + 纳秒时间戳」保证全局唯一且从不创建——比迁移前
    ///    （先建临时目录、再引用其中不存在的文件）少一次磁盘写入与清理，
    /// 命中的仍是同一条「路径不存在」分支。
    #[test]
    fn probe_lumen_reports_error_for_missing_path() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let missing = std::env::temp_dir().join(format!(
            "gallery_probe_test_{}_{}.exe",
            std::process::id(),
            nanos
        ));
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
    }

    /// 真机冒烟（手动运行，不进 CI）：真实 24MP ARW + 真实 lumen-cli，走
    /// `detail_impl` 全链路（缓存键 / 单飞 / 原子落盘 / 淘汰判定）。
    ///
    /// ```text
    /// GALLERY_REAL_RAW_DIR="%TEMP%\gallery-realraw-20261018" \
    ///   cargo test --lib real_arw_detail_smoke -- --ignored --nocapture
    /// ```
    ///
    /// 为什么必须真文件：夹具里的 RAW 是 JPEG 改后缀，`photo.export` 出不了图；
    /// 合成测试也证明不了「省略 `long_edge` 真能拿到原生尺寸」—— 那正是
    /// 报告 §5.4 里 6–8 秒与「1600 是硬顶」两条结论的根基。
    ///
    /// 断言的是**数字**，不是「返回 Ok」：首次 ≤10s、缓存命中 ≤100ms、
    /// 产物长边 ≥4000（24MP 原图 6000+，1600 预览拉大绝不可能到这个数）。
    #[test]
    #[ignore = "需要真实素材 + lumen-cli：设置 GALLERY_REAL_RAW_DIR 后加 --ignored 运行"]
    fn real_arw_detail_smoke() {
        let Ok(root) = std::env::var("GALLERY_REAL_RAW_DIR") else {
            println!("[detail] 未设置 GALLERY_REAL_RAW_DIR，跳过");
            return;
        };
        let src = PathBuf::from(root).join("rawonly").join("DSC04339.ARW");
        assert!(src.is_file(), "缺少真实 RAW: {}", src.display());
        let exe = lumen::find_lumen_cli("").expect("找不到 lumen-cli（开发态 src-tauri/binaries）");

        let cache_root = scratch("real_arw");
        let busy = AtomicBool::new(false);

        // 与生产同一条渲染路径（生产多一步 apply_recipe，这里没有调色）。
        let render = |_tmp: &Path, args: &Value| {
            lumen::run_lumen(&exe, "photo.export", args).map(|_| ())
        };

        let first = detail_impl(&src, &cache_root, None, &busy, render).expect("首次渲染应成功");
        let path = PathBuf::from(first.detail_path.clone().expect("必须返回产物路径"));
        println!(
            "[detail] 首次 {} ms / cached={} / {}",
            first.elapsed_ms,
            first.cached,
            path.display()
        );
        assert!(!first.cached, "首次不该命中缓存");
        assert!(
            first.elapsed_ms <= 10_000,
            "出口标准是首次 ≤10s，实测 {} ms",
            first.elapsed_ms
        );

        let bytes = fs::metadata(&path).expect("产物应存在").len();
        let (w, h) = image::image_dimensions(&path).expect("产物应是可解码 JPEG");
        println!("[detail] 产物 {} KB / {}x{}", bytes / 1024, w, h);
        assert!(bytes > 1_000_000, "全分辨率 JPEG 不应只有 {} B", bytes);
        assert!(
            w.max(h) >= 4000,
            "应是原生尺寸（24MP 长边 6000+），实测 {}x{} —— 若这里是 1600，\
             说明 long_edge 省略没生效或 photo.export 退回了预览尺寸",
            w,
            h
        );

        // 命中：同一张再来一次必须**零渲染**（闭包里 panic 就是证据）。
        let second = detail_impl(&src, &cache_root, None, &busy, |_tmp, _args| {
            panic!("命中缓存时不该再渲染");
        })
        .expect("缓存命中应成功");
        println!("[detail] 命中 {} ms / cached={}", second.elapsed_ms, second.cached);
        assert!(second.cached, "第二次必须走命中分支");
        assert_eq!(second.detail_path, first.detail_path, "命中必须返回同一个文件");
        assert!(
            second.elapsed_ms <= 100,
            "出口标准是命中 ≤100ms，实测 {} ms",
            second.elapsed_ms
        );

        let _ = fs::remove_dir_all(&cache_root);
    }
}
