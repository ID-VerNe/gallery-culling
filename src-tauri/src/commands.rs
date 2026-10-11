use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

use crate::db::Database;
use crate::lumen::{self, LumenStatus, PreviewVariant, PINNED_LUMEN_VERSION};
use crate::models::{AppSettings, ExportItem, FolderScanResult, LumenPreviewResult};
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
    state: State<'_, AppState>,
) -> Result<LumenPreviewResult, String> {
    let settings = state.db.load_settings()?;
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

    let key = lumen::lumen_cache_key(
        &src,
        width,
        variant,
        PINNED_LUMEN_VERSION,
        src_mtime,
        project_mtime,
    );
    let was_cached = lumen::cached_preview(&cache_root, &key, width, variant).is_some();

    let runtime = state.lumen.clone();
    let inputs = lumen::PreviewCacheInputs {
        width,
        variant,
        lumen_version: PINNED_LUMEN_VERSION,
        src_mtime,
        project_mtime,
    };
    let rendered = tokio::task::spawn_blocking(move || {
        lumen::ensure_preview(&src, &cache_root, inputs, |_tmp, args| {
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
#[tauri::command]
pub async fn lumen_sync_ratings_cmd(
    state: State<'_, AppState>,
    folder: String,
) -> Result<Vec<String>, String> {
    let settings = state.db.load_settings()?;
    if !settings.lumen_enabled {
        return Ok(Vec::new()); // 引擎关闭 → 零请求
    }
    let exe = match lumen::find_lumen_cli(&settings.lumen_cli_path) {
        Some(e) => e,
        None => return Ok(Vec::new()), // 未安装 → 静默降级
    };
    let runtime = state.lumen.clone();
    let db = state.db.clone();

    tokio::task::spawn_blocking(move || {
        let folder_path = PathBuf::from(&folder);
        let entries = match runtime.pull_ratings(&exe, &folder_path) {
            Ok(v) => v,
            Err(e) => return Err(format!("拉取 LUMEN RAW 评级失败: {}", e)),
        };

        let mut updated = Vec::new();
        for (path, rating, flag) in entries {
            let p = PathBuf::from(&path);
            if !p.exists() {
                continue;
            }
            let host_flag =
                flag_from_xmp(&read_xmp_full(&xmp::get_xmp_path(&p)).unwrap_or_default());
            let host_rating = read_xmp_full(&xmp::get_xmp_path(&p))
                .map(|m| m.rating)
                .unwrap_or(0);
            if host_rating == rating && host_flag == flag {
                continue; // 已一致
            }
            // lumen 的 reject → 宿主的 reject（flag_from_xmp 已统一 -1 语义）
            write_xmp(&p, rating, &flag)?;
            let _ = db.upsert_rating_sync(
                &path,
                rating,
                &flag,
                "lumen",
                crate::db::file_mtime_secs(&xmp::get_xmp_path(&p)),
            );
            updated.push(path);
        }
        Ok(updated)
    })
    .await
    .map_err(|e| format!("评级同步任务异常: {}", e))?
}
