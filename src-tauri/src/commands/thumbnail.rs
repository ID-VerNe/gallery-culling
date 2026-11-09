//! 缩略图生成。

use std::path::Path;

use crate::models::DEFAULT_THUMBNAIL_WIDTH;
use crate::thumbnail::get_or_create_thumbnail;

use super::blocking;

/// IPC 未传宽时的目标宽度：后端默认（`models::DEFAULT_THUMBNAIL_WIDTH`），与
/// `AppSettings::default` 同口径（issue #133 墓碑：`missing_width_falls_back_to_default_constant`）。
pub(crate) fn thumbnail_target_width(width: Option<u32>) -> u32 {
    width.unwrap_or(DEFAULT_THUMBNAIL_WIDTH)
}


#[tauri::command]
pub async fn get_thumbnail_cmd(file_path: String, width: Option<u32>) -> Result<String, String> {
    let target_width = thumbnail_target_width(width);
    blocking("生成缩略图任务异常", move || {
        let path = Path::new(&file_path);
        get_or_create_thumbnail(path, target_width)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// issue #133 墓碑：IPC 未传宽时回落到后端默认常量，与 `Default` 同口径。
    /// 改常量值必红（200→201）。
    #[test]
    fn missing_width_falls_back_to_default_constant() {
        assert_eq!(thumbnail_target_width(None), 200);
    }

    #[test]
    fn explicit_width_passes_through() {
        assert_eq!(thumbnail_target_width(Some(300)), 300);
    }
}
