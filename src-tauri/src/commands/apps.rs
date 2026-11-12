//! 把照片交给外部程序：Photoshop、系统默认程序、回收站。

use std::path::Path;

use tauri::State;

use super::{blocking, AppState};

/// 「外部打开」的落点：能拿到真实存在的 Photoshop 就直连，否则交回系统默认程序。
///
/// **刻意不做 explorer 代理降权**（issue #197 的实测结论）：把
/// `explorer.exe <Photoshop.exe> <照片>` 喂给 shell，它既不启动那个 exe、也不打开
/// 那个文件，只会弹一个「文档」窗口 —— 提权用户点「外部打开」看到的正是这一幕。
/// 真正可行的 IL 降权要复制 explorer.exe 的 Medium 令牌再 `CreateProcessWithTokenW`，
/// 是独立工程（#106 的遗留诉求），不该和「先让它能用」混在一起。
///
/// 代价：提权运行时 PS 会继承 High IL。这与 2.0.10 及更早的长期行为一致，
/// 比「点开什么都不发生」好得多。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalLaunch {
    /// 直连 `Photoshop.exe <照片>`。
    Photoshop,
    /// 交给系统默认程序（PS 路径未配置或文件不存在）。
    Default,
}

/// 纯决策函数（可测）：只看 PS 路径是否真的在盘上。
///
/// 与 `open_folder_cmd` 同口径 —— 路径缺失时回落默认程序，不经 shell 重新解析。
/// 注意这里**没有**「宿主是否提权」这一维：外部打开不因 IL 改变落点（issue #197）。
pub fn plan_external_open(ps_path: &str) -> ExternalLaunch {
    if !ps_path.trim().is_empty() && Path::new(ps_path).exists() {
        ExternalLaunch::Photoshop
    } else {
        ExternalLaunch::Default
    }
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

    match plan_external_open(&ps_path) {
        ExternalLaunch::Photoshop => {
            // 直连。提权宿主下 PS 继承 High IL —— 见 `ExternalLaunch` 的说明（issue #197）。
            crate::proc::silent(&ps_path)
                .arg(&file_path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("启动 Photoshop 失败 ({}): {}", ps_path, e))?;
            Ok(true)
        }
        ExternalLaunch::Default => {
            // 回落用 false 区分（前端据此 toast，而非静默）。
            open_in_default_app_cmd(file_path).await.map(|_| false)
        }
    }
}

#[tauri::command]
pub async fn open_in_default_app_cmd(file_path: String) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        // A 档收敛：不再走 `cmd /c start "" <file>`（shell 会重新解析 &/^ 且 exe 仍继承 High），
        // 统一经 explorer 代理（Medium）+ 独立 argv（& 安全），与 open_folder_cmd 的 opener 口径一致。
        crate::proc::silent("explorer.exe")
            .arg(&file_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
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

/// 在 Luminar Neo 里打开照片并等用户编辑完回传路径（roundtrip）。
#[tauri::command]
pub async fn open_in_luminar_roundtrip_cmd(file_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(file_path);
    let edited_path = crate::luminar::edit_in_luminar(&path).await?;
    Ok(edited_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{plan_external_open, ExternalLaunch};

    /// 墓碑（issue #197）：外部打开**只能**直连 Photoshop。
    ///
    /// 曾经的 `PhotoshopViaExplorer` 分支把 `explorer.exe <Photoshop.exe> <照片>` 交给
    /// shell，实测只弹一个「文档」窗口、PS 进程数为 0 —— 提权用户点 W 就是这个结果。
    /// 现在 `ExternalLaunch` 里不存在任何代理变体，这条断言同时守住「落点没被改回去」。
    #[test]
    fn plan_有真实ps路径就直连不走代理() {
        // 真实存在的可执行文件（用系统自带 cmd.exe 当替身，避免依赖 Photoshop 装没装）。
        let sys = std::env::var("COMSPEC").unwrap_or_else(|_| "C:/Windows/System32/cmd.exe".into());
        assert!(
            std::path::Path::new(&sys).exists(),
            "前提不成立：{sys} 应该存在"
        );
        assert_eq!(plan_external_open(&sys), ExternalLaunch::Photoshop);
    }

    /// 路径缺失 / 空串 / 纯空白 → 回落默认程序（前端据此 toast，不静默）。
    #[test]
    fn plan_缺ps路径回落默认程序() {
        assert_eq!(
            plan_external_open("C:/definitely-not-here/Photoshop.exe"),
            ExternalLaunch::Default
        );
        assert_eq!(plan_external_open(""), ExternalLaunch::Default);
        assert_eq!(plan_external_open("   "), ExternalLaunch::Default);
    }

    /// 真机：按「点外部打开」那一步跑一遍，素材与设置都用真实数据。
    ///
    /// `GALLERY_REAL_RAW_DIR="…\2026年9月12日-惠州西湖"` 后
    /// `cargo test --lib -- --ignored 外部打开`。
    /// 真实素材路径来自该目录，Photoshop 路径来自用户真实设置库里的 `photoshop_path`
    /// —— 就是 `open_in_photoshop_cmd` 实际会用的那个。
    #[cfg(windows)]
    #[test]
    #[ignore = "需要真实素材与真实设置库：设置 GALLERY_REAL_RAW_DIR 后加 --ignored 运行"]
    fn 外部打开_真实素材走通决策链路() {
        let Ok(dir) = std::env::var("GALLERY_REAL_RAW_DIR") else {
            println!("[external-open] 未设置 GALLERY_REAL_RAW_DIR，跳过");
            return;
        };
        let sample = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| {
                    matches!(
                        p.extension()
                            .and_then(|s| s.to_str())
                            .map(|s| s.to_ascii_lowercase())
                            .as_deref(),
                        Some("arw") | Some("jpg")
                    )
                })
            })
            .ok()
            .flatten()
            .expect("GALLERY_REAL_RAW_DIR 下没找到 arw/jpg");
        assert!(sample.is_file(), "真实素材应可读：{}", sample.display());

        // 用户真实设置库（`~/.galleryculling/gallery_culling.db`），只读。
        let settings = crate::db::Database::new()
            .and_then(|db| db.load_settings())
            .expect("读用户设置库失败");
        let ps_path = settings
            .photoshop_path
            .trim_matches(|c| c == '"' || c == '\'' || c == ' ')
            .to_string();

        let kind = plan_external_open(&ps_path);
        println!(
            "[external-open] 素材={} PS={:?} 存在={} 决策={:?}",
            sample.display(),
            ps_path,
            std::path::Path::new(&ps_path).exists(),
            kind
        );

        // 真实 PS 路径必须落到直连；落到 Default 说明路径解析或判定坏了（issue #197）。
        assert_eq!(
            kind,
            ExternalLaunch::Photoshop,
            "配置的 Photoshop 路径应判为直连；若 PS 确实没装，请改这条断言的前提而不是放宽它"
        );
    }
}
