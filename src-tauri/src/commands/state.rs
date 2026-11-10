//! 命令层共享状态与基础设施（issue #143 自 `commands.rs` 门面搬运）。
//!
//! `commands.rs` 现在只剩 mod 声明 + `pub use` 转发（对照 `lumen.rs` 门面），
//! 本文件承接原驻留其上的业务段：AppState 组装 / 进度节流 / 时钟 /
//! `spawn_blocking` 包装 / Lumen 可用性判定。搬运逐字不改，
//! 唯一路径适配：`xmprw::DiskSink` → `super::xmprw::DiskSink`。

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use crate::db::Database;
use crate::lumen;
use crate::syncqueue;

use crate::models::AppSettings;

pub struct AppState {
    pub db: Database,
    /// LUMEN RAW 常驻运行时（A 通道）：spawn 一次、握手、复用
    pub lumen: lumen::LumenRuntime,
    /// 扫描取消标志（协作式轮询）。置位后扫描在下一个安全点尽早返回。
    pub scan_cancel: Arc<AtomicBool>,
    /// 导出取消标志（协作式轮询）。置位后导出丢弃临时目录，目标目录零污染。
    pub export_cancel: Arc<AtomicBool>,
    /// 写盘合并队列（FR-03）：同一照片的连续改动折叠成一次落盘。
    pub sync: Arc<syncqueue::Coalescer>,
    /// 任务槽（FR-09）：扫描/导出/渲染/AI 互斥，重入返回 E_BUSY。
    pub tasks: crate::taskgate::TaskGate,
    /// 1:1 细节渲染的单飞标记（FR-05）：761MB/张，并行 3 张就是 2.3GB。
    ///
    /// 刻意**不**并进 `tasks`：那是「互斥表 + 禁用原因」的用户可见语义，
    /// 而这里是「同一时刻只渲一张」的资源上限 —— 第二个请求应当立刻
    /// `E_BUSY` 让前端队列自己排队，不该让导出按钮变灰。
    pub detail_busy: Arc<AtomicBool>,
    /// 引擎包下载/校验/缓存（issue #75）：单飞 + 状态机。
    pub engine: lumen::EngineManager,
}

impl AppState {
    /// 组装应用状态。合并队列的 sink 复用同一个数据库句柄 —— 落盘成功后由它
    /// 删除 `pending_xmp` 里那条意图。
    pub fn new(db: Database) -> Self {
        let sink = Arc::new(super::xmprw::DiskSink::new(db.clone()));
        Self {
            db,
            lumen: lumen::LumenRuntime::new(),
            scan_cancel: Arc::new(AtomicBool::new(false)),
            export_cancel: Arc::new(AtomicBool::new(false)),
            sync: Arc::new(syncqueue::Coalescer::new(sink)),
            tasks: crate::taskgate::TaskGate::new(),
            detail_busy: Arc::new(AtomicBool::new(false)),
            engine: lumen::EngineManager::new(),
        }
    }
}

/// 进度节流器。
///
/// 万张规模下每张都 `emit` 会淹掉 IPC（前端主线程忙于解码事件），因此只在
/// **阶段切换 / 首个 / 末个 / 累计 ≥32 项 / 距上次 ≥80ms** 时放行一次。
pub struct ProgressThrottle {
    last_emit: std::time::Instant,
    last_count: usize,
    last_phase: String,
}

impl ProgressThrottle {
    pub fn new() -> Self {
        Self {
            last_emit: std::time::Instant::now(),
            last_count: 0,
            last_phase: String::new(),
        }
    }

    pub fn should_emit(&mut self, phase: &str, processed: usize, total: usize) -> bool {
        let phase_changed = phase != self.last_phase.as_str();
        let due = self.last_emit.elapsed() >= Duration::from_millis(80)
            || processed.saturating_sub(self.last_count) >= 32
            || processed == 0
            || (total > 0 && processed >= total);
        if phase_changed || due {
            self.last_emit = std::time::Instant::now();
            self.last_count = processed;
            self.last_phase = phase.to_string();
            true
        } else {
            false
        }
    }
}

/// 当前 Unix 秒（清单文件用）。实现收敛到 clock（issue #139），哨兵 0。
pub fn now_epoch_secs() -> u64 {
    crate::clock::now_secs_u64()
}

/// 把一次 `spawn_blocking` 收进统一的 JoinError→String 包装。
///
/// `msg` 是**任务描述前缀**，最终错误文本为 `"{msg}: {join_error}"` —— 与
/// 重构前逐字一致（勿改文案）。闭包的错误类型 `E` 泛型化：`lumen_preview_cmd`
/// 的闭包返回 `Result<_, LumenError>`，其余为 `Result<_, String>`。
pub async fn blocking<F, T, E>(msg: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(e) => Err(format!("{}: {}", msg, e)),
    }
}

/// 闭包**本身不返回 Result**（只可能因 JoinError 失败）的专用。
///
/// 覆盖 `query_version -> Option<String>` / `read_project_tone -> Option<..>` /
/// `list_masks -> Vec<Value>` —— 这三个 lumen 公开方法都不是 `Result`，
/// 硬塞进 `blocking` 需要伪造错误类型，属于投机抽象。
pub async fn blocking_value<F, T>(msg: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("{}: {}", msg, e))
}

/// Lumen 引擎「可用性」判定，**不可用即 Err**，两条错误文案逐字保留。
///
/// 与 `lumen_exe` 的区别只在于"说什么"：本函数用于必须走引擎路径的命令
/// （写 recipe / 探测能力 / 应用预设 / 应用蒙版），不可用就是调用失败。
pub fn require_lumen(settings: &AppSettings) -> Result<PathBuf, String> {
    if !settings.lumen_enabled {
        return Err("未启用 LUMEN RAW 引擎".to_string());
    }
    lumen::find_lumen_cli(&settings.lumen_cli_path).ok_or_else(|| "未找到 lumen-cli".to_string())
}

/// Lumen 引擎「可用性」判定，**不可用即 None**，降级语义由调用方自己决定。
///
/// 「引擎未启用」与「未找到 lumen-cli」在全部调用点都导向同一个后续动作
/// （放弃引擎路径），差异仅在降级文案，因此可安全合并为一次判定。
/// 调用方返回各自的 `Ok(降级值)`（status / preview / recipe / 蒙版…）。
pub fn lumen_exe(settings: &AppSettings) -> Option<PathBuf> {
    if !settings.lumen_enabled {
        return None;
    }
    lumen::find_lumen_cli(&settings.lumen_cli_path)
}

#[cfg(test)]
mod state_tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gc_cmd143_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn settings(lumen_enabled: bool) -> AppSettings {
        AppSettings {
            lumen_enabled,
            ..Default::default()
        }
    }

    #[test]
    fn app_state_new_取消标志与单飞标记初值全false() {
        let dir = temp_dir("appstate");
        let db = Database::open(&dir.join("t.db")).expect("临时库");
        let state = AppState::new(db);
        assert!(!state.scan_cancel.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state
            .export_cancel
            .load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.detail_busy.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn progress_throttle_首帧阶段切换末帧必放行() {
        let mut t = ProgressThrottle::new();
        assert!(t.should_emit("scan", 0, 10), "processed==0 首帧必放行");
        assert!(!t.should_emit("scan", 1, 10), "同阶段小增量未到期不放行");
        assert!(t.should_emit("export", 2, 10), "阶段切换放行");
        assert!(t.should_emit("export", 10, 10), "processed==total 末帧放行");
    }

    #[test]
    fn progress_throttle_计数增量达32放行() {
        let mut t = ProgressThrottle::new();
        assert!(t.should_emit("scan", 0, 100));
        assert!(!t.should_emit("scan", 31, 100), "增量 31 < 32 不放行");
        assert!(t.should_emit("scan", 32, 100), "增量 32 达阈值放行");
    }

    #[test]
    fn now_epoch_secs_非零且单调不回退() {
        let a = now_epoch_secs();
        let b = now_epoch_secs();
        assert!(a > 0, "Unix 秒不应为 0（哨兵）");
        assert!(b >= a, "时钟不回退");
    }

    #[test]
    fn require_lumen_未启用文案逐字() {
        let err = require_lumen(&settings(false)).unwrap_err();
        assert_eq!(err, "未启用 LUMEN RAW 引擎");
    }

    #[test]
    fn lumen_exe_未启用返回None() {
        assert!(lumen_exe(&settings(false)).is_none());
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("建运行时")
    }

    #[test]
    fn blocking_Ok原样透传闭包Err转String() {
        let ok: Result<i32, String> = rt().block_on(blocking("任务", || Ok::<i32, String>(42)));
        assert_eq!(ok, Ok(42));
        let err: Result<i32, String> = rt().block_on(blocking("任务", || {
            Err::<i32, String>("boom".to_string())
        }));
        assert_eq!(err, Err("boom".to_string()));
    }

    #[test]
    fn blocking_任务panic错误带前缀() {
        let r: Result<i32, String> =
            rt().block_on(blocking("任务前缀", || -> Result<i32, String> {
                panic!("boom");
            }));
        let e = r.unwrap_err();
        assert!(e.starts_with("任务前缀: "), "实际: {e}");
    }

    #[test]
    fn blocking_value_回传非Result闭包的值() {
        let v: Result<String, String> =
            rt().block_on(blocking_value("任务", || "value".to_string()));
        assert_eq!(v.unwrap(), "value");
    }
}
