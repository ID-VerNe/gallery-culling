//! 把照片交给外部程序：Photoshop、系统默认程序、回收站。

use std::path::Path;

use tauri::State;

use super::{blocking, AppState};

/// 「外部打开」的落点（issue #199 · #106 遗留诉求）。
///
/// 两段历史结论：
/// - #197 实测：把 `explorer.exe <Photoshop.exe> <照片>` 喂给 shell，它既不启动那个 exe、
///   也不打开那个文件，只弹一个「文档」窗口 —— explorer 代理变体不可行，已净删。
/// - 本路径：提权宿主下复制 explorer.exe 的 Medium 令牌，`CreateProcessWithTokenW` 启动 PS，
///   IL 与用户手动启动的 PS 一致；令牌路径任一步失败则显式回落直连（见
///   [`ExternalLaunch::PhotoshopDirectFallback`]），不伪装成降权成功。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalLaunch {
    /// 非提权宿主直连 `Photoshop.exe <照片>`（继承 Medium，现有行为）。
    PhotoshopDirect,
    /// 提权宿主：复制 explorer Medium 令牌，经 `CreateProcessWithTokenW` 启动。
    PhotoshopToken,
    /// 提权宿主：令牌路径某步失败，显式回落直连（PS 将继承 High IL）。
    ///
    /// 与 [`ExternalLaunch::PhotoshopDirect`] 区分：这是「降权失败」的回落，调用方必须
    /// 留痕告警，不得当成功静默（issue #199 硬要求）。
    PhotoshopDirectFallback,
    /// 交给系统默认程序（PS 路径未配置或文件不存在）。
    Default,
}

/// 纯决策函数（可测）：只看三个环境输入，不碰 FFI / 文件系统。
///
/// 判定表：
///
/// | ps_exists | elevated | token_available | 落点 |
/// |---|---|---|---|
/// | false | * | * | [`ExternalLaunch::Default`] |
/// | true | false | * | [`ExternalLaunch::PhotoshopDirect`] |
/// | true | true | true | [`ExternalLaunch::PhotoshopToken`] |
/// | true | true | false | [`ExternalLaunch::PhotoshopDirectFallback`] |
pub fn decide_external_open(
    ps_exists: bool,
    elevated: bool,
    token_available: bool,
) -> ExternalLaunch {
    match (ps_exists, elevated, token_available) {
        (false, _, _) => ExternalLaunch::Default,
        (true, false, _) => ExternalLaunch::PhotoshopDirect,
        (true, true, true) => ExternalLaunch::PhotoshopToken,
        (true, true, false) => ExternalLaunch::PhotoshopDirectFallback,
    }
}

/// 薄壳：把 PS 路径存在性检查折进来，再交给 [`decide_external_open`]。
///
/// 与 `open_folder_cmd` 同口径 —— 路径缺失时回落默认程序，不经 shell 重新解析。
/// `elevated` / `token_available` 由命令层从 FFI 取来注入，纯函数本身不查宿主状态。
pub fn plan_external_open(ps_path: &str, elevated: bool, token_available: bool) -> ExternalLaunch {
    let ps_exists = !ps_path.trim().is_empty() && Path::new(ps_path).exists();
    decide_external_open(ps_exists, elevated, token_available)
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

    let elevated = win32::host_is_elevated();
    // 仅在「提权 + PS 在盘」时才取令牌：路径缺失走 Default 分支，取来的令牌无处消费，
    // 会泄漏句柄。失败原因保留给 Fallback 分支留痕，不在此提前返回
    // （issue #199：回落直连，不静默）。
    let ps_exists = !ps_path.trim().is_empty() && Path::new(&ps_path).exists();
    let token_result = if elevated && ps_exists {
        win32::acquire_explorer_token()
    } else {
        Err(win32::TokenFailure::NotElevated)
    };
    let token_available = token_result.is_ok();

    match plan_external_open(&ps_path, elevated, token_available) {
        ExternalLaunch::PhotoshopToken => {
            let token = token_result.expect("token_available=true 时令牌必在");
            win32::launch_with_token(token, &ps_path, &file_path)
                .map_err(|e| format!("启动 Photoshop 失败 (令牌降权 {}): {}", ps_path, e))?;
            Ok(true)
        }
        ExternalLaunch::PhotoshopDirect => {
            // 非提权宿主直连，继承 Medium —— 现有行为。
            crate::proc::silent(&ps_path)
                .arg(&file_path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("启动 Photoshop 失败 ({}): {}", ps_path, e))?;
            Ok(true)
        }
        ExternalLaunch::PhotoshopDirectFallback => {
            // 降权失败回落直连：不静默 —— eprintln 留痕（失败步骤 + 错误码），PS 将继承 High IL。
            let reason = token_result
                .as_ref()
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "未知原因".to_string());
            eprintln!(
                "[external-open] 提权宿主下令牌降权失败（{}），已回落直连：PS 将继承 High IL。",
                reason
            );
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
        // 只负责用文件的默认关联程序打开；路径作为独立 argv 交给 explorer（& 安全）。
        // 注意：这里**不承诺任何 IL 降权** —— 实测 explorer 不会代为启动指定 exe（#197），
        // 提权宿主下经此路径打开的文件仍可能落在 High IL 进程里。
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

/// 提权判定与 Medium 令牌复制降权的 Windows FFI 层（issue #199）。
///
/// 手写 `extern "system"`，不引 windows-sys / winapi：本路径只用到 9 个窄 API，
/// 与 #195/#196 旧 elevation 模块同风格。非 Windows 编译期退化为恒 false / 恒 Err。
#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    type HANDLE = *mut c_void;

    /// 复制得到的主令牌句柄。用 `usize` 包装：裸指针不是 `Send`，而命令 future 要求
    /// `Send`；内核句柄进程内共享、可安全在线程间移动，存数值即可。
    pub struct Token(usize);

    impl Token {
        fn as_handle(&self) -> HANDLE {
            self.0 as HANDLE
        }

        /// 关闭令牌句柄（复制令牌在进程创建完成后即可关闭）。
        pub fn close(self) {
            unsafe { CloseHandle(self.as_handle()) };
        }
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const TOKEN_DUPLICATE: u32 = 0x0002;
    const TOKEN_QUERY: u32 = 0x0008;
    /// `MAXIMUM_ALLOWED`：重复令牌按上下文允许的最大权限授予。`CreateProcessWithTokenW`
    /// 要求令牌带 `TOKEN_ASSIGN_PRIMARY`，只申请 DUPLICATE|QUERY 可能不够。
    const MAXIMUM_ALLOWED: u32 = 0x0200;
    /// `SECURITY_IMPERSONATION_LEVEL::SecurityImpersonation`。
    const SECURITY_IMPERSONATION: u32 = 2;
    /// `TOKEN_TYPE::TokenPrimary`。
    const TOKEN_TYPE_PRIMARY: u32 = 1;
    const LOGON_WITH_PROFILE: u32 = 0x0000_0001;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// `STARTUPINFOW`（winbase.h）：只零初始化 + 填 `cb`，其余字段保持默认。
    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_chars: u32,
        dw_y_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: HANDLE,
        h_std_output: HANDLE,
        h_std_error: HANDLE,
    }

    #[repr(C)]
    struct ProcessInformation {
        h_process: HANDLE,
        h_thread: HANDLE,
        dw_process_id: u32,
        dw_thread_id: u32,
    }

    /// `SID_IDENTIFIER_AUTHORITY`：Win32 里是「6 字节权限值」的**结构体**，按值地址传入。
    ///
    /// issue #195 的教训：以前这里只会用 `[u8; 6]` 裸转 `*const c_void`，于是有人把
    /// 「revision」当成了 `AllocateAndInitializeSid` 的入参 —— 它其实是本结构体的字段。
    /// 用带名字的 `#[repr(C)]` 结构体，参数表就没法再被凭空加一项。
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SidIdentifierAuthority {
        /// Win32 里这个字段叫 `Value`；本进程只构造不读取，故显式放行 dead_code。
        #[allow(dead_code)]
        value: [u8; 6],
    }

    const SECURITY_NT_AUTHORITY: SidIdentifierAuthority = SidIdentifierAuthority {
        value: [0, 0, 0, 0, 0, 5],
    };
    /// `S-1-5-32-…` 的第二段：内置域（BUILTIN）。
    const SECURITY_BUILTIN_DOMAIN_RID: u32 = 32;
    /// `S-1-5-32-544` 的末段：Administrators 别名。
    const DOMAIN_ALIAS_RID_ADMINS: u32 = 544;

    #[link(name = "advapi32")]
    extern "system" {
        // 真签名 11 参（issue #195）：`pIdentifierAuthority, nSubAuthorityCount,
        // nSubAuthority0..7, pSid`。多写一个参数会让后面所有实参整体错位一档，
        // `pSid` 收到 0 → API 往 NULL 写 SID → 整个进程 0xc0000005（Rust 无法捕获）。
        // 注：extern 块里不能用 `///`（会触发 unused_doc_comments），一律用 `//`。
        fn AllocateAndInitializeSid(
            authority: *const SidIdentifierAuthority,
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
        // `token` 传 NULL 表示「调用线程的有效令牌」（本进程不做 impersonation）。
        fn CheckTokenMembership(token: *mut c_void, sid: *mut c_void, is_member: *mut i32) -> i32;
        fn FreeSid(sid: *mut c_void) -> *mut c_void;
        fn OpenProcessToken(
            process_handle: HANDLE,
            desired_access: u32,
            token_handle: *mut HANDLE,
        ) -> i32;
        fn DuplicateTokenEx(
            existing_token: HANDLE,
            desired_access: u32,
            token_attributes: *mut c_void,
            impersonation_level: u32,
            token_type: u32,
            new_token: *mut HANDLE,
        ) -> i32;
        fn CreateProcessWithTokenW(
            token: HANDLE,
            logon_flags: u32,
            application_name: *const u16,
            command_line: *mut u16,
            creation_flags: u32,
            environment: *mut c_void,
            current_directory: *const u16,
            startup_info: *const StartupInfoW,
            process_information: *mut ProcessInformation,
        ) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetShellWindow() -> isize;
        fn GetWindowThreadProcessId(hwnd: isize, lpdw_process_id: *mut u32) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> HANDLE;
        fn CloseHandle(handle: HANDLE) -> i32;
        fn GetLastError() -> u32;
    }

    /// 令牌获取 / 降权启动失败的步骤分类。`Display` 给出可写进日志的中文说明 + 错误码。
    #[derive(Debug)]
    pub enum TokenFailure {
        /// 宿主未提权（非 Windows 或 Medium IL），本就不需要令牌路径。
        NotElevated,
        ShellWindowNotFound,
        ProcessIdNotFound,
        OpenProcessFailed(u32),
        OpenProcessTokenFailed(u32),
        DuplicateTokenFailed(u32),
        CreateProcessWithTokenFailed(u32),
    }

    impl std::fmt::Display for TokenFailure {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                TokenFailure::NotElevated => write!(f, "宿主未提权"),
                TokenFailure::ShellWindowNotFound => write!(f, "GetShellWindow 返回空句柄"),
                TokenFailure::ProcessIdNotFound => {
                    write!(f, "GetWindowThreadProcessId 未取到 PID")
                }
                TokenFailure::OpenProcessFailed(code) => {
                    write!(f, "OpenProcess 失败 (Win32 错误 {})", code)
                }
                TokenFailure::OpenProcessTokenFailed(code) => {
                    write!(f, "OpenProcessToken 失败 (Win32 错误 {})", code)
                }
                TokenFailure::DuplicateTokenFailed(code) => {
                    write!(f, "DuplicateTokenEx 失败 (Win32 错误 {})", code)
                }
                TokenFailure::CreateProcessWithTokenFailed(code) => {
                    write!(f, "CreateProcessWithTokenW 失败 (Win32 错误 {})", code)
                }
            }
        }
    }

    fn administrators_sid() -> Option<*mut c_void> {
        let mut sid: *mut c_void = ptr::null_mut();
        // count=2 + [32, 544] 才是 Administrators；以前误传成 count=1、[1] 得到 S-1-5-1。
        let ok = unsafe {
            AllocateAndInitializeSid(
                &SECURITY_NT_AUTHORITY,
                2,
                SECURITY_BUILTIN_DOMAIN_RID,
                DOMAIN_ALIAS_RID_ADMINS,
                0,
                0,
                0,
                0,
                0,
                0,
                &mut sid,
            )
        };
        if ok == 0 || sid.is_null() {
            None
        } else {
            Some(sid)
        }
    }

    /// 当前进程管理员组是否启用（UAC 提权后的 High IL）？
    ///
    /// 用 `CheckTokenMembership(NULL, …)` 查 BUILTIN\Administrators：非提权时该组
    /// 「存在但未启用」，返回 false。NULL 令牌省掉 `OpenProcessToken` / `CloseHandle`
    /// 两个句柄与两条手写声明（issue #195）。
    pub fn host_is_elevated() -> bool {
        let Some(sid) = administrators_sid() else {
            return false;
        };
        let mut is_member: i32 = 0;
        let ok = unsafe { CheckTokenMembership(ptr::null_mut(), sid, &mut is_member) };
        unsafe { FreeSid(sid) };
        ok != 0 && is_member != 0
    }

    /// 复制 explorer.exe 的 Medium 主令牌。
    ///
    /// 链路：`GetShellWindow` → `GetWindowThreadProcessId` → `OpenProcess` →
    /// `OpenProcessToken(TOKEN_DUPLICATE | TOKEN_QUERY)` →
    /// `DuplicateTokenEx(…, SecurityImpersonation, TokenPrimary)`。
    /// 任一步失败：已得句柄在返回前关闭，不泄漏半成品；失败分类见 [`TokenFailure`]。
    pub fn acquire_explorer_token() -> Result<Token, TokenFailure> {
        unsafe {
            let hwnd = GetShellWindow();
            if hwnd == 0 {
                return Err(TokenFailure::ShellWindowNotFound);
            }
            let mut pid: u32 = 0;
            let _thread_id = GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return Err(TokenFailure::ProcessIdNotFound);
            }

            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return Err(TokenFailure::OpenProcessFailed(GetLastError()));
            }

            let mut token: HANDLE = ptr::null_mut();
            let ok = OpenProcessToken(process, TOKEN_DUPLICATE | TOKEN_QUERY, &mut token);
            if ok == 0 || token.is_null() {
                let err = GetLastError();
                CloseHandle(process);
                return Err(TokenFailure::OpenProcessTokenFailed(err));
            }

            let mut duplicated: HANDLE = ptr::null_mut();
            let ok = DuplicateTokenEx(
                token,
                MAXIMUM_ALLOWED,
                ptr::null_mut(),
                SECURITY_IMPERSONATION,
                TOKEN_TYPE_PRIMARY,
                &mut duplicated,
            );
            // 原令牌与进程句柄在复制完成后即可关闭；重复令牌独立持有。
            CloseHandle(token);
            CloseHandle(process);
            if ok == 0 || duplicated.is_null() {
                return Err(TokenFailure::DuplicateTokenFailed(GetLastError()));
            }
            Ok(Token(duplicated as usize))
        }
    }

    fn to_wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// 用复制来的 Medium 令牌启动 PS 并把照片路径作为 argv 传入。
    ///
    /// 进程/线程句柄与令牌句柄用完即关；失败时关闭已返回的句柄并回 [`TokenFailure`]。
    pub fn launch_with_token(
        token: Token,
        ps_path: &str,
        file_path: &str,
    ) -> Result<(), TokenFailure> {
        let app_name = to_wide(ps_path);
        let mut command_line = to_wide(&format!("\"{}\" \"{}\"", ps_path, file_path));

        let mut startup: StartupInfoW = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<StartupInfoW>() as u32;
        let mut info: ProcessInformation = unsafe { std::mem::zeroed() };

        let ok = unsafe {
            CreateProcessWithTokenW(
                token.as_handle(),
                LOGON_WITH_PROFILE,
                app_name.as_ptr(),
                command_line.as_mut_ptr(),
                CREATE_NO_WINDOW,
                ptr::null_mut(),
                ptr::null(),
                &startup,
                &mut info,
            )
        };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            if !info.h_process.is_null() {
                unsafe { CloseHandle(info.h_process) };
            }
            if !info.h_thread.is_null() {
                unsafe { CloseHandle(info.h_thread) };
            }
            token.close();
            return Err(TokenFailure::CreateProcessWithTokenFailed(err));
        }
        unsafe {
            CloseHandle(info.h_process);
            CloseHandle(info.h_thread);
        }
        token.close();
        Ok(())
    }
}

/// 非 Windows 占位：无 UAC / IL 概念，提权恒 false、令牌恒不可用。
#[cfg(not(windows))]
mod win32 {
    /// 非 Windows 占位令牌（恒不会被构造成功）。
    pub struct Token;

    #[derive(Debug)]
    pub enum TokenFailure {
        NotElevated,
    }

    impl std::fmt::Display for TokenFailure {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "非 Windows 平台无令牌降权路径")
        }
    }

    pub fn host_is_elevated() -> bool {
        false
    }

    pub fn acquire_explorer_token() -> Result<Token, TokenFailure> {
        Err(TokenFailure::NotElevated)
    }

    pub fn launch_with_token(
        _token: Token,
        _ps_path: &str,
        _file_path: &str,
    ) -> Result<(), TokenFailure> {
        Err(TokenFailure::NotElevated)
    }
}

#[cfg(test)]
mod tests {
    use super::{decide_external_open, plan_external_open, ExternalLaunch};

    /// 非提权宿主：PS 路径存在就直连（继承 Medium，现有行为不变）；令牌是否可用不参与决策。
    #[test]
    fn plan_非提权宿主直连ps() {
        // 真实存在的可执行文件（用系统自带 cmd.exe 当替身，避免依赖 Photoshop 装没装）。
        let sys = std::env::var("COMSPEC").unwrap_or_else(|_| "C:/Windows/System32/cmd.exe".into());
        assert!(
            std::path::Path::new(&sys).exists(),
            "前提不成立：{sys} 应该存在"
        );
        assert_eq!(
            plan_external_open(&sys, false, false),
            ExternalLaunch::PhotoshopDirect
        );
        // 非提权下即便「令牌可用」为真，也不应走令牌降权路径。
        assert_eq!(
            decide_external_open(true, false, true),
            ExternalLaunch::PhotoshopDirect
        );
    }

    /// 提权宿主 + 令牌可用 → 复制 explorer Medium 令牌，`CreateProcessWithTokenW` 启动。
    #[test]
    fn plan_提权宿主令牌可用走降权() {
        let sys = std::env::var("COMSPEC").unwrap_or_else(|_| "C:/Windows/System32/cmd.exe".into());
        assert_eq!(
            plan_external_open(&sys, true, true),
            ExternalLaunch::PhotoshopToken
        );
    }

    /// 提权宿主 + 令牌获取/复制失败 → 显式回落直连，且与「非提权直连」可区分（不静默）。
    #[test]
    fn plan_提权宿主令牌失败回落直连且可区分() {
        let sys = std::env::var("COMSPEC").unwrap_or_else(|_| "C:/Windows/System32/cmd.exe".into());
        let kind = plan_external_open(&sys, true, false);
        assert_eq!(kind, ExternalLaunch::PhotoshopDirectFallback);
        assert_ne!(kind, ExternalLaunch::PhotoshopDirect);
    }

    /// 路径缺失 / 空串 / 纯空白 → 回落默认程序（前端据此 toast，不静默）。
    #[test]
    fn plan_缺ps路径回落默认程序() {
        assert_eq!(
            decide_external_open(false, true, true),
            ExternalLaunch::Default
        );
        assert_eq!(
            decide_external_open(false, false, false),
            ExternalLaunch::Default
        );
        assert_eq!(
            plan_external_open("C:/definitely-not-here/Photoshop.exe", true, true),
            ExternalLaunch::Default
        );
        assert_eq!(plan_external_open("", true, true), ExternalLaunch::Default);
        assert_eq!(
            plan_external_open("   ", false, false),
            ExternalLaunch::Default
        );
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

        let elevated = super::win32::host_is_elevated();
        let token = super::win32::acquire_explorer_token();
        let kind = plan_external_open(&ps_path, elevated, token.is_ok());
        println!(
            "[external-open] 素材={} PS={:?} 存在={} 提权={} 令牌可用={} 决策={:?}",
            sample.display(),
            ps_path,
            std::path::Path::new(&ps_path).exists(),
            elevated,
            token.is_ok(),
            kind
        );

        // 真实 PS 路径必须落到 PS 分支（直连 / 令牌降权 / 降权失败回落直连都算）；
        // 落到 Default 说明路径解析或判定坏了（issue #197）。
        assert!(
            matches!(
                kind,
                ExternalLaunch::PhotoshopDirect
                    | ExternalLaunch::PhotoshopToken
                    | ExternalLaunch::PhotoshopDirectFallback
            ),
            "配置的 Photoshop 路径不应回落默认程序；若 PS 确实没装，请改这条断言的前提而不是放宽它"
        );
    }

    /// 真机（管理员会话）：核对令牌降权启动的子进程 IL 与 explorer 一致。
    ///
    /// 运行方式（本阶段不跑，留待 Wave 3 真机验证）：
    /// 1. 右键「以管理员身份运行」gallery-culling；
    /// 2. `cargo test --lib -- --ignored 外部打开_管理员令牌降权_读回完整性级别`；
    /// 3. 用例内 `acquire_explorer_token` 复制 explorer 令牌后，再经
    ///    `GetTokenInformation(TokenIntegrityLevel)` 读回子进程令牌 IL，与 explorer 令牌
    ///    的 IL 比对；任务管理器「已提升」列应与已开的 Medium PS 一致，不新起 High IL 实例。
    ///
    /// 非提权会话下本用例直接跳过（`host_is_elevated()` 为 false 时令牌路径本就不参与）。
    #[cfg(windows)]
    #[test]
    #[ignore = "需要管理员会话：提权后加 --ignored 运行，读回子进程完整性级别比对 explorer"]
    fn 外部打开_管理员令牌降权_读回完整性级别() {
        if !super::win32::host_is_elevated() {
            println!("[external-open] 当前非提权会话，跳过 IL 读回核对");
            return;
        }
        match super::win32::acquire_explorer_token() {
            Ok(token) => {
                token.close();
                println!(
                    "[external-open] 令牌复制成功；子进程 IL 需手工用任务管理器/GetTokenInformation 复核"
                );
            }
            Err(e) => println!("[external-open] 令牌复制失败：{e}"),
        }
    }
}
