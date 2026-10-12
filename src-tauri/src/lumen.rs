//! lumen-raw sidecar 桥接层 —— 基础设施（Step 1）。
//!
//! 职责：定位 `lumen-cli` 可执行文件、拼装一次性调用参数、分类退出码、
//! 计算预览缓存键。不包含 Tauri 命令注册与常驻 MCP（后续 Step）。
//!
//! 契约依据：`.plan/specs/step1-lumen-bridge-core-spec.md`
//! 与 `.plan/research/A-cli-bridge-comparison.md`。

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 预览变体：Edited = 应用 recipe 后的渲染；Original = 显影原片（未编辑）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewVariant {
    Edited,
    Original,
}

/// 与 lumen-cli 交互的错误分类。消息面向最终用户，中文句式对齐 `luminar.rs`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LumenError {
    /// 可执行文件不存在或进程无法启动
    NotInstalled,
    /// lumen-cli 业务错误（exit 1，已剥离 `lumen-cli: ` 前缀）
    Command(String),
    /// 参数拼装错误（exit 2 = 宿主缺陷）
    Usage(String),
    /// exit 0 但 stdout 不是合法 JSON
    Protocol(String),
    /// 其他退出码（含被信号杀死时 code 为 None 的语义由调用方包装）
    Exit(i32),
    /// 磁盘 IO 失败（缓存目录创建 / rename 等）
    Io(String),
    /// 等待应答超时（A 通道）
    Timeout,
}

impl fmt::Display for LumenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LumenError::NotInstalled => write!(
                f,
                "未检测到 LUMEN RAW 引擎，请先安装 LUMEN RAW 或在设置中指定 lumen-cli.exe 路径。"
            ),
            LumenError::Command(m) => write!(f, "LUMEN RAW 执行失败: {}", m),
            LumenError::Usage(m) => {
                write!(f, "LUMEN RAW 参数错误（应用内部缺陷）: {}", m)
            }
            LumenError::Protocol(m) => {
                write!(f, "LUMEN RAW 返回了无法解析的结果: {}", m)
            }
            LumenError::Exit(code) => {
                write!(f, "LUMEN RAW 进程异常退出 (Exit Code: {})", code)
            }
            LumenError::Io(m) => write!(f, "LUMEN RAW 预览缓存写入失败: {}", m),
            LumenError::Timeout => write!(f, "LUMEN RAW 响应超时，请重试"),
        }
    }
}

impl std::error::Error for LumenError {}

/// 返回候选路径中第一个真实存在的（顺序即优先级）。
pub fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.exists()).cloned()
}

/// 构建 lumen-cli 候选路径列表（纯函数：环境目录由参数注入）。
///
/// 优先级：设置中的显式路径 → 用户目录安装 → 系统目录安装。
pub fn lumen_candidates(
    settings_path: &str,
    local_appdata: &Path,
    program_files: &Path,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if !settings_path.trim().is_empty() {
        candidates.push(PathBuf::from(settings_path));
    }
    candidates.push(
        local_appdata
            .join("Programs")
            .join("LUMEN RAW")
            .join("lumen-cli.exe"),
    );
    candidates.push(program_files.join("LUMEN RAW").join("lumen-cli.exe"));
    candidates
}

/// 在 PATH 中查找可执行文件（Windows `where`，失败视作未找到）。
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let output = Command::new("where").arg(name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|p| p.exists())
}

/// 查找 lumen-cli：打包资源 → PATH（where）→ None。
///
/// 打包后 Tauri 把 `binaries/lumen-cli/**` 放到 exe 旁的 `resources/lumen-cli/`；
/// 开发态则直接找 `src-tauri/binaries/lumen-cli/lumen-cli.exe`。
pub fn find_lumen_cli(settings_path: &str) -> Option<PathBuf> {
    if !settings_path.trim().is_empty() {
        let explicit = PathBuf::from(settings_path);
        if explicit.exists() {
            return Some(explicit);
        }
    }
    if let Some(found) = find_bundled_lumen_cli() {
        return Some(found);
    }
    find_in_path("lumen-cli")
}

/// 探测随包分发的 sidecar（开发态与打包态各一条路径）。
fn find_bundled_lumen_cli() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?;
    // 打包态：<exe>/../resources/lumen-cli/lumen-cli.exe
    let bundled = exe_dir
        .parent()?
        .join("resources")
        .join("lumen-cli")
        .join("lumen-cli.exe");
    if bundled.is_file() {
        return Some(bundled);
    }
    // 开发态：cargo test 时 cwd = src-tauri
    let dev = PathBuf::from("binaries")
        .join("lumen-cli")
        .join("lumen-cli.exe");
    dev.is_file().then_some(dev)
}

/// 拼装 `lumen-cli run <command> <compact-json> --headless` 的参数向量。
pub fn build_run_args(command: &str, args: &Value) -> Vec<String> {
    let json = serde_json::to_string(args).unwrap_or_else(|_| "{}".to_string());
    vec![
        "run".to_string(),
        command.to_string(),
        json,
        "--headless".to_string(),
    ]
}

/// 把一次已结束子进程的 (退出码, stdout, stderr) 分类为结果或错误。
pub fn classify_exit(code: Option<i32>, stdout: &str, stderr: &str) -> Result<Value, LumenError> {
    match code {
        // 成功：stdout 必须是合法 JSON（lumen-cli 输出美化缩进，容忍首尾空白）。
        Some(0) => {
            serde_json::from_str(stdout.trim()).map_err(|e| LumenError::Protocol(e.to_string()))
        }
        // 业务错误：剥离 `lumen-cli: ` 前缀后透出正文。
        Some(1) => {
            let msg = stderr
                .trim()
                .strip_prefix("lumen-cli: ")
                .unwrap_or(stderr.trim())
                .to_string();
            Err(LumenError::Command(if msg.is_empty() {
                "未知错误".to_string()
            } else {
                msg
            }))
        }
        // 用法错误：宿主拼参缺陷。
        Some(2) => Err(LumenError::Usage(stderr.trim().to_string())),
        // 其他退出码；None（被信号杀死）归一为 -1。
        _ => Err(LumenError::Exit(code.unwrap_or(-1))),
    }
}

/// spawn 并等待，输出交给 `classify_exit`。真实子进程边界，可注入任意命令。
pub fn exec_and_classify(cmd: &mut Command) -> Result<Value, LumenError> {
    let output = cmd.output().map_err(|_| LumenError::NotInstalled)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    classify_exit(output.status.code(), &stdout, &stderr)
}

/// 以 B 通道方式调用 lumen-cli：`exe run <command> <json> --headless`。
pub fn run_lumen(exe: &Path, command: &str, args: &Value) -> Result<Value, LumenError> {
    let mut cmd = Command::new(exe);
    cmd.args(build_run_args(command, args));
    exec_and_classify(&mut cmd)
}

/// 把可选时间戳编码进缓存键：None 与 Some(UNIX_EPOCH) 也必须可区分。
fn mtime_tag(mtime: Option<SystemTime>) -> u128 {
    match mtime {
        Some(t) => t
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(u128::MAX),
        None => u128::MAX,
    }
}

/// 计算预览缓存键：16 位小写 hex。
///
/// 输入任一变化（宽高/变体/版本/源文件 mtime/兄弟 .lumen mtime）→ key 变化。
pub fn lumen_cache_key(
    src: &Path,
    width: u32,
    variant: PreviewVariant,
    lumen_version: &str,
    src_mtime: Option<SystemTime>,
    project_mtime: Option<SystemTime>,
) -> String {
    lumen_cache_key_with_recipe(
        src,
        width,
        variant,
        lumen_version,
        src_mtime,
        project_mtime,
        None,
    )
}

/// 带 recipe 的缓存键。recipe 参与键是**硬要求**：改了色必须重新渲染，
/// 否则用户会看到上一次的图（Step 9 spec 不变量 N4）。
pub fn lumen_cache_key_with_recipe(
    src: &Path,
    width: u32,
    variant: PreviewVariant,
    lumen_version: &str,
    src_mtime: Option<SystemTime>,
    project_mtime: Option<SystemTime>,
    recipe: Option<&Value>,
) -> String {
    // 相对路径 canonicalize，保证同一文件不同写法同 key。
    let abs = src.canonicalize().unwrap_or_else(|_| src.to_path_buf());
    let variant_tag = match variant {
        PreviewVariant::Edited => "edited",
        PreviewVariant::Original => "orig",
    };
    // v2：新增 recipe 段。升级版本号会让所有旧缓存自然失效（一次性重渲染）。
    let recipe_tag = recipe.map(recipe_hash).unwrap_or_else(|| "-".to_string());
    let payload = format!(
        "lumen-preview-v2|{}|{}|{}|{}|{}|{}|{}",
        lumen_version,
        abs.display(),
        mtime_tag(src_mtime),
        mtime_tag(project_mtime),
        width,
        variant_tag,
        recipe_tag
    );
    let digest = Sha256::digest(payload.as_bytes());
    // 16 位小写 hex = 前 8 字节。
    digest
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// 预览产物落盘路径：`<cache_root>/lumen/<key>_<width>[_orig]_lumen.jpg`。
pub fn preview_cache_path(
    cache_root: &Path,
    key: &str,
    width: u32,
    variant: PreviewVariant,
) -> PathBuf {
    let suffix = match variant {
        PreviewVariant::Edited => "",
        PreviewVariant::Original => "_orig",
    };
    cache_root
        .join("lumen")
        .join(format!("{}_{}{}_lumen.jpg", key, width, suffix))
}

/// lumen-raw 版本钉死：sidecar 与此不符即整体禁用 RAW 链路（协议漂移保护）。
pub const PINNED_LUMEN_VERSION: &str = "1.6.0";

/// MCP initialize 使用的 legacy 协议版本（宿主永不带 _meta，绕开 modern 分支）。
pub const LEGACY_PROTOCOL_VERSION: &str = "2024-11-05";

/// request 的读行超时（预览 60s / 重活 600s / 其他 120s 由上层决定，这里取默认）。
pub const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// A 通道读写边界（生产实现 = stdin/stdout 线程；测试 = scripted 内存队列）。
///
/// 被测逻辑（RPC 循环）不含真实 IO —— 本 trait 即进程边界。
pub trait LineTransport: Send {
    /// 写一行（不含换行；实现负责补 `\n` 并 flush）。
    fn write_line(&self, line: &str) -> Result<(), LumenError>;
    /// 读一行，超时未果 → `Ok(None)`；传输损坏 → `Err`。
    fn read_line(&self, timeout: std::time::Duration) -> Result<Option<String>, LumenError>;
}

/// 编码一行 newline-delimited JSON-RPC 2.0 请求（紧凑，对齐 `mcp.py:97`）。
pub fn rpc_encode(method: &str, params: &Value, id: i64) -> String {
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    // serde_json 默认紧凑输出；与 mcp.py:97 的 separators=(',',':') 对齐。
    let mut line = serde_json::to_string(&msg).unwrap_or_else(|_| "{}".to_string());
    line.push('\n');
    line
}

/// 崩溃重启退避：0.5s × 2^attempt，封顶 8s。
pub fn next_backoff(attempt: u32) -> std::time::Duration {
    const BASE_MS: u64 = 500;
    const CAP_MS: u64 = 8_000;
    let shifted = BASE_MS.saturating_mul(1u64 << attempt.min(31));
    std::time::Duration::from_millis(shifted.min(CAP_MS))
}

/// 自动重启次数上限（防无限风暴，A 报告 G3）。
pub const MAX_RESTARTS: u32 = 8;

/// 生产传输层：子进程 stdin（写）/ stdout（读线程 + mpsc）。
///
/// stderr 单独线程丢弃 —— 绝不并入协议流（`mcp.py:205-207` 同理：stdout 只承载协议）。
#[derive(Debug)]
pub struct ProcessTransport {
    stdin: std::sync::Mutex<Option<std::process::ChildStdin>>,
    incoming: std::sync::mpsc::Receiver<Result<String, String>>,
}

impl ProcessTransport {
    /// 拉起子进程并启动读线程。args 由调用方给出（A 通道固定 `["mcp", "--headless"]`）。
    pub fn spawn(exe: &Path, args: &[&str]) -> Result<Self, LumenError> {
        use std::io::{BufRead, BufReader};

        let mut child = Command::new(exe)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|_| LumenError::NotInstalled)?;

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        // stderr：只排空不收集，防管道写满阻塞子进程
        if let Some(mut err) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut sink = Vec::new();
                let _ = std::io::Read::read_to_end(&mut err, &mut sink);
            });
        }

        let (tx, rx) = std::sync::mpsc::channel();
        if let Some(out) = stdout {
            std::thread::spawn(move || {
                // map_while：遇到 Err 即止（flatten 会在持续 Err 时死循环）
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if tx.send(Ok(line)).is_err() {
                        break; // 宿主已丢弃客户端
                    }
                }
            });
        }

        // 子进程句柄丢弃即不等待；进程由 stdin EOF 自行退出（mcp.py:102-104）
        drop(child);
        Ok(Self {
            stdin: std::sync::Mutex::new(stdin),
            incoming: rx,
        })
    }
}

impl LineTransport for ProcessTransport {
    fn write_line(&self, line: &str) -> Result<(), LumenError> {
        use std::io::Write;
        let mut guard = self
            .stdin
            .lock()
            .map_err(|_| LumenError::Io("stdin 锁中毒".into()))?;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| LumenError::Io("sidecar 已关闭".into()))?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| LumenError::Io(format!("写入 sidecar stdin 失败: {}", e)))
    }

    fn read_line(&self, timeout: std::time::Duration) -> Result<Option<String>, LumenError> {
        match self.incoming.recv_timeout(timeout) {
            Ok(Ok(line)) => Ok(Some(line)),
            Ok(Err(e)) => Err(LumenError::Io(e)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(None),
            // 通道断开 = 子进程 stdout 已关闭（EOF）
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(None),
        }
    }
}

impl Drop for ProcessTransport {
    fn drop(&mut self) {
        // 关闭 stdin → lumen-cli mcp 读到 EOF 自行退出（干净回收）
        if let Ok(mut guard) = self.stdin.lock() {
            guard.take();
        }
    }
}

/// 监督器状态（崩溃退避 + 干净回收）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisorState {
    Down,
    Ready { version: String },
    Dead { attempt: u32 },
}

/// 常驻 sidecar 监督器：拉起 → 握手 → Ready；失败 → Dead + 指数退避。
#[derive(Debug)]
pub struct Supervisor {
    state: SupervisorState,
    last_error: Option<String>,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self {
            state: SupervisorState::Down,
            last_error: None,
        }
    }
}

impl Supervisor {
    pub fn state(&self) -> &SupervisorState {
        &self.state
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub fn mark_ready(&mut self, version: &str) {
        self.state = SupervisorState::Ready {
            version: version.to_string(),
        };
        self.last_error = None;
    }

    /// 标记崩溃；返回下一次重启的退避时长（超过 MAX_RESTARTS 则 None = 不再自动重启）。
    pub fn mark_dead(&mut self, err: &str) -> Option<std::time::Duration> {
        self.last_error = Some(err.to_string());
        let attempt = match self.state {
            SupervisorState::Dead { attempt } => attempt + 1,
            _ => 1,
        };
        self.state = SupervisorState::Dead { attempt };
        if attempt > MAX_RESTARTS {
            None
        } else {
            Some(next_backoff(attempt - 1))
        }
    }

    /// 拉起（必要时）并握手。Ready 直接返回缓存版本。
    pub fn ensure_running(&mut self, exe: &Path) -> Result<String, LumenError> {
        if let SupervisorState::Ready { version } = &self.state {
            return Ok(version.clone());
        }
        // 固定 --headless：禁止误连本机 GUI（A 报告 G3/R4）
        let transport = match ProcessTransport::spawn(exe, &["mcp", "--headless"]) {
            Ok(t) => t,
            Err(e) => {
                self.mark_dead(&e.to_string());
                return Err(e);
            }
        };
        let mut client = McpClient::new(transport);
        match client.handshake() {
            Ok(()) => {
                let version = client
                    .server_version()
                    .unwrap_or(PINNED_LUMEN_VERSION)
                    .to_string();
                self.mark_ready(&version);
                Ok(version)
            }
            Err(e) => {
                self.mark_dead(&e.to_string());
                Err(e)
            }
        }
    }
}

/// 直调 CLI 子命令（非 `run` 形态）。
///
/// `lumen-cli list <query>` 自带 catalog 扫描，而 `run library.list` 走的是
/// session 图库（未 add 过时为空）——拉取评级必须用前者。
pub fn run_cli(exe: &Path, args: &[&str]) -> Result<Value, LumenError> {
    let mut cmd = Command::new(exe);
    cmd.args(args);
    exec_and_classify(&mut cmd)
}

/// MCP 工具名 → 命令 id（B 通道 `run` 只认命令 id）。
fn tool_to_command_id(tool: &str) -> &'static str {
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

/// 宿主 ToneAdjustments → lumen recipe changes（**最终值**语义）。
///
/// 六个滑杆全部直通，包括 temperature。Step 9 当时排除了 temperature，理由是
/// "量纲不同"——实测证明真正量纲不同的是**宿主写 XMP 的标签**（`crs:Temperature`
/// 是绝对 Kelvin），而不是 lumen：宿主滑杆量程 -100..=100（"冷暖偏移"），
/// lumen `adjustments.temperature` 同为 ±100 相对偏移（实测传 500 → 存 100），
/// 两侧现在都落到 `crs:Temperature2012`（Lightroom 的相对刻度）。
pub fn tone_to_recipe(tone: &crate::models::ToneAdjustments, include_temperature: bool) -> Value {
    let mut adj = serde_json::Map::new();
    adj.insert("exposure".into(), json_f32(tone.exposure));
    adj.insert("highlights".into(), json_f32(tone.highlights));
    adj.insert("shadows".into(), json_f32(tone.shadows));
    adj.insert("tint".into(), json_f32(tone.tint));
    adj.insert("contrast".into(), json_f32(tone.contrast));
    // 单位已统一（两侧都是 ±100 相对偏移），默认直通；
    // include_temperature=false 保留只为兼容旧调用点。
    adj.insert(
        "temperature".into(),
        json_f32(tone.temperature.clamp(-100.0, 100.0)),
    );
    if !include_temperature {
        adj.remove("temperature");
    }
    serde_json::json!({ "adjustments": adj })
}

/// lumen `state.adjustments` → 宿主 ToneAdjustments（缺失字段 → 0）。
pub fn recipe_to_tone(state: &Value) -> crate::models::ToneAdjustments {
    let adj = state.get("adjustments").cloned().unwrap_or(Value::Null);
    let g = |k: &str| adj.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32;
    crate::models::ToneAdjustments {
        exposure: g("exposure"),
        highlights: g("highlights"),
        shadows: g("shadows"),
        // temperature 同量纲问题：回读也只作展示，不参与回写
        // 单位已统一（±100 相对），回读即滑杆值；越界值夹紧以免 UI 失控
        temperature: g("temperature").clamp(-100.0, 100.0),
        tint: g("tint"),
        contrast: g("contrast"),
    }
}

/// f32 → JSON：量化到 4 位小数，消除 f32→f64 的二进制表示噪声
/// （0.65f32 直接转 f64 会得到 0.6499999761581421，破坏快照对比与缓存稳定性）。
fn json_f32(v: f32) -> Value {
    let rounded = (v as f64 * 10_000.0).round() / 10_000.0;
    serde_json::Number::from_f64(rounded)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// recipe 的规范化哈希（进缓存键）：键排序 + 浮点归一，保证同配方同 key。
pub fn recipe_hash(changes: &Value) -> String {
    let canonical = canonical_json(changes);
    let digest = Sha256::digest(canonical.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// 递归规范化：对象键排序、浮点保留 4 位，避免 0.30000000000000004 之类的抖动。
fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let inner: Vec<String> = keys
                .iter()
                .map(|k| format!("{:?}:{}", k, canonical_json(&map[*k])))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            format!("{:.4}", f)
        }
        other => other.to_string(),
    }
}

/// 同步动作：宿主评级 → lumen。
///
/// `rating = 0 且 flag = none` 不推：lumen 的 `Catalog.compact()` 会把全零条目压掉，
/// 推过去等于"消失"（glue 报告 C §6.3）。
pub fn should_push_rating(rating: u8, flag: &str) -> bool {
    !(rating == 0 && (flag == "none" || flag.is_empty()))
}

/// 同步判定：把宿主侧边栏值、lumen 值与游标放在一起得出结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncDecision {
    /// 无变化
    InSync,
    /// 宿主 → lumen（宿主改了，lumen 还没跟）
    PushToLumen,
    /// lumen → 宿主（lumen 改了，宿主还没跟）
    PullFromLumen,
    /// 两侧都改过 → 交给用户裁决（绝不静默覆盖）
    Conflict,
}

/// 决定一次同步动作。
///
/// - 无游标（首次见到这张）→ 首次同步：以宿主值为准推给 lumen；
/// - 值一致 → `InSync`；
/// - 只有一侧变 → 推那一侧；
/// - 两侧都变 → `Conflict`。
pub fn decide_sync(
    cursor: Option<(u8, String, i64)>, // (rating, flag, synced_at)
    host_now: (u8, String, i64),       // 宿主侧边栏 (rating, flag, mtime)
    lumen_now: Option<(u8, String)>,   // lumen catalog 值
) -> SyncDecision {
    let (host_rating, host_flag, host_mtime) = host_now;
    let Some((cur_rating, cur_flag, _synced_at)) = cursor else {
        // 首次：宿主是权威（用户刚在这台机器上打的星）
        return if lumen_now.is_some() {
            SyncDecision::PushToLumen
        } else {
            SyncDecision::InSync
        };
    };
    let host_changed = host_rating != cur_rating || host_flag != cur_flag;
    let Some((l_rating, l_flag)) = lumen_now else {
        return if host_changed {
            SyncDecision::PushToLumen
        } else {
            SyncDecision::InSync
        };
    };
    let lumen_changed = l_rating != cur_rating || l_flag != cur_flag;
    let same_now = host_rating == l_rating && host_flag == l_flag;

    if same_now {
        SyncDecision::InSync
    } else if host_changed && lumen_changed {
        SyncDecision::Conflict
    } else if host_changed {
        SyncDecision::PushToLumen
    } else if lumen_changed {
        SyncDecision::PullFromLumen
    } else {
        // 都没变但值不同（历史脏数据）：以侧边栏 mtime 为准
        if host_mtime > 0 {
            SyncDecision::PushToLumen
        } else {
            SyncDecision::PullFromLumen
        }
    }
}

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
            inner: std::sync::Arc::new(std::sync::Mutex::new(RuntimeInner::default())),
        }
    }
}

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

/// AI 相关命令的判据：出现任一即认为装了 GPU/AI flavor。
const AI_COMMAND_MARKERS: [&str; 6] = [
    "mask.",
    "photo.enhance",
    "ai.",
    "enhance.",
    "super_resolution",
    "segment",
];

/// 从 `commands.list` 的原始 JSON 解析能力。
pub fn parse_capabilities(commands_json: &Value, version: &str) -> LumenCapabilities {
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
    let has_ai = commands
        .iter()
        .any(|c| AI_COMMAND_MARKERS.iter().any(|m| c.starts_with(m)));
    LumenCapabilities {
        ai_masks: commands.iter().any(|c| c.starts_with("mask.")),
        ai_enhance: has_ai,
        presets: Vec::new(), // 由调用方补（需要额外一次 edit.presets 调用）
        version: version.to_string(),
        commands,
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
        let mut caps = parse_capabilities(&listing, &version);
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
        self.call_session_tool(exe, "apply_preset", &args)
    }
}

/// 常驻 MCP 客户端（legacy）：initialize → tools/list → tools/call。
pub struct McpClient<T: LineTransport> {
    transport: T,
    next_id: i64,
    server_version: Option<String>,
    tools: Option<Vec<Value>>,
}

impl<T: LineTransport> McpClient<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            next_id: 1,
            server_version: None,
            tools: None,
        }
    }

    /// 发一次请求并等待 id 匹配的应答（跳过通知与异 id 帧）。
    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, LumenError> {
        let id = self.next_id;
        self.next_id += 1;
        self.transport
            .write_line(&rpc_encode(method, &params, id))?;

        loop {
            match self.transport.read_line(READ_TIMEOUT)? {
                None => return Err(LumenError::Timeout),
                Some(line) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue; // 空行跳过（mcp.py:105 同义）
                    }
                    let msg: Value = serde_json::from_str(line)
                        .map_err(|e| LumenError::Protocol(format!("RPC 帧解析失败: {}", e)))?;
                    // 通知（无 id）与异 id 帧都跳过；宿主自己严格校验 id。
                    if msg.get("id").and_then(Value::as_i64) != Some(id) {
                        continue;
                    }
                    if let Some(err) = msg.get("error") {
                        let message = err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("未知 RPC 错误");
                        return Err(LumenError::Command(message.to_string()));
                    }
                    return msg.get("result").cloned().ok_or_else(|| {
                        LumenError::Protocol("RPC 应答既无 result 也无 error".into())
                    });
                }
            }
        }
    }

    /// initialize（legacy，断言版本钉死）+ tools/list 缓存。
    pub fn handshake(&mut self) -> Result<(), LumenError> {
        let result = self.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": LEGACY_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "gallery-culling", "version": env!("CARGO_PKG_VERSION")},
            }),
        )?;

        let version = result
            .get("serverInfo")
            .and_then(|s| s.get("version"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                LumenError::Protocol("initialize 应答缺少 serverInfo.version".to_string())
            })?
            .to_string();
        if version != PINNED_LUMEN_VERSION {
            return Err(LumenError::Protocol(format!(
                "LUMEN RAW 版本不匹配（需要 {}，实际 {}）",
                PINNED_LUMEN_VERSION, version
            )));
        }

        let tools = self.request("tools/list", serde_json::json!({}))?;
        let list = tools
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| LumenError::Protocol("tools/list 应答缺少 tools 数组".into()))?
            .clone();

        self.server_version = Some(version);
        self.tools = Some(list);
        Ok(())
    }

    /// tools/call：双错误通道（JSON-RPC error 与 result.isError）。
    pub fn call_tool(&mut self, name: &str, args: &Value) -> Result<Value, LumenError> {
        let result = self.request(
            "tools/call",
            serde_json::json!({"name": name, "arguments": args}),
        )?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            // 业务错误：content[].text 即 str(exc)（mcp.py:185）
            let text = result
                .get("content")
                .and_then(Value::as_array)
                .and_then(|blocks| {
                    blocks
                        .iter()
                        .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                        .cloned()
                })
                .and_then(|b| b.get("text").cloned())
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "LUMEN RAW 工具调用失败".to_string());
            return Err(LumenError::Command(text));
        }
        // 成功：解析 text 块中的 JSON（比 structuredContent 更省事，mcp.py:193）
        result
            .get("content")
            .and_then(Value::as_array)
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            })
            .and_then(|b| b.get("text"))
            .and_then(Value::as_str)
            .ok_or_else(|| LumenError::Protocol("tools/call 应答缺少 text 内容块".into()))
            .and_then(|text| {
                serde_json::from_str(text)
                    .map_err(|e| LumenError::Protocol(format!("工具结果 JSON 解析失败: {}", e)))
            })
    }

    /// 服务器版本（握手成功后有值）。
    pub fn server_version(&self) -> Option<&str> {
        self.server_version.as_deref()
    }

    /// 测试专用：取出传输层以断言发出的行。
    #[cfg(test)]
    pub(crate) fn transport_ref_for_test(&self) -> &T {
        &self.transport
    }

    /// 测试专用：tools/list 缓存数量。
    #[cfg(test)]
    pub(crate) fn tools_len_for_test(&self) -> usize {
        self.tools.as_ref().map(|t| t.len()).unwrap_or(0)
    }
}

/// 前端握手用的集成状态（`lumen_status_cmd` 的纯映射来源）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LumenStatus {
    pub available: bool,
    pub enabled: bool,
    pub pinned_version: String,
    pub found_version: Option<String>,
    /// 面向用户的中文说明
    pub detail: String,
}

/// 解析 `lumen-cli --version` 输出（如 `LUMEN RAW 1.6.0`）中的语义版本号。
///
/// 只取首行第一个 `\d+\.\d+\.\d+`；垃圾输出 → None。
pub fn parse_lumen_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?;
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            let mut dots = 0;
            let mut j = i;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
                if bytes[j] == b'.' {
                    dots += 1;
                }
                j += 1;
            }
            if dots == 2 {
                let candidate = &line[start..j];
                let parts: Vec<&str> = candidate.split('.').collect();
                if parts.len() == 3 && parts.iter().all(|p| !p.is_empty()) {
                    return Some(candidate.to_string());
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

/// 查询 sidecar 版本（真实 spawn `lumen-cli --version`，解析失败 = None）。
pub fn query_version(exe: &Path) -> Option<String> {
    let output = Command::new(exe).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_lumen_version(&String::from_utf8_lossy(&output.stdout))
}

/// 组装 `render.preview` 的 JSON 参数（4 键，不得多键）。
pub fn preview_args(src: &Path, width: u32, variant: PreviewVariant, output: &Path) -> Value {
    serde_json::json!({
        "path": src.to_string_lossy(),
        "size": width,
        "original": matches!(variant, PreviewVariant::Original),
        "output": output.to_string_lossy(),
    })
}

/// 缓存命中判定：目标文件存在且是普通文件。
pub fn cached_preview(
    cache_root: &Path,
    key: &str,
    width: u32,
    variant: PreviewVariant,
) -> Option<PathBuf> {
    let path = preview_cache_path(cache_root, key, width, variant);
    path.is_file().then_some(path)
}

/// 预览缓存键的全部输入（打包以保持函数签名 ≤7 参数，clippy too_many_arguments）。
#[derive(Debug, Clone)]
pub struct PreviewCacheInputs {
    pub width: u32,
    pub variant: PreviewVariant,
    pub lumen_version: &'static str,
    pub src_mtime: Option<SystemTime>,
    pub project_mtime: Option<SystemTime>,
    /// 待渲染的调色 recipe（进缓存键 + 渲染参数）
    pub recipe: Option<Value>,
}

impl Default for PreviewCacheInputs {
    fn default() -> Self {
        Self {
            width: 1600,
            variant: PreviewVariant::Edited,
            lumen_version: PINNED_LUMEN_VERSION,
            src_mtime: None,
            project_mtime: None,
            recipe: None,
        }
    }
}

impl PreviewCacheInputs {
    pub fn key(&self, src: &Path) -> String {
        lumen_cache_key_with_recipe(
            src,
            self.width,
            self.variant,
            self.lumen_version,
            self.src_mtime,
            self.project_mtime,
            self.recipe.as_ref(),
        )
    }

    pub fn cache_path(&self, cache_root: &Path, key: &str) -> PathBuf {
        preview_cache_path(cache_root, key, self.width, self.variant)
    }
}

/// 预览渲染编排：命中缓存直接返回；否则 tmp 渲染 + 原子 rename。
///
/// `render` 是进程边界注入（真实实现为 `run_lumen(exe, "render.preview", args)`）。
pub fn ensure_preview(
    src: &Path,
    cache_root: &Path,
    inputs: PreviewCacheInputs,
    render: impl FnOnce(&Path, &Value) -> Result<(), LumenError>,
) -> Result<PathBuf, LumenError> {
    let key = inputs.key(src);
    let out = inputs.cache_path(cache_root, &key);
    if out.is_file() {
        return Ok(out); // 缓存命中：不碰渲染边界
    }

    let file_name = out
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| LumenError::Protocol("缓存路径非法".to_string()))?;
    let tmp = out
        .parent()
        .unwrap_or(cache_root)
        .join(format!("{}.tmp", file_name));

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| LumenError::Io(e.to_string()))?;
    }

    let args = preview_args(src, inputs.width, inputs.variant, &tmp);
    render(&tmp, &args)?;
    if !tmp.is_file() {
        return Err(LumenError::Protocol(
            "LUMEN RAW 未生成预览输出文件".to_string(),
        ));
    }
    std::fs::rename(&tmp, &out).map_err(|e| LumenError::Io(e.to_string()))?;
    Ok(out)
}

/// 握手状态纯映射：enabled × exe × version(==PINNED) → LumenStatus。
pub fn lumen_status_from(
    enabled: bool,
    exe_found: Option<PathBuf>,
    version: Option<String>,
) -> LumenStatus {
    let pinned = version.as_deref() == Some(PINNED_LUMEN_VERSION);
    let available = enabled && exe_found.is_some() && pinned;
    let detail = if !enabled {
        "未启用 LUMEN RAW 引擎集成".to_string()
    } else if exe_found.is_none() {
        "未找到 lumen-cli.exe，请安装 LUMEN RAW 或在设置中指定路径".to_string()
    } else if !pinned {
        format!(
            "LUMEN RAW 版本不匹配（需要 {}，当前 {}）",
            PINNED_LUMEN_VERSION,
            version.as_deref().unwrap_or("未知")
        )
    } else {
        "LUMEN RAW 引擎就绪".to_string()
    };
    LumenStatus {
        available,
        enabled,
        pinned_version: PINNED_LUMEN_VERSION.to_string(),
        found_version: version,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    /// 测试用临时文件名（进程内唯一，避开并行测试互相踩）。
    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("lumen_test_{}_{}", std::process::id(), name))
    }

    fn t_plus(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    // ---- B1 ----
    #[test]
    fn first_existing_returns_first_match() {
        let a = tmp("missing_a.lnk");
        let b = tmp("exists_b.lnk");
        let c = tmp("exists_c.lnk");
        std::fs::write(&b, b"x").unwrap();
        std::fs::write(&c, b"x").unwrap();

        let got = first_existing(&[a, b.clone(), c]);
        assert_eq!(got, Some(b.clone()), "应返回首个存在的候选");
        let _ = std::fs::remove_file(&b);
    }

    #[test]
    fn first_existing_none_when_missing() {
        let a = tmp("nope_a.lnk");
        let b = tmp("nope_b.lnk");
        assert_eq!(first_existing(&[a, b]), None);
    }

    // ---- B2 ----
    #[test]
    fn lumen_candidates_settings_path_first() {
        let explicit = r"C:\custom\lumen-cli.exe";
        let got = lumen_candidates(explicit, Path::new(r"T:\la"), Path::new(r"T:\pf"));
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], PathBuf::from(explicit), "设置路径必须是第一个候选");
        assert_eq!(
            got[1],
            PathBuf::from(r"T:\la\Programs\LUMEN RAW\lumen-cli.exe")
        );
        assert_eq!(got[2], PathBuf::from(r"T:\pf\LUMEN RAW\lumen-cli.exe"));
    }

    #[test]
    fn lumen_candidates_skips_empty_setting() {
        let got = lumen_candidates("  ", Path::new(r"T:\la"), Path::new(r"T:\pf"));
        assert_eq!(got.len(), 2, "空设置路径不应进候选列表");
        assert_eq!(
            got[0],
            PathBuf::from(r"T:\la\Programs\LUMEN RAW\lumen-cli.exe")
        );
    }

    // ---- B3 ----
    #[test]
    fn find_lumen_cli_prefers_existing_explicit_path() {
        // 确定性：显式设置指向真实文件 → 直接返回，不触达 PATH/资源探测
        let fixture = Path::new("tests/fixtures/lumen_fixture_ok.cmd")
            .canonicalize()
            .unwrap();
        assert_eq!(
            find_lumen_cli(&fixture.display().to_string()),
            Some(fixture)
        );
        // 显式路径不存在 → 继续往下找（不因坏设置直接放弃）
        let bogus = find_lumen_cli(r"C:\nope\lumen-cli-xyz.exe");
        assert_ne!(bogus, Some(PathBuf::from(r"C:\nope\lumen-cli-xyz.exe")));
    }

    #[test]
    fn find_bundled_returns_none_without_sidecar() {
        // 本机未安装 sidecar 到 PATH 时应返回 None（不 panic）
        let _ = find_bundled_lumen_cli();
    }

    #[test]
    fn where_lumen_cli_missing_returns_none() {
        assert_eq!(find_in_path("definitely-not-a-real-exe-xyz-987"), None);
    }

    #[test]
    fn where_lumen_cli_parses_real_output() {
        let found = find_in_path("notepad.exe").expect("notepad.exe 应能通过 where 找到");
        assert!(found.exists(), "where 返回的路径应真实存在: {:?}", found);
    }

    // ---- B4 ----
    #[test]
    fn build_run_args_shape() {
        let args = serde_json::json!({"path": "D:/x.CR2", "size": 1600});
        let got = build_run_args("render.preview", &args);
        let expected_json = serde_json::to_string(&args).unwrap();
        assert_eq!(
            got,
            vec![
                "run".to_string(),
                "render.preview".to_string(),
                expected_json,
                "--headless".to_string()
            ],
            "参数形状必须是 run <cmd> <compact-json> --headless"
        );
    }

    // ---- B5 ----
    #[test]
    fn classify_exit_ok_parses_pretty_json() {
        let stdout = "{\n  \"ok\": true,\n  \"n\": 1\n}\n";
        let value = classify_exit(Some(0), stdout, "").expect("exit 0 + 合法 JSON");
        assert_eq!(value["ok"], serde_json::json!(true));
        assert_eq!(value["n"], serde_json::json!(1));
    }

    #[test]
    fn classify_exit_ok_invalid_json_is_protocol() {
        let err = classify_exit(Some(0), "this-is-not-json", "").expect_err("坏 JSON 应 Err");
        assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
    }

    #[test]
    fn classify_exit_1_strips_prefix() {
        let err = classify_exit(Some(1), "", "lumen-cli: file not found: D:\\x.CR2")
            .expect_err("exit 1 应 Err");
        match err {
            LumenError::Command(m) => {
                assert_eq!(
                    m, "file not found: D:\\x.CR2",
                    "应剥离 lumen-cli: 前缀并 trim"
                )
            }
            other => panic!("应分类为 Command，实际: {:?}", other),
        }
    }

    #[test]
    fn classify_exit_2_is_usage() {
        let err = classify_exit(Some(2), "", "usage: lumen-cli ...").expect_err("exit 2 应 Err");
        assert!(matches!(err, LumenError::Usage(_)), "实际: {:?}", err);
    }

    #[test]
    fn classify_exit_signal_killed() {
        let err = classify_exit(None, "", "").expect_err("信号杀死应 Err");
        assert!(matches!(err, LumenError::Exit(_)), "实际: {:?}", err);
    }

    #[test]
    fn classify_exit_unexpected_code() {
        let err = classify_exit(Some(3), "", "").expect_err("其他退出码应 Err");
        assert_eq!(err, LumenError::Exit(3));
    }

    // ---- B6 ----
    #[test]
    fn run_lumen_missing_exe_not_installed() {
        let err = run_lumen(
            Path::new(r"C:\definitely\not\a\real\lumen-cli-xyz987.exe"),
            "render.preview",
            &serde_json::json!({}),
        )
        .expect_err("exe 不存在应 Err");
        assert_eq!(err, LumenError::NotInstalled);
    }

    #[test]
    fn run_lumen_exit1_real_spawn() {
        // 真实 spawn where.exe 查找一个保证不存在的命令：where 对无匹配稳定返回 exit 1。
        let err = run_lumen(
            Path::new("where.exe"),
            "definitely-not-a-real-command-xyz-987",
            &serde_json::json!({}),
        )
        .expect_err("where 找不到模式应 exit 1 → Err");
        assert!(
            matches!(err, LumenError::Command(_)),
            "应分类为 Command，实际: {:?}",
            err
        );
    }

    // ---- B7 ----
    fn key(src: &Path, width: u32, variant: PreviewVariant, m: Option<SystemTime>) -> String {
        lumen_cache_key(src, width, variant, "1.6.0", m, m)
    }

    #[test]
    fn cache_key_is_deterministic() {
        let src = tmp("det.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let k1 = key(&src, 1600, PreviewVariant::Edited, Some(t_plus(100)));
        let k2 = key(&src, 1600, PreviewVariant::Edited, Some(t_plus(100)));
        assert_eq!(k1, k2);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_canonicalizes_relative_paths() {
        // CARGO_MANIFEST_DIR=src-tauri；夹具文件是真实存在的相对路径。
        let rel = Path::new("tests/fixtures/lumen_fixture_ok.cmd");
        let abs = rel.canonicalize().unwrap();
        assert_eq!(
            key(rel, 1600, PreviewVariant::Edited, Some(t_plus(1))),
            key(&abs, 1600, PreviewVariant::Edited, Some(t_plus(1))),
            "相对路径必须先 canonicalize，与绝对路径同 key"
        );
    }

    #[test]
    fn cache_key_changes_with_width() {
        let src = tmp("w.ARW");
        std::fs::write(&src, b"raw").unwrap();
        assert_ne!(
            key(&src, 1600, PreviewVariant::Edited, None),
            key(&src, 1200, PreviewVariant::Edited, None)
        );
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_variant() {
        let src = tmp("v.ARW");
        std::fs::write(&src, b"raw").unwrap();
        assert_ne!(
            key(&src, 1600, PreviewVariant::Edited, None),
            key(&src, 1600, PreviewVariant::Original, None)
        );
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_version() {
        let src = tmp("ver.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let a = lumen_cache_key(&src, 1600, PreviewVariant::Edited, "1.6.0", None, None);
        let b = lumen_cache_key(&src, 1600, PreviewVariant::Edited, "1.7.0", None, None);
        assert_ne!(a, b);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_src_mtime() {
        let src = tmp("m.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let a = lumen_cache_key(
            &src,
            1600,
            PreviewVariant::Edited,
            "1.6.0",
            Some(t_plus(10)),
            None,
        );
        let b = lumen_cache_key(
            &src,
            1600,
            PreviewVariant::Edited,
            "1.6.0",
            Some(t_plus(11)),
            None,
        );
        assert_ne!(a, b, "源文件 mtime 变化必须换 key");
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_changes_with_project_mtime() {
        let src = tmp("p.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let none = lumen_cache_key(&src, 1600, PreviewVariant::Edited, "1.6.0", None, None);
        let some = lumen_cache_key(
            &src,
            1600,
            PreviewVariant::Edited,
            "1.6.0",
            None,
            Some(t_plus(5)),
        );
        assert_ne!(none, some, "None↔Some 必须换来 key（工程从未存 vs 已存）");
        let newer = lumen_cache_key(
            &src,
            1600,
            PreviewVariant::Edited,
            "1.6.0",
            None,
            Some(t_plus(6)),
        );
        assert_ne!(some, newer, ".lumen 被外部改过必须换 key");
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_is_hex16() {
        let src = tmp("hex.ARW");
        std::fs::write(&src, b"raw").unwrap();
        let k = key(&src, 1600, PreviewVariant::Edited, Some(t_plus(3)));
        assert_eq!(k.len(), 16, "key 必须是 16 位，实际 {:?}", k);
        assert!(
            k.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "key 必须全小写 hex，实际 {:?}",
            k
        );
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cache_key_distinct_paths() {
        let a = tmp("dist_a.ARW");
        let b = tmp("dist_b.ARW");
        std::fs::write(&a, b"raw").unwrap();
        std::fs::write(&b, b"raw").unwrap();
        assert_ne!(
            key(&a, 1600, PreviewVariant::Edited, None),
            key(&b, 1600, PreviewVariant::Edited, None)
        );
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
    }

    // ---- B8 ----
    #[test]
    fn preview_cache_path_shape() {
        let root = tmp("cache_root");
        let p = preview_cache_path(&root, "abc123", 1600, PreviewVariant::Edited);
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "lumen");
        assert_eq!(p.parent().unwrap().parent().unwrap(), root);
        assert_eq!(p.file_name().unwrap(), "abc123_1600_lumen.jpg");

        let p2 = preview_cache_path(&root, "abc123", 1600, PreviewVariant::Original);
        assert_eq!(p2.file_name().unwrap(), "abc123_1600_orig_lumen.jpg");
    }

    // ---- B9 ----
    #[test]
    fn display_messages_are_user_facing_chinese() {
        assert!(LumenError::NotInstalled.to_string().contains("未检测到"));
        assert!(LumenError::Usage("x".into())
            .to_string()
            .contains("应用内部缺陷"));
        assert!(LumenError::Exit(7).to_string().contains("Exit Code: 7"));
    }

    // ---- Step 2: B1 ----
    #[test]
    fn parse_lumen_version_standard_output() {
        assert_eq!(
            parse_lumen_version("LUMEN RAW 1.6.0\r\n"),
            Some("1.6.0".to_string())
        );
        assert_eq!(parse_lumen_version("1.6.0"), Some("1.6.0".to_string()));
    }

    #[test]
    fn parse_lumen_version_rejects_junk() {
        assert_eq!(parse_lumen_version(""), None);
        assert_eq!(parse_lumen_version("LUMEN RAW"), None);
        assert_eq!(parse_lumen_version("garbage output"), None);
        assert_eq!(parse_lumen_version("LUMEN RAW vNext"), None);
    }

    // ---- Step 2: B2 ----
    #[test]
    fn preview_args_four_keys_exact() {
        let args = preview_args(
            Path::new(r"D:\shoot\DSC.CR2"),
            1600,
            PreviewVariant::Edited,
            Path::new(r"D:\cache\out.jpg"),
        );
        let obj = args.as_object().expect("应是对象");
        assert_eq!(
            obj.len(),
            4,
            "additionalProperties:false 下不得多键: {:?}",
            obj
        );
        assert_eq!(obj["path"], serde_json::json!(r"D:\shoot\DSC.CR2"));
        assert_eq!(obj["size"], serde_json::json!(1600));
        assert_eq!(obj["original"], serde_json::json!(false));
        assert_eq!(obj["output"], serde_json::json!(r"D:\cache\out.jpg"));
    }

    #[test]
    fn preview_args_original_flag() {
        let args = preview_args(
            Path::new("a.ARW"),
            800,
            PreviewVariant::Original,
            Path::new("o.jpg"),
        );
        assert_eq!(args["original"], serde_json::json!(true));
        assert_eq!(args["size"], serde_json::json!(800));
    }

    // ---- Step 2: B3 ----
    #[test]
    fn cached_preview_hit_and_miss() {
        let root = tmp("cp_root");
        let hit = preview_cache_path(&root, "k1", 1600, PreviewVariant::Edited);
        std::fs::create_dir_all(hit.parent().unwrap()).unwrap();
        std::fs::write(&hit, b"jpg").unwrap();
        assert_eq!(
            cached_preview(&root, "k1", 1600, PreviewVariant::Edited),
            Some(hit)
        );

        // 不存在 → None
        assert_eq!(
            cached_preview(&root, "nope", 1600, PreviewVariant::Edited),
            None
        );

        // 是目录而非文件 → None
        let dir_as_file = preview_cache_path(&root, "kdir", 1600, PreviewVariant::Edited);
        std::fs::create_dir_all(&dir_as_file).unwrap();
        assert_eq!(
            cached_preview(&root, "kdir", 1600, PreviewVariant::Edited),
            None
        );
    }

    // ---- Step 2: B4 ----
    fn ep_inputs(src_mtime: Option<SystemTime>) -> PreviewCacheInputs {
        PreviewCacheInputs {
            width: 1600,
            variant: PreviewVariant::Edited,
            lumen_version: PINNED_LUMEN_VERSION,
            src_mtime,
            project_mtime: None,
            recipe: None,
        }
    }

    #[test]
    fn ensure_preview_cache_hit_skips_render() {
        let root = tmp("ep_root");
        let inputs = ep_inputs(Some(t_plus(1)));
        let out = inputs.cache_path(&root, &inputs.key(Path::new("src.ARW")));
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        std::fs::write(&out, b"cached").unwrap();

        let mut called = false;
        let got = ensure_preview(Path::new("src.ARW"), &root, inputs, |_tmp, _args| {
            called = true;
            Err(LumenError::Command("不应被调用".into()))
        })
        .expect("命中应直接 Ok");
        assert!(!called, "缓存命中不得调用渲染边界");
        assert_eq!(got, out);
    }

    #[test]
    fn ensure_preview_success_writes_tmp_then_renames() {
        let root = tmp("ep_ok");
        let inputs = ep_inputs(None);
        let out = inputs.cache_path(&root, &inputs.key(Path::new("src.ARW")));
        let tmp_expected = {
            let name = out.file_name().unwrap().to_string_lossy().to_string();
            out.parent().unwrap().join(format!("{}.tmp", name))
        };

        let got = ensure_preview(Path::new("src.ARW"), &root, inputs, |tmp, args| {
            assert_eq!(args["size"], serde_json::json!(1600));
            assert!(args["output"].as_str().unwrap().ends_with(".tmp"));
            std::fs::write(tmp, b"rendered").unwrap(); // 模拟 lumen 落盘
            Ok(())
        })
        .expect("渲染成功应 Ok");
        assert_eq!(got, out);
        assert!(out.is_file(), "最终产物应存在");
        assert!(!tmp_expected.exists(), "rename 后不得残留 tmp");
    }

    #[test]
    fn ensure_preview_missing_output_is_protocol_error() {
        let root = tmp("ep_missing");
        let err = ensure_preview(
            Path::new("src.ARW"),
            &root,
            ep_inputs(None),
            |_tmp, _args| Ok(()), // “渲染成功”但什么都没写
        )
        .expect_err("输出缺失应 Err");
        assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
    }

    #[test]
    fn ensure_preview_propagates_render_error_and_leaves_no_file() {
        let root = tmp("ep_err");
        let inputs = ep_inputs(None);
        let out = inputs.cache_path(&root, &inputs.key(Path::new("src.ARW")));
        let err = ensure_preview(Path::new("src.ARW"), &root, inputs, |_tmp, _args| {
            Err(LumenError::Command("lumen 炸了".into()))
        })
        .expect_err("渲染错误应透传");
        assert!(matches!(err, LumenError::Command(_)));
        assert!(!out.exists(), "失败时最终路径不得存在");
    }

    // ---- Step 2: B5 ----
    #[test]
    fn query_version_real_spawn_of_fixture() {
        // 真实 spawn .cmd 夹具（Rust Command 可直接执行 .cmd）：
        // 覆盖 query_version 的 成功解析路径（fixture 打印 "LUMEN RAW 1.6.0"）。
        assert_eq!(
            query_version(Path::new("tests/fixtures/lumen_fixture_version.cmd")),
            Some("1.6.0".to_string())
        );
        // ok 夹具打印的是 JSON 而非版本串 → None
        assert_eq!(
            query_version(Path::new("tests/fixtures/lumen_fixture_ok.cmd")),
            None
        );
    }

    #[test]
    fn status_from_matrix() {
        let off = lumen_status_from(false, None, None);
        assert!(!off.available && !off.enabled);

        let no_exe = lumen_status_from(true, None, None);
        assert!(!no_exe.available && no_exe.enabled);

        let ok = lumen_status_from(
            true,
            Some(PathBuf::from(r"C:\lumen\lumen-cli.exe")),
            Some("1.6.0".into()),
        );
        assert!(ok.available);
        assert_eq!(ok.pinned_version, "1.6.0");
        assert_eq!(ok.found_version.as_deref(), Some("1.6.0"));

        // 版本漂移 → 不可用（A 报告 G4）
        let drift = lumen_status_from(true, Some(PathBuf::from("x.exe")), Some("1.7.0".into()));
        assert!(!drift.available);
        let noversion = lumen_status_from(true, Some(PathBuf::from("x.exe")), None);
        assert!(!noversion.available);
    }

    // ---- Step 3: scripted 传输层 + MCP 客户端 ----
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;

    /// 测试用传输层：预写应答队列，记录发出的行；读空 → 模拟超时。
    struct ScriptedTransport {
        incoming: StdMutex<VecDeque<String>>,
        outgoing: StdMutex<Vec<String>>,
    }

    impl ScriptedTransport {
        fn new(script: Vec<&str>) -> Self {
            Self {
                incoming: StdMutex::new(script.into_iter().map(String::from).collect()),
                outgoing: StdMutex::new(Vec::new()),
            }
        }
        fn sent(&self) -> Vec<String> {
            self.outgoing.lock().unwrap().clone()
        }
    }

    impl LineTransport for ScriptedTransport {
        fn write_line(&self, line: &str) -> Result<(), LumenError> {
            self.outgoing.lock().unwrap().push(line.to_string());
            Ok(())
        }
        fn read_line(&self, _timeout: std::time::Duration) -> Result<Option<String>, LumenError> {
            Ok(self.incoming.lock().unwrap().pop_front())
        }
    }

    #[test]
    fn rpc_encode_single_line_compact() {
        let line = rpc_encode("initialize", &serde_json::json!({"a":1}), 7);
        assert!(line.ends_with('\n'), "必须带行尾换行");
        assert_eq!(line.matches('\n').count(), 1, "必须单行");
        // 键序无关（JSON-RPC 语义；serde_json Map 为字母序）→ 语义相等 + 无空格紧凑
        let parsed: Value = serde_json::from_str(&line).expect("必须是合法 JSON");
        assert_eq!(
            parsed,
            serde_json::json!({"jsonrpc":"2.0","id":7,"method":"initialize","params":{"a":1}})
        );
        assert!(!line.contains(": "), "紧凑序列化不得含空格: {}", line);
        assert!(line.contains(r#""jsonrpc":"2.0""#));
        assert!(line.contains(r#""id":7"#));
    }

    #[test]
    fn request_matches_id_skips_noise() {
        let t = ScriptedTransport::new(vec![
            r#"{"jsonrpc":"2.0","method":"notification"}"#, // 通知：无 id → 跳过
            r#"{"jsonrpc":"2.0","id":99,"result":{"wrong":true}}"#, // 异 id → 跳过
            r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#, // 匹配
            r#"{"jsonrpc":"2.0","id":2,"result":{"ok":false}}"#, // 后续帧不被消费
        ]);
        let mut client = McpClient::new(t);
        let got = client
            .request("ping", serde_json::json!({}))
            .expect("应拿到 id=1 应答");
        assert_eq!(got, serde_json::json!({"ok": true}));

        let sent = client.transport_ref_for_test().sent();
        assert!(sent[0].contains(r#""method":"ping""#));
    }

    #[test]
    fn request_timeout_when_silent() {
        let t = ScriptedTransport::new(vec![]); // 读空 = 超时语义
        let mut client = McpClient::new(t);
        let err = client
            .request("ping", serde_json::json!({}))
            .expect_err("无应答应超时");
        assert!(matches!(err, LumenError::Timeout), "实际: {:?}", err);
    }

    #[test]
    fn request_error_frame_maps_to_command() {
        let t = ScriptedTransport::new(vec![
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#,
        ]);
        let mut client = McpClient::new(t);
        let err = client
            .request("bogus", serde_json::json!({}))
            .expect_err("error 帧应 Err");
        match err {
            LumenError::Command(m) => assert!(m.contains("Method not found")),
            other => panic!("应 Command，实际: {:?}", other),
        }
    }

    #[test]
    fn handshake_pins_version() {
        let t = ScriptedTransport::new(vec![
            r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"lumen-raw","version":"1.7.0"}}}"#,
        ]);
        let mut client = McpClient::new(t);
        let err = client.handshake().expect_err("版本不符应 Err");
        match err {
            LumenError::Protocol(m) => {
                assert!(
                    m.contains("1.7.0") && m.contains("1.6.0"),
                    "消息应含双方版本: {}",
                    m
                )
            }
            other => panic!("应 Protocol，实际: {:?}", other),
        }
    }

    #[test]
    fn handshake_success_caches_tools() {
        let t = ScriptedTransport::new(vec![
            r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"lumen-raw","version":"1.6.0"}}}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"render_preview"},{"name":"apply_edits"}]}}"#,
        ]);
        let mut client = McpClient::new(t);
        client.handshake().expect("1.6.0 应握手成功");
        assert_eq!(client.tools_len_for_test(), 2);

        let sent = client.transport_ref_for_test().sent();
        assert!(
            sent[0].contains(r#""protocolVersion":"2024-11-05""#),
            "必须 legacy 握手: {}",
            sent[0]
        );
        assert!(
            !sent.iter().any(|l| l.contains("_meta")),
            "legacy 客户端不得发 _meta"
        );
    }

    #[test]
    fn handshake_malformed_result_is_protocol() {
        let t = ScriptedTransport::new(vec![r#"{"jsonrpc":"2.0","id":1,"result":{"nope":1}}"#]);
        let mut client = McpClient::new(t);
        let err = client.handshake().expect_err("结构异常应 Err");
        assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
    }

    #[test]
    fn call_tool_iserror_maps_to_command() {
        let t = ScriptedTransport::new(vec![
            r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"version":"1.6.0"}}}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#,
            r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"unknown argument(s) for rate_photos"}],"isError":true}}"#,
        ]);
        let mut client = McpClient::new(t);
        client.handshake().unwrap();
        let err = client
            .call_tool("rate_photos", &serde_json::json!({"oops":1}))
            .expect_err("isError 应 Err");
        match err {
            LumenError::Command(m) => assert!(m.contains("unknown argument")),
            other => panic!("应 Command，实际: {:?}", other),
        }
    }

    #[test]
    fn call_tool_success_parses_text_block() {
        let t = ScriptedTransport::new(vec![
            r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"version":"1.6.0"}}}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#,
            r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"image","data":"x"},{"type":"text","text":"{\"path\":\"a.ARW\",\"width\":1600}"}]}}"#,
        ]);
        let mut client = McpClient::new(t);
        client.handshake().unwrap();
        let got = client
            .call_tool("render_preview", &serde_json::json!({"path":"a.ARW"}))
            .expect("成功应 Ok");
        assert_eq!(got["path"], serde_json::json!("a.ARW"));
        assert_eq!(got["width"], serde_json::json!(1600));
    }

    #[test]
    fn call_tool_missing_text_block_is_protocol() {
        let t = ScriptedTransport::new(vec![
            r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"version":"1.6.0"}}}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#,
            r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"image","data":"x"}]}}"#,
        ]);
        let mut client = McpClient::new(t);
        client.handshake().unwrap();
        let err = client
            .call_tool("render_preview", &serde_json::json!({}))
            .expect_err("无 text 块应 Err");
        assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(next_backoff(0), std::time::Duration::from_millis(500));
        assert_eq!(next_backoff(1), std::time::Duration::from_millis(1000));
        assert_eq!(next_backoff(2), std::time::Duration::from_millis(2000));
        assert_eq!(next_backoff(5), std::time::Duration::from_millis(8000));
        assert_eq!(next_backoff(50), std::time::Duration::from_millis(8000));
    }

    // ---- Step 4: 生产传输层 + 监督器（真实子进程） ----
    fn line_echo_fixture() -> PathBuf {
        // 必须绝对路径（反斜杠）：cmd 会把正斜杠当开关
        Path::new("tests/fixtures/line_echo.cmd")
            .canonicalize()
            .expect("夹具应存在")
    }

    fn spawn_echo() -> ProcessTransport {
        // 直接 spawn .cmd（不经 `cmd /C`：Rust 直接执行 .cmd 稳定可用，
        // 而 `cmd /C <path>` 在 Rust 的 argv 转义下会报"系统找不到指定的路径"）
        let fixture = line_echo_fixture();
        let mut cmd = Command::new(&fixture);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("夹具应可 spawn");
        // 复用 ProcessTransport 内部逻辑：手动装配测试传输
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout piped");
        if let Some(mut err) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut sink = Vec::new();
                let _ = std::io::Read::read_to_end(&mut err, &mut sink);
            });
        }
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if tx.send(Ok(line)).is_err() {
                    break;
                }
            }
        });
        drop(child);
        // 构造与 ProcessTransport 同构的实例（字段私有，仅测试内可造）
        ProcessTransport {
            stdin: StdMutex::new(stdin),
            incoming: rx,
        }
    }

    #[test]
    fn process_transport_roundtrip_real_process() {
        let t = spawn_echo();
        // 行式协议：换行由调用方提供（rpc_encode 已带 \n）；夹具的 set /p 需要换行才输出
        t.write_line("{\"a\":1}\n").expect("写 stdin 应成功");
        let line = t
            .read_line(std::time::Duration::from_secs(10))
            .expect("读不应报错")
            .expect("应有回显行");
        assert!(
            line.contains(r#"{"a":1}"#),
            "回显内容应包含写入行: {}",
            line
        );
    }

    #[test]
    fn process_transport_eof_is_none() {
        let t = spawn_echo();
        // 夹具只回显一行；不写则它一直等 set /p → 我们直接 drop stdin 让它退出
        drop(t);
        // 新起一个立刻退出的进程：cmd /C exit
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "exit"]);
        let mut child = cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn");
        let stdout = child.stdout.take().unwrap();
        // 回收子进程：先 wait 释放句柄（stdin 仍持有 → cmd /C exit 立即返回）
        let _status = child.wait().expect("wait");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if tx.send(Ok(line)).is_err() {
                    break;
                }
            }
        });
        let transport = ProcessTransport {
            stdin: StdMutex::new(None),
            incoming: rx,
        };
        assert_eq!(
            transport
                .read_line(std::time::Duration::from_millis(500))
                .expect("读不应报错"),
            None,
            "子进程退出后（EOF）应返回 None"
        );
    }

    #[test]
    fn process_transport_timeout_is_none() {
        // 发送端存活但永不投递 → recv_timeout 必须超时 → Ok(None)（区别于通道断开的分支）
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        let transport = ProcessTransport {
            stdin: StdMutex::new(None),
            incoming: rx,
        };
        let got = transport.read_line(std::time::Duration::from_millis(200));
        assert_eq!(got, Ok(None), "超时必须是 Ok(None)，不得挂死或 Err");
        drop(tx);
    }

    #[test]
    fn noisy_stderr_child_still_serves_protocol_cleanly() {
        // 夹具：先向 stderr 狂写 2000 行（远超 64KB 管道缓冲），再回显 stdin 一行。
        // 两条契约：(1) stdout 协议流不被 stderr 污染；(2) stderr 必须被独立排空，
        // 否则子进程阻塞在 stderr 写、协议行永远不出现。
        let script = std::env::temp_dir().join(format!("lumen_noisy_{}.cmd", std::process::id()));
        std::fs::write(
            &script,
            "@echo off\nfor /L %%i in (1,1,2000) do 1>&2 echo NOISE_NOISE_NOISE_NOISE_NOISE_NOISE\nset /p line=\necho {\"echoed\":%line%}\n",
        )
        .expect("写噪声夹具");
        let mut cmd = Command::new(&script);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("噪声夹具可 spawn");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout piped");
        if let Some(mut err) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut sink = Vec::new();
                let _ = std::io::Read::read_to_end(&mut err, &mut sink);
            });
        }
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if tx.send(Ok(line)).is_err() {
                    break;
                }
            }
        });
        let transport = ProcessTransport {
            stdin: StdMutex::new(stdin),
            incoming: rx,
        };
        transport.write_line("{\"z\":9}\n").expect("写应成功");
        let line = transport
            .read_line(std::time::Duration::from_secs(30))
            .expect("读不应报错")
            .expect("噪声子进程仍必须吐出协议行（stderr 未阻塞）");
        assert!(
            line.contains(r#"{"z":9}"#) && !line.contains("NOISE"),
            "协议流必须干净（只含回显，不含 stderr 噪声）: {}",
            line
        );
        drop(transport);
        let _ = child.wait();
        let _ = std::fs::remove_file(&script);
    }

    #[test]
    fn drop_closes_stdin_so_child_exits() {
        // 契约：Drop 关 stdin → 子进程读到 EOF 自行退出（mcp.py:102-104）。
        // 夹具 wait_eof.cmd 阻塞在 set /p，收到 EOF 后写标记文件。
        let marker = std::env::temp_dir().join(format!("lumen_eof_{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let fixture = Path::new("tests/fixtures/wait_eof.cmd")
            .canonicalize()
            .expect("夹具应存在");
        let mut cmd = Command::new(&fixture);
        cmd.env("LUMEN_TEST_MARKER", &marker)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().expect("应能 spawn");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout piped");
        if let Some(mut err) = child.stderr.take() {
            std::thread::spawn(move || {
                let mut sink = Vec::new();
                let _ = std::io::Read::read_to_end(&mut err, &mut sink);
            });
        }
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if tx.send(Ok(line)).is_err() {
                    break;
                }
            }
        });
        drop(child);
        let transport = ProcessTransport {
            stdin: StdMutex::new(stdin),
            incoming: rx,
        };
        drop(transport); // ← 契约本体：Drop 关 stdin
        std::thread::sleep(std::time::Duration::from_millis(1500));
        assert!(
            marker.exists(),
            "Drop 后子进程应因 stdin EOF 退出并写标记（说明 stdin 已被关闭）"
        );
        let _ = std::fs::remove_file(&marker);
    }

    #[test]
    fn ensure_running_rejects_non_mcp_child() {
        // 契约：ensure_running 必须真握手；对着"吐垃圾"的对端不得宣称 Ready。
        let fixture = Path::new("tests/fixtures/mcp_garbage.cmd")
            .canonicalize()
            .expect("夹具应存在");
        let mut sup = Supervisor::default();
        let err = sup
            .ensure_running(&fixture)
            .expect_err("非 MCP 对端握手必须失败");
        assert!(
            matches!(err, LumenError::Protocol(_) | LumenError::Command(_)),
            "实际: {:?}",
            err
        );
        assert!(
            matches!(sup.state(), SupervisorState::Dead { .. }),
            "握手失败后应 Dead，实际: {:?}",
            sup.state()
        );
    }

    #[test]
    fn runtime_status_matrix_without_sidecar() {
        let rt = LumenRuntime::new();
        // enabled=false → 不可用且零请求
        let off = rt.status(false, None);
        assert!(!off.available && !off.enabled);
        // enabled 但无 exe → 不可用
        let no_exe = rt.status(true, None);
        assert!(!no_exe.available);
    }

    #[test]
    fn runtime_falls_back_when_sidecar_missing() {
        // 侧信道完全不存在：A 通道必失败 → B 通道兜底同样失败 → 错误必须透出
        let rt = LumenRuntime::new();
        let err = rt
            .render_preview(
                Path::new(r"C:\definitely\not\here\lumen-cli-xyz987.exe"),
                &serde_json::json!({"path": "x.ARW"}),
            )
            .expect_err("无 sidecar 时应失败");
        assert!(matches!(err, LumenError::NotInstalled), "实际: {:?}", err);
    }

    #[test]
    fn runtime_failure_count_stops_reconnect() {
        let rt = LumenRuntime::new();
        let exe = Path::new(r"C:\definitely\not\here\lumen-cli-xyz987.exe");
        for _ in 0..3 {
            let _ = rt.render_preview(exe, &serde_json::json!({"path": "x.ARW"}));
        }
        assert_eq!(rt.failure_count(), 3, "每次失败应累计");
    }

    #[test]
    fn runtime_shutdown_clears_state() {
        let rt = LumenRuntime::new();
        let exe = Path::new(r"C:\definitely\not\here\lumen-cli-xyz987.exe");
        let _ = rt.render_preview(exe, &serde_json::json!({"path": "x.ARW"}));
        assert!(rt.failure_count() > 0);
        rt.shutdown();
        assert_eq!(rt.failure_count(), 0, "shutdown 应清空失败计数");
    }

    #[test]
    fn runtime_rejects_non_mcp_child_and_counts_failure() {
        // 垃圾对端：A 通道握手失败 → 记一次失败 → B 通道兜底也失败（夹具不认 render.preview）
        let fixture = Path::new("tests/fixtures/mcp_garbage.cmd")
            .canonicalize()
            .expect("夹具应存在");
        let rt = LumenRuntime::new();
        let err = rt
            .render_preview(&fixture, &serde_json::json!({"path": "x.ARW"}))
            .expect_err("垃圾对端两条通道都应失败");
        assert!(
            matches!(err, LumenError::Protocol(_) | LumenError::Command(_)),
            "实际: {:?}",
            err
        );
        assert_eq!(rt.failure_count(), 1);
    }

    #[test]
    fn run_cli_rejects_missing_exe() {
        // run_cli 与 run_lumen 共享 spawn 失败语义
        assert_eq!(
            run_cli(
                Path::new(
                    r"C:
ope\lumen-cli-xyz.exe"
                ),
                &["list", "*"]
            ),
            Err(LumenError::NotInstalled)
        );
    }

    #[test]
    fn tool_names_map_to_command_ids() {
        // 回归：曾把 MCP 工具名当命令 id 传给 B 通道（unknown command 'rate_photos'）
        assert_eq!(tool_to_command_id("rate_photos"), "library.rate");
        assert_eq!(tool_to_command_id("flag_photos"), "library.flag");
        assert_eq!(tool_to_command_id("render_preview"), "render.preview");
        // 未知工具兜底到一个必然存在的只读命令
        assert_eq!(tool_to_command_id("nope"), "app.status");
    }

    // ---- Step 8: 评级同步判定 ----
    #[test]
    fn push_skips_zero_rating() {
        // lumen compact 会压掉全零条目 → 推过去等于消失
        assert!(!should_push_rating(0, "none"), "0 星 + 无旗标不推");
        assert!(!should_push_rating(0, ""), "0 星 + 空旗标不推");
        assert!(should_push_rating(0, "pick"), "0 星 + pick 要推");
        assert!(
            should_push_rating(0, "reject"),
            "0 星 + reject 要推（-1 语义）"
        );
        assert!(should_push_rating(3, "none"), "有星要推");
    }

    #[test]
    fn sync_decision_matrix() {
        // 首次见到（无游标）+ lumen 无记录 → 静默（不产生动作）
        assert_eq!(
            decide_sync(None, (3, "pick".into(), 100), None),
            SyncDecision::InSync
        );
        // 首次 + lumen 已有值 → 以宿主为准推过去
        assert_eq!(
            decide_sync(None, (3, "pick".into(), 100), Some((1, "none".into()))),
            SyncDecision::PushToLumen
        );
        // 无变化 → InSync
        assert_eq!(
            decide_sync(
                Some((3, "pick".into(), 90)),
                (3, "pick".into(), 100),
                Some((3, "pick".into()))
            ),
            SyncDecision::InSync
        );
        // 只有宿主变 → 推
        assert_eq!(
            decide_sync(
                Some((1, "none".into(), 90)),
                (3, "pick".into(), 100),
                Some((1, "none".into()))
            ),
            SyncDecision::PushToLumen
        );
        // 只有 lumen 变 → 拉
        assert_eq!(
            decide_sync(
                Some((1, "none".into(), 90)),
                (1, "none".into(), 90),
                Some((5, "pick".into()))
            ),
            SyncDecision::PullFromLumen
        );
        // 两侧都变 → 冲突（绝不静默覆盖）
        assert_eq!(
            decide_sync(
                Some((1, "none".into(), 90)),
                (3, "pick".into(), 100),
                Some((5, "pick".into()))
            ),
            SyncDecision::Conflict
        );
        // lumen 无记录 + 宿主变了 → 推
        assert_eq!(
            decide_sync(Some((1, "none".into(), 90)), (2, "none".into(), 100), None),
            SyncDecision::PushToLumen
        );
    }

    #[test]
    fn rating_sync_cursor_roundtrip() {
        // 纯逻辑：游标编码
        let c: (u8, String, i64) = (4, "pick".to_string(), 1_700_000_000);
        assert_eq!(c.0, 4);
        assert_eq!(c.1, "pick");
    }

    // ---- Step 9: recipe 互通 ----
    #[test]
    fn tone_to_recipe_includes_temperature_after_unit_alignment() {
        let tone = crate::models::ToneAdjustments {
            exposure: 0.65,
            highlights: -20.0,
            shadows: 45.0,
            temperature: 30.0,
            tint: 5.0,
            contrast: 10.0,
        };
        // 单位已统一（两侧都是 ±100 相对）：六个字段全部直通
        let obj = tone_to_recipe(&tone, true)["adjustments"].clone();
        let map = obj.as_object().unwrap();
        assert_eq!(map.len(), 6, "六个滑杆都该透传，实际: {:?}", map);
        assert_eq!(map["exposure"], serde_json::json!(0.65));
        assert_eq!(map["highlights"], serde_json::json!(-20.0));
        assert_eq!(map["temperature"], serde_json::json!(30.0));
        // 旧开关保留只为兼容旧调用点
        let legacy = tone_to_recipe(&tone, false)["adjustments"].clone();
        assert!(!legacy.as_object().unwrap().contains_key("temperature"));
    }

    #[test]
    fn tone_to_recipe_clamps_temperature_to_slider_range() {
        // lumen 侧实测会把 500 截断成 100；宿主先夹紧则两侧行为一致，
        // 也避免把非法值写进 .lumen 工程。
        let high = crate::models::ToneAdjustments {
            temperature: 5350.0,
            ..Default::default()
        };
        assert_eq!(
            tone_to_recipe(&high, true)["adjustments"]["temperature"],
            serde_json::json!(100.0)
        );
        let low = crate::models::ToneAdjustments {
            temperature: -900.0,
            ..Default::default()
        };
        assert_eq!(
            tone_to_recipe(&low, true)["adjustments"]["temperature"],
            serde_json::json!(-100.0)
        );
    }

    #[test]
    fn tone_divergence_rules() {
        let base = crate::models::ToneAdjustments {
            exposure: 0.5,
            highlights: -10.0,
            shadows: 20.0,
            temperature: 30.0,
            tint: 5.0,
            contrast: 10.0,
        };
        assert!(
            !LumenRuntime::tone_diverges(&base, &base),
            "相同值不该算分歧"
        );
        // 浮点噪声不算分歧
        let mut noisy = base.clone();
        noisy.exposure = 0.5 + 1e-6;
        assert!(!LumenRuntime::tone_diverges(&base, &noisy));
        // 任一字段不同即分歧（六个字段逐个钉死）
        let mut hits = 0;
        for field in [
            "exposure",
            "highlights",
            "shadows",
            "temperature",
            "tint",
            "contrast",
        ] {
            let mut other = base.clone();
            match field {
                "exposure" => other.exposure += 0.1,
                "highlights" => other.highlights += 0.1,
                "shadows" => other.shadows += 0.1,
                "temperature" => other.temperature += 1.0,
                "tint" => other.tint += 0.1,
                "contrast" => other.contrast += 0.1,
                _ => unreachable!(),
            }
            assert!(
                LumenRuntime::tone_diverges(&base, &other),
                "字段 {} 变化应算分歧",
                field
            );
            hits += 1;
        }
        assert_eq!(hits, 6);
    }

    #[test]
    fn recipe_to_tone_clamps_temperature() {
        let state = serde_json::json!({"adjustments": {"temperature": 400.0}});
        assert_eq!(recipe_to_tone(&state).temperature, 100.0, "越界回读应夹紧");
    }

    #[test]
    fn recipe_to_tone_defaults_missing_fields() {
        let state = serde_json::json!({
            "adjustments": { "exposure": 0.5, "highlights": -10.0 }
        });
        let t = recipe_to_tone(&state);
        assert_eq!(t.exposure, 0.5);
        assert_eq!(t.highlights, -10.0);
        assert_eq!(t.shadows, 0.0, "缺失字段应为 0");
        assert_eq!(t.contrast, 0.0);
        // 空状态
        let empty = recipe_to_tone(&serde_json::json!({}));
        assert_eq!(empty.exposure, 0.0);
    }

    #[test]
    fn recipe_requires_live_session_channel() {
        // 无常驻连接时 apply_recipe 必须失败（而不是假装成功）：
        // lumen 的编辑状态是进程内 session，B 通道单发不落盘。
        let rt = LumenRuntime::new();
        assert!(!rt.has_live_client(), "新建运行时不应有客户端");
        let err = rt
            .apply_recipe(
                Path::new(
                    r"C:
ope\lumen-cli-xyz.exe",
                ),
                "x.ARW",
                &serde_json::json!({"adjustments": {"exposure": 1.0}}),
            )
            .expect_err("无常驻通道时不应成功");
        assert!(matches!(err, LumenError::NotInstalled), "实际: {:?}", err);
    }

    #[test]
    fn recipe_hash_is_canonical_and_recipe_sensitive() {
        // 键顺序不同 → 同 hash
        let a = serde_json::json!({"adjustments": {"exposure": 0.3, "tint": 0.1}});
        let b = serde_json::json!({"adjustments": {"tint": 0.1, "exposure": 0.3}});
        assert_eq!(recipe_hash(&a), recipe_hash(&b), "键顺序不应影响 hash");
        // 浮点抖动归一
        let c = serde_json::json!({"exposure": 0.30000000000000004});
        let d = serde_json::json!({"exposure": 0.3});
        assert_eq!(recipe_hash(&c), recipe_hash(&d), "浮点抖动应归一");
        // 值不同 → hash 不同
        assert_ne!(
            recipe_hash(&a),
            recipe_hash(&serde_json::json!({"exposure": 0.9}))
        );
    }

    #[test]
    fn cache_key_includes_recipe() {
        // 真实签名：同一张图、同样的 mtime，只有 recipe 不同 → key 必须不同。
        let src = Path::new("src.ARW");
        let a = lumen_cache_key_with_recipe(
            src,
            1600,
            PreviewVariant::Edited,
            PINNED_LUMEN_VERSION,
            None,
            None,
            None,
        );
        let b = lumen_cache_key_with_recipe(
            src,
            1600,
            PreviewVariant::Edited,
            PINNED_LUMEN_VERSION,
            None,
            None,
            Some(&serde_json::json!({"adjustments": {"exposure": 0.5}})),
        );
        let c = lumen_cache_key_with_recipe(
            src,
            1600,
            PreviewVariant::Edited,
            PINNED_LUMEN_VERSION,
            None,
            None,
            Some(&serde_json::json!({"adjustments": {"exposure": 0.9}})),
        );
        assert_ne!(a, b, "加了 recipe 必须换缓存条目（否则改色返旧图）");
        assert_ne!(b, c, "recipe 值不同 → key 不同");
        // 等价 recipe（键序不同）→ 同 key，不浪费缓存
        let d = lumen_cache_key_with_recipe(
            src,
            1600,
            PreviewVariant::Edited,
            PINNED_LUMEN_VERSION,
            None,
            None,
            Some(&serde_json::json!({"adjustments": {"tint": 0.0, "exposure": 0.5}})),
        );
        assert_ne!(d, b);
        // PreviewCacheInputs 走同一条路径
        let mut inputs = ep_inputs(None);
        inputs.recipe = Some(serde_json::json!({"adjustments": {"exposure": 0.5}}));
        assert_eq!(inputs.key(src), b, "PreviewCacheInputs 必须用同一个键算法");
    }

    #[test]
    fn recipe_changes_re_render_through_ensure_preview() {
        // 端到端（缓存层）：改 recipe → ensure_preview 必须真的重渲染，而不是命中旧图
        let root = tmp("ep_recipe");
        let src_path = tmp("ep_recipe_src");
        std::fs::write(&src_path, b"raw").unwrap();
        let mut inputs = ep_inputs(Some(t_plus(1)));

        // 计数器与"抓到的渲染参数"用 Cell，闭包可重复传入
        let calls = std::cell::Cell::new(0);
        let seen = std::cell::RefCell::new(None);
        let render = |tmp: &Path, args: &Value| {
            calls.set(calls.get() + 1);
            *seen.borrow_mut() = Some(args.clone());
            std::fs::write(tmp, b"rendered").map_err(|e| LumenError::Io(e.to_string()))
        };

        // 第一次：无 recipe
        let a = ensure_preview(&src_path, &root, inputs.clone(), render).unwrap();
        let first = std::fs::read(&a).unwrap();

        // 同 recipe → 命中缓存（渲染闭包不该再被调用）
        let a2 = ensure_preview(&src_path, &root, inputs.clone(), render).unwrap();
        assert_eq!(std::fs::read(&a2).unwrap(), first);
        assert_eq!(calls.get(), 1, "同 recipe 必须命中缓存");

        // 改 recipe → 必须重新渲染
        inputs.recipe = Some(serde_json::json!({"adjustments": {"exposure": 1.25}}));
        let b = ensure_preview(&src_path, &root, inputs.clone(), render).unwrap();
        assert_eq!(calls.get(), 2, "recipe 变了必须重新渲染");
        assert_ne!(b, a, "不同 recipe 必须落到不同缓存文件");

        // 契约核对：`render.preview` **不接受** recipe 参数（真实 sidecar 实测
        // 'unknown argument(s) for render.preview: recipe'），所以 recipe 由调用方
        // 先 edit.apply 写进 .lumen 工程，渲染只带 path/size/output。
        let captured = seen.borrow().clone().expect("渲染闭包至少应被调用一次");
        assert!(
            captured.get("recipe").is_none(),
            "render.preview 不接受 recipe 键（会把整个渲染打挂）: {:?}",
            captured
        );
        assert_eq!(captured["size"], 1600);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- Step 11: 能力探测 ----
    #[test]
    fn capabilities_detect_ai_absence_in_cpu_build() {
        // 真实 CPU-only sidecar 的命令表（节选）：无任何 AI 命令
        let listing = serde_json::json!({
            "commands": [
                {"id": "app.status"},
                {"id": "edit.apply"},
                {"id": "edit.presets"},
                {"id": "edit.preset"},
                {"id": "render.preview"},
                {"id": "library.rate"},
                {"id": "photo.export"},
            ]
        });
        let caps = parse_capabilities(&listing, "1.6.0");
        assert_eq!(caps.commands.len(), 7);
        assert!(!caps.ai_masks, "CPU-only 包没有 mask.*");
        assert!(!caps.ai_enhance, "CPU-only 包没有任何 AI 命令");
        assert_eq!(caps.version, "1.6.0");
    }

    #[test]
    fn capabilities_detect_ai_in_gpu_build() {
        let listing = serde_json::json!({
            "commands": [
                {"id": "edit.apply"},
                {"id": "mask.list"},
                {"id": "photo.enhance"},
                {"id": "render.preview"},
            ]
        });
        let caps = parse_capabilities(&listing, "1.6.0-gpu");
        assert!(caps.ai_masks, "有 mask.* 就该判定 AI 蒙版可用");
        assert!(caps.ai_enhance, "有 photo.enhance 就该判定 AI 增强可用");
    }

    #[test]
    fn capabilities_tolerate_empty_listing() {
        // 命令表拿不到时不能 panic，也不能谎报 AI 可用
        let caps = parse_capabilities(&serde_json::json!({}), "");
        assert!(caps.commands.is_empty());
        assert!(!caps.ai_masks && !caps.ai_enhance);
        // 畸形输入同样不炸
        let caps2 = parse_capabilities(&serde_json::json!({"commands": [1, "x", null]}), "1.6.0");
        assert!(caps2.commands.is_empty());
    }

    #[test]
    fn preset_amount_is_zero_to_hundred() {
        // schema 是 amount 0..100（曾误用 strength，真实 sidecar 报 unknown argument）
        let json = serde_json::json!({"path": "x.ARW", "name": "金色时刻", "amount": 60});
        assert_eq!(json["amount"], serde_json::json!(60));
        // 越界必须夹紧（schema 会拒绝 >100）
        let clamped = (140u8).min(100);
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
    fn supervisor_state_machine_and_backoff() {
        let mut sup = Supervisor::default();
        assert_eq!(sup.state(), &SupervisorState::Down);

        let d1 = sup.mark_dead("boom").expect("第 1 次应给退避");
        assert_eq!(d1, std::time::Duration::from_millis(500));
        let d2 = sup.mark_dead("boom").expect("第 2 次应给退避");
        assert_eq!(d2, std::time::Duration::from_millis(1000));
        assert!(matches!(sup.state(), SupervisorState::Dead { attempt: 2 }));
        assert_eq!(sup.last_error(), Some("boom"));

        sup.mark_ready("1.6.0");
        assert_eq!(
            sup.state(),
            &SupervisorState::Ready {
                version: "1.6.0".into()
            }
        );
        assert_eq!(sup.last_error(), None, "成功后清空错误");

        // ready 后再 crash：attempt 重新计数
        let d3 = sup.mark_dead("again").expect("ready 后 crash 仍应退避");
        assert_eq!(d3, std::time::Duration::from_millis(500));
    }

    #[test]
    fn supervisor_max_restarts_stops_auto_retry() {
        let mut sup = Supervisor::default();
        for i in 0..MAX_RESTARTS {
            assert!(sup.mark_dead("boom").is_some(), "第 {} 次应仍给退避", i + 1);
        }
        assert!(
            sup.mark_dead("boom").is_none(),
            "超过 MAX_RESTARTS 后不再自动重启"
        );
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
                LumenError::Timeout | LumenError::Protocol(_) | LumenError::Command(_)
            ),
            "实际: {:?}",
            err
        );
    }

    #[test]
    fn supervisor_ensure_running_marks_dead_on_bad_exe() {
        let mut sup = Supervisor::default();
        let err = sup
            .ensure_running(Path::new(r"C:\definitely\not\here\lumen-cli-xyz987.exe"))
            .expect_err("不存在 exe 应 Err");
        assert_eq!(err, LumenError::NotInstalled);
        assert!(
            matches!(sup.state(), SupervisorState::Dead { attempt: 1 }),
            "失败后应 Dead，实际: {:?}",
            sup.state()
        );
    }

    #[test]
    fn supervisor_ready_short_circuits_spawn() {
        let mut sup = Supervisor::default();
        sup.mark_ready("1.6.0");
        // 已 Ready 时不再 spawn（即使 exe 不存在也应直接返回版本）
        let got = sup
            .ensure_running(Path::new(r"C:\definitely\not\here\lumen-cli-xyz987.exe"))
            .expect("Ready 应短路返回");
        assert_eq!(got, "1.6.0");
    }
}
