//! 把照片交给外部程序：Photoshop、系统默认程序、回收站。

use std::path::Path;

use tauri::State;

use super::{blocking, AppState};

/// 外部打开的启动方式（issue #106 · A 档）：统一 Medium IL。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalLaunch {
    PhotoshopDirect,
    PhotoshopViaExplorer,
    DefaultDirect,
    DefaultViaExplorer,
}

/// 纯决策函数（可测）：输入宿主是否提权 / PS 路径是否存在 / 目标是否 Medium。
///
/// A 档期望 Medium（`want_medium=true`）：提权时主路径走 explorer 代理降权到 Medium，
/// 非提权直接 spawn 本就是 Medium；路径缺失走默认程序回落（与 `open_folder_cmd` 同口径，不经 shell 重新解析）。
/// `want_medium=false` 是“保持宿主继承”语义：恒直接 spawn（继承 High/Medium）。
pub fn decide_external_launch(
    host_is_elevated: bool,
    ps_path_exists: bool,
    want_medium: bool,
) -> ExternalLaunch {
    match (host_is_elevated, ps_path_exists, want_medium) {
        (true, true, true) => ExternalLaunch::PhotoshopViaExplorer,
        (false, true, true) => ExternalLaunch::PhotoshopDirect,
        (true, true, false) => ExternalLaunch::PhotoshopDirect,
        (false, true, false) => ExternalLaunch::PhotoshopDirect,
        (true, false, true) => ExternalLaunch::DefaultViaExplorer,
        (false, false, true) => ExternalLaunch::DefaultViaExplorer,
        (true, false, false) => ExternalLaunch::DefaultDirect,
        (false, false, false) => ExternalLaunch::DefaultDirect,
    }
}

#[cfg(windows)]
mod elevation {
    use std::ffi::c_void;

    #[link(name = "advapi32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn CloseHandle(h: *mut c_void) -> i32;
        fn CheckTokenMembership(token: *mut c_void, sid: *mut c_void, is_member: *mut i32) -> i32;
        fn AllocateAndInitializeSid(
            authority: *const c_void,
            revision: u8,
            sub_authority_count: u8,
            n0: u32,
            n1: u32,
            n2: u32,
            n3: u32,
            n4: u32,
            n5: u32,
            n6: u32,
            n7: u32,
            out_sid: *mut *mut c_void,
        ) -> i32;
        fn FreeSid(sid: *mut c_void) -> *mut c_void;
    }

    const TOKEN_QUERY: u32 = 0x0008;
    const SECURITY_NT_AUTHORITY: [u8; 6] = [0, 0, 0, 0, 0, 5];
    const DOMAIN_ADMIN_GROUP_RID: u32 = 544;

    /// 当前进程管理员组是否启用（UAC 提权后的 High IL）？
    /// 用 `CheckTokenMembership` 查 BUILTIN\Administrators；非提权时仅存在但未启用。
    pub fn is_elevated() -> bool {
        unsafe {
            let mut token: *mut c_void = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0
                || token.is_null()
            {
                return false;
            }
            let mut admin_sid: *mut c_void = std::ptr::null_mut();
            let ok = AllocateAndInitializeSid(
                SECURITY_NT_AUTHORITY.as_ptr() as *const c_void,
                1,
                1,
                DOMAIN_ADMIN_GROUP_RID,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                &mut admin_sid,
            );
            if ok == 0 || admin_sid.is_null() {
                let _ = CloseHandle(token);
                return false;
            }
            let mut is_member: i32 = 0;
            let check = CheckTokenMembership(token, admin_sid, &mut is_member);
            let _ = FreeSid(admin_sid);
            let _ = CloseHandle(token);
            check != 0 && is_member != 0
        }
    }
}

/// 宿主当前是否提权（管理员组启用）。Windows 以外恒 false（无 UAC/IL 概念）。
pub fn host_is_elevated() -> bool {
    #[cfg(windows)]
    {
        elevation::is_elevated()
    }
    #[cfg(not(windows))]
    {
        false
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

    let ps_exists = Path::new(&ps_path).exists();
    // A 档目标 Medium（want_medium=true），提权时 explorer 代理降权，IL 与用户手动启动的 PS 一致。
    let kind = decide_external_launch(host_is_elevated(), ps_exists, true);

    match kind {
        ExternalLaunch::PhotoshopDirect => {
            crate::proc::silent(&ps_path)
                .arg(&file_path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("启动 Photoshop 失败 ({}): {}", ps_path, e))?;
            Ok(true)
        }
        ExternalLaunch::PhotoshopViaExplorer => {
            // explorer 在提权父下仍以 Medium IL 拉起目标（#49 探针），避免新 PS 继承 High 或与已有 Medium 实例的单实例 IPC 被 UIPI 拦截。
            // 参数为独立 argv，不经过 cmd 二次解析（& 安全）。
            crate::proc::silent("explorer.exe")
                .arg(&ps_path)
                .arg(&file_path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| {
                    format!("启动 Photoshop 失败 (经 explorer 代理 {}): {}", ps_path, e)
                })?;
            Ok(true)
        }
        ExternalLaunch::DefaultDirect | ExternalLaunch::DefaultViaExplorer => {
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

#[cfg(test)]
mod tests {
    use super::{decide_external_launch, ExternalLaunch};

    #[test]
    fn decide_a档提权有ps走explorer代理() {
        assert_eq!(
            decide_external_launch(true, true, true),
            ExternalLaunch::PhotoshopViaExplorer
        );
        assert_eq!(
            decide_external_launch(false, true, true),
            ExternalLaunch::PhotoshopDirect
        );
        assert_eq!(
            decide_external_launch(true, false, true),
            ExternalLaunch::DefaultViaExplorer
        );
        assert_eq!(
            decide_external_launch(false, false, true),
            ExternalLaunch::DefaultViaExplorer
        );
    }

    #[test]
    fn decide_c档恒继承宿主不管提权() {
        assert_eq!(
            decide_external_launch(true, true, false),
            ExternalLaunch::PhotoshopDirect
        );
        assert_eq!(
            decide_external_launch(false, true, false),
            ExternalLaunch::PhotoshopDirect
        );
        assert_eq!(
            decide_external_launch(true, false, false),
            ExternalLaunch::DefaultDirect
        );
        assert_eq!(
            decide_external_launch(false, false, false),
            ExternalLaunch::DefaultDirect
        );
    }

    #[test]
    fn decide_提权必须有explorer分支非直连() {
        assert_ne!(
            decide_external_launch(true, true, true),
            ExternalLaunch::PhotoshopDirect,
            "提权 + 想要 Medium 时不得直连（会继承 High）"
        );
        assert_ne!(
            decide_external_launch(true, false, true),
            ExternalLaunch::DefaultDirect,
            "提权回落不得走 cmd start 直连"
        );
    }

    #[test]
    #[ignore]
    fn smoke_host_is_elevated_runs() {
        let _ = super::host_is_elevated();
    }
}
