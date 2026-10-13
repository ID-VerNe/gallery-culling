//! 调色统一管线：**一条命令，两个落点**。
//!
//! - 总是写 XMP（互操作底线，引擎挂了也不受影响）；
//! - 引擎可用时在**同一常驻进程**内 apply_edits -> save_project（落盘持久，
//!   否则重启后调色消失）；
//! - 引擎失败**不回滚 XMP**，只在报告里带 warning。
//!
//! 引擎不可用与写盘失败是两件事：apply_tone 的守卫在 XMP 已落盘**之后**，
//! 走 report.warnings 记账而非 `?` 早退 —— 早退会把「XMP 已写成功」报成
//! 失败，UI 状态再也回滚不了。

use std::path::PathBuf;

use tauri::State;

use crate::models::{ToneAdjustments, ToneState, ToneWriteReport};
use crate::lumen;
use crate::xmp;
use crate::xmp::read_xmp_full;

use super::{blocking, blocking_value, lumen_exe, AppState};

/// 统一调色写入：**一条命令，两个落点**。
///
/// - 总是写 XMP（互操作底线，引擎挂了也不受影响）；
/// - 引擎可用时在**同一常驻进程**内 `apply_edits` → `save_project`（落盘持久，
///   否则重启后调色消失）；
/// - 引擎失败不回滚 XMP，只在报告里带 warning。
#[tauri::command]
pub async fn apply_tone_cmd(
    state: State<'_, AppState>,
    file_path: String,
    tone: ToneAdjustments,
) -> Result<ToneWriteReport, String> {
    let settings = state.db.load_settings()?;
    let path = PathBuf::from(&file_path);

    // 1) XMP（同步 IO、必做）。挪进阻塞线程池，避免同步文件写入阻塞 async 执行器。
    //    tone 的 6 个分量是 f32（Copy），先取出再 move 进闭包，保证 tone 后续仍可用。
    let (exposure, highlights, shadows, temperature, tint, contrast) = (
        tone.exposure,
        tone.highlights,
        tone.shadows,
        tone.temperature,
        tone.tint,
        tone.contrast,
    );
    blocking("调色写入任务异常", move || {
        crate::xmp::update_xmp_tone(
            &path,
            Some(exposure),
            Some(highlights),
            Some(shadows),
            Some(temperature),
            Some(tint),
            Some(contrast),
        )
    })
    .await?;
    let mut report = ToneWriteReport {
        xmp_written: true,
        ..Default::default()
    };

    if !settings.lumen_enabled {
        report
            .warnings
            .push("LUMEN RAW 引擎未启用：只写入了 XMP，预览仍用 CSS 滤镜。".to_string());
        return Ok(report);
    }
    let exe = match lumen::find_lumen_cli(&settings.lumen_cli_path) {
        Some(e) => e,
        None => {
            report
                .warnings
                .push("未找到 lumen-cli：只写入了 XMP。".to_string());
            return Ok(report);
        }
    };
    let runtime = state.lumen.clone();

    // 2) lumen：apply + save 必须同进程（编辑态是 session 态）
    let applied = blocking("调色写入任务异常", move || {
        let changes = lumen::tone_to_recipe(&tone, true);
        let applied = runtime.apply_recipe(&exe, &file_path, &changes);
        let applied = match applied {
            Ok(v) => v,
            Err(e) => {
                return Err(format!("应用 LUMEN RAW 调色失败: {}", e));
            }
        };
        // 落盘：不 save_project 的话调色下次就消失（session 不持久）
        let project = runtime
            .save_project(&exe, &file_path)
            .map_err(|e| format!("保存 LUMEN RAW 工程失败: {}", e))?;
        Ok::<_, String>((applied, project))
    })
    .await;

    match applied {
        Ok((_state, project)) => {
            report.lumen_applied = true;
            report.project_path = Some(project);
        }
        Err(e) => {
            // XMP 已写成功 —— 不回滚，只如实报告
            report.warnings.push(e);
        }
    }
    Ok(report)
}

/// 统一调色读取：XMP（互操作真值）+ lumen 工程（渲染真值），并报告是否分歧。
#[tauri::command]
pub async fn get_tone_state_cmd(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<ToneState, String> {
    let settings = state.db.load_settings()?;
    let path = PathBuf::from(&file_path);
    let xmp_tone = read_xmp_tone(&xmp::get_xmp_path(&path));

    let mut result = ToneState {
        tone: xmp_tone.clone(),
        xmp_tone,
        ..Default::default()
    };

    let Some(exe) = lumen_exe(&settings) else {
        return Ok(result); // 不可用 → 零请求，沿用 XMP 读回的状态
    };
    let runtime = state.lumen.clone();
    let lumen_tone = blocking_value("读取调色状态任务异常", move || {
        runtime.read_project_tone(&exe, &file_path)
    })
    .await?;

    match lumen_tone {
        Some(t) => {
            result.divergent = lumen::LumenRuntime::tone_diverges(&result.xmp_tone, &t);
            // 引擎可用时以 lumen 为准（它决定实际渲染），分歧另行提示
            result.tone = t.clone();
            result.lumen_tone = Some(t);
            result.lumen_available = true;
        }
        None => {
            // 没有 .lumen 工程 → 引擎是"在的但这张没调过色"，仍算可用
            result.lumen_available = true;
        }
    }
    Ok(result)
}

/// 从 XMP 读回六滑杆（缺失按 0，与滑杆零点一致）。
fn read_xmp_tone(path: &std::path::Path) -> ToneAdjustments {
    read_xmp_full(path)
        .map(|m| ToneAdjustments {
            exposure: m.exposure.unwrap_or(0.0),
            highlights: m.highlights.unwrap_or(0.0),
            shadows: m.shadows.unwrap_or(0.0),
            temperature: m.temperature.unwrap_or(0.0),
            tint: m.tint.unwrap_or(0.0),
            contrast: m.contrast.unwrap_or(0.0),
        })
        .unwrap_or_default()
}
