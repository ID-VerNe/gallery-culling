//! A 通道常驻运行时：spawn 一次、握手、复用；失败自动降级 B 通道。
//!
//! 线程安全：内部 Mutex；Tauri 命令在 spawn_blocking 内调用（阻塞读）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::capabilities::{detect_ai_flavor, parse_capabilities, LumenCapabilities};
use super::cli::{run_cli, run_lumen};
use super::mcp::McpClient;
use super::status::{lumen_status_from, query_version, LumenStatus};
use super::tools::{mask_changes, project_masks, tool_to_command_id};
use super::tone::recipe_to_tone;
use super::transport::{ProcessTransport, MAX_RESTARTS};
use super::LumenError;

/// A 通道常驻运行时：spawn 一次、握手、复用；失败自动降级 B 通道。
///
/// 线程安全：内部 `Mutex`；Tauri 命令在 `spawn_blocking` 内调用（阻塞读）。
pub struct LumenRuntime {
    // Arc 包裹：命令层需要把运行时搬进 spawn_blocking 线程
    inner: std::sync::Arc<std::sync::Mutex<RuntimeInner>>,
}

#[derive(Default)]
struct RuntimeInner {
    // capabilities 见下方字段
    client: Option<McpClient<ProcessTransport>>,
    version: Option<String>,
    capabilities: Option<LumenCapabilities>,
    failures: u32,
    last_error: Option<String>,
}

impl Default for LumenRuntime {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RuntimeInner::default())),
        }
    }
}


impl Clone for LumenRuntime {
    fn clone(&self) -> Self {
        Self {
            inner: std::sync::Arc::clone(&self.inner),
        }
    }
}

impl LumenRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    /// 握手状态（零 IO；仅返回缓存）。
    pub fn status(&self, enabled: bool, exe_found: Option<PathBuf>) -> LumenStatus {
        if !enabled {
            return lumen_status_from(false, None, None);
        }
        let version = self.inner.lock().ok().and_then(|g| g.version.clone());
        lumen_status_from(true, exe_found, version)
    }

    /// 连续失败次数（测试/诊断用）。
    pub fn failure_count(&self) -> u32 {
        self.inner.lock().map(|g| g.failures).unwrap_or(0)
    }

    /// 显式关闭：丢客户端（Drop 关 stdin → 子进程退出）。
    pub fn shutdown(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.client = None;
            g.version = None;
            g.failures = 0;
            g.last_error = None;
        }
    }

    /// A 通道渲染预览；失败则**单次 B 通道兜底**（spec B1）。
    pub fn render_preview(&self, exe: &Path, args: &Value) -> Result<Value, LumenError> {
        match self.render_via_mcp(exe, args) {
            Ok(v) => {
                if let Ok(mut g) = self.inner.lock() {
                    g.failures = 0;
                    g.last_error = None;
                }
                Ok(v)
            }
            Err(e) => {
                if let Ok(mut g) = self.inner.lock() {
                    g.failures = g.failures.saturating_add(1);
                    g.last_error = Some(e.to_string());
                    g.client = None; // 坏连接丢弃，下次重连
                    g.version = None;
                }
                // 兜底：单发 B 通道（已被 E2E 验证）
                run_lumen(exe, "render.preview", args)
            }
        }
    }

    /// 应用 recipe（`edit.apply`，最终值语义）。
    ///
    /// **只能走 A 通道**：lumen 的编辑状态是**进程内 session**——headless 单发
    /// `run edit.apply` 会返回 `applied: [...]`，但下一个进程 `edit.get` 读回仍是 0
    /// （实测：不落盘、无 .lumen 工程文件）。所以必须与随后的 `render_preview` 落在
    /// **同一个 sidecar 进程**内。B 通道兜底在这里是假的成功，故不做兜底。
    pub fn apply_recipe(
        &self,
        exe: &Path,
        photo: &str,
        changes: &Value,
    ) -> Result<Value, LumenError> {
        let args = serde_json::json!({ "path": photo, "changes": changes });
        self.call_session_tool(exe, "apply_edits", &args)
    }

    /// 常驻 session 内的工具调用（编辑类命令的唯一可行通道）。
    ///
    /// lumen 的编辑状态是**进程内 session**：headless 单发 `run edit.apply` 会
    /// 返回 `applied: [...]`，但下一个进程 `edit.get` 读回仍是 0（实测不落盘）。
    /// 所以 apply + render 必须落在同一个 sidecar 进程内 —— 这里没有 B 通道兜底，
    /// 兜底会是假的成功。
    fn call_session_tool(&self, exe: &Path, tool: &str, args: &Value) -> Result<Value, LumenError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| LumenError::Io("锁中毒".to_string()))?;
        if guard.failures >= MAX_RESTARTS {
            return Err(LumenError::Timeout);
        }
        if guard.client.is_none() {
            let transport = ProcessTransport::spawn(exe, &["mcp", "--headless"])?;
            let mut client = McpClient::new(transport);
            client.handshake()?;
            guard.version = client.server_version().map(str::to_string);
            guard.client = Some(client);
        }
        let client = guard.client.as_mut().expect("client 已建立");
        match client.call_tool(tool, args) {
            Ok(v) => {
                guard.failures = 0;
                Ok(v)
            }
            Err(e) => {
                guard.client = None;
                guard.version = None;
                guard.failures = guard.failures.saturating_add(1);
                Err(e)
            }
        }
    }

    /// 落盘工程（`project.save`，工具名 `save_project`）。
    ///
    /// **必须与 `apply_edits` 同进程**：编辑态是 session 态，不落盘。少了这一步，
    /// 调色在下次预览/重启后就消失了（`.lumen` 文件是跨进程唯一可读回的形式）。
    pub fn save_project(&self, exe: &Path, photo: &str) -> Result<String, LumenError> {
        let args = serde_json::json!({ "path": photo });
        let out = self.call_session_tool(exe, "save_project", &args)?;
        out.get("project")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                LumenError::Protocol("LUMEN RAW 未返回工程路径（project.save）".to_string())
            })
    }

    /// 读回落盘工程的调色（任意进程可读，因为 .lumen 落盘了）。
    /// 读不到返回 None —— 没有工程不是错误。
    pub fn read_project_tone(
        &self,
        exe: &Path,
        photo: &str,
    ) -> Option<crate::models::ToneAdjustments> {
        let out = run_lumen(
            exe,
            "edit.get",
            &serde_json::json!({ "path": photo, "full": true }),
        )
        .ok()?;
        Some(recipe_to_tone(out.get("state").unwrap_or(&Value::Null)))
    }

    /// 两份真值是否一致（统一管线的分歧检测）。
    pub fn tone_diverges(
        xmp: &crate::models::ToneAdjustments,
        lumen: &crate::models::ToneAdjustments,
    ) -> bool {
        const EPS: f32 = 0.005;
        let d = |a: f32, b: f32| (a - b).abs() > EPS;
        d(xmp.exposure, lumen.exposure)
            || d(xmp.highlights, lumen.highlights)
            || d(xmp.shadows, lumen.shadows)
            || d(xmp.temperature, lumen.temperature)
            || d(xmp.tint, lumen.tint)
            || d(xmp.contrast, lumen.contrast)
    }

    /// 应用 AI 蒙版（`edit.apply` 的 `masks` 段）+ 落盘工程。
    ///
    /// 需要 GPU flavor（模型 + onnxruntime，见 `detect_ai_flavor`）。蒙版检测
    /// 实测约 4s（DirectML 上单次前向反而比 CPU 慢：dispatch 开销占主导）。
    pub fn apply_mask(
        &self,
        exe: &Path,
        photo: &str,
        region: &str,
        adjustments: &crate::models::MaskAdjustments,
    ) -> Result<Value, LumenError> {
        if !detect_ai_flavor(exe) {
            return Err(LumenError::Command(
                "当前 LUMEN RAW 为 CPU 版，不含 AI 蒙版模型（需 GPU 版）".to_string(),
            ));
        }
        let changes = mask_changes(region, adjustments)?;
        let applied = self.apply_recipe(exe, photo, &changes)?;
        // 落盘：不 save_project 蒙版下次就没了
        self.save_project(exe, photo)?;
        Ok(applied)
    }

    /// 读回落盘工程里的蒙版列表（跨进程可读）。
    pub fn list_masks(&self, exe: &Path, photo: &str) -> Vec<Value> {
        run_lumen(
            exe,
            "edit.get",
            &serde_json::json!({ "path": photo, "full": true }),
        )
        .map(|v| project_masks(v.get("state").unwrap_or(&Value::Null)))
        .unwrap_or_default()
    }

    /// A 通道是否活着（调色等 session 态操作的前提）。
    pub fn has_live_client(&self) -> bool {
        self.inner
            .lock()
            .map(|g| g.client.is_some())
            .unwrap_or(false)
    }

    /// 读回 recipe（`edit.get full=true`）。
    pub fn get_recipe(&self, exe: &Path, photo: &str) -> Result<Value, LumenError> {
        run_lumen(
            exe,
            "edit.get",
            &serde_json::json!({ "path": photo, "full": true }),
        )
    }

    /// 推送评级到 LUMEN RAW（Step 8）：A 通道工具优先，B 通道兜底。
    ///
    /// 调 `rate_photos` / `flag_photos`（MCP 工具名），失败降级 `run_lumen`。
    pub fn push_rating(
        &self,
        exe: &Path,
        photo: &Path,
        rating: u8,
        flag: &str,
    ) -> Result<(), LumenError> {
        let path_arg = serde_json::json!({ "paths": [photo.to_string_lossy()] });
        // flag 语义映射：reject → 明确的 reject（lumen 与 Lightroom 同款 -1）
        if let Err(e) = self.call_rating_tool(
            exe,
            "rate_photos",
            &serde_json::json!({ "rating": rating as i64, "paths": path_arg["paths"].clone() }),
        ) {
            return self.push_flag(exe, photo, flag).map_err(|_| e);
        }
        if flag != "none" && !flag.is_empty() {
            self.push_flag(exe, photo, flag)?;
        }
        Ok(())
    }

    fn push_flag(&self, exe: &Path, photo: &Path, flag: &str) -> Result<(), LumenError> {
        let args = serde_json::json!({
            "flag": flag,
            "paths": [photo.to_string_lossy()],
        });
        self.call_rating_tool(exe, "flag_photos", &args)
    }

    /// 评级工具调用：A 通道（有客户端时）→ B 通道兜底。
    fn call_rating_tool(&self, exe: &Path, tool: &str, args: &Value) -> Result<(), LumenError> {
        let via_mcp = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| LumenError::Io("锁中毒".into()))?;
            if guard.client.is_some() {
                match guard.client.as_mut().unwrap().call_tool(tool, args) {
                    Ok(_) => Ok(()),
                    Err(e) => {
                        guard.client = None;
                        guard.version = None;
                        guard.failures = guard.failures.saturating_add(1);
                        Err(e)
                    }
                }
            } else {
                Err(LumenError::Timeout)
            }
        };
        match via_mcp {
            Ok(()) => Ok(()),
            Err(_) => {
                // B 通道兜底：`run` 收的是**命令 id**（不是 MCP 工具名）。
                let command_id = tool_to_command_id(tool);
                run_lumen(exe, command_id, args).map(|_| ())
            }
        }
    }

    /// 拉取 lumen 侧的评级（catalog 真值）：返回 path → (rating, flag)。
    /// 拉取 lumen 侧（catalog 真值）评级。
    ///
    /// `folder` 是**照片所在目录**；lumen 的查询语言按文件名过滤，
    /// 故取目录下唯一的文件名做 `name:` 查询（宿主一次同步一个目录）。
    pub fn pull_ratings(
        &self,
        exe: &Path,
        folder: &Path,
    ) -> Result<Vec<(String, u8, String)>, LumenError> {
        // lumen 的 `name:` 按**文件名**过滤（不是目录名）。宿主与 lumen 共享同一批
        // 文件，故逐个文件名查询后合并；目录为空则直接返回。
        let mut names: Vec<String> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(folder) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_file() {
                    if let Some(name) = p.file_name().map(|s| s.to_string_lossy().to_string()) {
                        names.push(name);
                    }
                }
            }
        }
        if names.is_empty() {
            return Ok(Vec::new());
        }

        let mut merged: Vec<(String, u8, String)> = Vec::new();
        for name in names {
            let query = format!("name:{}", name);
            let out = match run_cli(exe, &["list", &query]) {
                Ok(v) => v,
                Err(_) => continue, // 单个文件查不到不算失败
            };
            if let Some(photos) = out.get("photos").and_then(Value::as_array) {
                for p in photos {
                    if let Some(path) = p.get("path").and_then(Value::as_str) {
                        merged.push((
                            path.to_string(),
                            p.get("rating").and_then(Value::as_u64).unwrap_or(0) as u8,
                            p.get("flag")
                                .and_then(Value::as_str)
                                .unwrap_or("none")
                                .to_string(),
                        ));
                    }
                }
            }
        }
        Ok(merged)
    }

    fn render_via_mcp(&self, exe: &Path, args: &Value) -> Result<Value, LumenError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| LumenError::Io("运行时锁中毒".to_string()))?;
        // 达到重连上限 → 直接走兜底（防无限重启风暴）
        if guard.failures >= MAX_RESTARTS {
            return Err(LumenError::Timeout);
        }
        if guard.client.is_none() {
            // 首次：拉起 + 握手（版本钉死在 handshake 内）
            let transport = ProcessTransport::spawn(exe, &["mcp", "--headless"])?;
            let mut client = McpClient::new(transport);
            client.handshake()?;
            guard.version = client.server_version().map(str::to_string);
            guard.client = Some(client);
        }
        let client = guard.client.as_mut().expect("client 已建立");
        client.call_tool("render_preview", args)
    }
    /// 探测 sidecar 能力（`commands.list` + `edit.presets`），结果缓存在运行��内。
    pub fn capabilities(&self, exe: &Path) -> Result<LumenCapabilities, LumenError> {
        if let Some(caps) = self.inner.lock().ok().and_then(|g| g.capabilities.clone()) {
            return Ok(caps);
        }
        let version = query_version(exe).unwrap_or_default();
        let listing = run_lumen(exe, "commands.list", &serde_json::json!({}))?;
        let mut caps = parse_capabilities(&listing, &version, detect_ai_flavor(exe));
        // 预设清单失败不算能力缺失（老版本可能没有该命令）
        if caps.commands.iter().any(|c| c == "edit.presets") {
            if let Ok(p) = run_lumen(exe, "edit.presets", &serde_json::json!({})) {
                caps.presets = p
                    .get("presets")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.get("name").and_then(Value::as_str))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
            }
        }
        if let Ok(mut g) = self.inner.lock() {
            g.capabilities = Some(caps.clone());
        }
        Ok(caps)
    }

    /// 应用内置预设（`edit.preset`，**必须走 A 通道**：编辑态是进程内 session）。
    pub fn apply_preset(
        &self,
        exe: &Path,
        photo: &str,
        name: &str,
        amount: u8,
    ) -> Result<Value, LumenError> {
        let args = serde_json::json!({
            "path": photo,
            "name": name,
            // schema: 0..100（不是 0..1，也不是 strength）
            "amount": (amount.min(100)) as i64,
        });
        // 必须走 apply_preset 工具：**不能**复用 apply_recipe —— 后者会把载荷
        // 包进 {"changes": ...}，而 edit.preset 的参数是 {path, name, amount}。
        // 包错了会静默变成 no-op（预设"应用成功"但什么都没变）。
        let applied = self.call_session_tool(exe, "apply_preset", &args)?;
        // 落盘：预设只改常驻 session 的**进程内**编辑态；不 save_project 的话
        // 随后 get_tone_state_cmd（跨进程 edit.get 读 .lumen 工程）读回仍是旧值
        // —— 滑杆不动、重启即丢（2026-10-15 e2e 实测：断言A1=false、
        // 无 .lumen 落盘）。与 apply_mask 同款两步式，缺一不可。
        self.save_project(exe, photo)?;
        Ok(applied)
    }
}
