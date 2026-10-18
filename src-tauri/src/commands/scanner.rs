//! 目录扫描与取消。
//!
//! 进度节流器 `ProgressThrottle` 仍由 mod.rs 持有 —— 导出路径也用它，
//! 两处节流阈值必须一致，分叉会让两条进度条的刷新节奏不同。

use std::sync::atomic::Ordering;

use tauri::{Emitter, State};

use crate::models::FolderScanResult;
use crate::scanner::scan_folders;

use super::{blocking, AppState, ProgressThrottle};

/// `scan-progress` 事件负载。字段名即前端读取的键（都是单词，保持小写）。
#[derive(Clone, serde::Serialize)]
pub struct ScanProgress {
    /// 阶段："enumerate" | "read" | "sort" | "done"
    pub phase: String,
    /// 当前阶段已处理数
    pub processed: usize,
    /// 当前阶段总数（枚举阶段未知时为 0）
    pub total: usize,
}

/// 请求取消正在进行的扫描（幂等：没有进行中的任务时调用也安全）。
#[tauri::command]
pub fn cancel_scan_cmd(state: State<'_, AppState>) -> Result<(), String> {
    state.scan_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn scan_folders_cmd(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    jpg_folder: String,
    raw_folder: Option<String>,
    sort_order: Option<String>,
) -> Result<FolderScanResult, String> {
    // FR-09：必须在碰取消标志**之前**抢占。重入时如果先 `store(false)`，
    // 会把正在跑的第一次扫描的取消请求抹掉 —— 用户点了取消，任务却继续。
    let _guard = state
        .tasks
        .try_begin(crate::taskgate::Activity::Scan)
        .map_err(|e| e.to_string())?;
    let sort = sort_order.unwrap_or_else(|| "time_filename".to_string());
    let cancel = state.scan_cancel.clone();
    cancel.store(false, Ordering::SeqCst); // 复位上一轮遗留的取消标志

    // 首帧进度：让 UI 立刻切到"扫描中"并显示阶段，而不是干等到枚举结束
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            phase: "enumerate".to_string(),
            processed: 0,
            total: 0,
        },
    );

    let app_for_progress = app.clone();
    let result = blocking("扫描任务异常", move || {
        let mut throttle = ProgressThrottle::new();
        scan_folders(
            &jpg_folder,
            raw_folder.as_deref(),
            &sort,
            &cancel,
            |phase, processed, total| {
                if throttle.should_emit(phase, processed, total) {
                    let _ = app_for_progress.emit(
                        "scan-progress",
                        ScanProgress {
                            phase: phase.to_string(),
                            processed,
                            total,
                        },
                    );
                }
            },
        )
    })
    .await?;

    // 收尾进度：UI 据此把进度条推到 100%
    let _ = app.emit(
        "scan-progress",
        ScanProgress {
            phase: "done".to_string(),
            processed: result.total_count,
            total: result.total_count,
        },
    );
    Ok(result)
}

