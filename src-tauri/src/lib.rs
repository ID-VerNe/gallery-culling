mod album;
mod cachekey;
mod clock;
mod commands;
mod cullstore;
mod db;
mod lrcat;
pub mod lumen;
mod luminar;
pub mod models;
mod pathutil;
mod proc;
mod scanner;
mod syncqueue;
mod taskgate;
mod thumbnail;
mod watermark;
pub mod xmp;
mod xmprefresh;

// FE-07：显式导入替代 glob。此前 `use commands::*` 把 8 个子模块转发的全部
// 命令宏一并卷入本作用域，而 generate_handler 里用的都是 `commands::` 限定
// 路径——glob 实际提供的未限定名只有这两个。显式列表让「本文件到底依赖
// commands 的什么」可一眼读尽，新增命令时也不会被 glob 悄悄放行。
use commands::{open_in_luminar_roundtrip_cmd, AppState};
use db::Database;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = Database::new().expect("Failed to initialize SQLite database");
    let state = AppState::new(db);

    // FR-03 回放：上次没写完的意图在这里补写。
    //
    // 放后台线程：启动路径上一张照片都不用等。回放逐条立即写（不等防抖窗口），
    // 与用户的新操作共用同一个队列，所以同一张照片不会被写两遍。
    let replay_db = state.db.clone();
    let replay_queue = Arc::clone(&state.sync);
    std::thread::spawn(move || {
        if let Err(e) = syncqueue::replay_pending(&replay_db, &replay_queue) {
            eprintln!("回放待写盘记录失败: {}", e);
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // 说明：M-17 的会话防抖**不在这里加窗口关闭钩子**。后端拿不到前端防抖窗口内
        // 尚未发送的选中索引，加钩子只会制造"已保存"的伪安全感。正确落点是前端在
        // `getCurrentWindow().onCloseRequested` / 组件卸载 / 目录切换三处主动 flush。
        .manage(state)
        // issue #68：随包 sidecar 启动预热。放在后台线程：
        // 首屏不等引擎（PyInstaller 冷启动可能几秒），失败也不静默——通过
        // `lumen-startup-error` 事件让前端弹可见提示，同时在状态行保留原因。
        .setup(|app| {
            let settings = match app.state::<AppState>().db.load_settings() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("读取设置失败，跳过 LUMEN 预热: {}", e);
                    return Ok(());
                }
            };
            if !settings.lumen_enabled {
                return Ok(());
            }
            let runtime = app.state::<AppState>().lumen.clone();
            let engine = app.state::<AppState>().engine.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Emitter;
                // issue #75：引擎不再随安装包分发。先在后台确保缓存就位
                // （缺失则从独立 Release 资产下载 + 校验 + 原子就位），
                // 再做定位与预热。状态变化通过 `lumen-engine-status` 推给前端，
                // 首屏不被下载阻塞。
                let spec = crate::lumen::pinned_engine_spec();
                let mut emit = |status: &crate::lumen::EngineStatus| {
                    let _ = handle.emit(crate::lumen::ENGINE_STATUS_EVENT, status);
                };
                let engine_status = engine.ensure(spec, &crate::lumen::HttpFetcher, &mut emit);
                emit(&engine_status);

                let message = match crate::lumen::find_lumen_cli(&settings.lumen_cli_path) {
                    Some(exe) => match runtime.warm_up(&exe) {
                        Ok(()) => return,
                        Err(e) => e.to_string(),
                    },
                    None if engine_status.phase == crate::lumen::EnginePhase::Failed => {
                        engine_status.detail
                    }
                    None => "未找到 lumen-cli.exe（引擎缓存缺失或路径无效）；下一步：在设置中手动指定 lumen-cli.exe，或点击引擎横幅上的「重试」。".to_string(),
                };
                eprintln!("LUMEN 预热失败: {}", message);
                let _ = handle.emit(crate::lumen::STARTUP_ERROR_EVENT, message);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_folders_cmd,
            commands::probe_folder_cmd,
            commands::cancel_scan_cmd,
            commands::get_thumbnail_cmd,
            commands::update_rating_flag_cmd,
            commands::check_cull_state_cmd,
            commands::save_album_cmd,
            commands::open_album_cmd,
            commands::read_lrcat_cmd,
            commands::refresh_from_xmp_cmd,
            commands::resolve_xmp_conflicts_cmd,
            commands::open_in_photoshop_cmd,
            commands::open_in_default_app_cmd,
            commands::open_folder_cmd,
            commands::trash_photos_cmd,
            commands::batch_export_cmd,
            commands::batch_render_export_cmd,
            commands::cancel_export_cmd,
            commands::batch_update_metadata_cmd,
            commands::get_settings_cmd,
            commands::save_settings_cmd,
            commands::get_lens_presets_cmd,
            commands::save_lens_presets_cmd,
            commands::save_session_cmd,
            commands::load_session_cmd,
            open_in_luminar_roundtrip_cmd,
            commands::lumen_status_cmd,
            commands::lumen_engine_status_cmd,
            commands::lumen_engine_ensure_cmd,
            commands::probe_lumen_cmd,
            commands::lumen_preview_cmd,
            commands::lumen_detail_cmd,
            commands::lumen_sync_ratings_cmd,
            commands::lumen_get_recipe_cmd,
            commands::lumen_apply_recipe_cmd,
            commands::lumen_capabilities_cmd,
            commands::lumen_apply_preset_cmd,
            commands::apply_tone_cmd,
            commands::get_tone_state_cmd,
            commands::lumen_apply_mask_cmd,
            commands::lumen_list_masks_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 退出时显式关 stdin：常驻 sidecar 读到 EOF 自行退出，
            // 不留下孤儿进程（不主动 kill，避免误杀用户手动启动的实例）。
            if let tauri::RunEvent::Exit = event {
                app_handle.state::<AppState>().lumen.shutdown();
            }
        });
}
