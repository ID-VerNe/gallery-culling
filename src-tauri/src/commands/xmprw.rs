//! 评级与旗标写入：评级进 XMP 侧边栏，旗标进本地 `.gallerycull.json`。
//!
//! 两条写入互不依赖（旗标不再借用 `xmp:Label`，见
//! `.plan/adr-001-cull-flag-store.md`），但都失败即报错 —— 界面已乐观更新，
//! 静默吞错会让用户以为标记已落盘。
//!
//! 落盘走 `syncqueue` 的合并队列（FR-03）：先记 pending 意图，再由队列把同一张
//! 照片的连续改动折叠成一次写盘。命令本身仍然**阻塞到真正写完**，所以调用方
//! 拿到的是磁盘上的事实，不是「已排队」。

use std::path::Path;
use std::sync::Arc;

use tauri::State;

use crate::cullstore;
use crate::db::{Database, XmpCursor};
use crate::lumen;
use crate::syncqueue::{Intent, IntentSink};
use crate::xmp as xmp;
use crate::xmp::{update_xmp_metadata, write_xmp};

use super::{blocking, AppState};

/// 真正的落盘动作：本地旗标存储 → XMP → 删除 pending 意图。
pub struct DiskSink {
    db: Database,
}

impl DiskSink {
    pub fn new(db: Database) -> Self {
        Self { db }
    }
}

impl IntentSink for DiskSink {
    fn write(&self, intent: &Intent) -> Result<(), String> {
        let path = &intent.photo_path;
        let folder = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| format!("无法确定照片所在目录: {}", path.display()))?;
        let base_name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");

        // 旗标先落：它是本地独占的数据，且与 XMP 无关。
        cullstore::upsert(folder, base_name, &intent.flag)?;
        if intent.sync_xmp {
            // 色标是**整组状态**的一部分（与星级/旗标同进同退）：调用方每次都传
            // 当前值，`""` 表示这张照片现在没有色标。只传增量会让折叠后的意图
            // 丢掉被覆盖那次改动里的色标。
            write_xmp(path, intent.rating, &intent.flag, Some(&intent.label))?;

            // FR-08：写盘成功后立刻推进增量游标。
            //
            // 不推进的话，下次「从 XMP 重新读取」会把这个 sidecar 判成外部改动，
            // 白读一遍 —— 值相同所以无害，但 10k 张就是 10k 次多余读取。
            //
            // 记的必须是**磁盘上的实际值**：reject 会被 `write_xmp` 写成
            // `Rating=-1`（读回是 0 星 + 淘汰），照抄 `intent.rating` 会让游标
            // 与磁盘长期不一致，下次 mtime 一变就误报「外部把 5 星改成了 0 星」。
            let xmp_path = xmp::get_xmp_path(path);
            if let Some(mtime_ms) = crate::db::file_mtime_ms(&xmp_path) {
                let disk_rating = if intent.flag == "reject" {
                    0
                } else {
                    intent.rating
                };
                let _ = self.db.upsert_xmp_cursor(&XmpCursor {
                    sidecar_path: xmp_path.to_string_lossy().to_string(),
                    mtime_ms,
                    rating: disk_rating,
                    flag: intent.flag.clone(),
                    label: intent.label.clone(),
                });
            }
        }

        // **只有全部写成功才删意图。** 失败时留着，下次启动回放。
        let _ = self.db.delete_pending(&path.to_string_lossy());
        Ok(())
    }
}

#[tauri::command]
pub async fn update_rating_flag_cmd(
    state: State<'_, AppState>,
    file_path: String,
    rating: u8,
    flag: String,
    label: Option<String>,
    sync_xmp: bool,
    coalesce: Option<bool>,
) -> Result<bool, String> {
    let runtime = state.lumen.clone();
    let settings = state.db.load_settings()?;
    let db = state.db.clone();
    let queue = Arc::clone(&state.sync);

    blocking("更新评级任务异常", move || {
        let path = Path::new(&file_path);

        // 路径与旗标先验：非法输入不该进队列，更不该在 pending 表里留垃圾。
        if path
            .parent()
            .map(|p| p.as_os_str().is_empty())
            .unwrap_or(true)
        {
            return Err(format!("无法确定照片所在目录: {}", file_path));
        }
        cullstore::validate_flag(&flag)?;
        // 色标先归一（小写/别名 → Lightroom 的规范色名），非法值直接拒。
        // `None` 按"无色标"处理：命令契约是**整组状态**，不是增量补丁。
        let label = xmp::validate_label(label.as_deref().unwrap_or(""))?.to_string();

        // 先记意图（同步、极快），再交给合并队列。进程在这里被杀也不丢。
        db.enqueue_pending(&file_path, rating, &flag, &label, crate::db::now_secs())?;

        let outcome = queue.submit(
            Intent {
                photo_path: path.to_path_buf(),
                rating,
                flag,
                label,
                sync_xmp,
            },
            coalesce.unwrap_or(true),
        )?;

        // 落盘失败直接上报：界面已乐观更新，调用方负责提示「可能丢失」。
        outcome.result?;

        // 评级同步（P1）：引擎启用时推给 LUMEN RAW。
        //
        // 只有**真正落盘的那一次**推：折叠掉的调用方各推一遍会对着同一文件连开
        // N 个 sidecar 进程，而且推的是被覆盖掉的过期值。失败只记账不回滚 ——
        // 宿主 XMP 已写成功，UI 不该因 sidecar 抖动而回退。
        if outcome.wrote {
            let intent = &outcome.intent;
            if settings.lumen_enabled && lumen::should_push_rating(intent.rating, &intent.flag) {
                if let Some(exe) = lumen::find_lumen_cli(&settings.lumen_cli_path) {
                    match runtime.push_rating(
                        &exe,
                        &intent.photo_path,
                        intent.rating,
                        &intent.flag,
                    ) {
                        Ok(()) => {
                            let xmp_path = xmp::get_xmp_path(&intent.photo_path);
                            let _ = db.upsert_rating_sync(
                                &intent.photo_path.to_string_lossy(),
                                intent.rating,
                                &intent.flag,
                                "host",
                                crate::db::file_mtime_secs(&xmp_path),
                            );
                        }
                        Err(e) => {
                            eprintln!("LUMEN RAW 评级推送失败（已忽略）: {}", e);
                        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::now_secs;
    use crate::syncqueue::{replay_pending, Coalescer};
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gc_replay_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn queue_for(db: &Database) -> Coalescer {
        Coalescer::with_debounce(
            Arc::new(DiskSink::new(db.clone())),
            Duration::from_millis(20),
        )
    }

    /// 回放必须真的写出侧边栏与本地旗标，并且**写成功才删意图**。
    #[test]
    fn replay_writes_sidecar_and_clears_intent() {
        let dir = temp_dir("ok");
        let photo = dir.join("DSC_0001.ARW");
        let xmp_path = crate::xmp::get_xmp_path(&photo);
        let db = Database::open(&dir.join("test.db")).expect("临时库");

        db.enqueue_pending(&photo.to_string_lossy(), 4, "pick", "", now_secs())
            .expect("记意图");

        let written = replay_pending(&db, &queue_for(&db)).expect("回放");
        assert_eq!(written, 1);
        assert!(xmp_path.exists(), "回放必须真的写出侧边栏");
        assert_eq!(
            db.count_pending().expect("计数"),
            0,
            "写成功必须删掉意图，否则每次启动都重放"
        );

        let store = cullstore::load(&dir);
        assert_eq!(
            store.get("DSC_0001").map(|e| e.flag.as_str()),
            Some("pick"),
            "旗标也要落到本地存储"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 色标必须完整穿过「pending → Intent → DiskSink → XMP」这条链。
    ///
    /// 只测 `write_xmp` 不够：命令层/意图层漏传 label 时那些单测仍然全绿，
    /// 而用户按 6 什么也写不出去。
    #[test]
    fn replay_writes_colour_label_to_sidecar() {
        let dir = temp_dir("label");
        let photo = dir.join("DSC_0003.ARW");
        let xmp_path = crate::xmp::get_xmp_path(&photo);
        let db = Database::open(&dir.join("test.db")).expect("临时库");

        db.enqueue_pending(&photo.to_string_lossy(), 4, "pick", "Red", now_secs())
            .expect("记意图");

        let written = replay_pending(&db, &queue_for(&db)).expect("回放");
        assert_eq!(written, 1);

        let meta = crate::xmp::read_xmp_full(&xmp_path).expect("侧边栏应存在");
        assert_eq!(meta.label, "Red", "色标必须写进 XMP");
        assert_eq!(meta.rating, 4, "评级同时落盘");
        let content = fs::read_to_string(&xmp_path).unwrap();
        assert_eq!(
            content.matches("<xmp:Label>").count(),
            1,
            "只能有一份色标: {}",
            content
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// reject 落盘后游标必须记**磁盘实际值**（0 星），不是意图里的星级。
    ///
    /// 记错的话，下次 mtime 一变（外部重新保存一次）就会误报
    /// 「外部把 5 星改成了 0 星」—— 而磁盘上本来就是淘汰态，什么都没发生。
    #[test]
    fn reject_records_disk_rating_in_cursor() {
        let dir = temp_dir("reject_cursor");
        let photo = dir.join("DSC_0004.ARW");
        let db = Database::open(&dir.join("test.db")).expect("临时库");
        db.enqueue_pending(&photo.to_string_lossy(), 5, "reject", "", now_secs())
            .expect("记意图");

        replay_pending(&db, &queue_for(&db)).expect("回放");

        let sidecar = crate::xmp::get_xmp_path(&photo)
            .to_string_lossy()
            .to_string();
        let cursor = db
            .lookup_xmp_cursor(&sidecar)
            .expect("查游标")
            .expect("写盘后必须推进游标");
        assert_eq!(cursor.rating, 0, "磁盘上是 Rating=-1，读回 0 星");
        assert_eq!(cursor.flag, "reject");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 侧边栏在本次改动之后被外部改过 → 以外部为准，不覆盖，只清掉过期意图。
    #[test]
    fn replay_skips_intent_older_than_external_edit() {
        let dir = temp_dir("conflict");
        let photo = dir.join("DSC_0002.ARW");
        let xmp_path = crate::xmp::get_xmp_path(&photo);
        let external = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"></x:xmpmeta>";
        fs::write(&xmp_path, external).expect("外部侧边栏");

        let db = Database::open(&dir.join("test.db")).expect("临时库");
        // updated_at = 1：远早于侧边栏 mtime，模拟「用户改完，Lightroom 又改过」
        db.enqueue_pending(&photo.to_string_lossy(), 4, "pick", "", 1)
            .expect("记意图");

        let written = replay_pending(&db, &queue_for(&db)).expect("回放");
        assert_eq!(written, 0, "冲突时不该写");
        assert_eq!(
            fs::read_to_string(&xmp_path).expect("读回"),
            external,
            "外部内容必须原样保留"
        );
        assert_eq!(
            db.count_pending().expect("计数"),
            0,
            "过期意图要清掉，否则每次启动都判一次冲突"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
