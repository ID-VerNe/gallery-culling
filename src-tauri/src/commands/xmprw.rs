//! XMP 侧边栏写入：评级旗标（含 LUMEN 推送）与镜头元数据。
//!
//! 评级推送失败只记账不回滚 —— 宿主 XMP 已写成功，UI 不该因 sidecar 抖动而回退。

use std::path::Path;

use tauri::State;

use crate::lumen;
use crate::xmp as xmp;
use crate::xmp::{update_xmp_metadata, write_xmp};

use super::{blocking, AppState};

#[tauri::command]
pub async fn update_rating_flag_cmd(
    state: State<'_, AppState>,
    file_path: String,
    rating: u8,
    flag: String,
    sync_xmp: bool,
) -> Result<bool, String> {
    let runtime = state.lumen.clone();
    let settings = state.db.load_settings()?;
    let db = state.db.clone();

    blocking("更新评级任务异常", move || {
        let path = Path::new(&file_path);
        if sync_xmp {
            write_xmp(path, rating, &flag)?;
        }

        // 评级同步（P1）：引擎启用时推给 LUMEN RAW。
        // 失败只记账不回滚 —— 宿主 XMP 已写成功，UI 不该因 sidecar 抖动而回退。
        if settings.lumen_enabled && lumen::should_push_rating(rating, &flag) {
            if let Some(exe) = lumen::find_lumen_cli(&settings.lumen_cli_path) {
                match runtime.push_rating(&exe, path, rating, &flag) {
                    Ok(()) => {
                        let xmp = xmp::get_xmp_path(path);
                        let _ = db.upsert_rating_sync(
                            &file_path,
                            rating,
                            &flag,
                            "host",
                            crate::db::file_mtime_secs(&xmp),
                        );
                    }
                    Err(e) => {
                        eprintln!("LUMEN RAW 评级推送失败（已忽略）: {}", e);
                    }
                }
            }
        }
        Ok::<_, String>(true)
    })
    .await
}

#[tauri::command]
pub async fn batch_update_metadata_cmd(
    file_paths: Vec<String>,
    lens_model: Option<String>,
    focal_length: Option<String>,
    aperture: Option<String>,
) -> Result<usize, String> {
    blocking("批量更新元数据任务异常", move || {
        let mut count = 0;
        let lens = lens_model.as_deref();
        let focal = focal_length.as_deref();
        let ap = aperture.as_deref();

        for file_path in file_paths {
            let path = Path::new(&file_path);
            if path.exists() && update_xmp_metadata(path, lens, focal, ap).is_ok() {
                count += 1;
            }
        }
        Ok::<_, String>(count)
    })
    .await
}
