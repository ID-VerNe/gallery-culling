//! MCP 工具名映射与 AI 蒙版载荷构造。

use serde_json::Value;

use super::{json_f32, LumenError};

/// MCP 工具名 → 命令 id（B 通道 `run` 只认命令 id）。
pub fn tool_to_command_id(tool: &str) -> &'static str {
    match tool {
        "rate_photos" => "library.rate",
        "flag_photos" => "library.flag",
        "label_photos" => "library.label",
        "render_preview" => "render.preview",
        "get_edits" => "edit.get",
        "apply_edits" => "edit.apply",
        _ => "app.status",
    }
}

/// 中文/英文区域名 → lumen region id。
///
/// 宿主 UI 用中文展示，但 .lumen 工程与命令载荷必须落英文 id（读回时才认得出）。
pub fn normalize_mask_region(input: &str) -> Option<&'static str> {
    let lowered = input.trim().to_ascii_lowercase();
    Some(match lowered.as_str() {
        "sky" | "天空" => "sky",
        "subject" | "主体" => "subject",
        "person" | "人像" | "人物" => "person",
        "background" | "背景" => "background",
        "foreground" | "前景" => "foreground",
        "top" | "顶部" => "top",
        "bottom" | "底部" => "bottom",
        "edges" | "边缘" => "edges",
        _ => return None,
    })
}

/// 构造 `edit.apply` 的 masks 载荷。
///
/// 形状来自真实 sidecar 的命令 schema 与实跑结果：`masks` 是
/// `[{region, adjustments}]`（新蒙版，region 由 AI 本地检测），一次最多 4 个。
/// 实跑确认 region 也接受中文自然语言（返回名如"天空（自然语言）"），但写英文 id 最稳。
pub fn mask_changes(
    region: &str,
    adjustments: &crate::models::MaskAdjustments,
) -> Result<Value, LumenError> {
    let region = normalize_mask_region(region)
        .ok_or_else(|| LumenError::Command(format!("未知的 AI 蒙版区域: {}", region)))?;
    Ok(serde_json::json!({
        "masks": [{
            "region": region,
            "adjustments": {
                "exposure": json_f32(adjustments.exposure),
                "highlights": json_f32(adjustments.highlights),
                "shadows": json_f32(adjustments.shadows),
                "dehaze": json_f32(adjustments.dehaze),
                "clarity": json_f32(adjustments.clarity),
                "saturation": json_f32(adjustments.saturation),
                "temperature": json_f32(adjustments.temperature.clamp(-100.0, 100.0)),
            },
        }]
    }))
}

/// 读回工程里的蒙版列表（`.lumen` 跨进程可读）。
pub fn project_masks(state: &Value) -> Vec<Value> {
    state
        .get("masks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
