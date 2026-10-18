mod album;
mod commands;
mod cullstore;
mod db;
pub mod lumen;
mod luminar;
pub mod models;
mod proc;
mod scanner;
mod syncqueue;
mod taskgate;
mod thumbnail;
pub mod xmp;
mod xmprefresh;

// FE-07：显式导入替代 glob。此前 `use commands::*` 把 8 个子模块转发的全部
// 命令宏一并卷入本作用域，而 generate_handler 里用的都是 `commands::` 限定
// 路径——glob 实际提供的未限定名只有这两个。显式列表让「本文件到底依赖
// commands 的什么」可一眼读尽，新增命令时也不会被 glob 悄悄放行。
use commands::{AppState, open_in_luminar_roundtrip_cmd};
use db::Database;
use std::sync::Arc;

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
        .invoke_handler(tauri::generate_handler![
            commands::scan_folders_cmd,
            commands::cancel_scan_cmd,
            commands::get_thumbnail_cmd,
            commands::update_rating_flag_cmd,
            commands::check_cull_state_cmd,
            commands::save_album_cmd,
            commands::open_album_cmd,
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
            commands::save_session_cmd,
            commands::load_session_cmd,
            open_in_luminar_roundtrip_cmd,
            commands::lumen_status_cmd,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
