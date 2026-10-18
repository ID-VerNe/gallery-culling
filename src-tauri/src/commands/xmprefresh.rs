//! FR-08 命令层：从 XMP 重新读取，以及冲突的三选一裁决。
//!
//! 两条命令共用 `Activity::Refresh` 任务槽：刷新会读、裁决还会写同一批 sidecar，
//! 与扫描 / 导出 / 批量写盘并发会让「谁最后写」不可预测。

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::cullstore;
use crate::db::{Database, XmpCursor};
use crate::syncqueue::{Coalescer, Intent};
use crate::taskgate::Activity;
use crate::xmp;
use crate::xmprefresh::{
    refresh, CullState, FsProbe, RefreshItem, RefreshReport, RefreshTarget, SidecarProbe,
};

use super::{blocking, AppState};

/// 用户在冲突弹窗里的选择。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictAction {
    /// 保留本地：用未落盘的意图重写 XMP
    KeepLocal,
    /// 采用外部：丢弃本地意图，界面改成磁盘值
    UseExternal,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConflictChoice {
    pub path: String,
    pub action: ConflictAction,
    /// `UseExternal` 时前端回传弹窗里显示的外部值。
    ///
    /// 由前端带回来而不是重读磁盘，是为了避免「弹窗开着的时候外部又改了一次」
    /// 造成二次不一致 —— 用户裁决的是他**看到的**那个值。
    #[serde(default)]
    pub external: Option<CullState>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ResolveReport {
    /// 裁决后的最终状态（前端据此更新界面）
    pub applied: Vec<RefreshItem>,
    /// 逐张失败原因
    pub failed: Vec<String>,
}

/// 从 XMP 增量读取。前端在窗口重新聚焦（防抖后）或手动点「重新读取」时调用。
#[tauri::command]
pub async fn refresh_from_xmp_cmd(
    state: State<'_, AppState>,
    targets: Vec<RefreshTarget>,
) -> Result<RefreshReport, String> {
    let _guard = state
        .tasks
        .try_begin(Activity::Refresh)
        .map_err(|e| e.to_string())?;
    let db = state.db.clone();
    blocking("读取 XMP 任务异常", move || {
        Ok::<_, String>(refresh(&db, &FsProbe, targets))
    })
    .await
}

/// 裁决冲突。可以一次提交多张（逐张选择走这条），也可以整组一个动作。
#[tauri::command]
pub async fn resolve_xmp_conflicts_cmd(
    state: State<'_, AppState>,
    choices: Vec<ConflictChoice>,
) -> Result<ResolveReport, String> {
    let _guard = state
        .tasks
        .try_begin(Activity::Refresh)
        .map_err(|e| e.to_string())?;
    let db = state.db.clone();
    let queue = Arc::clone(&state.sync);
    blocking("裁决 XMP 冲突任务异常", move || {
        Ok::<_, String>(resolve_conflicts(&db, &FsProbe, &queue, choices))
    })
    .await
}

/// 裁决的落地逻辑（抽出来是为了能不经过 Tauri 直接测）。
pub fn resolve_conflicts(
    db: &Database,
    probe: &dyn SidecarProbe,
    queue: &Coalescer,
    choices: Vec<ConflictChoice>,
) -> ResolveReport {
    let mut report = ResolveReport::default();

    for choice in choices {
        let pending = match db.lookup_pending(&choice.path) {
            Ok(Some(p)) => p,
            // 没有待裁决的意图：上一次点击已经处理过（双击 / 重放事件）。
            // 幂等跳过比报错好 —— 用户不该为重复点击看到一条红字。
            Ok(None) => continue,
            Err(e) => {
                report.failed.push(format!("{}: {}", choice.path, e));
                continue;
            }
        };

        match choice.action {
            ConflictAction::KeepLocal => {
                let state = CullState::new(pending.rating, &pending.flag, &pending.label);
                // 记录可能来自旧版本：非法旗标不能进合并队列。
                if let Err(e) = cullstore::validate_flag(&state.flag) {
                    report.failed.push(format!("{}: {}", choice.path, e));
                    continue;
                }
                let intent = Intent {
                    photo_path: Path::new(&choice.path).to_path_buf(),
                    rating: state.rating,
                    flag: state.flag.clone(),
                    label: state.label.clone(),
                    sync_xmp: true,
                };
                // coalesce = false：这是用户点下的一次确定裁决，没有「后续改动」
                // 需要等，别让防抖窗口白拖 400ms。
                match queue.submit(intent, false) {
                    Ok(outcome) => match outcome.result {
                        Ok(()) => report.applied.push(RefreshItem {
                            path: choice.path.clone(),
                            state,
                            sidecar_removed: false,
                        }),
                        // 写盘失败：DiskSink 不删意图，用户下次刷新还能再裁决一次。
                        Err(e) => report.failed.push(format!("{}: {}", choice.path, e)),
                    },
                    Err(e) => report.failed.push(format!("{}: {}", choice.path, e)),
                }
            }
            ConflictAction::UseExternal => {
                if let Err(e) = db.delete_pending(&choice.path) {
                    report.failed.push(format!("{}: {}", choice.path, e));
                    continue;
                }
                let sidecar = xmp::get_xmp_path(Path::new(&choice.path));
                let sidecar_key = sidecar.to_string_lossy().to_string();
                match choice.external {
                    Some(state) => {
                        // 游标推进到外部值：否则下次刷新会把「刚采用的」再报一遍。
                        match probe.mtime_ms(&sidecar) {
                            Some(mtime_ms) => {
                                let _ = db.upsert_xmp_cursor(&XmpCursor {
                                    sidecar_path: sidecar_key,
                                    mtime_ms,
                                    rating: state.rating,
                                    flag: state.flag.clone(),
                                    label: state.label.clone(),
                                });
                            }
                            // 文件已不在：清掉游标，下次按「首次见到」重建基线。
                            None => {
                                let _ = db.delete_xmp_cursor(&sidecar_key);
                            }
                        }
                        report.applied.push(RefreshItem {
                            path: choice.path.clone(),
                            state,
                            sidecar_removed: false,
                        });
                    }
                    // 没带回外部值：只清记录，界面由前端自己保持不动。
                    None => {
                        let _ = db.delete_xmp_cursor(&sidecar_key);
                    }
                }
            }
        }
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::xmprw::DiskSink;
    use crate::xmprefresh::RefreshConflict;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::Duration;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gc_resolve_{}_{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn queue_for(db: &Database) -> Coalescer {
        Coalescer::with_debounce(
            Arc::new(DiskSink::new(db.clone())),
            Duration::from_millis(10),
        )
    }

    fn choice(path: &str, action: ConflictAction) -> ConflictChoice {
        ConflictChoice {
            path: path.to_string(),
            action,
            external: None,
        }
    }

    /// 保留本地：真的写进 XMP、清掉意图、推进游标。
    #[test]
    fn keep_local_writes_xmp_and_clears_pending() {
        let dir = temp_dir("keep");
        let photo = dir.join("a.ARW");
        let photo_str = photo.to_string_lossy().to_string();
        let db = Database::open(&dir.join("t.db")).expect("临时库");
        db.enqueue_pending(&photo_str, 4, "pick", "Red", 100)
            .expect("记意图");

        let report = resolve_conflicts(
            &db,
            &FsProbe,
            &queue_for(&db),
            vec![choice(&photo_str, ConflictAction::KeepLocal)],
        );

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(report.applied.len(), 1);
        assert_eq!(report.applied[0].state, CullState::new(4, "pick", "Red"));

        let meta = xmp::read_xmp_full(&xmp::get_xmp_path(&photo)).expect("侧边栏应已写出");
        assert_eq!(meta.rating, 4, "评级要真的落盘");
        assert_eq!(meta.label, "Red", "色标要一起落盘");

        assert!(
            db.lookup_pending(&photo_str).unwrap().is_none(),
            "写成功后意图要清掉"
        );
        let sidecar = xmp::get_xmp_path(&photo).to_string_lossy().to_string();
        let cursor = db
            .lookup_xmp_cursor(&sidecar)
            .unwrap()
            .expect("写盘后必须推进游标，否则下次刷新会把自己写的当成外部改动");
        assert_eq!(cursor.rating, 4, "游标记的必须是磁盘值");
        assert_eq!(cursor.flag, "pick");
        assert_eq!(cursor.label, "Red");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 采用外部：清掉意图，游标推进到外部值 —— 下一次刷新必须是静默的。
    #[test]
    fn use_external_clears_pending_and_advances_cursor() {
        let dir = temp_dir("external");
        let photo = dir.join("a.ARW");
        let photo_str = photo.to_string_lossy().to_string();
        let db = Database::open(&dir.join("t.db")).expect("临时库");
        // 磁盘上已经是 5 星 + 蓝标（外部写的）
        xmp::write_xmp(&photo, 5, "none", Some("Blue")).expect("预置侧边栏");
        db.enqueue_pending(&photo_str, 4, "pick", "", 100)
            .expect("记意图");

        let report = resolve_conflicts(
            &db,
            &FsProbe,
            &queue_for(&db),
            vec![ConflictChoice {
                path: photo_str.clone(),
                action: ConflictAction::UseExternal,
                external: Some(CullState::new(5, "none", "Blue")),
            }],
        );

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(report.applied.len(), 1);
        assert_eq!(report.applied[0].state, CullState::new(5, "none", "Blue"));
        assert!(
            db.lookup_pending(&photo_str).unwrap().is_none(),
            "采用外部后本地意图必须丢弃"
        );

        // 闭环：裁决后再刷新一次，什么都不该报。
        let sidecar = xmp::get_xmp_path(&photo).to_string_lossy().to_string();
        let after = crate::xmprefresh::refresh(
            &db,
            &FsProbe,
            vec![RefreshTarget {
                path: photo_str.clone(),
                jpg_path: None,
            }],
        );
        assert!(
            after.adopted.is_empty() && after.conflicts.is_empty(),
            "裁决后不该再报：{after:?}"
        );
        assert_eq!(after.unchanged, 1);
        assert!(db.lookup_xmp_cursor(&sidecar).unwrap().is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 保留本地但写盘失败 → 意图必须留着，用户还能再裁决一次。
    #[test]
    fn keep_local_write_failure_keeps_pending() {
        let dir = temp_dir("keep_fail");
        // 父目录不存在：cullstore 与 XMP 都会写失败
        let missing = dir.join("no_such_subdir").join("a.ARW");
        let photo_str = missing.to_string_lossy().to_string();
        let db = Database::open(&dir.join("t.db")).expect("临时库");
        db.enqueue_pending(&photo_str, 4, "pick", "", 100)
            .expect("记意图");

        let report = resolve_conflicts(
            &db,
            &FsProbe,
            &queue_for(&db),
            vec![choice(&photo_str, ConflictAction::KeepLocal)],
        );

        assert_eq!(report.failed.len(), 1, "写盘失败要如实上报");
        assert!(report.applied.is_empty());
        assert!(
            db.lookup_pending(&photo_str).unwrap().is_some(),
            "写盘失败时意图不能被删掉，否则这次改动就永久丢了"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 没有待裁决意图的路径（重复点击 / 事件重放）→ 静默跳过，不报错。
    #[test]
    fn unknown_path_is_skipped() {
        let dir = temp_dir("unknown");
        let db = Database::open(&dir.join("t.db")).expect("临时库");

        let report = resolve_conflicts(
            &db,
            &FsProbe,
            &queue_for(&db),
            vec![choice("C:/p/none.ARW", ConflictAction::KeepLocal)],
        );

        assert!(report.failed.is_empty(), "重复裁决不该报错");
        assert!(report.applied.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 意图里的旗标非法（旧版本/手改数据库）→ 拒写，且不删意图。
    #[test]
    fn invalid_flag_is_rejected_without_clearing_intent() {
        let dir = temp_dir("badflag");
        let photo = dir.join("a.ARW");
        let photo_str = photo.to_string_lossy().to_string();
        let db = Database::open(&dir.join("t.db")).expect("临时库");
        db.enqueue_pending(&photo_str, 4, "keep", "", 100)
            .expect("记意图");

        let report = resolve_conflicts(
            &db,
            &FsProbe,
            &queue_for(&db),
            vec![choice(&photo_str, ConflictAction::KeepLocal)],
        );

        assert_eq!(report.failed.len(), 1);
        assert!(
            report.failed[0].contains("未知的旗标值"),
            "错误信息要说明原因: {:?}",
            report.failed
        );
        assert!(db.lookup_pending(&photo_str).unwrap().is_some());
        assert!(
            !xmp::get_xmp_path(&photo).exists(),
            "拒写时不该留下任何副作用"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 记录队列收到的意图，用来区分「命令层就拒了」与「进了队列才被 DiskSink 拒」。
    ///
    /// 两者最终都不写盘，只有这一步能证明校验发生在**入队之前** ——
    /// 否则一个非法值会白占一次队列往返，而且 `Intent` 里会躺着一条永远写不出去的记录。
    #[derive(Default)]
    struct RecordingSink {
        writes: Mutex<Vec<Intent>>,
    }

    impl crate::syncqueue::IntentSink for RecordingSink {
        fn write(&self, intent: &Intent) -> Result<(), String> {
            self.writes.lock().unwrap().push(intent.clone());
            Ok(())
        }
    }

    /// 非法旗标必须在入队之前被拒。
    #[test]
    fn invalid_flag_is_rejected_before_queueing() {
        let dir = temp_dir("badflag_queue");
        let photo = dir.join("a.ARW");
        let photo_str = photo.to_string_lossy().to_string();
        let db = Database::open(&dir.join("t.db")).expect("临时库");
        db.enqueue_pending(&photo_str, 4, "keep", "", 100)
            .expect("记意图");

        let sink = Arc::new(RecordingSink::default());
        let queue = Coalescer::with_debounce(sink.clone(), Duration::from_millis(10));

        let report = resolve_conflicts(
            &db,
            &FsProbe,
            &queue,
            vec![choice(&photo_str, ConflictAction::KeepLocal)],
        );

        assert_eq!(report.failed.len(), 1);
        assert!(
            sink.writes.lock().unwrap().is_empty(),
            "非法旗标不该进入合并队列"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 前端没带回外部值 → 只清记录，界面由前端自己保持不动。
    #[test]
    fn use_external_without_state_only_clears_records() {
        let dir = temp_dir("external_none");
        let photo = dir.join("a.ARW");
        let photo_str = photo.to_string_lossy().to_string();
        let db = Database::open(&dir.join("t.db")).expect("临时库");
        xmp::write_xmp(&photo, 5, "none", Some("")).expect("预置侧边栏");
        db.enqueue_pending(&photo_str, 4, "pick", "", 100)
            .expect("记意图");
        let sidecar = xmp::get_xmp_path(&photo).to_string_lossy().to_string();
        db.upsert_xmp_cursor(&XmpCursor {
            sidecar_path: sidecar.clone(),
            mtime_ms: 1,
            rating: 4,
            flag: "pick".to_string(),
            label: String::new(),
        })
        .expect("预置游标");

        let report = resolve_conflicts(
            &db,
            &FsProbe,
            &queue_for(&db),
            vec![choice(&photo_str, ConflictAction::UseExternal)],
        );

        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(report.applied.is_empty(), "没带回外部值就没有可应用的状态");
        assert!(db.lookup_pending(&photo_str).unwrap().is_none());
        assert!(
            db.lookup_xmp_cursor(&sidecar).unwrap().is_none(),
            "游标清掉，下次刷新按首次见到重建基线"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_choices_is_noop() {
        let dir = temp_dir("empty");
        let db = Database::open(&dir.join("t.db")).expect("临时库");
        let report = resolve_conflicts(&db, &FsProbe, &queue_for(&db), Vec::new());
        assert!(report.applied.is_empty());
        assert!(report.failed.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 真实文件闭环：建立基线 → 外部改动 → 增量读 → 冲突 → 裁决。
    #[test]
    fn real_files_end_to_end() {
        let dir = temp_dir("e2e");
        let photo = dir.join("a.ARW");
        let photo_str = photo.to_string_lossy().to_string();
        let db = Database::open(&dir.join("t.db")).expect("临时库");

        // 1. 首次：建立基线
        xmp::write_xmp(&photo, 3, "none", Some("")).expect("预置侧边栏");
        let first = crate::xmprefresh::refresh(
            &db,
            &FsProbe,
            vec![RefreshTarget {
                path: photo_str.clone(),
                jpg_path: None,
            }],
        );
        assert_eq!(first.baselined, 1);
        assert!(first.adopted.is_empty());

        // 2. 同一份内容再刷：零读取（unchanged）
        let second = crate::xmprefresh::refresh(
            &db,
            &FsProbe,
            vec![RefreshTarget {
                path: photo_str.clone(),
                jpg_path: None,
            }],
        );
        assert_eq!(second.unchanged, 1);
        assert!(second.adopted.is_empty());

        // 3. 外部改成 5 星（模拟 Lightroom）
        std::thread::sleep(Duration::from_millis(20)); // 保证 mtime 前进
        xmp::write_xmp(&photo, 5, "none", Some("")).expect("外部改写");
        let third = crate::xmprefresh::refresh(
            &db,
            &FsProbe,
            vec![RefreshTarget {
                path: photo_str.clone(),
                jpg_path: None,
            }],
        );
        assert_eq!(third.adopted.len(), 1, "外部改动必须被发现");
        assert_eq!(third.adopted[0].state.rating, 5);

        // 4. 本地又改（写盘失败留下意图）→ 外部再改 → 冲突
        db.enqueue_pending(&photo_str, 2, "pick", "", 200)
            .expect("记意图");
        std::thread::sleep(Duration::from_millis(20));
        xmp::write_xmp(&photo, 1, "none", Some("")).expect("外部再改写");
        let fourth = crate::xmprefresh::refresh(
            &db,
            &FsProbe,
            vec![RefreshTarget {
                path: photo_str.clone(),
                jpg_path: None,
            }],
        );
        assert_eq!(fourth.conflicts.len(), 1, "本地有意图 + 外部也改 = 冲突");
        let c: &RefreshConflict = &fourth.conflicts[0];
        assert_eq!(c.local, CullState::new(2, "pick", ""));
        assert_eq!(c.external, CullState::new(1, "none", ""));

        // 5. 裁决「保留本地」→ 磁盘变成 2 星，意图清掉
        let resolved = resolve_conflicts(
            &db,
            &FsProbe,
            &queue_for(&db),
            vec![choice(&photo_str, ConflictAction::KeepLocal)],
        );
        assert!(resolved.failed.is_empty(), "{:?}", resolved.failed);
        assert_eq!(
            xmp::read_disk_state(&photo).0,
            2,
            "保留本地后磁盘必须是本地值"
        );
        assert!(db.lookup_pending(&photo_str).unwrap().is_none());

        // 6. 裁决后再刷：静默
        let fifth = crate::xmprefresh::refresh(
            &db,
            &FsProbe,
            vec![RefreshTarget {
                path: photo_str.clone(),
                jpg_path: None,
            }],
        );
        assert!(
            fifth.adopted.is_empty() && fifth.conflicts.is_empty(),
            "裁决后应归于平静: {fifth:?}"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
