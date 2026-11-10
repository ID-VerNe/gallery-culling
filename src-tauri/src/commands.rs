// ---- 子模块：按领域拆分的命令 ----
// 命名：xmprw = XMP 读写。刻意不叫 `xmp`，否则与顶层的 `use crate::xmp` 同名。
//
// `#[tauri::command]` 生成的宏带 `#[macro_export]`，落在**定义它的模块**里。
// generate_handler 在 lib.rs 里按名字找它们，`macro_rules!` 无法被 glob 带出，
// 故下面每个模块都要显式转发它自己的那组宏。
mod apps;
mod export;
mod lumencmds;
mod tone;
mod scanner;
mod settings;
mod state;
mod thumbnail;

pub use settings::{
    __cmd__get_lens_presets_cmd, __cmd__get_settings_cmd, __cmd__load_session_cmd,
    __cmd__save_lens_presets_cmd, __cmd__save_session_cmd, __cmd__save_settings_cmd,
    __tauri_command_name_get_lens_presets_cmd, __tauri_command_name_get_settings_cmd,
    __tauri_command_name_load_session_cmd, __tauri_command_name_save_lens_presets_cmd,
    __tauri_command_name_save_session_cmd, __tauri_command_name_save_settings_cmd,
    get_lens_presets_cmd, get_settings_cmd, load_session_cmd, save_lens_presets_cmd,
    save_session_cmd, save_settings_cmd,
};

pub use thumbnail::{
    __cmd__get_thumbnail_cmd, __tauri_command_name_get_thumbnail_cmd, get_thumbnail_cmd,
};

pub use scanner::{
    __cmd__cancel_scan_cmd, __cmd__probe_folder_cmd, __cmd__scan_folders_cmd,
    __tauri_command_name_cancel_scan_cmd, __tauri_command_name_probe_folder_cmd,
    __tauri_command_name_scan_folders_cmd, cancel_scan_cmd, probe_folder_cmd, scan_folders_cmd,
};

pub use lumencmds::{
    __cmd__lumen_status_cmd, __tauri_command_name_lumen_status_cmd,
    __cmd__probe_lumen_cmd, __tauri_command_name_probe_lumen_cmd,
    __cmd__lumen_preview_cmd, __tauri_command_name_lumen_preview_cmd,
    __cmd__lumen_detail_cmd, __tauri_command_name_lumen_detail_cmd,
    __cmd__lumen_sync_ratings_cmd, __tauri_command_name_lumen_sync_ratings_cmd,
    __cmd__lumen_get_recipe_cmd, __tauri_command_name_lumen_get_recipe_cmd,
    __cmd__lumen_apply_recipe_cmd, __tauri_command_name_lumen_apply_recipe_cmd,
    __cmd__lumen_capabilities_cmd, __tauri_command_name_lumen_capabilities_cmd,
    __cmd__lumen_apply_preset_cmd, __tauri_command_name_lumen_apply_preset_cmd,
    __cmd__lumen_apply_mask_cmd, __tauri_command_name_lumen_apply_mask_cmd,
    __cmd__lumen_list_masks_cmd, __tauri_command_name_lumen_list_masks_cmd,
    __cmd__lumen_engine_status_cmd, __tauri_command_name_lumen_engine_status_cmd,
    __cmd__lumen_engine_ensure_cmd, __tauri_command_name_lumen_engine_ensure_cmd,
    lumen_status_cmd,
    probe_lumen_cmd,
    lumen_preview_cmd,
    lumen_detail_cmd,
    lumen_sync_ratings_cmd,
    lumen_get_recipe_cmd,
    lumen_apply_recipe_cmd,
    lumen_capabilities_cmd,
    lumen_apply_preset_cmd,
    lumen_apply_mask_cmd,
    lumen_list_masks_cmd,
    lumen_engine_status_cmd,
    lumen_engine_ensure_cmd,
};

pub use tone::{
    __cmd__apply_tone_cmd, __cmd__get_tone_state_cmd,
    __tauri_command_name_apply_tone_cmd, __tauri_command_name_get_tone_state_cmd,
    apply_tone_cmd, get_tone_state_cmd,
};

pub use export::{
    __cmd__batch_export_cmd, __cmd__batch_render_export_cmd, __cmd__cancel_export_cmd,
    __tauri_command_name_batch_export_cmd, __tauri_command_name_batch_render_export_cmd,
    __tauri_command_name_cancel_export_cmd,
    batch_export_cmd, batch_render_export_cmd, cancel_export_cmd,
};

pub use apps::{
    __cmd__open_folder_cmd, __cmd__open_in_default_app_cmd, __cmd__open_in_photoshop_cmd,
    __cmd__trash_photos_cmd,
    __tauri_command_name_open_folder_cmd,
    __tauri_command_name_open_in_default_app_cmd,
    __tauri_command_name_open_in_photoshop_cmd,
    __tauri_command_name_trash_photos_cmd,
    open_folder_cmd, open_in_default_app_cmd, open_in_luminar_roundtrip_cmd,
    open_in_photoshop_cmd, trash_photos_cmd,
};
mod cullcheck;
mod albumcmds;
mod lrcatcmds;
mod xmprw;
mod xmprefresh;

pub use albumcmds::{
    __cmd__open_album_cmd, __cmd__save_album_cmd, __tauri_command_name_open_album_cmd,
    __tauri_command_name_save_album_cmd, open_album_cmd, save_album_cmd,
};

pub use lrcatcmds::{
    __cmd__read_lrcat_cmd, __tauri_command_name_read_lrcat_cmd, read_lrcat_cmd,
};

pub use cullcheck::{
    __cmd__check_cull_state_cmd, __tauri_command_name_check_cull_state_cmd,
    check_cull_state_cmd,
};

pub use xmprw::{
    __cmd__batch_update_metadata_cmd, __cmd__update_rating_flag_cmd,
    __tauri_command_name_batch_update_metadata_cmd,
    __tauri_command_name_update_rating_flag_cmd,
    batch_update_metadata_cmd, update_rating_flag_cmd,
};

pub use xmprefresh::{
    __cmd__refresh_from_xmp_cmd, __cmd__resolve_xmp_conflicts_cmd,
    __tauri_command_name_refresh_from_xmp_cmd, __tauri_command_name_resolve_xmp_conflicts_cmd,
    refresh_from_xmp_cmd, resolve_xmp_conflicts_cmd,
};

// 共享状态与基础设施（issue #143 自本文件搬出）：子模块按 `super::` 引用，
// 这里统一再转发，调用点零改动。
pub use state::{
    AppState, ProgressThrottle, blocking, blocking_value, lumen_exe, now_epoch_secs, require_lumen,
};
