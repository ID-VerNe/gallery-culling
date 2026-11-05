//! LUMEN 引擎（lumen-cli）的下载、校验与缓存（issue #75）。
//!
//! ## 为什么要在这里下载
//!
//! 引擎是 181.6 MB 的 PyInstaller onedir 产物，塞进主安装包会让每个用户都多背这份
//! 体积，而它与主应用版本无关。现在改为：产物只作为**独立 Release 资产**存在，
//! 应用首次需要 LUMEN 时按入库的 `src-tauri/sidecar.lock.json` 拉取并逐项校验。
//!
//! ## 缓存契约
//!
//! - 目录：`%LOCALAPPDATA%\gallery-culling\sidecar\lumen-cli-<version>\`
//!   （可用 `GALLERY_ENGINE_CACHE_DIR` 覆盖根目录，企业镜像与 e2e 都走这个口子）；
//! - 校验通过后写 `verified.json`，内容与锁文件的 `directory` 基线一致；
//! - 启动时只比对 `verified.json` 与锁文件：一致即直接用，**不重复下载、不重复哈希**；
//! - 版本号变化（换引擎）才失效——不做自动升级。
//!
//! ## 失败语义
//!
//! 任何一步失败都必须**删掉临时产物**，缓存目录里只可能出现「完整且已校验」的目录。
//! 错误文案面向最终用户：说清发生了什么，以及下一步怎么办。
//!
//! 口径与 `scripts/sidecar-lock.mjs` 的 `collectDirectory` 必须逐字一致：
//! 每个文件一行 `<小写相对路径>\t<字节>\t<sha256>`，按路径排序、`\n` 连接、末尾补 `\n`。
//! 改口径等于让所有人的缓存一起失效，别随手改。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::PINNED_LUMEN_VERSION;

/// 入库的锁文件，编译期嵌入：运行时不依赖仓库路径，也不会「读不到锁就随便下」。
pub const ENGINE_LOCK_JSON: &str = include_str!("../../sidecar.lock.json");

/// 引擎状态变化事件名。前端 `useLumenEngine` 里的同名常量必须与此一致。
pub const ENGINE_STATUS_EVENT: &str = "lumen-engine-status";

/// 缓存根目录的环境变量覆盖（企业镜像 / e2e 测试口子）。
pub const CACHE_ROOT_ENV: &str = "GALLERY_ENGINE_CACHE_DIR";

/// 下载地址的环境变量覆盖（企业镜像 / e2e 测试口子）。
pub const ENGINE_URL_ENV: &str = "GALLERY_ENGINE_URL";

/// 引擎下载与校验的进度阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnginePhase {
    /// 尚未检查（缓存未知）
    Missing,
    /// 正在下载 zip
    Downloading,
    /// 正在解压 / 校验目录
    Verifying,
    /// 已校验，可直接使用
    Ready,
    /// 失败，等待用户重试
    Failed,
}

/// 前端可见的引擎状态。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub phase: EnginePhase,
    pub version: String,
    /// 面向用户的中文说明（失败时含下一步）
    pub detail: String,
    pub downloaded_bytes: u64,
    /// zip 总字节数；未知时为 0
    pub total_bytes: u64,
}

impl Default for EngineStatus {
    fn default() -> Self {
        Self {
            phase: EnginePhase::Missing,
            version: PINNED_LUMEN_VERSION.to_string(),
            detail: "LUMEN RAW 引擎尚未准备".to_string(),
            downloaded_bytes: 0,
            total_bytes: 0,
        }
    }
}

/// 锁文件里 `source` 的下载描述。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineSource {
    pub url: Option<String>,
    pub zip_sha256: Option<String>,
    pub zip_bytes: Option<u64>,
}

/// 引擎的预期基线（来自入库锁文件）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineSpec {
    pub version: String,
    pub source: EngineSource,
    pub exe_sha256: String,
    pub exe_bytes: u64,
    pub file_count: u64,
    pub total_bytes: u64,
    pub content_sha256: String,
}

#[derive(Debug, Deserialize)]
struct LockFile {
    version: String,
    source: LockSource,
    exe: LockExe,
    directory: LockDirectory,
}

#[derive(Debug, Deserialize)]
struct LockSource {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default, rename = "zipSha256")]
    zip_sha256: Option<String>,
    #[serde(default, rename = "zipBytes")]
    zip_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct LockExe {
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Deserialize)]
struct LockDirectory {
    #[serde(rename = "fileCount")]
    file_count: u64,
    #[serde(rename = "totalBytes")]
    total_bytes: u64,
    #[serde(rename = "contentSha256")]
    content_sha256: String,
}

/// 解析锁文件文本；结构不合法返回中文原因。
pub fn parse_engine_spec(json: &str) -> Result<EngineSpec, String> {
    let lock: LockFile =
        serde_json::from_str(json).map_err(|e| format!("sidecar.lock.json 无法解析：{}", e))?;
    if lock.source.kind != "url" && lock.source.kind != "local-path" {
        return Err(format!(
            "sidecar.lock.json 的 source.type 只能是 url 或 local-path（实际 {}）",
            lock.source.kind
        ));
    }
    Ok(EngineSpec {
        version: lock.version,
        source: EngineSource {
            url: lock.source.url,
            zip_sha256: lock.source.zip_sha256,
            zip_bytes: lock.source.zip_bytes,
        },
        exe_sha256: lock.exe.sha256,
        exe_bytes: lock.exe.bytes,
        file_count: lock.directory.file_count,
        total_bytes: lock.directory.total_bytes,
        content_sha256: lock.directory.content_sha256,
    })
}

/// 编译期锁文件解析后的基线（进程内只解析一次）。
pub fn pinned_engine_spec() -> &'static EngineSpec {
    static SPEC: OnceLock<EngineSpec> = OnceLock::new();
    SPEC.get_or_init(|| parse_engine_spec(ENGINE_LOCK_JSON).expect("sidecar.lock.json 结构异常"))
}

/// 缓存根目录。`GALLERY_ENGINE_CACHE_DIR` 优先，其次 `LOCALAPPDATA`。
pub fn cache_root() -> PathBuf {
    if let Some(dir) = std::env::var_os(CACHE_ROOT_ENV) {
        let dir = PathBuf::from(dir);
        if !dir.as_os_str().is_empty() {
            return dir;
        }
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir());
    base.join("gallery-culling").join("sidecar")
}

/// 某个版本的最终缓存目录。
pub fn engine_dir(cache_root: &Path, version: &str) -> PathBuf {
    cache_root.join(format!("lumen-cli-{}", version))
}

/// 校验标记文件名。
pub const VERIFIED_MARK: &str = "verified.json";

/// `verified.json` 的内容：只记录「这份缓存是什么」。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedMark {
    pub version: String,
    pub file_count: u64,
    pub total_bytes: u64,
    pub content_sha256: String,
    pub verified_at: String,
}

impl VerifiedMark {
    fn matches(&self, spec: &EngineSpec) -> bool {
        self.version == spec.version
            && self.file_count == spec.file_count
            && self.total_bytes == spec.total_bytes
            && self.content_sha256 == spec.content_sha256
    }
}

/// 目录统计结果（口径见文件头）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirStat {
    pub file_count: u64,
    pub total_bytes: u64,
    pub content_sha256: String,
}

/// 文件 sha256（流式读取，避免把大文件整个读进内存）。
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("打开 {} 失败：{}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取 {} 失败：{}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 递归统计目录。口径必须与 `scripts/sidecar-lock.mjs` 的 `collectDirectory` 一致。
pub fn collect_directory(dir: &Path) -> Result<DirStat, String> {
    let mut lines = Vec::new();
    let mut total_bytes = 0u64;
    walk(dir, dir, &mut lines, &mut total_bytes)?;
    lines.sort();
    let content = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    let content_sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
    Ok(DirStat {
        file_count: lines.len() as u64,
        total_bytes,
        content_sha256,
    })
}

fn walk(
    root: &Path,
    current: &Path,
    lines: &mut Vec<String>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let entries =
        fs::read_dir(current).map_err(|e| format!("读取目录 {} 失败：{}", current.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录 {} 项失败：{}", current.display(), e))?;
        let path = entry.path();
        let meta = entry
            .metadata()
            .map_err(|e| format!("读取 {} 元数据失败：{}", path.display(), e))?;
        if meta.is_dir() {
            walk(root, &path, lines, total_bytes)?;
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| format!("{} 不在 {} 内", path.display(), root.display()))?;
        let rel = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect::<Vec<_>>()
            .join("/");
        let size = meta.len();
        let sha = sha256_file(&path)?;
        lines.push(format!("{}\t{}\t{}", rel, size, sha));
        *total_bytes += size;
    }
    Ok(())
}

/// 目录与基线逐项比对；返回「期望 vs 实际」的问题列表（空数组 = 一致）。
pub fn compare_directory(spec: &EngineSpec, dir: &Path) -> Result<Vec<String>, String> {
    let stat = collect_directory(dir)?;
    let mut problems = Vec::new();
    if stat.file_count != spec.file_count {
        problems.push(format!(
            "文件数不一致：锁文件 {}，实际 {}",
            spec.file_count, stat.file_count
        ));
    }
    if stat.total_bytes != spec.total_bytes {
        problems.push(format!(
            "总字节数不一致：锁文件 {}，实际 {}",
            spec.total_bytes, stat.total_bytes
        ));
    }
    if stat.content_sha256 != spec.content_sha256 {
        problems.push("contentSha256 不一致（目录内容被换过）".to_string());
    }
    let exe = dir.join("lumen-cli.exe");
    if !exe.is_file() {
        problems.push("缺少 lumen-cli.exe".to_string());
    } else {
        let bytes = fs::metadata(&exe)
            .map_err(|e| format!("读取 {} 元数据失败：{}", exe.display(), e))?
            .len();
        if bytes != spec.exe_bytes {
            problems.push(format!(
                "exe 字节数不一致：锁文件 {}，实际 {}",
                spec.exe_bytes, bytes
            ));
        }
        let sha = sha256_file(&exe)?;
        if sha != spec.exe_sha256 {
            problems.push("exe sha256 不一致".to_string());
        }
    }
    if !dir.join("_internal").is_dir() {
        problems.push("缺少 _internal/（PyInstaller onedir 只搬 exe 会一启动就崩）".to_string());
    }
    Ok(problems)
}

/// 缓存是否已可用：`verified.json` 与锁文件基线一致，且目录里确有 exe 与 `_internal/`。
pub fn cache_ready(cache_root: &Path, spec: &EngineSpec) -> bool {
    let dir = engine_dir(cache_root, &spec.version);
    let mark_path = dir.join(VERIFIED_MARK);
    let mark = match fs::read_to_string(&mark_path) {
        Ok(text) => match serde_json::from_str::<VerifiedMark>(&text) {
            Ok(mark) => mark,
            Err(_) => return false,
        },
        Err(_) => return false,
    };
    mark.matches(spec) && dir.join("lumen-cli.exe").is_file() && dir.join("_internal").is_dir()
}

/// 下载器接口。生产实现走 reqwest，单测注入 fake，不触碰真实网络。
pub trait Fetcher {
    fn fetch(
        &self,
        url: &str,
        dest: &Path,
        on_progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<(), String>;
}

/// 真实下载器：reqwest blocking，尊重系统代理，超时 10 分钟。
pub struct HttpFetcher;

impl Fetcher for HttpFetcher {
    fn fetch(
        &self,
        url: &str,
        dest: &Path,
        on_progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .user_agent("gallery-culling-engine-fetcher/1.0")
            .build()
            .map_err(|e| format!("创建下载客户端失败：{}。下一步：重试；若仍失败请在设置中手动指定 lumen-cli.exe。", e))?;
        let mut resp = client.get(url).send().map_err(|e| network_error_text(&e))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!(
                "下载引擎失败：服务器返回 HTTP {}。下一步：稍后点「重试」；若长期失败，多为代理或限流，请在设置中手动指定 lumen-cli.exe。",
                status.as_u16()
            ));
        }
        let total = resp.content_length();
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建下载目录失败：{}。下一步：检查磁盘权限后重试。", e))?;
        }
        let mut file = fs::File::create(dest).map_err(|e| {
            format!(
                "创建下载文件失败：{}。下一步：确认磁盘剩余空间 ≥ 250 MB 后重试。",
                e
            )
        })?;
        let mut downloaded = 0u64;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = resp
                .read(&mut buf)
                .map_err(|e| format!("下载中断：{}。下一步：检查网络后点「重试」。", e))?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| {
                format!(
                    "写入下载文件失败：{}。下一步：确认磁盘剩余空间 ≥ 250 MB 后重试。",
                    e
                )
            })?;
            downloaded += n as u64;
            on_progress(downloaded, total);
        }
        Ok(())
    }
}

fn network_error_text(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "下载引擎超时（网络过慢或被代理阻断）。下一步：检查网络/代理后点「重试」，或在设置中手动指定 lumen-cli.exe。".to_string()
    } else if e.is_connect() {
        "无法连接 GitHub 下载引擎（断网或代理未生效）。下一步：确认能访问 github.com 后点「重试」，或在设置中手动指定 lumen-cli.exe。".to_string()
    } else if e.is_body() || e.is_decode() {
        "下载引擎时连接被中断。下一步：检查网络稳定性后点「重试」。".to_string()
    } else {
        format!("下载引擎失败：{}。下一步：检查网络后点「重试」。", e)
    }
}

/// 引擎管理器：单飞 + 状态缓存。
#[derive(Clone, Default)]
pub struct EngineManager {
    inner: Arc<Mutex<EngineInner>>,
}

#[derive(Default)]
struct EngineInner {
    status: EngineStatus,
    in_flight: bool,
}

impl EngineManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前状态（零 IO）。
    pub fn status(&self) -> EngineStatus {
        match self.inner.lock() {
            Ok(g) => g.status.clone(),
            Err(e) => e.into_inner().status.clone(),
        }
    }

    /// 确保引擎可用；已有可用缓存时直接返回 Ready，不重复下载。
    ///
    /// 单飞：并发调用时后来者拿到的当前状态，不会启动第二次下载。
    pub fn ensure(
        &self,
        spec: &EngineSpec,
        fetcher: &dyn Fetcher,
        on_status: &mut dyn FnMut(&EngineStatus),
    ) -> EngineStatus {
        {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            if g.in_flight {
                return g.status.clone();
            }
            g.in_flight = true;
            if cache_ready(&cache_root(), spec) {
                let status = ready_status(spec);
                g.status = status.clone();
                g.in_flight = false;
                return status;
            }
        }

        let status = self.run_download(spec, fetcher, on_status);
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        g.in_flight = false;
        g.status = status.clone();
        status
    }

    /// 与 [`Self::ensure`] 相同，但缓存根目录显式传入（单测用，避免改全局环境变量）。
    pub fn ensure_at(
        &self,
        cache_root: &Path,
        spec: &EngineSpec,
        fetcher: &dyn Fetcher,
        on_status: &mut dyn FnMut(&EngineStatus),
    ) -> EngineStatus {
        {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            if g.in_flight {
                return g.status.clone();
            }
            g.in_flight = true;
            if cache_ready(cache_root, spec) {
                let status = ready_status(spec);
                g.status = status.clone();
                g.in_flight = false;
                return status;
            }
        }
        let status = self.run_download_at(cache_root, spec, fetcher, on_status);
        let mut g = match self.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        g.in_flight = false;
        g.status = status.clone();
        status
    }

    fn run_download(
        &self,
        spec: &EngineSpec,
        fetcher: &dyn Fetcher,
        on_status: &mut dyn FnMut(&EngineStatus),
    ) -> EngineStatus {
        self.run_download_at(&cache_root(), spec, fetcher, on_status)
    }

    fn run_download_at(
        &self,
        cache_root: &Path,
        spec: &EngineSpec,
        fetcher: &dyn Fetcher,
        on_status: &mut dyn FnMut(&EngineStatus),
    ) -> EngineStatus {
        let url = match resolve_url(spec) {
            Some(url) => url,
            None => {
                return failed_status(
                    spec,
                    "锁文件没有配置引擎下载地址。下一步：同步 src-tauri/sidecar.lock.json，或在设置中手动指定 lumen-cli.exe。",
                )
            }
        };
        if let Err(e) = fs::create_dir_all(cache_root) {
            return failed_status(
                spec,
                &format!(
                    "创建引擎缓存目录失败：{}。下一步：检查 {} 的写入权限后重试。",
                    e,
                    cache_root.display()
                ),
            );
        }

        let final_dir = engine_dir(cache_root, &spec.version);
        // 上一轮被强杀（关窗口 / 任务管理器）会留下半截 zip 或临时目录；
        // 这里先清掉，避免它们永久占着磁盘、也避免误把残片当成缓存。
        sweep_stale_temp(cache_root, &spec.version);
        let stamp = unique_stamp();
        let tmp_zip = cache_root.join(format!(".lumen-cli-{}.zip.tmp-{}", spec.version, stamp));
        let tmp_dir = cache_root.join(format!(".lumen-cli-{}.tmp-{}", spec.version, stamp));

        let downloading = EngineStatus {
            phase: EnginePhase::Downloading,
            version: spec.version.clone(),
            detail: "正在下载 LUMEN RAW 引擎…".to_string(),
            downloaded_bytes: 0,
            total_bytes: spec.source.zip_bytes.unwrap_or(0),
        };
        on_status(&downloading);

        let fetch_result = fetcher.fetch(&url, &tmp_zip, &mut |downloaded, total| {
            let status = EngineStatus {
                phase: EnginePhase::Downloading,
                version: spec.version.clone(),
                detail: progress_detail(downloaded, total.or(spec.source.zip_bytes)),
                downloaded_bytes: downloaded,
                total_bytes: total.or(spec.source.zip_bytes).unwrap_or(0),
            };
            on_status(&status);
        });
        if let Err(message) = fetch_result {
            cleanup(&tmp_zip);
            cleanup(&tmp_dir);
            return failed_status(spec, &message);
        }

        // zip 自身的完整性：字节数 + sha256，任一不符都不解压。
        let actual_zip_bytes = match fs::metadata(&tmp_zip) {
            Ok(m) => m.len(),
            Err(e) => {
                cleanup(&tmp_zip);
                return failed_status(
                    spec,
                    &format!("读取下载文件失败：{}。下一步：点「重试」。", e),
                );
            }
        };
        if let Some(expected) = spec.source.zip_bytes {
            if actual_zip_bytes != expected {
                cleanup(&tmp_zip);
                return failed_status(
                    spec,
                    &format!(
                        "下载的引擎包大小不符（期望 {} 字节，实际 {} 字节）。下一步：点「重试」；若反复失败，可能是代理改写了下载内容。",
                        expected, actual_zip_bytes
                    ),
                );
            }
        }
        if let Some(expected_sha) = &spec.source.zip_sha256 {
            match sha256_file(&tmp_zip) {
                Ok(actual) if actual == *expected_sha => {}
                Ok(actual) => {
                    cleanup(&tmp_zip);
                    return failed_status(
                        spec,
                        &format!(
                            "下载的引擎包校验失败（sha256 期望 {}，实际 {}）。下一步：点「重试」；若反复失败，请在设置中手动指定 lumen-cli.exe。",
                            expected_sha, actual
                        ),
                    );
                }
                Err(e) => {
                    cleanup(&tmp_zip);
                    return failed_status(spec, &format!("校验下载文件失败：{}", e));
                }
            }
        }

        let verifying = EngineStatus {
            phase: EnginePhase::Verifying,
            version: spec.version.clone(),
            detail: "正在校验引擎完整性…".to_string(),
            downloaded_bytes: actual_zip_bytes,
            total_bytes: actual_zip_bytes,
        };
        on_status(&verifying);

        if let Err(e) = extract_zip(&tmp_zip, &tmp_dir) {
            cleanup(&tmp_zip);
            cleanup(&tmp_dir);
            return failed_status(spec, &e);
        }
        cleanup(&tmp_zip);

        match compare_directory(spec, &tmp_dir) {
            Ok(problems) if problems.is_empty() => {}
            Ok(problems) => {
                cleanup(&tmp_dir);
                return failed_status(
                    spec,
                    &format!(
                        "引擎目录校验失败（{}）。下一步：点「重试」；若反复失败，可能是代理改写了下载内容，请在设置中手动指定 lumen-cli.exe。",
                        problems.join("；")
                    ),
                );
            }
            Err(e) => {
                cleanup(&tmp_dir);
                return failed_status(spec, &format!("校验引擎目录失败：{}", e));
            }
        }

        let mark = VerifiedMark {
            version: spec.version.clone(),
            file_count: spec.file_count,
            total_bytes: spec.total_bytes,
            content_sha256: spec.content_sha256.clone(),
            verified_at: now_iso8601(),
        };
        if let Err(e) = fs::write(
            tmp_dir.join(VERIFIED_MARK),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&mark).unwrap_or_default()
            ),
        ) {
            cleanup(&tmp_dir);
            return failed_status(
                spec,
                &format!("写入校验标记失败：{}。下一步：检查磁盘权限后重试。", e),
            );
        }

        if let Err(e) = swap_into_place(&tmp_dir, &final_dir, cache_root, &spec.version) {
            cleanup(&tmp_dir);
            return failed_status(spec, &e);
        }

        ready_status(spec)
    }
}

/// 解析下载地址：环境变量覆盖优先，其次锁文件。
fn resolve_url(spec: &EngineSpec) -> Option<String> {
    if let Ok(url) = std::env::var(ENGINE_URL_ENV) {
        let url = url.trim().to_string();
        if !url.is_empty() {
            return Some(url);
        }
    }
    spec.source.url.clone()
}

fn ready_status(spec: &EngineSpec) -> EngineStatus {
    EngineStatus {
        phase: EnginePhase::Ready,
        version: spec.version.clone(),
        detail: format!("LUMEN RAW 引擎已就绪（{}）", spec.version),
        downloaded_bytes: spec.source.zip_bytes.unwrap_or(0),
        total_bytes: spec.source.zip_bytes.unwrap_or(0),
    }
}

fn failed_status(spec: &EngineSpec, detail: &str) -> EngineStatus {
    EngineStatus {
        phase: EnginePhase::Failed,
        version: spec.version.clone(),
        detail: detail.to_string(),
        downloaded_bytes: 0,
        total_bytes: spec.source.zip_bytes.unwrap_or(0),
    }
}

fn progress_detail(downloaded: u64, total: Option<u64>) -> String {
    match total {
        Some(total) if total > 0 => format!(
            "正在下载 LUMEN RAW 引擎…（{:.1}/{:.1} MB）",
            downloaded as f64 / 1_048_576.0,
            total as f64 / 1_048_576.0
        ),
        _ => format!(
            "正在下载 LUMEN RAW 引擎…（已下载 {:.1} MB）",
            downloaded as f64 / 1_048_576.0
        ),
    }
}

fn unique_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), now)
}

fn now_iso8601() -> String {
    // 只为留痕，不需要严格 ISO：chrono 已在依赖里，但这里避免额外引入格式化代码。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{}", secs)
}

/// 解压 zip 到目标目录；路径穿越（`..`）一律拒绝。
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("打开下载文件失败：{}。下一步：点「重试」。", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        format!(
            "引擎包不是有效 zip：{}。下一步：点「重试」；若反复失败，可能是下载被代理改写。",
            e
        )
    })?;
    fs::create_dir_all(dest).map_err(|e| {
        format!(
            "创建解压目录失败：{}。下一步：确认磁盘剩余空间 ≥ 250 MB 后重试。",
            e
        )
    })?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("读取引擎包条目失败：{}。下一步：点「重试」。", e))?;
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| "引擎包内含非法路径（含 .. 或绝对路径），已拒绝解压。下一步：核对发布资产是否被篡改。".to_string())?;
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| {
                format!(
                    "创建目录 {} 失败：{}。下一步：确认磁盘空间后重试。",
                    out.display(),
                    e
                )
            })?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "创建目录 {} 失败：{}。下一步：确认磁盘空间后重试。",
                    parent.display(),
                    e
                )
            })?;
        }
        let mut writer = fs::File::create(&out).map_err(|e| {
            format!(
                "写入 {} 失败：{}。下一步：确认磁盘剩余空间 ≥ 250 MB 后重试。",
                out.display(),
                e
            )
        })?;
        std::io::copy(&mut entry, &mut writer).map_err(|e| {
            format!(
                "解压 {} 失败：{}。下一步：点「重试」；若反复失败请检查磁盘空间。",
                out.display(),
                e
            )
        })?;
    }
    Ok(())
}

/// 原子就位：旧目录先让位，新目录改名就位后删旧目录；失败时把旧目录改回来。
fn swap_into_place(
    tmp_dir: &Path,
    final_dir: &Path,
    cache_root: &Path,
    version: &str,
) -> Result<(), String> {
    let old_dir = cache_root.join(format!(".lumen-cli-{}.old-{}", version, unique_stamp()));
    let had_final = final_dir.exists();
    if had_final {
        fs::rename(final_dir, &old_dir).map_err(|e| {
            format!(
                "替换旧引擎目录失败：{}。下一步：关闭正在使用引擎的窗口后重试。",
                e
            )
        })?;
    }
    match fs::rename(tmp_dir, final_dir) {
        Ok(()) => {
            if had_final {
                cleanup(&old_dir);
            }
            Ok(())
        }
        Err(e) => {
            if had_final {
                let _ = fs::rename(&old_dir, final_dir);
            }
            Err(format!(
                "安装引擎目录失败：{}。下一步：确认 %LOCALAPPDATA% 可写、磁盘剩余空间 ≥ 250 MB 后重试。",
                e
            ))
        }
    }
}

fn cleanup(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

/// 清掉本轮版本的陈旧临时产物（`.zip.tmp-*` / `.tmp-*` / `.old-*`）。
///
/// 只在真正要下载/安装时调用：已校验缓存走短路，不做任何磁盘写入。
fn sweep_stale_temp(cache_root: &Path, version: &str) {
    let Ok(entries) = fs::read_dir(cache_root) else {
        return;
    };
    let prefixes = [
        format!(".lumen-cli-{}.zip.tmp-", version),
        format!(".lumen-cli-{}.tmp-", version),
        format!(".lumen-cli-{}.old-", version),
    ];
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if prefixes.iter().any(|p| name.starts_with(p)) {
            cleanup(&entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lumen::test_support::tmp;

    /// 造一个合成基线：两个文件，内容可指定。
    fn spec_with(exe: &str, dll: &str) -> EngineSpec {
        EngineSpec {
            version: "1.6.0".to_string(),
            source: EngineSource {
                url: Some("https://example.invalid/lumen.zip".to_string()),
                zip_sha256: None,
                zip_bytes: None,
            },
            exe_sha256: format!("{:x}", Sha256::digest(exe.as_bytes())),
            exe_bytes: exe.len() as u64,
            file_count: 2,
            total_bytes: (exe.len() + dll.len()) as u64,
            content_sha256: String::new(),
        }
    }

    fn write_engine(dir: &Path, exe: &str, dll: &str) {
        fs::create_dir_all(dir.join("_internal")).unwrap();
        fs::write(dir.join("lumen-cli.exe"), exe).unwrap();
        fs::write(dir.join("_internal").join("python.dll"), dll).unwrap();
    }

    /// 把目录基线补进 spec（合成基线要自己算 contentSha256）。
    fn with_content_sha(mut spec: EngineSpec, dir: &Path) -> EngineSpec {
        spec.content_sha256 = collect_directory(dir).unwrap().content_sha256;
        spec
    }

    fn unique_root(name: &str) -> PathBuf {
        let root = tmp(name);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    struct FakeFetcher {
        content: Result<Vec<u8>, String>,
        calls: std::cell::Cell<usize>,
    }

    impl FakeFetcher {
        fn ok(content: Vec<u8>) -> Self {
            Self {
                content: Ok(content),
                calls: std::cell::Cell::new(0),
            }
        }
        fn failing(message: &str) -> Self {
            Self {
                content: Err(message.to_string()),
                calls: std::cell::Cell::new(0),
            }
        }
    }

    impl Fetcher for FakeFetcher {
        fn fetch(
            &self,
            _url: &str,
            dest: &Path,
            on_progress: &mut dyn FnMut(u64, Option<u64>),
        ) -> Result<(), String> {
            self.calls.set(self.calls.get() + 1);
            match &self.content {
                Ok(bytes) => {
                    fs::write(dest, bytes).map_err(|e| e.to_string())?;
                    on_progress(bytes.len() as u64, Some(bytes.len() as u64));
                    Ok(())
                }
                Err(message) => {
                    // 模拟「下到一半连接断了」：先落一个半截文件，再报错。
                    // 清理责任在 `ensure` 里，这里刻意留下残留物供断言。
                    let _ = fs::write(dest, b"partial-download");
                    Err(message.clone())
                }
            }
        }
    }

    fn make_zip(dir: &Path, exe: &str, dll: &str) -> Vec<u8> {
        let zip_path = dir.join("fixture.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("lumen-cli.exe", options).unwrap();
            std::io::Write::write_all(&mut writer, exe.as_bytes()).unwrap();
            writer.start_file("_internal/python.dll", options).unwrap();
            std::io::Write::write_all(&mut writer, dll.as_bytes()).unwrap();
            writer.finish().unwrap();
        }
        fs::read(&zip_path).unwrap()
    }

    /// 编译期锁文件必须能与宿主版本对上，且带下载地址。
    #[test]
    fn pinned_lock_parses_and_has_download_source() {
        let spec = pinned_engine_spec();
        assert_eq!(spec.version, PINNED_LUMEN_VERSION);
        assert_eq!(spec.file_count, 1150);
        assert_eq!(spec.total_bytes, 190_420_760);
        assert!(
            spec.source.url.is_some(),
            "锁文件必须配置下载地址，否则运行时无处可取"
        );
        assert!(
            spec.source.zip_sha256.is_some(),
            "锁文件必须钉住 zip 的 sha256"
        );
    }

    #[test]
    fn parse_without_url_yields_no_download_source() {
        let json = r#"{"version":"1.6.0","source":{"type":"local-path","note":"离线"},"exe":{"sha256":"a","bytes":1},"directory":{"fileCount":1,"totalBytes":1,"contentSha256":"a"}}"#;
        let spec = parse_engine_spec(json).unwrap();
        assert!(spec.source.url.is_none());
        if std::env::var(ENGINE_URL_ENV).is_err() {
            let root = unique_root("engine_no_url");
            let manager = EngineManager::new();
            let fetcher = FakeFetcher::ok(vec![]);
            let status = manager.ensure_at(&root, &spec, &fetcher, &mut |_| {});
            assert_eq!(status.phase, EnginePhase::Failed);
            assert!(status.detail.contains("下载地址"), "{}", status.detail);
            let _ = fs::remove_dir_all(&root);
        }
    }

    /// 已校验缓存 → 不下载。
    #[test]
    fn verified_cache_skips_download() {
        let root = unique_root("engine_cache_hit");
        let dir = engine_dir(&root, "1.6.0");
        write_engine(&dir, "exe-bytes", "dll-bytes");
        let spec = with_content_sha(spec_with("exe-bytes", "dll-bytes"), &dir);
        let mark = VerifiedMark {
            version: "1.6.0".to_string(),
            file_count: spec.file_count,
            total_bytes: spec.total_bytes,
            content_sha256: spec.content_sha256.clone(),
            verified_at: "unix:1".to_string(),
        };
        fs::write(
            dir.join(VERIFIED_MARK),
            serde_json::to_string(&mark).unwrap(),
        )
        .unwrap();

        let fetcher = FakeFetcher::ok(vec![]);
        let manager = EngineManager::new();
        let status = manager.ensure_at(&root, &spec, &fetcher, &mut |_| {});
        assert_eq!(status.phase, EnginePhase::Ready);
        assert_eq!(fetcher.calls.get(), 0, "命中缓存不得再下载");
        let _ = fs::remove_dir_all(&root);
    }

    /// 缓存缺失 → 下载 + 解压 + 校验 + 原子就位。
    #[test]
    fn missing_cache_downloads_and_installs() {
        let root = unique_root("engine_install");
        let fixture = root.join("fixture");
        fs::create_dir_all(&fixture).unwrap();
        let zip_bytes = make_zip(&fixture, "exe-bytes", "dll-bytes");
        let zip_sha = format!("{:x}", Sha256::digest(&zip_bytes));

        let probe = fixture.join("probe");
        write_engine(&probe, "exe-bytes", "dll-bytes");
        let mut spec = with_content_sha(spec_with("exe-bytes", "dll-bytes"), &probe);
        spec.source.zip_sha256 = Some(zip_sha);
        spec.source.zip_bytes = Some(zip_bytes.len() as u64);

        let fetcher = FakeFetcher::ok(zip_bytes);
        let manager = EngineManager::new();
        let status = manager.ensure_at(&root, &spec, &fetcher, &mut |_| {});
        assert_eq!(status.phase, EnginePhase::Ready, "{}", status.detail);
        assert_eq!(fetcher.calls.get(), 1);
        let dir = engine_dir(&root, "1.6.0");
        assert!(dir.join("lumen-cli.exe").is_file());
        assert!(dir.join("_internal").join("python.dll").is_file());
        assert!(dir.join(VERIFIED_MARK).is_file());

        // 第二次不需要再下载
        let status = manager.ensure_at(&root, &spec, &fetcher, &mut |_| {});
        assert_eq!(status.phase, EnginePhase::Ready);
        assert_eq!(fetcher.calls.get(), 1, "已就绪后不得重复下载");

        // 不留临时产物
        let leftovers = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".lumen-cli-"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "残留临时产物：{:?}", leftovers);
        let _ = fs::remove_dir_all(&root);
    }

    /// zip sha256 不符 → 拒绝并清理，不留下半截目录。
    #[test]
    fn bad_zip_hash_rejects_and_cleans() {
        let root = unique_root("engine_bad_hash");
        let fixture = root.join("fixture");
        fs::create_dir_all(&fixture).unwrap();
        // zip 内容本身与基线一致，只有声明的 sha256 是错的：
        // 这样红必须来自「zip 哈希校验」，而不是后续的目录内容比对。
        let zip_bytes = make_zip(&fixture, "exe-bytes", "dll-bytes");
        let probe = fixture.join("probe");
        write_engine(&probe, "exe-bytes", "dll-bytes");
        let mut spec = with_content_sha(spec_with("exe-bytes", "dll-bytes"), &probe);
        spec.source.zip_sha256 = Some("0".repeat(64));
        spec.source.zip_bytes = Some(zip_bytes.len() as u64);

        let fetcher = FakeFetcher::ok(zip_bytes);
        let manager = EngineManager::new();
        let status = manager.ensure_at(&root, &spec, &fetcher, &mut |_| {});
        assert_eq!(status.phase, EnginePhase::Failed);
        assert!(status.detail.contains("sha256 期望"), "{}", status.detail);
        assert!(!engine_dir(&root, "1.6.0").exists(), "失败不得落成最终目录");
        let leftovers = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".lumen-cli-"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "残留临时产物：{:?}", leftovers);
        let _ = fs::remove_dir_all(&root);
    }

    /// 目录内容与基线不符 → 拒绝并清理。
    #[test]
    fn content_mismatch_rejects_and_cleans() {
        let root = unique_root("engine_bad_content");
        let fixture = root.join("fixture");
        fs::create_dir_all(&fixture).unwrap();
        // exe 与基线一致，只有 _internal/ 里的内容被换掉：
        // 这样 exe 哈希/字节数都过得去，红必须来自 contentSha256。
        let zip_bytes = make_zip(&fixture, "exe-bytes", "other-dll");
        let zip_sha = format!("{:x}", Sha256::digest(&zip_bytes));
        let mut spec = spec_with("exe-bytes", "dll-bytes");
        spec.content_sha256 = "1".repeat(64);
        spec.source.zip_sha256 = Some(zip_sha);
        spec.source.zip_bytes = Some(zip_bytes.len() as u64);

        let fetcher = FakeFetcher::ok(zip_bytes);
        let manager = EngineManager::new();
        let status = manager.ensure_at(&root, &spec, &fetcher, &mut |_| {});
        assert_eq!(status.phase, EnginePhase::Failed);
        assert!(status.detail.contains("校验失败"), "{}", status.detail);
        assert!(!engine_dir(&root, "1.6.0").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// 下载中断 → 不留半截目录 / 半截 zip。
    #[test]
    fn interrupted_download_leaves_nothing() {
        let root = unique_root("engine_interrupted");
        let spec = spec_with("exe-bytes", "dll-bytes");
        let fetcher = FakeFetcher::failing("下载中断：连接被重置。下一步：检查网络后点「重试」。");
        let manager = EngineManager::new();
        let status = manager.ensure_at(&root, &spec, &fetcher, &mut |_| {});
        assert_eq!(status.phase, EnginePhase::Failed);
        assert!(status.detail.contains("下一步"), "{}", status.detail);
        assert!(!engine_dir(&root, "1.6.0").exists());
        let leftovers = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "残留：{:?}", leftovers);
        let _ = fs::remove_dir_all(&root);
    }

    /// 上一轮被强杀留下的临时产物，下次真正下载前必须先被清掉。
    #[test]
    fn stale_temp_from_previous_run_is_swept() {
        let root = unique_root("engine_stale_sweep");
        let fixture = root.join("fixture");
        fs::create_dir_all(&fixture).unwrap();
        let zip_bytes = make_zip(&fixture, "exe-bytes", "dll-bytes");
        let zip_sha = format!("{:x}", Sha256::digest(&zip_bytes));
        let probe = fixture.join("probe");
        write_engine(&probe, "exe-bytes", "dll-bytes");
        let mut spec = with_content_sha(spec_with("exe-bytes", "dll-bytes"), &probe);
        spec.source.zip_sha256 = Some(zip_sha);
        spec.source.zip_bytes = Some(zip_bytes.len() as u64);

        // 模拟强杀残骸：半截 zip + 半截临时目录
        let stale_zip = root.join(".lumen-cli-1.6.0.zip.tmp-prev");
        fs::write(&stale_zip, b"partial-download").unwrap();
        let stale_dir = root.join(".lumen-cli-1.6.0.tmp-prev");
        fs::create_dir_all(&stale_dir).unwrap();

        let fetcher = FakeFetcher::ok(zip_bytes);
        let manager = EngineManager::new();
        let status = manager.ensure_at(&root, &spec, &fetcher, &mut |_| {});
        assert_eq!(status.phase, EnginePhase::Ready);
        assert!(!stale_zip.exists(), "半截 zip 必须被清掉");
        assert!(!stale_dir.exists(), "半截临时目录必须被清掉");
        let _ = fs::remove_dir_all(&root);
    }

    /// zip 字节数与锁文件不符 → 拒绝并清理（防止代理截断/追加）。
    #[test]
    fn bad_zip_size_rejects_and_cleans() {
        let root = unique_root("engine_bad_size");
        let fixture = root.join("fixture");
        fs::create_dir_all(&fixture).unwrap();
        let zip_bytes = make_zip(&fixture, "exe-bytes", "dll-bytes");
        let mut spec = spec_with("exe-bytes", "dll-bytes");
        spec.source.zip_sha256 = Some(format!("{:x}", Sha256::digest(&zip_bytes)));
        // 目录基线也要对上，否则红会来自 contentSha256 而非字节数检查（归因不纯）。
        let baseline = root.join("baseline");
        write_engine(&baseline, "exe-bytes", "dll-bytes");
        spec.content_sha256 = collect_directory(&baseline).unwrap().content_sha256;
        // 只把期望字节数改错，sha 仍正确：红必须来自字节数检查。
        spec.source.zip_bytes = Some(zip_bytes.len() as u64 + 1);
        let fetcher = FakeFetcher::ok(zip_bytes);
        let manager = EngineManager::new();
        let status = manager.ensure_at(&root, &spec, &fetcher, &mut |_| {});
        assert_eq!(status.phase, EnginePhase::Failed);
        assert!(status.detail.contains("大小不符"), "{}", status.detail);
        assert!(!engine_dir(&root, "1.6.0").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// 目录口径必须与 `scripts/sidecar-lock.mjs` 逐字一致（这里用 JS 算出的字面值锁住）。
    #[test]
    fn content_sha256_matches_js_definition() {
        let dir = unique_root("engine_js_parity");
        write_engine(&dir, "exe-bytes", "dll-bytes");
        let stat = collect_directory(&dir).unwrap();
        assert_eq!(
            stat.content_sha256, "ddcea4a6c8c2f314106cfdddd5d9e49963e2540047058da646608495c2fc492b",
            "contentSha256 口径变了：Rust 与 sidecar-lock.mjs 会算出不同的值"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 目录口径必须与 JS 的 collectDirectory 一致（同名文件同内容 → 同哈希）。
    #[test]
    fn directory_hash_is_stable_and_sensitive_to_content() {
        let dir = unique_root("engine_dir_hash");
        write_engine(&dir, "exe-bytes", "dll-bytes");
        let first = collect_directory(&dir).unwrap();
        assert_eq!(first.file_count, 2);
        assert_eq!(
            first.total_bytes,
            ("exe-bytes".len() + "dll-bytes".len()) as u64
        );
        assert_eq!(collect_directory(&dir).unwrap(), first);
        fs::write(dir.join("_internal").join("extra.txt"), "x").unwrap();
        let after = collect_directory(&dir).unwrap();
        assert_eq!(after.file_count, 3);
        assert_ne!(after.content_sha256, first.content_sha256);
        let _ = fs::remove_dir_all(&dir);
    }
}
