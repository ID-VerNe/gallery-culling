//! LUMEN RAW 引擎的全部 Tauri 命令：握手、探测、预览、评级同步、
//! recipe 读写、能力查询、AI 蒙版。
//!
//! 降级语义分两族，**不要**统一成一个带 kind 参数的 helper：
//! `require_lumen` 是不可用即 Err（必须走引擎路径的操作），
//! `lumen_exe` 是不可用即 None（调用方返回各自的 Ok(降级值)）。
//! 两者的差别是外部事实（引擎公开方法的返回类型），不是调用点口味。

use std::fs;
use std::path::PathBuf;

use tauri::State;

use crate::thumbnail::get_cache_dir;
use crate::xmp;
use crate::xmp::{flag_from_xmp, read_xmp_full, write_xmp};
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

/// `probe_lumen_impl` 的单测（FE-07 从 commands.rs 的 `mod tests` 归位到此）。
#[cfg(test)]
mod tests {
    use super::*;

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
}
