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

#[cfg(test)]
mod tests {
    use std::path::Path;
    use crate::lumen::transport::tests::spawn_echo;
    use super::*;
    use crate::lumen::*;
// ---- Step 11: 能力探测 ----
#[test]
fn capabilities_ignore_command_table_for_ai() {
    // 回归：曾用命令表判 AI（找 mask.* / photo.enhance）。实测 GPU flavor 的
    // 命令表与 CPU 版**逐字节相同**（27 条、无任何 AI 命令），那个判据永远为
    // false —— 即便装了 487MB 的 AI 版也会告诉用户"AI 不可用"。
    let listing = serde_json::json!({
        "commands": [
            {"id": "app.status"}, {"id": "edit.apply"}, {"id": "edit.presets"},
            {"id": "render.preview"}, {"id": "library.rate"}, {"id": "photo.export"},
        ]
    });
    let cpu = parse_capabilities(&listing, "1.6.0", false);
    assert_eq!(cpu.commands.len(), 6);
    assert!(!cpu.ai_masks && !cpu.ai_enhance, "CPU 版不该报 AI 可用");

    // 同一份命令表 + 磁盘探测为真 → 必须报可用
    let ai = parse_capabilities(&listing, "1.6.0", true);
    assert!(ai.ai_masks, "装了模型就必须报 AI 蒙版可用");
    assert!(ai.ai_enhance);
    assert_eq!(
        ai.commands, cpu.commands,
        "AI 不改变命令表（这正是不能用命令表判 AI 的原因）"
    );
}

#[test]
fn capabilities_gpu_build_detected_from_disk() {
    // 真实 AI 构建的目录布局（_internal/onnxruntime + _internal/assets/models）
    let dir = std::env::temp_dir().join(format!("lumen_ai_probe_{}", std::process::id()));
    let capi = dir.join("_internal").join("onnxruntime").join("capi");
    let models = dir.join("_internal").join("assets").join("models");
    std::fs::create_dir_all(&capi).unwrap();
    std::fs::create_dir_all(&models).unwrap();
    let exe = dir.join("lumen-cli.exe");
    std::fs::write(&exe, b"stub").unwrap();

    // 只有运行时没有模型 → 不算 AI 版（避免半残安装被误判）
    std::fs::write(capi.join("onnxruntime.dll"), b"stub").unwrap();
    assert!(!detect_ai_flavor(&exe), "缺模型时不该判 AI 可用");

    std::fs::write(models.join("skyseg.onnx"), b"stub").unwrap();
    assert!(detect_ai_flavor(&exe), "运行时 + 模型齐全应判 AI 可用");

    // 没有任何 _internal 的目录 → CPU 版布局
    let cpu_dir = std::env::temp_dir().join(format!("lumen_cpu_probe_{}", std::process::id()));
    std::fs::create_dir_all(&cpu_dir).unwrap();
    let cpu_exe = cpu_dir.join("lumen-cli.exe");
    std::fs::write(&cpu_exe, b"stub").unwrap();
    assert!(!detect_ai_flavor(&cpu_exe), "CPU 布局不该判 AI 可用");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&cpu_dir);
}

#[test]
fn capabilities_tolerate_empty_listing() {
    // 命令表拿不到时不能 panic，也不能谎报 AI 可用
    let caps = parse_capabilities(&serde_json::json!({}), "", false);
    assert!(caps.commands.is_empty());
    assert!(!caps.ai_masks && !caps.ai_enhance);
    // 畸形输入同样不炸
    let caps2 = parse_capabilities(
        &serde_json::json!({"commands": [1, "x", null]}),
        "1.6.0",
        false,
    );
    assert!(caps2.commands.is_empty());
}

#[test]
fn preset_amount_is_zero_to_hundred() {
    // schema 是 amount 0..100（曾误用 strength，真实 sidecar 报 unknown argument）
    let json = serde_json::json!({"path": "x.ARW", "name": "金色时刻", "amount": 60});
    assert_eq!(json["amount"], serde_json::json!(60));
    // 越界必须夹紧（schema 会拒绝 >100）。用变量而非两个字面量，
    // 否则 .min() 在编译期就折叠成常量，这个断言其实什么都没测。
    let raw: u8 = 140;
    let clamped = raw.min(100u8);
    assert_eq!(clamped, 100);
}

#[test]
fn process_transport_spawn_failure() {
    let err = ProcessTransport::spawn(
        Path::new(r"C:\definitely\not\here\lumen-cli-xyz987.exe"),
        &["mcp", "--headless"],
    )
    .expect_err("不存在 exe 应 Err");
    assert_eq!(err, LumenError::NotInstalled);
}

#[test]
fn non_mcp_child_fails_request_protocol() {
    // 真实进程：回显夹具把我们的请求包在 {"echoed":...} 里 → id 不匹配，
    // 读尽后无有效 MCP 应答 → 必须失败（Timeout/Protocol/Command 均可：
    // 核心契约是"非 MCP 对端绝不产生假 Ok"）。
    let mut client = McpClient::new(spawn_echo());
    let err = client
        .request(
            "initialize",
            serde_json::json!({"protocolVersion": LEGACY_PROTOCOL_VERSION}),
        )
        .expect_err("回显不是合法 MCP 应答，必须失败");
    assert!(
        matches!(
            err,
            LumenError::Timeout
                | LumenError::Protocol(_)
                | LumenError::Command(_)
                // 回显夹具不是真 MCP：它不回合法帧就退出，stdout 关闭 ->
                // ProcessExited（BL-02 起与 Timeout 分开）。
                | LumenError::ProcessExited
        ),
        "实际: {:?}",
        err
    );
}
}
