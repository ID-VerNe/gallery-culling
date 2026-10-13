//! 缩略图生成。

use std::path::Path;

use crate::thumbnail::get_or_create_thumbnail;

use super::blocking;


#[tauri::command]
pub async fn get_thumbnail_cmd(file_path: String, width: Option<u32>) -> Result<String, String> {
    let target_width = width.unwrap_or(200);
    blocking("生成缩略图任务异常", move || {
        let path = Path::new(&file_path);
        get_or_create_thumbnail(path, target_width)
    })
    .await
}
