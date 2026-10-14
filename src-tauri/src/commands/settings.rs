//! 全局设置与会话持久化。

use tauri::State;

use crate::models::AppSettings;

use super::AppState;

#[tauri::command]
pub fn get_settings_cmd(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.db.load_settings()
}

#[tauri::command]
pub fn save_settings_cmd(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    // 换了 lumen-cli 路径 = 指向了另一个 catalog，旧的同步游标不再有意义
    // （否则冲突判定会拿旧引擎的值做基准）。清空是安全方向：最坏情况是
    // 下次同步时按"首次见到"处理，不会误覆盖。
    if let Ok(old) = state.db.load_settings() {
        if old.lumen_cli_path.trim() != settings.lumen_cli_path.trim() {
            let _ = state.db.clear_rating_sync();
            state.lumen.shutdown();
        }
    }
    state.db.save_settings(&settings)?;
    Ok(true)
}

#[tauri::command]
pub fn save_session_cmd(
    jpg_folder: String,
    raw_folder: String,
    last_index: usize,
    sort_order: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .db
        .save_session(&jpg_folder, &raw_folder, last_index, &sort_order)?;
    Ok(true)
}

#[tauri::command]
pub fn load_session_cmd(
    jpg_folder: String,
    state: State<'_, AppState>,
) -> Result<Option<(usize, String)>, String> {
    state.db.load_session(&jpg_folder)
}
