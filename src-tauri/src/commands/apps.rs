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
    }

    // SID 结构读回（只给测试用）：`GetSidSubAuthorityCount` / `GetSidSubAuthority`。
    // 没有这层断言，参数错位可以「不崩但构造出 `S-1-5-1`」而门禁全绿。
    #[cfg(test)]
    #[link(name = "advapi32")]
    extern "system" {
        fn GetSidSubAuthorityCount(sid: *mut c_void) -> *mut u8;
        fn GetSidSubAuthority(sid: *mut c_void, index: u32) -> *mut u32;
    }

    /// 分配 `S-1-5-32-544`（BUILTIN\Administrators）的 SID。
    ///
    /// 成功后**调用方必须 `free_sid`**；失败返回 `None`（不泄漏半成品）。
    pub fn administrators_sid() -> Option<*mut c_void> {
        let mut sid: *mut c_void = std::ptr::null_mut();
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

    pub fn free_sid(sid: *mut c_void) {
        if !sid.is_null() {
            unsafe {
                let _ = FreeSid(sid);
            }
        }
    }

    /// 读回 SID 的 RID 数组（测试与诊断用）。
    #[cfg(test)]
    pub fn sid_sub_authorities(sid: *mut c_void) -> Option<Vec<u32>> {
        if sid.is_null() {
            return None;
        }
        unsafe {
            let count = *GetSidSubAuthorityCount(sid) as u32;
            Some((0..count).map(|i| *GetSidSubAuthority(sid, i)).collect())
        }
    }

    /// 当前进程管理员组是否启用（UAC 提权后的 High IL）？
    ///
    /// 用 `CheckTokenMembership(NULL, …)` 查 BUILTIN\Administrators：非提权时该组
    /// 「存在但未启用」，返回 false。NULL 令牌省掉 `OpenProcessToken` / `CloseHandle`
    /// 两个句柄与两条手写声明 —— 少一条声明就少一处错位的机会（issue #195）。
    pub fn is_elevated() -> bool {
        let Some(sid) = administrators_sid() else {
            return false;
        };
        let mut is_member: i32 = 0;
        let ok = unsafe { CheckTokenMembership(std::ptr::null_mut(), sid, &mut is_member) };
        free_sid(sid);
        ok != 0 && is_member != 0
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

/// 「外部打开」的启动决策（issue #195 抽出）。
///
/// 抽出来是为了让**生产路径和真机用例跑同一份代码** —— 以前单测只覆盖纯函数
/// `decide_external_launch`，崩溃发生在它上游的 FFI 里，门禁因此全绿。
/// 只收 `ps_path`：目标文件路径不参与决策，只在真正 spawn 时作为 argv 传下去。
pub fn plan_external_open(ps_path: &str) -> ExternalLaunch {
    // A 档目标 Medium（want_medium=true），提权时 explorer 代理降权，IL 与用户手动启动的 PS 一致。
    decide_external_launch(host_is_elevated(), Path::new(ps_path).exists(), true)
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

    let kind = plan_external_open(&ps_path);

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

/// 在 Luminar Neo 里打开照片并等用户编辑完回传路径（roundtrip）。
#[tauri::command]
pub async fn open_in_luminar_roundtrip_cmd(file_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(file_path);
    let edited_path = crate::luminar::edit_in_luminar(&path).await?;
    Ok(edited_path.to_string_lossy().to_string())
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

    /// 墓碑（issue #195）：点「外部打开」时的崩溃点。
    ///
    /// 旧实现的 `AllocateAndInitializeSid` 多声明了一个 `revision` 参数，x64 下实参整体
    /// 错位，`pSid` 收到 0 → API 写 NULL → **整个测试二进制 `0xc0000005`**。所以这条
    /// 用例不需要断言崩溃之外的任何东西：它在旧代码上根本跑不到 `assert`。
    /// 同时把它从 `#[ignore]` 提成常规用例 —— 一个必现的进程级崩溃被 ignore 藏了整整一版。
    #[test]
    fn host_is_elevated_返回bool且不崩() {
        let first = super::host_is_elevated();
        let second = super::host_is_elevated();
        println!("[elevation] host_is_elevated() = {first}");
        assert_eq!(first, second, "同一进程内两次判定必须一致");
    }

    /// 结构断言：SID 必须是 `S-1-5-32-544`。
    ///
    /// 「不崩」不等于「判对」—— 参数错位还可能构造出 `S-1-5-1`（count=1、rid=1），
    /// 判定恒 false，并把 #106 的降权路径悄悄废掉。这里读回 RID 数组钉死。
    #[cfg(windows)]
    #[test]
    fn administrators_sid_结构是_builtin_32_544() {
        let sid =
            super::elevation::administrators_sid().expect("分配 BUILTIN\\Administrators SID 失败");
        let rids = super::elevation::sid_sub_authorities(sid).expect("读回 SID 失败");
        super::elevation::free_sid(sid);
        assert_eq!(
            rids,
            vec![32, 544],
            "必须是 S-1-5-32-544（BUILTIN\\Administrators）；出现 [1] 或 [] 说明实参错位（issue #195）"
        );
    }

    /// 真机：按「点外部打开」那一步跑一遍，素材与设置都用真实数据。
    ///
    /// `GALLERY_REAL_RAW_DIR="…\2026年9月12日-惠州西湖"` 后
    /// `cargo test --lib -- --ignored 外部打开`。
    /// 真实素材路径来自该目录，Photoshop 路径来自用户真实设置库里的 `photoshop_path`
    /// —— 就是 `open_in_photoshop_cmd` 实际会用的那个。旧实现（issue #195）在这里必崩。
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

        let elevated = super::host_is_elevated();
        let kind = super::plan_external_open(&ps_path);
        let ps_exists = std::path::Path::new(&ps_path).exists();
        println!(
            "[external-open] 素材={} PS={:?} 存在={} 提权={} 决策={:?}",
            sample.display(),
            ps_path,
            ps_exists,
            elevated,
            kind
        );

        // 跑完还活着 = 崩溃没复发；再钉住「决策必须与 PS 路径存在性自洽」。
        match (ps_exists, kind) {
            (true, ExternalLaunch::PhotoshopDirect | ExternalLaunch::PhotoshopViaExplorer) => {}
            (false, ExternalLaunch::DefaultDirect | ExternalLaunch::DefaultViaExplorer) => {}
            _ => panic!("决策与 PS 路径存在性不一致：ps_exists={ps_exists} kind={kind:?}"),
        }
    }
}
