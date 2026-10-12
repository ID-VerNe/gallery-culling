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
            lumen_sync_ratings_cmd,
            lumen_get_recipe_cmd,
            lumen_apply_recipe_cmd,
            lumen_capabilities_cmd,
            lumen_apply_preset_cmd,
            apply_tone_cmd,
            get_tone_state_cmd,
            lumen_apply_mask_cmd,
            lumen_list_masks_cmd,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
