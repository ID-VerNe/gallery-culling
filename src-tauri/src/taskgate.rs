//! FR-09 后端任务槽：**前端能禁用按钮，挡不住并发 IPC**。
//!
//! 背景：`scan_cancel` / `export_cancel` 是 `AppState` 上的**全局**标志。两次扫描
//! 并发时，第二次入口的 `cancel.store(false)` 会把第一次的取消请求抹掉 —— 用户
//! 点了取消，任务却继续跑。两个导出并发则会互相覆盖临时目录。
//!
//! 所以后端必须自己拒绝，而不是信任 UI。这里用 RAII：
//!
//! ```ignore
//! let _guard = state.tasks.try_begin(Activity::Scan)?; // 函数结束自动释放
//! ```
//!
//! **无死锁**的三条保证：
//! 1. 只有一把锁，临界区内不做 IO、不 await；
//! 2. `try_begin` 永不阻塞等待另一个任务结束（要么立即拿到，要么立即 `E_BUSY`）；
//! 3. 释放靠 `Drop`，任务 panic / 提前 return 也会解锁。
//!
//! 互斥表是前端 `src/utils/taskMutex.ts` 的后端子集。两边各有一份，跨语言无法
//! 共享常量；各自都有「对称性」测试兜底，改动时必须同时改。

use std::collections::HashSet;
use std::fmt;
use std::sync::Mutex;

/// 错误前缀：前端据此把「忙」与真实失败区分开（可显示不同语气）。
pub const E_BUSY: &str = "E_BUSY";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Activity {
    Scan,
    Export,
    Render,
    Ai,
    Refresh,
}

impl Activity {
    /// 中文标签：错误文案直接用它。
    pub fn label(self) -> &'static str {
        match self {
            Activity::Scan => "扫描照片",
            Activity::Export => "导出照片",
            Activity::Render => "渲染导出",
            Activity::Ai => "AI 蒙版",
            Activity::Refresh => "读取 XMP",
        }
    }
}

/// 后端这四种活动两两互斥。
///
/// 它们分别对应：共享取消标志（Scan/Export）、共享 LUMEN 编辑态
/// （Render/Ai）、以及读同一批文件。将来若加入「可与扫描并行」的活动
/// （例如缩略图），**不能**直接塞进这个列表，要改成显式邻接表。
const EXCLUSIVE: [Activity; 5] = [
    Activity::Scan,
    Activity::Export,
    Activity::Render,
    Activity::Ai,
    Activity::Refresh,
];

/// 两个活动是否不能同时存在。**自反**：同一活动也不允许开两份。
fn conflicts(a: Activity, b: Activity) -> bool {
    a == b || (EXCLUSIVE.contains(&a) && EXCLUSIVE.contains(&b))
}

/// 拒绝理由：谁在跑、你想干什么。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusyError {
    pub activity: Activity,
    pub blockers: Vec<Activity>,
}

impl fmt::Display for BusyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names = self
            .blockers
            .iter()
            .map(|a| a.label())
            .collect::<Vec<_>>()
            .join("、");
        write!(
            f,
            "{}: 正在{}，暂时不能{}。",
            E_BUSY,
            names,
            self.activity.label()
        )
    }
}

impl std::error::Error for BusyError {}

/// 任务槽：活跃活动集合。
#[derive(Debug, Default)]
pub struct TaskGate {
    active: Mutex<HashSet<Activity>>,
}

impl TaskGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// 尝试占用。成功返回的 guard 在 `Drop` 时释放。
    ///
    /// 永不阻塞：冲突时立刻返回 `BusyError`，调用方（命令层）把它转成 `Err(String)`。
    pub fn try_begin(&self, activity: Activity) -> Result<TaskGuard<'_>, BusyError> {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let blockers: Vec<Activity> = active
            .iter()
            .copied()
            .filter(|a| conflicts(activity, *a))
            .collect();
        if !blockers.is_empty() {
            // 排序只为文案稳定（HashSet 迭代顺序不定）。
            let mut blockers = blockers;
            blockers.sort_by_key(|a| EXCLUSIVE.iter().position(|x| x == a).unwrap_or(0));
            return Err(BusyError { activity, blockers });
        }
        active.insert(activity);
        Ok(TaskGuard {
            gate: self,
            activity,
        })
    }

    /// 当前活跃活动（仅测试与诊断用；顺序不保证）。
    ///
    /// `cfg(test)`：生产代码不应该有「读一眼槽位」的需求 —— 需要判断就用
    /// `try_begin`，它同时完成判定与占用。
    #[cfg(test)]
    pub fn active(&self) -> Vec<Activity> {
        let active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        active.iter().copied().collect()
    }
}

/// 占用凭据。**只能由 `try_begin` 产生**，释放不可取消。
#[derive(Debug)]
pub struct TaskGuard<'a> {
    gate: &'a TaskGate,
    activity: Activity,
}

impl Drop for TaskGuard<'_> {
    fn drop(&mut self) {
        // poison 也要释放：panic 之后更不能再把槽位永久占住。
        let mut active = self.gate.active.lock().unwrap_or_else(|e| e.into_inner());
        active.remove(&self.activity);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_begin_succeeds() {
        let gate = TaskGate::new();
        let _g = gate.try_begin(Activity::Scan).expect("首次占用应成功");
        assert_eq!(gate.active(), vec![Activity::Scan]);
    }

    #[test]
    fn same_activity_reentry_is_rejected() {
        let gate = TaskGate::new();
        let _g = gate.try_begin(Activity::Export).unwrap();
        let err = gate.try_begin(Activity::Export).unwrap_err();
        assert_eq!(err.activity, Activity::Export);
        assert_eq!(err.blockers, vec![Activity::Export]);
        assert!(err.to_string().starts_with(E_BUSY));
        assert!(err.to_string().contains("正在导出照片"));
    }

    #[test]
    fn mutually_exclusive_activity_is_rejected() {
        let gate = TaskGate::new();
        let _g = gate.try_begin(Activity::Export).unwrap();
        let err = gate.try_begin(Activity::Scan).unwrap_err();
        assert_eq!(err.blockers, vec![Activity::Export]);
        assert_eq!(
            err.to_string(),
            "E_BUSY: 正在导出照片，暂时不能扫描照片。"
        );
    }

    #[test]
    fn render_and_ai_are_exclusive() {
        let gate = TaskGate::new();
        let _g = gate.try_begin(Activity::Render).unwrap();
        assert!(gate.try_begin(Activity::Ai).is_err());
    }

    #[test]
    fn dropping_the_guard_releases_the_slot() {
        let gate = TaskGate::new();
        {
            let _g = gate.try_begin(Activity::Scan).unwrap();
            assert!(gate.try_begin(Activity::Export).is_err());
        }
        assert!(gate.active().is_empty());
        assert!(gate.try_begin(Activity::Export).is_ok());
    }

    #[test]
    fn dropping_one_guard_does_not_release_another() {
        let gate = TaskGate::new();
        let g1 = gate.try_begin(Activity::Scan).unwrap();
        drop(g1);
        let _g2 = gate.try_begin(Activity::Scan).unwrap();
        // 第二个 guard 仍在：不能再进。
        assert!(gate.try_begin(Activity::Scan).is_err());
    }

    #[test]
    fn busy_error_lists_multiple_blockers_in_stable_order() {
        // 正常路径不会同时有两个阻塞者（互斥表保证），但错误类型必须能表达。
        let err = BusyError {
            activity: Activity::Scan,
            blockers: vec![Activity::Export, Activity::Ai],
        };
        assert_eq!(
            err.to_string(),
            "E_BUSY: 正在导出照片、AI 蒙版，暂时不能扫描照片。"
        );
    }

    /// 表对称性：A 与 B 冲突当且仅当 B 与 A 冲突。
    /// 不对称会造出「A 在跑时 B 进不来，B 在跑时 A 却能进」的诡异状态。
    #[test]
    fn conflict_relation_is_symmetric() {
        for a in EXCLUSIVE {
            for b in EXCLUSIVE {
                assert_eq!(
                    conflicts(a, b),
                    conflicts(b, a),
                    "{:?} 与 {:?} 的冲突关系不对称",
                    a,
                    b
                );
            }
        }
    }

    #[test]
    fn every_activity_has_a_chinese_label() {
        for a in EXCLUSIVE {
            let label = a.label();
            assert!(!label.is_empty());
            assert!(
                label.chars().any(|c| c as u32 > 0x4e00),
                "{:?} 的标签应为中文，实际是 {}",
                a,
                label
            );
        }
    }
}
