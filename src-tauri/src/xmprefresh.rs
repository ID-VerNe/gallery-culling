//! FR-08：XMP 增量导入与冲突裁决。
//!
//! 问题：扫描时读 XMP，但**运行期间不监听外部变化**。用户在 Lightroom 改完
//! 评级回来，界面还是旧值，必须整个重扫（10k 张要几十秒）。
//!
//! 这里做增量：先 stat 侧边栏的 mtime，与 `xmp_cursor` 里的记录比 —— 一致就
//! 一个字节都不读，只有变了的才解析。10k 张里通常只有个位数变化。
//!
//! 三条纪律：
//! - **不自动覆盖**：本地有未落盘意图（`pending_xmp`）且外部也改了 → 冲突，
//!   交用户裁决。这与 LUMEN 的评级冲突模型一致。
//! - **mtime 只是预筛**：mtime 变了但内容没变（外部只是重新保存了一次）不打扰
//!   界面，只推进游标。
//! - **没有游标就不猜**：从未见过的侧边栏只建立基线，不产生「更新」。否则升级
//!   用户第一次刷新会把全部照片报成「已更新 10000 张」。
//!
//! 与 `check_cull_state_cmd` 的分工：那条比**内容**（撤销前必须精确，量小）；
//! 这条比 **mtime 预筛 + 内容确认**（聚焦时触发，量大）。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cullstore;
use crate::db::{Database, XmpCursor};
use crate::models::PhotoGroupInfo;
use crate::xmp;

/// 分组的主路径：RAW 优先。
///
/// **必须与前端 `groupPath()` 逐字一致** —— 写盘、刷新、游标三条路径都靠它
/// 定位同一个 sidecar。前端改了而这里没改，会造出「写 RAW、读 JPG」这种
/// 两边各说各话的状态。
pub fn primary_photo_path(group: &PhotoGroupInfo) -> Option<&str> {
    group
        .raw
        .as_ref()
        .or(group.jpg.as_ref())
        .map(|f| f.path.as_str())
}

/// 一张照片的三项标记状态。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CullState {
    pub rating: u8,
    /// `pick` | `reject` | `none`
    pub flag: String,
    /// `""` 表示无色标
    pub label: String,
}

impl CullState {
    pub fn new(rating: u8, flag: &str, label: &str) -> Self {
        Self {
            rating,
            flag: flag.to_string(),
            label: label.to_string(),
        }
    }
}

/// 一次刷新的目标：一个分组的主路径 + JPG 路径（旗标存储的兜底）。
#[derive(Debug, Clone, Deserialize)]
pub struct RefreshTarget {
    /// 主路径，RAW 优先 —— 必须与前端 `groupPath()` 和写盘路径一致。
    pub path: String,
    /// JPG 路径：只用于旗标存储的兜底查找，与扫描的 `store_entry` 同义。
    #[serde(default)]
    pub jpg_path: Option<String>,
}

/// 一次读到的磁盘侧状态。
///
/// `retouched`（issue #200）**只用于判断要不要推一条更新**，不参与冲突裁决：
/// 它不是用户的评级意图，没有「本地未落盘 vs 磁盘」这层语义。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskXmp {
    pub rating: u8,
    pub rejected: bool,
    pub label: String,
    pub retouched: bool,
}

/// 侧边栏探测。抽成 trait 是为了让「mtime 一致时零读取」这条能被测到 ——
/// 用真实文件测不出来（改了内容 mtime 必然变，没法造「mtime 不变但内容不同」）。
pub trait SidecarProbe: Send + Sync {
    /// 侧边栏的毫秒级 mtime；不存在或读不到元数据返回 `None`。
    fn mtime_ms(&self, sidecar: &Path) -> Option<i64>;
    /// 读 XMP 的星级 / 是否淘汰 / 色标 / 是否经 ACR 精修。读失败返回 `None`。
    ///
    /// 这里的 `retouched` 只代表**sidecar 里写的**判据（`crs:HasSettings`）；
    /// 照片旁 `.acr` 那一路由 [`SidecarProbe::acr_exists`] 单独提供，两者在
    /// `refresh` 里取或。分开是为了让「sidecar 被删了但 .acr 还在」这条能测 ——
    /// 合在一起时它读的是真实文件系统，测试就只能靠现造文件，跨平台还脆。
    fn read_xmp(&self, photo: &Path) -> Option<DiskXmp>;

    /// 照片旁有没有同名 `.acr`。
    fn acr_exists(&self, photo: &Path) -> bool;
}

/// 真实文件系统探测。
pub struct FsProbe;

impl SidecarProbe for FsProbe {
    fn mtime_ms(&self, sidecar: &Path) -> Option<i64> {
        crate::db::file_mtime_ms(sidecar)
    }

    fn read_xmp(&self, photo: &Path) -> Option<DiskXmp> {
        let xmp_path = xmp::get_xmp_path(photo);
        if !xmp_path.exists() {
            return None;
        }
        // `read_xmp_full` 读不到内容时返回 None；这里保留它的 None 语义，
        // 与旧 `read_disk_state` 的「空状态」区分开：读失败不能当成「外部清空」。
        let meta = xmp::read_xmp_full(&xmp_path)?;
        Some(DiskXmp {
            rating: meta.rating,
            rejected: meta.rejected,
            label: meta.label,
            retouched: meta.acr_edited,
        })
    }

    fn acr_exists(&self, photo: &Path) -> bool {
        photo.with_extension("acr").is_file()
    }
}

/// 一张照片的采用结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefreshItem {
    /// 照片路径（与 `RefreshTarget::path` 一致，前端据此匹配分组）。
    pub path: String,
    pub state: CullState,
    /// 是否经 ACR/PS 精修（issue #200）。与 `state` 独立：星级没变、只修了图，也要推上来。
    pub retouched: bool,
    /// 侧边栏在磁盘上已不存在（外部删除）→ 前端可以额外提示一句。
    pub sidecar_removed: bool,
}

/// 需要用户裁决的一张照片。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefreshConflict {
    pub path: String,
    /// 本地未落盘的意图
    pub local: CullState,
    /// 磁盘上的当前值
    pub external: CullState,
}

/// 一次刷新的汇总。
#[derive(Debug, Clone, Default, Serialize)]
pub struct RefreshReport {
    /// 参与检查的目标数（去重后）
    pub checked: usize,
    /// 无事发生：mtime 一致 / 内容一致 / 从未见过且文件不存在
    pub unchanged: usize,
    /// 首次见到并建立了基线（不产生更新）
    pub baselined: usize,
    /// 采用的外部值
    pub adopted: Vec<RefreshItem>,
    /// 待裁决
    pub conflicts: Vec<RefreshConflict>,
    /// 读失败的路径（权限 / 文件在 stat 之后消失）
    pub failed: Vec<String>,
}

/// 冲突判定：本地有没有未落盘的意图，磁盘同不同意。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 无未同步意图 → 采用磁盘值
    Adopt,
    /// 有意图但内容与磁盘一致（上次写完没删干净）→ 视为已同步
    AlreadySynced,
    /// 有意图且磁盘内容不同 → 冲突，交用户裁决
    Conflict,
}

/// 纯判定，不碰磁盘。三条分支各有测试，防止退化成「只比星级」。
pub fn decide(pending: Option<&CullState>, disk: &CullState) -> Decision {
    match pending {
        None => Decision::Adopt,
        Some(p) if p == disk => Decision::AlreadySynced,
        Some(_) => Decision::Conflict,
    }
}

/// 把一次扫描的结果转成增量基线。
///
/// 抽成独立函数（而不是塞在命令层）是为了能直接测：命令层要 `AppHandle`，
/// 测不起来，而「哪些分组该进基线」正是最容易写错的地方（没有 sidecar 的
/// 分组不该写 —— 写了会让第一次刷新把它误判成「外部删除」）。
pub fn build_cursors(groups: &[PhotoGroupInfo]) -> Vec<XmpCursor> {
    groups
        .iter()
        .filter_map(|group| {
            let photo = primary_photo_path(group)?;
            let sidecar = xmp::get_xmp_path(Path::new(photo));
            let mtime_ms = crate::db::file_mtime_ms(&sidecar)?;
            Some(XmpCursor {
                sidecar_path: sidecar.to_string_lossy().to_string(),
                mtime_ms,
                rating: group.rating,
                flag: group.flag.clone(),
                label: group.label.clone(),
                retouched: group.retouched,
            })
        })
        .collect()
}

/// 增量刷新：只读变了的侧边栏。
pub fn refresh(
    db: &Database,
    probe: &dyn SidecarProbe,
    targets: Vec<RefreshTarget>,
) -> RefreshReport {
    let targets = dedupe(targets);
    let mut report = RefreshReport {
        checked: targets.len(),
        ..Default::default()
    };
    if targets.is_empty() {
        return report;
    }

    // 先把所有 sidecar 的 mtime 并行 stat 出来。10k 张串行 stat 在 Windows 上
    // 要 1 秒以上；这一步只碰元数据，没有任何写操作，可以放心并行。
    let sidecars: Vec<PathBuf> = targets
        .iter()
        .map(|t| xmp::get_xmp_path(Path::new(&t.path)))
        .collect();
    let mtimes = probe_mtimes(probe, &sidecars);

    // 旗标存储按文件夹缓存：一次刷新只读一次 `.gallerycull.json`。
    let mut stores: HashMap<PathBuf, cullstore::Store> = HashMap::new();

    for ((target, sidecar), mtime) in targets.iter().zip(&sidecars).zip(mtimes) {
        let cursor = match db.lookup_xmp_cursor(&sidecar.to_string_lossy()) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("读取 XMP 游标失败（已跳过）: {}", e);
                report.failed.push(target.path.clone());
                continue;
            }
        };

        // 核心：mtime 与游标一致 → 零读取。10k 张的增量全靠这一条。
        if let (Some(m), Some(c)) = (mtime, cursor.as_ref()) {
            if m == c.mtime_ms {
                report.unchanged += 1;
                continue;
            }
        }

        // 从未见过 + 文件不存在 = 无事发生。**不能**据此把界面清成 0 星：
        // 侧边栏可能本来就在另一个目录（JPG 侧），而扫描时是从那边读的。
        if mtime.is_none() && cursor.is_none() {
            report.unchanged += 1;
            continue;
        }

        let first_seen = cursor.is_none();
        let sidecar_removed = mtime.is_none();

        // `.acr` 可能落在主路径旁边，也可能落在配对 JPG 旁边（分目录摆放时
        // 两边都可能出现），两处都要看。一次算好，两个分支共用。
        let acr_exists = probe.acr_exists(Path::new(&target.path))
            || target
                .jpg_path
                .as_deref()
                .is_some_and(|j| probe.acr_exists(Path::new(j)));

        let (disk, disk_retouched) = if sidecar_removed {
            // 外部删了侧边栏 → 采用空状态。三元标记没有依据了，但「已精修」还有
            // 一路独立证据：同名 `.acr` 还在的话，这张确实进过 ACR。
            (
                CullState::new(0, &resolve_flag_for(&mut stores, target, false, ""), ""),
                acr_exists,
            )
        } else {
            match probe.read_xmp(Path::new(&target.path)) {
                Some(d) => (
                    CullState::new(
                        d.rating,
                        &resolve_flag_for(&mut stores, target, d.rejected, &d.label),
                        &d.label,
                    ),
                    // sidecar 里的 `HasSettings` 与照片旁 `.acr` 任一命中即已修。
                    d.retouched || acr_exists,
                ),
                None => {
                    // mtime 说有文件、读却失败：不推进游标，下次再试。
                    report.failed.push(target.path.clone());
                    continue;
                }
            }
        };

        let pending = match db.lookup_pending(&target.path) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("读取待写盘意图失败（已跳过）: {}", e);
                report.failed.push(target.path.clone());
                continue;
            }
        };
        let local = pending.as_ref().map(|p| {
            CullState::new(p.rating, &p.flag, &p.label)
        });

        match decide(local.as_ref(), &disk) {
            Decision::Conflict => {
                // 冲突时不推进游标：下次刷新还要继续判，直到用户裁决。
                report.conflicts.push(RefreshConflict {
                    path: target.path.clone(),
                    local: local.expect("冲突必然有本地意图"),
                    external: disk,
                });
            }
            Decision::AlreadySynced => {
                // 意图与磁盘一致 = 上次其实写成功了，只是记录没删干净。
                let _ = db.delete_pending(&target.path);
                advance_cursor(db, sidecar, mtime, &disk, disk_retouched);
                if !sidecar_removed {
                    report.adopted.push(RefreshItem {
                        path: target.path.clone(),
                        state: disk,
                        retouched: disk_retouched,
                        sidecar_removed: false,
                    });
                }
            }
            Decision::Adopt => {
                advance_cursor(db, sidecar, mtime, &disk, disk_retouched);
                if first_seen {
                    report.baselined += 1;
                } else if sidecar_removed {
                    let _ = db.delete_xmp_cursor(&sidecar.to_string_lossy());
                    report.adopted.push(RefreshItem {
                        path: target.path.clone(),
                        state: disk,
                        // 星级/旗标无从判断了，但「修没修过」还有 `.acr` 这一路证据：
                        // 用户把 sidecar 挪走或删掉时，不该顺手抹掉精修标记。
                        retouched: disk_retouched,
                        sidecar_removed: true,
                    });
                } else if cursor.as_ref().map(state_of) == Some(disk.clone())
                    && cursor
                        .as_ref()
                        .is_some_and(|c| c.retouched == disk_retouched)
                {
                    // mtime 变了但内容没变（外部只是重新保存）→ 不打扰界面。
                    report.unchanged += 1;
                } else {
                    // 内容或「已精修」有一项变了就推：PS 里只修图不动星级，也要亮标（issue #200）。
                    report.adopted.push(RefreshItem {
                        path: target.path.clone(),
                        state: disk,
                        retouched: disk_retouched,
                        sidecar_removed: false,
                    });
                }
            }
        }
    }

    report
}

/// 游标里记的三项状态。
fn state_of(cursor: &XmpCursor) -> CullState {
    CullState::new(cursor.rating, &cursor.flag, &cursor.label)
}

/// 把「这一张现在长什么样」记进游标。
fn advance_cursor(
    db: &Database,
    sidecar: &Path,
    mtime: Option<i64>,
    state: &CullState,
    retouched: bool,
) {
    let Some(mtime) = mtime else {
        // 文件已不在：由调用方决定要不要删游标，这里不写。
        return;
    };
    let cursor = XmpCursor {
        sidecar_path: sidecar.to_string_lossy().to_string(),
        mtime_ms: mtime,
        rating: state.rating,
        flag: state.flag.clone(),
        label: state.label.clone(),
        retouched,
    };
    if let Err(e) = db.upsert_xmp_cursor(&cursor) {
        eprintln!("记录 XMP 游标失败（已忽略）: {}", e);
    }
}

/// 算磁盘侧的旗标：本地 store 优先（与扫描的 `store_entry` 同一条规则），
/// `Rating = -1` 仍是最高优先的硬信号。
fn resolve_flag_for(
    stores: &mut HashMap<PathBuf, cullstore::Store>,
    target: &RefreshTarget,
    rejected: bool,
    label: &str,
) -> String {
    let primary = Path::new(&target.path);
    let base_name = primary
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let legacy = xmp::legacy_flag_from_label(label);

    // 条目先克隆出来：`stores` 是可变的缓存，借用不能跨两次查询存活。
    let entry = lookup_entry(stores, primary.parent(), base_name).or_else(|| {
        // JPG 侧的 store 兜底：配了 RAW 目录后，历史条目可能只写在 JPG 旁边。
        let p = Path::new(target.jpg_path.as_deref()?);
        let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        lookup_entry(stores, p.parent(), name)
    });

    cullstore::resolve_flag(rejected, legacy, entry.as_ref())
}

/// 按目录懒加载并缓存旗标存储。目录缺失时返回空 store（与扫描的宽松读一致）。
fn lookup_entry(
    stores: &mut HashMap<PathBuf, cullstore::Store>,
    folder: Option<&Path>,
    base_name: &str,
) -> Option<cullstore::Entry> {
    let folder = folder?;
    let store = stores
        .entry(folder.to_path_buf())
        .or_insert_with(|| cullstore::load(folder));
    store.get(base_name).cloned()
}

/// 同一路径只查一次：重复目标会让计数与 `adopted` 都翻倍。
fn dedupe(targets: Vec<RefreshTarget>) -> Vec<RefreshTarget> {
    let mut seen: HashSet<String> = HashSet::new();
    targets
        .into_iter()
        .filter(|t| seen.insert(t.path.to_lowercase()))
        .collect()
}

/// 并行 stat。线程数取 `available_parallelism`，上限 8 —— 再多也不会更快，
/// 磁盘的随机读才是瓶颈。
fn probe_mtimes(probe: &dyn SidecarProbe, sidecars: &[PathBuf]) -> Vec<Option<i64>> {
    let mut out: Vec<Option<i64>> = vec![None; sidecars.len()];
    if sidecars.is_empty() {
        return out;
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .clamp(1, 8)
        .min(sidecars.len());
    let chunk = sidecars.len().div_ceil(threads);

    std::thread::scope(|scope| {
        for (slice, slots) in sidecars.chunks(chunk).zip(out.chunks_mut(chunk)) {
            scope.spawn(move || {
                for (sidecar, slot) in slice.iter().zip(slots.iter_mut()) {
                    *slot = probe.mtime_ms(sidecar);
                }
            });
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// 可控的假探测：mtime 与内容各自独立设置，并记录被调用了几次。
    ///
    /// 真实文件系统造不出「mtime 不变但内容不同」，而「零读取」正是本模块的
    /// 核心承诺 —— 必须能数出来。
    /// `(星级, 是否淘汰, 色标)` —— `SidecarProbe::read_xmp` 的返回形状。
    type XmpTriple = DiskXmp;

    #[derive(Default)]
    struct FakeProbe {
        mtimes: Mutex<HashMap<String, Option<i64>>>,
        states: Mutex<HashMap<String, Option<XmpTriple>>>,
        /// 照片旁「存在 .acr」的路径集合（issue #200）。
        acrs: Mutex<HashSet<String>>,
        mtime_calls: AtomicUsize,
        read_calls: AtomicUsize,
    }

    impl FakeProbe {
        fn new() -> Self {
            Self::default()
        }

        /// 侧边栏存在，内容为 (rating, rejected, label)。
        fn file(&self, photo: &str, mtime: i64, rating: u8, rejected: bool, label: &str) {
            let sidecar = xmp::get_xmp_path(Path::new(photo));
            self.mtimes
                .lock()
                .unwrap()
                .insert(sidecar.to_string_lossy().to_string(), Some(mtime));
            self.states.lock().unwrap().insert(
                photo.to_string(),
                Some(DiskXmp {
                    rating,
                    rejected,
                    label: label.to_string(),
                    retouched: false,
                }),
            );
        }

        /// 同上，但带上「已精修」（issue #200）。
        fn file_retouched(
            &self,
            photo: &str,
            mtime: i64,
            rating: u8,
            rejected: bool,
            label: &str,
            retouched: bool,
        ) {
            self.file(photo, mtime, rating, rejected, label);
            if let Some(Some(state)) = self.states.lock().unwrap().get_mut(photo) {
                state.retouched = retouched;
            }
        }

        /// 照片旁存在同名 `.acr`。
        fn acr_file(&self, photo: &str) {
            self.acrs.lock().unwrap().insert(photo.to_string());
        }

        /// 侧边栏不存在。
        fn missing(&self, photo: &str) {
            let sidecar = xmp::get_xmp_path(Path::new(photo));
            self.mtimes
                .lock()
                .unwrap()
                .insert(sidecar.to_string_lossy().to_string(), None);
            self.states
                .lock()
                .unwrap()
                .insert(photo.to_string(), None);
        }

        /// 元数据在、读内容失败（权限 / 编码问题）。
        fn unreadable(&self, photo: &str, mtime: i64) {
            let sidecar = xmp::get_xmp_path(Path::new(photo));
            self.mtimes
                .lock()
                .unwrap()
                .insert(sidecar.to_string_lossy().to_string(), Some(mtime));
            self.states
                .lock()
                .unwrap()
                .insert(photo.to_string(), None);
        }

        fn mtime_calls(&self) -> usize {
            self.mtime_calls.load(Ordering::SeqCst)
        }

        fn read_calls(&self) -> usize {
            self.read_calls.load(Ordering::SeqCst)
        }
    }

    impl SidecarProbe for FakeProbe {
        fn mtime_ms(&self, sidecar: &Path) -> Option<i64> {
            self.mtime_calls.fetch_add(1, Ordering::SeqCst);
            self.mtimes
                .lock()
                .unwrap()
                .get(&sidecar.to_string_lossy().to_string())
                .copied()
                .flatten()
        }

        fn read_xmp(&self, photo: &Path) -> Option<DiskXmp> {
            self.read_calls.fetch_add(1, Ordering::SeqCst);
            self.states
                .lock()
                .unwrap()
                .get(&photo.to_string_lossy().to_string())
                .cloned()
                .flatten()
        }

        fn acr_exists(&self, photo: &Path) -> bool {
            self.acrs
                .lock()
                .unwrap()
                .contains(&photo.to_string_lossy().to_string())
        }
    }

    fn temp_db(tag: &str) -> (Database, PathBuf) {
        let path = std::env::temp_dir().join(format!("gc_refresh_{}_{}.db", tag, std::process::id()));
        let _ = std::fs::remove_file(&path);
        (Database::open(&path).expect("建临时库"), path)
    }

    fn cursor(path: &str, mtime: i64, rating: u8, flag: &str, label: &str) -> XmpCursor {
        XmpCursor {
            sidecar_path: path.to_string(),
            mtime_ms: mtime,
            rating,
            flag: flag.to_string(),
            label: label.to_string(),
            retouched: false,
        }
    }

    fn target(path: &str) -> RefreshTarget {
        RefreshTarget {
            path: path.to_string(),
            jpg_path: None,
        }
    }

    fn targets(paths: &[&str]) -> Vec<RefreshTarget> {
        paths.iter().map(|p| target(p)).collect()
    }

    // ---------------------------------------------------------------
    // 纯判定：三条分支各一例，单字段差异单独覆盖
    // ---------------------------------------------------------------

    #[test]
    fn no_pending_adopts() {
        let disk = CullState::new(3, "none", "");
        assert_eq!(decide(None, &disk), Decision::Adopt);
    }

    #[test]
    fn matching_pending_is_already_synced() {
        let disk = CullState::new(3, "pick", "Red");
        assert_eq!(
            decide(Some(&CullState::new(3, "pick", "Red")), &disk),
            Decision::AlreadySynced
        );
    }

    #[test]
    fn differing_rating_is_conflict() {
        let disk = CullState::new(5, "none", "");
        assert_eq!(
            decide(Some(&CullState::new(4, "none", "")), &disk),
            Decision::Conflict
        );
    }

    /// 只比星级会漏掉「旗标改了」这一类冲突。
    #[test]
    fn differing_flag_alone_is_conflict() {
        let disk = CullState::new(4, "none", "");
        assert_eq!(
            decide(Some(&CullState::new(4, "pick", "")), &disk),
            Decision::Conflict
        );
    }

    /// 只比星级与旗标会漏掉「色标改了」这一类冲突。
    #[test]
    fn differing_label_alone_is_conflict() {
        let disk = CullState::new(4, "none", "Blue");
        assert_eq!(
            decide(Some(&CullState::new(4, "none", "Red")), &disk),
            Decision::Conflict
        );
    }

    // ---------------------------------------------------------------
    // 增量：mtime 是预筛，内容是确认
    // ---------------------------------------------------------------

    /// 核心承诺：mtime 与游标一致时**一个字节都不读**。
    #[test]
    fn unchanged_mtime_reads_nothing() {
        let (db, db_path) = temp_db("unchanged");
        let probe = FakeProbe::new();
        probe.file("C:/p/a.ARW", 1000, 3, false, "");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "none", ""))
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.checked, 1);
        assert_eq!(report.unchanged, 1);
        assert_eq!(probe.read_calls(), 0, "mtime 一致时不得读内容");
        assert!(report.adopted.is_empty());
        assert!(report.conflicts.is_empty());
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn changed_mtime_adopts_external_state() {
        let (db, db_path) = temp_db("changed");
        let probe = FakeProbe::new();
        probe.file("C:/p/a.ARW", 2000, 5, false, "Blue");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "none", ""))
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(probe.read_calls(), 1, "mtime 变了必须读一次");
        assert_eq!(report.adopted.len(), 1);
        assert_eq!(report.adopted[0].path, "C:/p/a.ARW");
        assert_eq!(report.adopted[0].state.rating, 5);
        assert_eq!(report.adopted[0].state.label, "Blue");
        assert!(!report.adopted[0].sidecar_removed);
        // 游标必须前进，否则每次聚焦都重读一遍
        let after = db.lookup_xmp_cursor("C:/p/a.xmp").unwrap().unwrap();
        assert_eq!(after.mtime_ms, 2000);
        assert_eq!(after.rating, 5);
        let _ = std::fs::remove_file(&db_path);
    }

    /// mtime 变了但内容没变（外部只是重新保存了一次）→ 不打扰界面。
    #[test]
    fn mtime_bump_without_content_change_is_silent() {
        let (db, db_path) = temp_db("bump");
        let probe = FakeProbe::new();
        probe.file("C:/p/a.ARW", 2000, 3, false, "");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "none", ""))
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert!(report.adopted.is_empty(), "内容没变不该报更新");
        assert_eq!(report.unchanged, 1);
        assert_eq!(probe.read_calls(), 1, "mtime 变了还是要读一次才能确认");
        assert_eq!(
            db.lookup_xmp_cursor("C:/p/a.xmp").unwrap().unwrap().mtime_ms,
            2000,
            "游标仍要前进，否则下次还要读"
        );
        let _ = std::fs::remove_file(&db_path);
    }

    /// 从未见过 → 只建立基线。否则升级用户第一次刷新会报「已更新 10000 张」。
    #[test]
    fn first_seen_only_baselines() {
        let (db, db_path) = temp_db("first_seen");
        let probe = FakeProbe::new();
        probe.file("C:/p/a.ARW", 1000, 3, false, "");

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.baselined, 1);
        assert!(report.adopted.is_empty(), "首次见到不产生更新");
        assert_eq!(probe.read_calls(), 1);
        let after = db.lookup_xmp_cursor("C:/p/a.xmp").unwrap();
        assert!(after.is_some(), "基线要落库，下次才能增量");
        assert_eq!(after.unwrap().rating, 3);
        let _ = std::fs::remove_file(&db_path);
    }

    /// 从未见过 + 文件不存在 = 无事发生。
    ///
    /// 这是最容易写错的一条：配了 RAW 目录但历史 sidecar 还在 JPG 旁边时，
    /// 主路径的 sidecar 本来就不存在 —— 把它当成「外部清空」会把 4 星变 0 星。
    #[test]
    fn missing_sidecar_without_cursor_is_ignored() {
        let (db, db_path) = temp_db("missing_none");
        let probe = FakeProbe::new();
        probe.missing("C:/p/a.ARW");

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert!(report.adopted.is_empty());
        assert!(report.conflicts.is_empty());
        assert_eq!(report.unchanged, 1);
        assert_eq!(report.baselined, 0);
        let _ = std::fs::remove_file(&db_path);
    }

    /// 有游标但文件没了 → 外部删除，采用空状态并清掉游标（避免每次刷新重报）。
    #[test]
    fn sidecar_removed_adopts_empty_state() {
        let (db, db_path) = temp_db("removed");
        let probe = FakeProbe::new();
        probe.missing("C:/p/a.ARW");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 4, "pick", "Red"))
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.adopted.len(), 1);
        let item = &report.adopted[0];
        assert_eq!(item.state, CullState::new(0, "none", ""));
        assert!(item.sidecar_removed);
        assert_eq!(probe.read_calls(), 0, "文件都不在了，不该再尝试解析");
        assert!(
            db.lookup_xmp_cursor("C:/p/a.xmp").unwrap().is_none(),
            "游标要清掉，否则每次刷新都重报一次"
        );
        let _ = std::fs::remove_file(&db_path);
    }

    /// 只有色标变了也是外部改动。
    #[test]
    fn label_change_alone_is_adopted() {
        let (db, db_path) = temp_db("label_only");
        let probe = FakeProbe::new();
        probe.file("C:/p/a.ARW", 2000, 3, false, "Purple");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "none", ""))
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.adopted.len(), 1);
        assert_eq!(report.adopted[0].state.label, "Purple");
        assert_eq!(report.adopted[0].state.rating, 3);
        let _ = std::fs::remove_file(&db_path);
    }

    // ---------------------------------------------------------------
    // 冲突：不自动覆盖
    // ---------------------------------------------------------------

    #[test]
    fn pending_and_external_change_is_conflict() {
        let (db, db_path) = temp_db("conflict");
        let probe = FakeProbe::new();
        probe.file("C:/p/a.ARW", 2000, 5, false, "");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "none", ""))
            .unwrap();
        db.enqueue_pending("C:/p/a.ARW", 4, "pick", "", 1500)
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.conflicts.len(), 1);
        let c = &report.conflicts[0];
        assert_eq!(c.path, "C:/p/a.ARW");
        assert_eq!(c.local, CullState::new(4, "pick", ""));
        assert_eq!(c.external, CullState::new(5, "none", ""));
        assert!(report.adopted.is_empty(), "冲突时不得采用任何一方");
        assert!(
            db.lookup_pending("C:/p/a.ARW").unwrap().is_some(),
            "冲突时意图必须留着，等用户裁决"
        );
        assert_eq!(
            db.lookup_xmp_cursor("C:/p/a.xmp").unwrap().unwrap().mtime_ms,
            1000,
            "冲突时游标不前进：下次刷新还要继续判"
        );
        let _ = std::fs::remove_file(&db_path);
    }

    /// 意图与磁盘一致 = 上次其实写成功了，只是记录没删干净 → 清掉残留。
    #[test]
    fn pending_matching_disk_is_cleared() {
        let (db, db_path) = temp_db("already");
        let probe = FakeProbe::new();
        probe.file("C:/p/a.ARW", 2000, 4, false, "");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "none", ""))
            .unwrap();
        db.enqueue_pending("C:/p/a.ARW", 4, "none", "", 1500)
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert!(report.conflicts.is_empty());
        assert!(
            db.lookup_pending("C:/p/a.ARW").unwrap().is_none(),
            "残留意图要清掉，否则下次启动会白写一遍"
        );
        let _ = std::fs::remove_file(&db_path);
    }

    // ---------------------------------------------------------------
    // 旗标来源：本地 store 优先，Rating=-1 最高
    // ---------------------------------------------------------------

    #[test]
    fn flag_comes_from_local_store() {
        let dir = std::env::temp_dir().join(format!("gc_refresh_store_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        cullstore::upsert(&dir, "a", "pick").unwrap();

        let (db, db_path) = temp_db("store");
        let probe = FakeProbe::new();
        let photo = dir.join("a.ARW").to_string_lossy().to_string();
        probe.file(&photo, 2000, 0, false, "");
        let sidecar = xmp::get_xmp_path(Path::new(&photo))
            .to_string_lossy()
            .to_string();
        db.upsert_xmp_cursor(&cursor(&sidecar, 1000, 0, "none", ""))
            .unwrap();

        let report = refresh(&db, &probe, vec![target(&photo)]);

        assert_eq!(report.adopted.len(), 1);
        assert_eq!(
            report.adopted[0].state.flag, "pick",
            "旗标来自本地 store，不从 XMP 猜"
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&db_path);
    }

    /// 外部写 `Rating=-1` 是硬信号，本地 store 里的 pick 压不住。
    #[test]
    fn rating_minus_one_wins_over_store() {
        let dir = std::env::temp_dir().join(format!("gc_refresh_reject_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        cullstore::upsert(&dir, "a", "pick").unwrap();

        let (db, db_path) = temp_db("reject");
        let probe = FakeProbe::new();
        let photo = dir.join("a.ARW").to_string_lossy().to_string();
        probe.file(&photo, 2000, 0, true, "");
        let sidecar = xmp::get_xmp_path(Path::new(&photo))
            .to_string_lossy()
            .to_string();
        db.upsert_xmp_cursor(&cursor(&sidecar, 1000, 0, "pick", ""))
            .unwrap();

        let report = refresh(&db, &probe, vec![target(&photo)]);

        assert_eq!(report.adopted[0].state.flag, "reject");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&db_path);
    }

    /// 主路径的 store 没条目时回落到 JPG 路径的 store（与扫描的 `store_entry` 同义）。
    #[test]
    fn jpg_store_is_fallback() {
        let raw_dir = std::env::temp_dir().join(format!("gc_refresh_raw_{}", std::process::id()));
        let jpg_dir = std::env::temp_dir().join(format!("gc_refresh_jpg_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&raw_dir);
        let _ = std::fs::remove_dir_all(&jpg_dir);
        std::fs::create_dir_all(&raw_dir).unwrap();
        std::fs::create_dir_all(&jpg_dir).unwrap();
        // 条目只在 JPG 目录里（历史遗留：先有 JPG 目录，后配 RAW）
        cullstore::upsert(&jpg_dir, "a", "pick").unwrap();

        let (db, db_path) = temp_db("jpg_fallback");
        let probe = FakeProbe::new();
        let raw = raw_dir.join("a.ARW").to_string_lossy().to_string();
        let jpg = jpg_dir.join("a.JPG").to_string_lossy().to_string();
        probe.file(&raw, 2000, 0, false, "");
        let sidecar = xmp::get_xmp_path(Path::new(&raw))
            .to_string_lossy()
            .to_string();
        db.upsert_xmp_cursor(&cursor(&sidecar, 1000, 0, "none", ""))
            .unwrap();

        let report = refresh(
            &db,
            &probe,
            vec![RefreshTarget {
                path: raw.clone(),
                jpg_path: Some(jpg),
            }],
        );

        assert_eq!(
            report.adopted[0].state.flag, "pick",
            "主路径没有条目时要回落到 JPG 侧的 store"
        );
        let _ = std::fs::remove_dir_all(&raw_dir);
        let _ = std::fs::remove_dir_all(&jpg_dir);
        let _ = std::fs::remove_file(&db_path);
    }

    // ---------------------------------------------------------------
    // 失败与边界
    // ---------------------------------------------------------------

    /// 一张读失败不该让整批中断，也不该推进它的游标（下次再试）。
    #[test]
    fn read_failure_is_collected_not_fatal() {
        let (db, db_path) = temp_db("read_fail");
        let probe = FakeProbe::new();
        probe.unreadable("C:/p/bad.ARW", 2000);
        probe.file("C:/p/good.ARW", 2000, 5, false, "");
        db.upsert_xmp_cursor(&cursor("C:/p/bad.xmp", 1000, 1, "none", ""))
            .unwrap();
        db.upsert_xmp_cursor(&cursor("C:/p/good.xmp", 1000, 1, "none", ""))
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/bad.ARW", "C:/p/good.ARW"]));

        assert_eq!(report.failed, vec!["C:/p/bad.ARW".to_string()]);
        assert_eq!(report.adopted.len(), 1, "好的那张照常采用");
        assert_eq!(report.adopted[0].path, "C:/p/good.ARW");
        assert_eq!(
            db.lookup_xmp_cursor("C:/p/bad.xmp").unwrap().unwrap().mtime_ms,
            1000,
            "读失败时游标不前进"
        );
        let _ = std::fs::remove_file(&db_path);
    }

    /// 同一路径传两次只查一次，否则「已更新 N 张」会翻倍。
    #[test]
    fn duplicate_targets_are_collapsed() {
        let (db, db_path) = temp_db("dup");
        let probe = FakeProbe::new();
        probe.file("C:/p/a.ARW", 2000, 5, false, "");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "none", ""))
            .unwrap();

        let report = refresh(
            &db,
            &probe,
            targets(&["C:/p/a.ARW", "C:/p/a.ARW", "c:/p/a.arw"]),
        );

        assert_eq!(report.checked, 1, "大小写不同也算同一个文件");
        assert_eq!(report.adopted.len(), 1);
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn empty_targets_returns_empty_report() {
        let (db, db_path) = temp_db("empty");
        let probe = FakeProbe::new();

        let report = refresh(&db, &probe, Vec::new());

        assert_eq!(report.checked, 0);
        assert!(report.adopted.is_empty());
        assert!(report.conflicts.is_empty());
        assert_eq!(probe.mtime_calls(), 0);
        let _ = std::fs::remove_file(&db_path);
    }

    fn photo_file(path: &str) -> crate::models::PhotoFileInfo {
        crate::models::PhotoFileInfo {
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            extension: "arw".to_string(),
            path: path.to_string(),
            size: 0,
            mtime: 0,
        }
    }

    fn group(jpg: Option<&str>, raw: Option<&str>) -> PhotoGroupInfo {
        PhotoGroupInfo {
            id: "a".to_string(),
            base_name: "a".to_string(),
            jpg: jpg.map(photo_file),
            raw: raw.map(photo_file),
            edited: None,
            tone: None,
            status: crate::models::PhotoGroupStatus::JpgOnly,
            rating: 0,
            flag: "none".to_string(),
            label: String::new(),
            has_xmp: false,
            retouched: false,
            exif: None,
            thumbnail_path: None,
        }
    }

    /// 主路径必须 RAW 优先 —— 前端 `groupPath()` 是同一规则的另一份实现，
    /// 两边分叉会造出「写 RAW、读 JPG」两套互不相干的状态。
    #[test]
    fn primary_path_prefers_raw() {
        assert_eq!(
            primary_photo_path(&group(Some("C:/p/a.JPG"), Some("C:/p/a.ARW"))),
            Some("C:/p/a.ARW")
        );
        assert_eq!(
            primary_photo_path(&group(Some("C:/p/a.JPG"), None)),
            Some("C:/p/a.JPG")
        );
        assert_eq!(
            primary_photo_path(&group(None, Some("C:/p/a.ARW"))),
            Some("C:/p/a.ARW")
        );
        assert_eq!(primary_photo_path(&group(None, None)), None);
    }

    /// 扫描基线：只有真的存在 sidecar 的分组才进。
    ///
    /// 写错方向很危险 —— 给没有 sidecar 的分组写一条基线，第一次刷新就会把它
    /// 判成「外部删除了侧边栏」，把界面上的星级清成 0。
    #[test]
    fn build_cursors_skips_groups_without_sidecar() {
        let dir = std::env::temp_dir().join(format!("gc_baseline_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let with_xmp = dir.join("has.ARW");
        let without_xmp = dir.join("none.ARW");
        xmp::write_xmp(&with_xmp, 3, "pick", Some("Red")).expect("预置侧边栏");

        let mut g1 = group(None, Some(&with_xmp.to_string_lossy()));
        g1.rating = 3;
        g1.flag = "pick".to_string();
        g1.label = "Red".to_string();
        let g2 = group(None, Some(&without_xmp.to_string_lossy()));

        let cursors = build_cursors(&[g1, g2]);

        assert_eq!(cursors.len(), 1, "没有 sidecar 的分组不该进基线");
        assert_eq!(cursors[0].rating, 3);
        assert_eq!(cursors[0].flag, "pick");
        assert_eq!(cursors[0].label, "Red");
        assert!(cursors[0].mtime_ms > 0, "基线必须带 mtime，否则增量没意义");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 并行 stat 不能漏掉任何一个：这是「批量」的正确性底线。
    #[test]
    fn parallel_stat_covers_every_target() {
        let (db, db_path) = temp_db("parallel");
        let probe = FakeProbe::new();
        let paths: Vec<String> = (0..200).map(|i| format!("C:/p/{:04}.ARW", i)).collect();
        for p in &paths {
            probe.file(p, 1000, 2, false, "");
        }

        let report = refresh(&db, &probe, paths.iter().map(|p| target(p)).collect());

        assert_eq!(report.checked, 200);
        assert_eq!(probe.mtime_calls(), 200, "每张都要 stat 一次");
        assert_eq!(report.baselined, 200, "全部首次见到 → 建立基线");
        let _ = std::fs::remove_file(&db_path);
    }

    // ---------------------------------------------------------------
    // issue #200：已精修（ACR/PS）也要进来刷新，且不能被静默吞掉
    //
    // 这是本次改动的核心风险点：`unchanged` 的原判据只看
    // (rating, flag, label)。用户在 PS 里只调了色、没动星级，
    // 三项全等 → 走「mtime 变了但内容没变」被吞 → 徽章永远不亮。
    // ---------------------------------------------------------------

    /// 星级/旗标/色标全没变，只有「已精修」从 false 变 true → 必须推一条。
    #[test]
    fn retouch_only_change_is_adopted() {
        let (db, db_path) = temp_db("retouch_only");
        let probe = FakeProbe::new();
        probe.file_retouched("C:/p/a.ARW", 2000, 3, false, "", true);
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "none", ""))
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.adopted.len(), 1, "只修图也要亮标");
        assert!(report.adopted[0].retouched);
        assert_eq!(report.adopted[0].state.rating, 3, "星级不该被改动");
        assert_eq!(report.unchanged, 0);
        assert_eq!(
            db.lookup_xmp_cursor("C:/p/a.xmp")
                .unwrap()
                .unwrap()
                .retouched,
            true,
            "游标要记下已精修，否则下次还会重复推"
        );
        let _ = std::fs::remove_file(&db_path);
    }

    /// `.acr` 落在**配对 JPG** 旁边（RAW/JPG 分目录摆放）时也算已修。
    ///
    /// 这是 `raw.or(jpg)` 那类短路的经典坑：RAW 在场时只看 RAW 一侧，
    /// 用户在 PS 里对 JPG 应用了 Camera Raw 滤镜就完全读不到。
    #[test]
    fn acr_on_paired_jpg_counts_as_retouched() {
        let (db, db_path) = temp_db("acr_jpg");
        let probe = FakeProbe::new();
        probe.file("C:/raw/a.ARW", 2000, 3, false, "");
        probe.acr_file("C:/jpg/a.JPG");
        db.upsert_xmp_cursor(&cursor("C:/raw/a.xmp", 1000, 3, "none", ""))
            .unwrap();

        let report = refresh(
            &db,
            &probe,
            vec![RefreshTarget {
                path: "C:/raw/a.ARW".to_string(),
                jpg_path: Some("C:/jpg/a.JPG".to_string()),
            }],
        );

        assert_eq!(report.adopted.len(), 1, "JPG 侧的 .acr 也必须算变化");
        assert!(report.adopted[0].retouched);
        let _ = std::fs::remove_file(&db_path);
    }

    /// sidecar 里没有 `HasSettings`，但照片旁有 `.acr` → 正常分支也必须推一条。
    ///
    /// 这条守的是「两路证据取或」的**前半**：只在 sidecar_removed 分支认 `.acr`
    /// 的话，用户从 PS 存了 `.acr`、而 sidecar 恰好没写 HasSettings 时会漏标。
    #[test]
    fn acr_file_alone_marks_retouched_on_normal_path() {
        let (db, db_path) = temp_db("acr_normal");
        let probe = FakeProbe::new();
        probe.file("C:/p/a.ARW", 2000, 3, false, "");
        probe.acr_file("C:/p/a.ARW");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "none", ""))
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.adopted.len(), 1, ".acr 出现也是变化");
        assert!(report.adopted[0].retouched);
        assert!(
            db.lookup_xmp_cursor("C:/p/a.xmp")
                .unwrap()
                .unwrap()
                .retouched,
            "游标要记下来，否则每次都推"
        );
        let _ = std::fs::remove_file(&db_path);
    }

    /// 侧边栏被外部删掉、但 `.acr` 还在 → 星级/旗标清空，「已修」必须留着。
    ///
    /// 这两个信号本来就独立：sidecar 里是设置记录，`.acr` 是 ACR 的产物。
    /// 顺手把 sidecar 挪走的用户，不该连「这张修过」的记忆一起丢。
    #[test]
    fn sidecar_removed_keeps_acr_evidence() {
        let (db, db_path) = temp_db("acr_left");
        let probe = FakeProbe::new();
        probe.missing("C:/p/a.ARW");
        probe.acr_file("C:/p/a.ARW");
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 3, "pick", "Red"))
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.adopted.len(), 1);
        let item = &report.adopted[0];
        assert!(item.sidecar_removed, "侧边栏确实不在了");
        assert_eq!(item.state.rating, 0, "三元标记无从判断，归空");
        assert!(item.retouched, "`.acr` 还在，就还是修过的");

        let _ = std::fs::remove_file(&db_path);
    }

    /// 反向：从「已精修」回到未精修（删了 .acr 或撤销调色）同样要推。
    #[test]
    fn retouch_cleared_is_adopted() {
        let (db, db_path) = temp_db("retouch_clear");
        let probe = FakeProbe::new();
        probe.file_retouched("C:/p/a.ARW", 2000, 3, false, "", false);
        let mut c = cursor("C:/p/a.xmp", 1000, 3, "none", "");
        c.retouched = true;
        db.upsert_xmp_cursor(&c).unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.adopted.len(), 1, "取消精修也要同步");
        assert!(!report.adopted[0].retouched);
        let _ = std::fs::remove_file(&db_path);
    }

    /// 已精修状态没变 + 内容没变 → 仍然静默（不能因为新字段就退化成每次都推）。
    #[test]
    fn same_retouch_with_mtime_bump_stays_silent() {
        let (db, db_path) = temp_db("retouch_same");
        let probe = FakeProbe::new();
        probe.file_retouched("C:/p/a.ARW", 2000, 3, false, "", true);
        let mut c = cursor("C:/p/a.xmp", 1000, 3, "none", "");
        c.retouched = true;
        db.upsert_xmp_cursor(&c).unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert!(report.adopted.is_empty(), "什么都没变就不该打扰界面");
        assert_eq!(report.unchanged, 1);
        assert_eq!(
            db.lookup_xmp_cursor("C:/p/a.xmp")
                .unwrap()
                .unwrap()
                .mtime_ms,
            2000
        );
        let _ = std::fs::remove_file(&db_path);
    }

    /// 有冲突时不推进游标，「已精修」也不能顺手写进去 —— 否则用户裁决完
    /// 那次刷新会以为「已经同步过了」而漏推。
    #[test]
    fn conflict_does_not_advance_retouch_cursor() {
        let (db, db_path) = temp_db("retouch_conflict");
        let probe = FakeProbe::new();
        probe.file_retouched("C:/p/a.ARW", 2000, 3, false, "", true);
        db.upsert_xmp_cursor(&cursor("C:/p/a.xmp", 1000, 1, "none", ""))
            .unwrap();
        db.enqueue_pending("C:/p/a.ARW", 5, "pick", "Blue", 1500)
            .unwrap();

        let report = refresh(&db, &probe, targets(&["C:/p/a.ARW"]));

        assert_eq!(report.conflicts.len(), 1);
        assert!(report.adopted.is_empty());
        let after = db.lookup_xmp_cursor("C:/p/a.xmp").unwrap().unwrap();
        assert_eq!(after.mtime_ms, 1000, "冲突不推进游标");
        assert!(!after.retouched, "冲突时也不该把已精修写进游标");
        let _ = std::fs::remove_file(&db_path);
    }

    /// 扫描基线要把「已精修」一起带进游标，否则首刷会把已修过的图当成变化。
    #[test]
    fn build_cursors_carries_retouched() {
        let dir = std::env::temp_dir().join(format!("gc_retouch_base_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let photo = dir.join("edited.ARW");
        xmp::write_xmp(&photo, 2, "none", None).expect("预置侧边栏");

        let mut g = group(None, Some(&photo.to_string_lossy()));
        g.rating = 2;
        g.retouched = true;

        let cursors = build_cursors(&[g]);

        assert_eq!(cursors.len(), 1);
        assert!(cursors[0].retouched, "基线要带上已精修");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
