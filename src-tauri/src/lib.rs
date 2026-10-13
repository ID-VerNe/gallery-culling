mod commands;
mod db;
pub mod lumen;
mod luminar;
pub mod models;
mod scanner;
mod thumbnail;
pub mod xmp;

use commands::*;
use db::Database;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = Database::new().expect("Failed to initialize SQLite database");

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // 说明：M-17 的会话防抖**不在这里加窗口关闭钩子**。后端拿不到前端防抖窗口内
        // 尚未发送的选中索引，加钩子只会制造"已保存"的伪安全感。正确落点是前端在
        // `getCurrentWindow().onCloseRequested` / 组件卸载 / 目录切换三处主动 flush。
        .manage(AppState {
            db,
            lumen: lumen::LumenRuntime::new(),
            scan_cancel: Arc::new(AtomicBool::new(false)),
            export_cancel: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_folders_cmd,
            commands::cancel_scan_cmd,
            commands::get_thumbnail_cmd,
            commands::update_rating_flag_cmd,
            commands::open_in_photoshop_cmd,
            commands::open_in_default_app_cmd,
            commands::trash_photos_cmd,
            commands::batch_export_cmd,
            commands::cancel_export_cmd,
            commands::batch_update_metadata_cmd,
            commands::get_settings_cmd,
            commands::save_settings_cmd,
            commands::save_session_cmd,
            commands::load_session_cmd,
            open_in_luminar_roundtrip_cmd,
            commands::lumen_status_cmd,
            commands::probe_lumen_cmd,
            commands::lumen_preview_cmd,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
