mod commands;
mod db;
pub mod lumen;
mod luminar;
mod models;
mod scanner;
mod thumbnail;
mod xmp;

use commands::*;
use db::Database;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = Database::new().expect("Failed to initialize SQLite database");

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db,
            lumen: lumen::LumenRuntime::new(),
        })
        .invoke_handler(tauri::generate_handler![
            scan_folders_cmd,
            get_thumbnail_cmd,
            update_rating_flag_cmd,
            open_in_photoshop_cmd,
            open_in_default_app_cmd,
            trash_photos_cmd,
            batch_export_cmd,
            batch_update_metadata_cmd,
            get_settings_cmd,
            save_settings_cmd,
            save_session_cmd,
            load_session_cmd,
            update_tone_adjustments_cmd,
            open_in_luminar_roundtrip_cmd,
            lumen_status_cmd,
            lumen_preview_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
