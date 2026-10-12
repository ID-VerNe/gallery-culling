use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

use crate::db::Database;
use crate::lumen::{self, LumenError, LumenStatus, PreviewVariant, PINNED_LUMEN_VERSION};
use crate::models::{
    AppSettings, ExportItem, FolderScanResult, LumenPreviewResult, LumenRatingConflict,
    LumenRatingSync, LumenRecipe, ToneAdjustments,
};
use crate::scanner::scan_folders;
use crate::thumbnail::{get_cache_dir, get_or_create_thumbnail};
use crate::xmp;
use crate::xmp::{flag_from_xmp, read_xmp_full, update_xmp_metadata, write_xmp};

pub struct AppState {
    pub db: Database,
    /// LUMEN RAW 常驻运行时（A 通道）：spawn 一次、握手、复用
    pub lumen: lumen::LumenRuntime,
}

#[tauri::command]
pub async fn scan_folders_cmd(
    jpg_folder: String,
    raw_folder: Option<String>,
    sort_order: Option<String>,
) -> Result<FolderScanResult, String> {
    let sort = sort_order.unwrap_or_else(|| "time_filename".to_string());
    tokio::task::spawn_blocking(move || scan_folders(&jpg_folder, raw_folder.as_deref(), &sort))
        .await
        .map_err(|e| format!("扫描任务异常: {}", e))?
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
            if path.exists() {
                if update_xmp_metadata(path, lens, focal, ap).is_ok() {
                    count += 1;
                }
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
            if path.exists() {
                if trash::delete(path).is_ok() {
                    count += 1;
                }
            }
        }
        Ok(count)
    })
    .await
    .map_err(|e| format!("移动至回收站失败: {}", e))?
}

#[tauri::command]
pub async fn batch_export_cmd(
    items: Vec<ExportItem>,
    target_folder: String,
    include_raw: bool,
    include_jpg: bool,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let target_dir = Path::new(&target_folder);
        if !target_dir.exists() {
            fs::create_dir_all(target_dir).map_err(|e| format!("创建目标导出目录失败: {}", e))?;
        }

        let mut exported = 0;
        for item in items {
            // Copy JPG if requested
            if include_jpg {
                if let Some(jpg_path_str) = &item.jpg_path {
                    let src = Path::new(jpg_path_str);
                    if src.exists() {
                        if let Some(file_name) = src.file_name() {
                            let dst = target_dir.join(file_name);
                            if fs::copy(src, dst).is_ok() {
                                exported += 1;
                            }
                        }
                    }
                }
            }

            // Copy RAW if requested
            if include_raw {
                if let Some(raw_path_str) = &item.raw_path {
                    let src = Path::new(raw_path_str);
                    if src.exists() {
                        if let Some(file_name) = src.file_name() {
                            let dst = target_dir.join(file_name);
                            if fs::copy(src, dst).is_ok() {
                                exported += 1;
                            }
                        }
                        // Also copy matching .xmp if exists
                        let xmp_src = src.with_extension("xmp");
                        if xmp_src.exists() {
                            if let Some(xmp_name) = xmp_src.file_name() {
                                let xmp_dst = target_dir.join(xmp_name);
                                let _ = fs::copy(xmp_src, xmp_dst);
                            }
                        }
                    }
                }
            }
        }

        Ok(exported)
    })
    .await
    .map_err(|e| format!("批量导出任务异常: {}", e))?
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
