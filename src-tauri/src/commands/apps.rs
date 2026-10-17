//! 把照片交给外部程序：Photoshop、系统默认程序、回收站。

use std::path::Path;

use tauri::State;

use super::{blocking, AppState};

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

    crate::proc::silent(&ps_path)
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
        crate::proc::silent("cmd")
            .args(["/c", "start", "", &file_path])
            .spawn()
            .map_err(|e| format!("无法使用系统默认程序打开文件: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        crate::proc::silent("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("无法使用系统默认程序打开文件: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        crate::proc::silent("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("无法使用系统默认程序打开文件: {}", e))?;
    }

    Ok(true)
}

/// 在系统文件管理器中打开一个**目录**。
///
/// 为什么不复用 `open_in_default_app_cmd`：那条在 Windows 上走
/// `cmd /c start "" <path>`，路径会被 cmd 当作命令行**重新解析** —— 名字里带
/// `&` / `^` 的文件夹（`2024_客户A&B` 这种完全合法）会被截断成两条命令。
/// 这里改用 opener 插件：路径作为独立参数交给 explorer / open，不经过 shell。
///
/// 先 `is_dir()` 再打开：目标目录可能已被用户删掉或改名，此时给一句明确的
/// 「目录不存在」比让资源管理器弹一个空白窗口更有用。
#[tauri::command]
pub async fn open_folder_cmd(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("目录路径为空".to_string());
    }
    if !Path::new(trimmed).is_dir() {
        return Err(format!("目录不存在或已被移动：{}", trimmed));
    }
    app.opener()
        .open_path(trimmed.to_string(), None::<&str>)
        .map_err(|e| format!("无法打开目录: {}", e))
}

#[tauri::command]
pub async fn trash_photos_cmd(file_paths: Vec<String>) -> Result<usize, String> {
    blocking("移动至回收站失败", move || {
        let mut count = 0;
        for path_str in file_paths {
            let path = Path::new(&path_str);
            if path.exists() && trash::delete(path).is_ok() {
                count += 1;
            }
        }
        Ok::<_, String>(count)
    })
    .await
}
