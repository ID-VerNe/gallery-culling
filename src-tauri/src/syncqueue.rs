//! 写盘合并（FR-03）：把同一张照片的连续改动折叠成一次落盘。
//!
//! 问题：快速选片时按 `1..5` / `P` / `X`，每按一次都是一条 IPC + 一次完整 XMP
//! 读-改-写。同一张照片被连按五次就是五次重写；更糟的是**写失败时磁盘上什么
//! 都没有留下**，用户关掉应用，这次改动就消失了。
//!
//! 这里做两件事：
//! 1. **意图先落盘**（`pending_xmp`，调用方在 submit 之前写），崩溃后能回放；
//! 2. **同一照片的连续改动只写一次**：400ms 静默窗口内后到的值覆盖先到的，
//!    窗口结束由其中一个等待者执行落盘，其余等待者共享同一结果。
//!
//! 三条纪律：
//! - **值以最新为准**：折叠时保留最后一个意图，落盘的也必须是它；
//! - **失败不吞**：写失败的结果发给**每一个**等待者，调用方仍能弹错误提示；
//! - **不做全局串行**：不同照片各自独立，批量写盘不会被单张的防抖拖慢
//!   （批量路径显式传 `coalesce = false`，立即落盘）。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::db::{self, Database};
use crate::xmp;

/// 静默窗口：最后一次改动之后这么久没有新改动，才认为这一轮结束了。
pub const DEBOUNCE: Duration = Duration::from_millis(400);

/// 等待落盘结果的兜底超时。正常路径远小于它；超时说明队列线程出了异常，
/// 宁可报错也不要把界面卡死。
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// 一次待落盘的意图。同一照片后到的覆盖先到的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Intent {
    /// 照片路径（JPG 或 RAW 分组里实际有侧边栏的那个）。
    pub photo_path: PathBuf,
    pub rating: u8,
    pub flag: String,
    /// 是否写 XMP。`false` 时只落本地旗标存储。
    pub sync_xmp: bool,
}

/// 真正的落盘动作。抽成 trait 是为了让合并逻辑能在不碰磁盘的前提下被测到。
pub trait IntentSink: Send + Sync {
    fn write(&self, intent: &Intent) -> Result<(), String>;
}

/// 一次 submit 的结果。
#[derive(Debug)]
pub struct Outcome {
    /// 落盘结果。折叠时多个调用方共享同一个结果。
    pub result: Result<(), String>,
    /// **实际落盘**的意图（可能比调用方提交的更新）。
    pub intent: Intent,
    /// 本次调用是否就是执行落盘的那个。批量推送 LUMEN 之类「每次落盘只该做一次」
    /// 的副作用必须以此为准，否则折叠的 N 个调用方会各推一遍。
    pub wrote: bool,
}

#[derive(Debug, Clone)]
struct Written {
    result: Result<(), String>,
    intent: Intent,
}

struct Slot {
    intent: Intent,
    /// 静默窗口的截止时刻。每次新提交都往后推。
    deadline: Instant,
    /// 等待这一轮结果的调用方。落盘者会把结果发给**全部**等待者（含自己）。
    waiters: Vec<Sender<Written>>,
}

pub struct Coalescer {
    debounce: Duration,
    sink: Arc<dyn IntentSink>,
    slots: Mutex<BTreeMap<String, Slot>>,
}

impl Coalescer {
    pub fn new(sink: Arc<dyn IntentSink>) -> Self {
        Self::with_debounce(sink, DEBOUNCE)
    }

    pub fn with_debounce(sink: Arc<dyn IntentSink>, debounce: Duration) -> Self {
        Self {
            debounce,
            sink,
            slots: Mutex::new(BTreeMap::new()),
        }
    }

    /// 提交一次意图并**阻塞到它（或覆盖它的更新值）落盘为止**。
    ///
    /// `coalesce = false` 表示「这一笔不需要等后续改动」——批量写盘、重试、
    /// 撤销走这条；按键连击走 `true`。
    pub fn submit(&self, intent: Intent, coalesce: bool) -> Result<Outcome, String> {
        let key = intent.photo_path.to_string_lossy().to_string();
        let (tx, rx) = mpsc::channel();

        {
            let mut slots = self
                .slots
                .lock()
                .map_err(|e| format!("写盘队列锁异常: {}", e))?;
            let deadline = if coalesce {
                Instant::now() + self.debounce
            } else {
                Instant::now()
            };
            match slots.get_mut(&key) {
                Some(slot) => {
                    // 后到的覆盖先到的：只保留最新意图，窗口重新计时。
                    slot.intent = intent;
                    slot.deadline = deadline;
                    slot.waiters.push(tx);
                }
                None => {
                    slots.insert(
                        key.clone(),
                        Slot {
                            intent,
                            deadline,
                            waiters: vec![tx],
                        },
                    );
                }
            }
        }

        self.await_slot(&key, &rx)
    }

    /// 等自己的槽位被处理：到点就自己落盘，没到点就等别人。
    fn await_slot(&self, key: &str, rx: &Receiver<Written>) -> Result<Outcome, String> {
        loop {
            let state = {
                let slots = self
                    .slots
                    .lock()
                    .map_err(|e| format!("写盘队列锁异常: {}", e))?;
                match slots.get(key) {
                    // 槽位已被别的等待者取走：结果一定在路上。
                    None => SlotState::Orphan,
                    Some(slot) if Instant::now() >= slot.deadline => SlotState::Flush,
                    Some(slot) => {
                        SlotState::Wait(slot.deadline.saturating_duration_since(Instant::now()))
                    }
                }
            };

            match state {
                SlotState::Flush => {
                    let slot = {
                        let mut slots = self
                            .slots
                            .lock()
                            .map_err(|e| format!("写盘队列锁异常: {}", e))?;
                        match slots.remove(key) {
                            // 锁外重取时槽位可能已被别人拿走（同一毫秒到点）：
                            // 退化成等待者，别重复落盘。
                            Some(slot) => slot,
                            None => continue,
                        }
                    };
                    // 落盘在锁外做：写盘是慢操作，不能挡住其它照片。
                    let result = self.sink.write(&slot.intent);
                    let written = Written {
                        result: result.clone(),
                        intent: slot.intent,
                    };
                    for waiter in slot.waiters {
                        let _ = waiter.send(written.clone());
                    }
                    let got = recv(rx)?;
                    return Ok(Outcome {
                        result: got.result,
                        intent: got.intent,
                        wrote: true,
                    });
                }
                SlotState::Wait(wait) => match rx.recv_timeout(wait) {
                    Ok(w) => {
                        return Ok(Outcome {
                            result: w.result,
                            intent: w.intent,
                            wrote: false,
                        })
                    }
                    // 窗口被后来的提交推后了：重新读一次截止时刻。
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => {
                        return Err("写盘队列异常：结果通道已关闭".to_string())
                    }
                },
                SlotState::Orphan => {
                    let got = recv(rx)?;
                    return Ok(Outcome {
                        result: got.result,
                        intent: got.intent,
                        wrote: false,
                    });
                }
            }
        }
    }
}

enum SlotState {
    Flush,
    Wait(Duration),
    Orphan,
}

fn recv(rx: &Receiver<Written>) -> Result<Written, String> {
    match rx.recv_timeout(WRITE_TIMEOUT) {
        Ok(w) => Ok(w),
        Err(RecvTimeoutError::Timeout) => Err("等待落盘结果超时".to_string()),
        Err(RecvTimeoutError::Disconnected) => {
            Err("写盘队列异常：结果通道已关闭".to_string())
        }
    }
}

/// 启动回放：把上次没写完的意图重新落盘（FR-03 的「零丢失」靠它兜底）。
///
/// 冲突规则：侧边栏 mtime **晚于**记录时间，说明用户做完这次改动之后又被别的
/// 程序（Lightroom / Bridge）改过 —— 以外部为准，不覆盖，只删掉这条过期意图。
/// 覆盖别人刚改的数据，比丢掉一次自己没落盘的改动严重得多。
pub fn replay_pending(db: &Database, coalescer: &Coalescer) -> Result<usize, String> {
    let pending = db.count_pending()?;
    if pending == 0 {
        return Ok(0);
    }
    eprintln!("发现 {} 条未落盘的标记，开始回放", pending);

    let rows = db.list_pending()?;
    let mut written = 0usize;
    for row in rows {
        let path = PathBuf::from(&row.photo_path);
        let sidecar = xmp::get_xmp_path(&path);
        if db::file_mtime_secs(&sidecar) > row.updated_at {
            eprintln!(
                "跳过待写盘记录（侧边栏在本次改动之后被外部修改过）: {}",
                row.photo_path
            );
            let _ = db.delete_pending(&row.photo_path);
            continue;
        }
        let intent = Intent {
            photo_path: path,
            rating: row.rating,
            flag: row.flag,
            sync_xmp: true,
        };
        // 回放逐条立即写：没有「后续改动」需要等，别在启动时白等防抖窗口。
        match coalescer.submit(intent, false) {
            Ok(Outcome { result: Ok(()), .. }) => written += 1,
            Ok(Outcome { result: Err(e), .. }) => {
                eprintln!("回放待写盘记录失败（{}）: {}", row.photo_path, e)
            }
            Err(e) => eprintln!("回放待写盘记录失败（{}）: {}", row.photo_path, e),
        }
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;
    use std::thread;

    /// 只记账、不碰磁盘的 sink：合并逻辑的正确性不该依赖真实文件系统。
    struct CountingSink {
        writes: Mutex<Vec<Intent>>,
        fail: bool,
    }

    impl CountingSink {
        fn ok() -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                fail: false,
            }
        }

        fn failing() -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                fail: true,
            }
        }

        fn count(&self) -> usize {
            self.writes.lock().unwrap().len()
        }

        fn last(&self) -> Option<Intent> {
            self.writes.lock().unwrap().last().cloned()
        }
    }

    impl IntentSink for CountingSink {
        fn write(&self, intent: &Intent) -> Result<(), String> {
            self.writes.lock().unwrap().push(intent.clone());
            if self.fail {
                Err("磁盘已满".to_string())
            } else {
                Ok(())
            }
        }
    }

    fn intent(name: &str, rating: u8) -> Intent {
        Intent {
            photo_path: PathBuf::from(format!("C:/photos/{}.JPG", name)),
            rating,
            flag: "none".to_string(),
            sync_xmp: true,
        }
    }

    /// 5 个并发提交（模拟连按 1..5）：只能落盘一次，且落的是最新值。
    ///
    /// 用固定间隔错开发车来固定「最新」的归属：Windows 的 sleep 精度足够撑住
    /// 25ms 的间隔，而窗口有 200ms。
    #[test]
    fn burst_writes_once_with_latest_value() {
        let sink = Arc::new(CountingSink::ok());
        let queue = Arc::new(Coalescer::with_debounce(
            sink.clone(),
            Duration::from_millis(200),
        ));
        let barrier = Arc::new(Barrier::new(5));

        let mut handles = Vec::new();
        for rating in 1..=5u8 {
            let queue = Arc::clone(&queue);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                thread::sleep(Duration::from_millis(rating as u64 * 25));
                queue.submit(intent("a", rating), true)
            }));
        }
        for handle in handles {
            handle.join().unwrap().expect("每次提交都该成功");
        }

        assert_eq!(sink.count(), 1, "同一张照片的连续 5 次改动只能落盘 1 次");
        assert_eq!(
            sink.last().unwrap().rating,
            5,
            "折叠后落盘的必须是最新值，不能是窗口里最早的那个"
        );
    }

    /// 折叠的 N 个调用方都要拿到成功，不能只有落盘者拿到。
    #[test]
    fn every_waiter_sees_the_result() {
        let sink = Arc::new(CountingSink::ok());
        let queue = Arc::new(Coalescer::with_debounce(
            sink.clone(),
            Duration::from_millis(150),
        ));
        let barrier = Arc::new(Barrier::new(4));

        let mut handles = Vec::new();
        for rating in 1..=4u8 {
            let queue = Arc::clone(&queue);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                thread::sleep(Duration::from_millis(rating as u64 * 20));
                queue.submit(intent("a", rating), true)
            }));
        }
        for handle in handles {
            let outcome = handle.join().unwrap().expect("每个等待者都该拿到 Ok");
            assert!(outcome.result.is_ok());
        }
        assert_eq!(sink.count(), 1);
    }

    /// 「每次落盘只做一次」的副作用（推 LUMEN）靠 `wrote` 去重：只能有一个 true。
    #[test]
    fn exactly_one_caller_reports_wrote() {
        let sink = Arc::new(CountingSink::ok());
        let queue = Arc::new(Coalescer::with_debounce(
            sink.clone(),
            Duration::from_millis(150),
        ));
        let barrier = Arc::new(Barrier::new(4));
        let wrote = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for rating in 1..=4u8 {
            let queue = Arc::clone(&queue);
            let barrier = Arc::clone(&barrier);
            let wrote = Arc::clone(&wrote);
            handles.push(thread::spawn(move || {
                barrier.wait();
                thread::sleep(Duration::from_millis(rating as u64 * 20));
                let outcome = queue.submit(intent("a", rating), true).unwrap();
                if outcome.wrote {
                    wrote.fetch_add(1, Ordering::SeqCst);
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            wrote.load(Ordering::SeqCst),
            1,
            "折叠后只能有一个调用方报告「我落盘了」"
        );
    }

    /// 后到的提交必须把静默窗口往后推，否则连按的中间值会被提前写出去。
    #[test]
    fn later_submit_extends_the_window() {
        let sink = Arc::new(CountingSink::ok());
        let queue = Arc::new(Coalescer::with_debounce(
            sink.clone(),
            Duration::from_millis(200),
        ));

        let q1 = Arc::clone(&queue);
        let first = thread::spawn(move || q1.submit(intent("a", 1), true));
        thread::sleep(Duration::from_millis(100));

        // 第二次提交把截止时刻推到 t=300ms。
        let q2 = Arc::clone(&queue);
        let second = thread::spawn(move || q2.submit(intent("a", 2), true));

        // t=250ms：原截止（200ms）已过，新截止（300ms）未到。
        thread::sleep(Duration::from_millis(150));
        assert_eq!(
            sink.count(),
            0,
            "窗口被推后了，t=250ms 不该已经落盘"
        );

        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
        assert_eq!(sink.count(), 1);
        assert_eq!(sink.last().unwrap().rating, 2);
    }

    /// 不同照片互不干扰：一张的防抖不能拖住另一张。
    #[test]
    fn distinct_paths_are_not_merged() {
        let sink = Arc::new(CountingSink::ok());
        let queue = Arc::new(Coalescer::with_debounce(
            sink.clone(),
            Duration::from_millis(80),
        ));
        let barrier = Arc::new(Barrier::new(2));

        let mut handles = Vec::new();
        for name in ["a", "b"] {
            let queue = Arc::clone(&queue);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                queue.submit(intent(name, 3), true)
            }));
        }
        for handle in handles {
            handle.join().unwrap().unwrap();
        }
        assert_eq!(sink.count(), 2, "两张照片必须各写各的");
    }

    /// 批量路径传 coalesce=false：不该被防抖窗口拖住。
    #[test]
    fn coalesce_false_writes_without_waiting() {
        let sink = Arc::new(CountingSink::ok());
        let queue = Coalescer::with_debounce(sink.clone(), Duration::from_secs(5));

        let started = Instant::now();
        queue.submit(intent("a", 3), false).expect("应成功");
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "coalesce=false 不该等 5 秒的防抖窗口"
        );
        assert_eq!(sink.count(), 1);
    }

    /// 写失败必须传回**每一个**等待者，否则折叠掉的调用方会以为写成功了。
    #[test]
    fn write_error_reaches_every_waiter() {
        let sink = Arc::new(CountingSink::failing());
        let queue = Arc::new(Coalescer::with_debounce(
            sink.clone(),
            Duration::from_millis(120),
        ));
        let barrier = Arc::new(Barrier::new(3));

        let mut handles = Vec::new();
        for rating in 1..=3u8 {
            let queue = Arc::clone(&queue);
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                barrier.wait();
                thread::sleep(Duration::from_millis(rating as u64 * 20));
                queue.submit(intent("a", rating), true)
            }));
        }
        let mut failures = 0;
        for handle in handles {
            let outcome = handle.join().unwrap().expect("submit 本身不该失败");
            if outcome.result.is_err() {
                failures += 1;
            }
        }
        assert_eq!(failures, 3, "三个等待者都必须看到失败");
        assert_eq!(sink.count(), 1, "失败也只尝试写一次");
    }

    /// 上一轮落盘结束后，同一张照片的新改动要开新的一轮。
    #[test]
    fn submit_after_flush_starts_a_new_write() {
        let sink = Arc::new(CountingSink::ok());
        let queue = Coalescer::with_debounce(sink.clone(), Duration::from_millis(20));

        queue.submit(intent("a", 1), true).unwrap();
        queue.submit(intent("a", 2), true).unwrap();

        assert_eq!(sink.count(), 2);
        assert_eq!(sink.last().unwrap().rating, 2);
    }
}
