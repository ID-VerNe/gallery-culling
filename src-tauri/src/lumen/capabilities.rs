//! sidecar 能力探测：命令表 + AI 模型是否在盘。
//!
//! 用途是让前端**提前**说明 AI 蒙版不可用，而不是等用户点下去再报错。

use std::path::Path;

use serde_json::Value;

/// sidecar 实际能力（由 `commands.list` 真实解析，不靠猜）。
///
/// 用途：AI 蒙版 / 增强只在 GPU flavor 里存在（CPU-only 包没有 `mask.*`/
/// `photo.enhance`，因为 onnxruntime 不在包里）。前端据此**提前**说明不可用，
/// 而不是等用户点下去再报错。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LumenCapabilities {
    /// 27 条命令的 id（原始顺序，便于契约冻结比对）
    pub commands: Vec<String>,
    /// 内置预设（`edit.presets`），CPU-only 包也有
    pub presets: Vec<String>,
    /// AI 蒙版是否可用（需要 GPU flavor）
    pub ai_masks: bool,
    /// AI 增强（去噪/超分）是否可用（需要 GPU flavor）
    pub ai_enhance: bool,
    pub version: String,
}

/// AI 蒙版模型的文件名（存在即视为装了 AI flavor）。
///
/// **不能用命令表判断**：实测 GPU flavor 的 `commands` 与 CPU 版**逐字节相同**
///（都是 27 条，都没有任何 `mask.*` / `photo.enhance`）。AI 是挂在既有
/// `edit.apply` 的 `changes.masks[].region` 上的，`commands.describe()` 只是遍历
/// import 时无条件填充的模块级 REGISTRY，而 onnxruntime 是懒加载的。所以判据必须
/// 落到磁盘：PyInstaller 把 onnxruntime 放在 `_internal/onnxruntime/capi/`，模型放在
/// `_internal/assets/models/`。
const AI_MODELS: [&str; 4] = [
    "skyseg.onnx",
    "person-deeplab.onnx",
    "ffdnet-color.onnx",
    "u2netp.onnx",
];

/// 从 `commands.list` 的原始 JSON 解析**命令**能力。
///
/// AI 能力不在这里判定（见 `AI_MODELS` 的说明）：AI 版与 CPU 版的命令表完全相同。
/// `ai_present` 由调用方按磁盘事实传入。
pub fn parse_capabilities(
    commands_json: &Value,
    version: &str,
    ai_present: bool,
) -> LumenCapabilities {
    let commands: Vec<String> = commands_json
        .get("commands")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    LumenCapabilities {
        // 蒙版（sky/person/subject…）与去噪/超分共用同一批模型，一起判定
        ai_masks: ai_present,
        ai_enhance: ai_present,
        presets: Vec::new(), // 由调用方补（需要额外一次 edit.presets 调用）
        version: version.to_string(),
        commands,
    }
}

/// 按磁盘事实探测 AI flavor：onnxruntime 运行时 + 至少一个 AI 模型都在才算。
///
/// 纯路径检查，不 spawn 进程 —— 探测失败只能说明"不是 AI 版"，不能拖慢/搞崩启动。
pub fn detect_ai_flavor(exe: &Path) -> bool {
    let Some(dir) = exe.parent() else {
        return false;
    };
    let has_runtime = dir
        .join("_internal")
        .join("onnxruntime")
        .join("capi")
        .join("onnxruntime.dll")
        .is_file();
    has_runtime
        && AI_MODELS.iter().any(|m| {
            dir.join("_internal")
                .join("assets")
                .join("models")
                .join(m)
                .is_file()
        })
}
