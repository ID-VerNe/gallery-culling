use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Locate Luminar AI executable path via Windows registry or default install directory
pub fn find_luminar_executable() -> Option<PathBuf> {
    // 1. Query HKLM\SOFTWARE\Skylum\Luminar AI
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Skylum\Luminar AI",
                "/v",
                "ApplicationPath",
            ])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    if line.contains("ApplicationPath") {
                        let parts: Vec<&str> = line.split("REG_SZ").collect();
                        if parts.len() >= 2 {
                            let p = PathBuf::from(parts[1].trim());
                            if p.exists() {
                                return Some(p);
                            }
                        }
                    }
                }
            }
        }

        // 2. Query HKCU\SOFTWARE\Skylum\Luminar AI
        if let Ok(output) = Command::new("reg")
            .args([
                "query",
                r"HKCU\SOFTWARE\Skylum\Luminar AI",
                "/v",
                "ApplicationPath",
            ])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    if line.contains("ApplicationPath") {
                        let parts: Vec<&str> = line.split("REG_SZ").collect();
                        if parts.len() >= 2 {
                            let p = PathBuf::from(parts[1].trim());
                            if p.exists() {
                                return Some(p);
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback standard default installation path
    let default_path = PathBuf::from(r"C:\Program Files\Skylum\Luminar AI\Luminar AI.exe");
    if default_path.exists() {
        return Some(default_path);
    }

    None
}

/// Launch Luminar AI in Photoshop Plugin mode, wait for user to click Apply, and return modified file path
pub async fn edit_in_luminar(file_path: &Path) -> Result<PathBuf, String> {
    let luminar_exe = find_luminar_executable()
        .ok_or_else(|| "未检测到 Luminar AI，请确认计算机上已安装 Luminar AI。".to_string())?;

    if !file_path.exists() {
        return Err(format!("原图片文件不存在: {}", file_path.display()));
    }

    let parent_dir = file_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");

    // Output target file name: e.g. "DSC04337_Luminar.tif"
    let target_tif = parent_dir.join(format!("{}_Luminar.tif", stem));

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let is_raw = matches!(
        ext.as_str(),
        "arw" | "cr2" | "cr3" | "nef" | "dng" | "orf" | "rw2" | "pef"
    );

    // Prepare target TIFF for Luminar AI
    if !target_tif.exists() {
        if is_raw {
            // Priority: check if a paired JPG exists
            let paired_jpg = parent_dir.join(format!("{}.jpg", stem));
            let paired_jpeg = parent_dir.join(format!("{}.jpeg", stem));
            let paired_jpg_upper = parent_dir.join(format!("{}.JPG", stem));

            if paired_jpg.exists() {
                let _ = fs::copy(&paired_jpg, &target_tif);
            } else if paired_jpeg.exists() {
                let _ = fs::copy(&paired_jpeg, &target_tif);
            } else if paired_jpg_upper.exists() {
                let _ = fs::copy(&paired_jpg_upper, &target_tif);
            } else {
                // Fallback: copy file directly
                let _ = fs::copy(file_path, &target_tif);
            }
        } else {
            let _ = fs::copy(file_path, &target_tif);
        }
    }

    let orig_mtime = fs::metadata(&target_tif).and_then(|m| m.modified()).ok();

    // Photoshop plugin protocol arguments reverse-engineered from LuminarAI.8bf:
    // "<exe>" "<target.tif>" photoshop "" origname "<orig_name>" document "Gallery Culling" display_dialog true
    let mut cmd = Command::new(&luminar_exe);
    cmd.arg(&target_tif)
        .arg("photoshop")
        .arg("")
        .arg("origname")
        .arg(
            file_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(stem),
        )
        .arg("document")
        .arg("Gallery Culling")
        .arg("display_dialog")
        .arg("true");

    let target_path_clone = target_tif.clone();

    tokio::task::spawn_blocking(move || {
        let status = cmd
            .status()
            .map_err(|e| format!("启动 Luminar AI 进程失败: {}", e))?;

        if !status.success() {
            return Err(format!(
                "Luminar AI 进程非正常退出 (Exit Code: {:?})",
                status.code()
            ));
        }

        // Verify that target_tif exists
        if !target_path_clone.exists() {
            return Err("用户在 Luminar AI 中取消或未生成成果文件。".to_string());
        }

        // Check if modified time has changed
        if let Ok(meta) = fs::metadata(&target_path_clone) {
            if let Ok(new_mtime) = meta.modified() {
                if Some(new_mtime) != orig_mtime {
                    return Ok(target_path_clone);
                }
            }
        }

        // Even if mtime hasn't noticeably changed, if target exists, return success
        Ok(target_path_clone)
    })
    .await
    .map_err(|e| format!("Luminar 执行任务异常: {}", e))?
}
