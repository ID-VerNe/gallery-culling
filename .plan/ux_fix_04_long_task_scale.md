# 长任务可见性与万张规模性能 — 独立复核报告（T4 / t4-long-task）

> 调查方式：只读。全量通读 `commands.rs` / `scanner.rs` / `db.rs` / `thumbnail.rs` / `lib.rs` / `App.tsx` / `ThumbnailGrid.tsx` / `TopBar.tsx` / `BatchExportModal.tsx` / `Toast.tsx` / `api.ts` / `useLumenPreview.ts` / `lumen.rs`（关键段），并 grep 验证既有假设。
> 结论标注约定：**【已验证】**＝源码可直接证实；**【需实机测量】**＝源码无法证实、必须跑数据。
> 全文行号均为当前工作区真实行号。

---

## 0. 前置事实复核（团队共识项）

### 0.1 后端完全没有事件/进度/取消基础设施

对 `src-tauri/src/**` grep `emit|progress|Progress|Channel|AtomicBool|listen|CancellationToken|cancel`：
- **零命中**于 Rust 侧。前端仅 `useLumenPreview.ts:57` / `useLumenStatus.ts:29` 有 `let cancelled = false` —— 那是 useEffect 竞态清理标志，**不是可中断后端任务的取消令牌**。

**【已验证】** 团队给出的"Rust 侧零 `emit`/事件/进度/取消"结论**成立**，我独立复核后确认。

### 0.2 依赖声明与实际使用严重不符（新增发现）

`src-tauri/Cargo.toml` 声明了 `rayon = "1.10"`、`walkdir = "2.5"`、`uuid`、`chrono`，但 grep 结果：
- `rayon` 引用数 **0**
- `walkdir` 引用数 **0**
- `uuid` 引用数 **0**
- `chrono` 引用数 **0**

**【已验证】** 扫描器**没有任何并行化**，`rayon` 是"声明了但从未接线"的死依赖。这直接推翻"上万张秒级加载"可能隐含的"并行扫描"假设——当前扫描是**纯串行**的。

### 0.3 Tauri 侧没有任何窗口生命周期钩子

`lib.rs:17-55` 的 `Builder` 链：插件 → `manage(AppState)` → `invoke_handler` → `run`。**没有 `.on_window_event(...)`**，**没有 `CloseRequested` 处理**。
前端 grep `onCloseRequested|beforeunload|visibilitychange`：**零命中**。

**【已验证】** 当前**不存在**任何"应用关闭前"钩子。这对 M-17 的防抖 flush 是硬约束（见 §3）。

---

## M-05 扫描与批量导出期间无进度、无条数、无取消

### 复核结论
**成立（严重度按汇报一致，MEDIUM 偏保守——万张场景下会升格为 HIGH 体验缺陷）。**

证据：
- `TopBar.tsx:160-171`：扫描按钮 `disabled={isLoading || !jpgFolder.trim()}`，文案 `{isLoading ? '扫描中…' : '扫描照片'}`，图标 `RefreshCw` 加 `animate-spin`。除此之外**无进度条、无"已扫描 N/M"、无取消按钮**。
- `BatchExportModal.tsx:135-147`：导出按钮 `{isExporting ? '导出中…' : '开始导出'}`，`disabled={isExporting || ...}`。**无进度、无条数、无取消**。
- 只有**事后**反馈：`App.tsx:355-363` 扫描完成 toast 带总数；`BatchExportModal.tsx:103-104` 导出完成写 `exportResult`。任务进行中零信息。

### 事实与根因

**扫描调用链（单命令、整数组返回、无回调）：**
```
TopBar onScan → App.tsx:315 handleScan → api.scanFolders (api.ts:24)
  → invoke('scan_folders_cmd')  commands.rs:24-34
     → tokio::task::spawn_blocking(move || scan_folders(...))   // 一次阻塞调用
        → scanner.rs:236 scan_folders
           └─ 返回 FolderScanResult{ groups: Vec<PhotoGroupInfo>, ... }
```
关键点：`scan_folders_cmd` **一次性返回整个 `Vec`**，序列化发生在命令结束时。中途**没有**任何回传通道，所以前端拿不到阶段与条数。

**scan_folders 内部阶段（scanner.rs:236-503，全部串行，无 rayon）：**

| # | 阶段 | 位置 | 每张成本来源 | 量级判断 |
|---|------|------|--------------|----------|
| 1 | 枚举 JPG 目录 | `scanner.rs:257` → `scan_directory:194-233` | `read_dir` + 每文件 `entry.metadata()`（1 次 stat） | 单张 µs 级 【需实机测量】 |
| 2 | 枚举 RAW 目录（可选） | `scanner.rs:258-266` | 同上 | 同 1 |
| 3 | 逐组：查 XMP sidecar | `scanner.rs:298-304, 370-392` | `check_sidecar_exists`（stat）+ `read_xmp_full`（**打开并解析 XML**） | 有 sidecar 时单张 0.1–1ms 【需实机测量】 |
| 4 | 逐组：读 EXIF | `scanner.rs:312, 395-401` → `read_exif_metadata:76-191` | `File::open` + `exif::Reader::read_from_container`（**打开文件读头**） | 单张 0.1–1ms，硬盘/网络盘显著更慢 【需实机测量】 |
| 5 | 逐组：找精修版本 | `scanner.rs:323-325, 427-431` → `find_edited_version:16-52` | **最多 8 次 `p.is_file()`**（8 次 stat） | 单张 µs 级、次数固定 |
| 6 | 排序 | `scanner.rs:451-493` | 比较器内 `a.base_name.to_lowercase()`（**每次比较分配新 String**） | O(n log n) 次分配 |

**注意：缩略图生成（阶段"生成缩略图"）不在这条链里。** 扫描只填 `thumbnail_path: None`（`scanner.rs:339, 445`）；缩略图是**渲染宫格时每格一次 `get_thumbnail_cmd`** 惰性生成（见 §4(b)）。汇报中"枚举 → 配 JPG/RAW → 读 EXIF → 生成缩略图 → 读 XMP → 排序"的阶段划分与实际略有出入：**缩略图生成不在扫描命令内**，XMP 读取与 EXIF 是在同一次逐组循环里交替进行的，不是独立串行阶段。

**结构性问题（算法级）：** `scanner.rs:344-349`
```rust
let mut all_stems: Vec<String> = jpg_files.keys().cloned().collect();
for k in raw_files.keys() {
    if !all_stems.contains(k) { all_stems.push(k.clone()); }  // Vec::contains = 线性扫描
}
```
配对模式下这是 **O(J×R)**（JPG 数 × RAW 数）。1 万 JPG + 1 万 RAW ≈ **10^8 次字符串比较**，实测很可能在数百 ms～数秒区间。**【需实机测量】**，但复杂度上确定是二次的——这是"上万张"叙事的正面威胁。

**导出调用链：**
```
BatchExportModal.tsx:96 handleExport → api.batchExport → invoke('batch_export_cmd')
  → commands.rs:197-254  spawn_blocking{ for item { fs::copy ×N } }   // 一次性返回 usize
```
同样一次性返回，循环内无回传、无取消、无逐文件结果。

### 影响面与触发条件
- 扫描：文件数 **≥ 数千** 时用户开始感知"点下去没反应"；**≥ 1 万**时若单张 EXIF+XMP 成本落在 1ms 量级则总时长进入 10s+，而 UI 只有按钮转圈。用户会怀疑卡死，反复点击（按钮已 disabled，缓解）或强杀进程。
- 导出：复制 **≥ 数百个 RAW**（单个 20–80MB）时，几十 GB 拷贝可能数分钟；无进度=用户不知道还要多久，无取消=选错目标目录只能干等或杀进程（后者留下半成品，见 §2）。
- 触发条件很明确：**只要操作耗时超过 2–3 秒**，现有反馈就不够。

### 修复方案

**路线 A：Tauri v2 `Channel<T>`（命令级流式回传）— 推荐用于"扫描/导出"这类命令作用域任务**

Tauri v2 的 `tauri::ipc::Channel<T>` 可作为命令参数传入，命令内 `channel.send(evt)` 把事件推给**发起该次调用的**前端回调。优点：
- 无需全局事件名、无跨窗口串扰；生命周期天然绑定这次 invoke。
- 前端 `invoke('scan_folders_cmd', { ..., onEvent })`，`onEvent` 即 `(e) => {...}`。
- 取消天然可做：`Channel` 只负责"下行"；**取消仍需一个上行通道**（见下）。

接口签名草案：
```rust
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ScanProgress {
    Enumerated { total: usize },
    Progress { done: usize, total: usize, phase: String }, // phase: "exif" | "xmp" | "pairing"
    Finished { total: usize },
    Cancelled { done: usize },
}

#[tauri::command]
pub async fn scan_folders_cmd(
    jpg_folder: String,
    raw_folder: Option<String>,
    sort_order: Option<String>,
    on_progress: tauri::ipc::Channel<ScanProgress>,
    state: State<'_, AppState>,           // 新增：取取消标志
) -> Result<FolderScanResult, String> { ... }
```

**路线 B：全局 `app.emit("scan://progress", payload)` + 前端 `listen`**
- Rust 侧需在命令签名加 `app: tauri::AppHandle`，`app.emit(...)`。
- 前端 `import { listen } from '@tauri-apps/api/event'`，在 `App.tsx` 挂一次 `useEffect` 订阅。
- 优点：一个全局进度可被多个 UI 位点（TopBar、BottomBar、后续状态栏）同时消费；适合**跨命令共享一个"当前长任务"**语义。
- 缺点：事件名全局、需手动在卸载时 `unlisten`；多窗口/多次并发调用需带 task_id 区分。

**路线取舍：** 本项目是单窗口、同一时刻只允许一个扫描/导出（`isLoading`/`isExporting` 已串行化），**两条路线都能满足**。若未来要做一个统一的"任务中心/状态栏"，选 **B**（全局事件 + 任务表）；若坚持最小改动，选 **A**（Channel）。**推荐 B**，理由是 M-17 的"保存会话"、AI 蒙版（`api.ts:284` 注释已说明 4s）等都能并入同一个任务中心。

**是否要把"同步返回大数组"改成"分批返回"？——不必。**
`FolderScanResult` 一次性返回是**正确的**：前端需要完整数组才能做虚拟化与排序，分批返回会让 `groups` 反复重建、索引漂移。进度**只走旁路**（Channel/emit），最终结果仍一次性 return。这样改动面最小，也不破坏现有 `setGroups(res.groups)` 语义。

**取消实现（`State<AtomicBool>` 标志位轮询）：**

新增共享状态：
```rust
pub struct AppState {
    pub db: Database,
    pub lumen: lumen::LumenRuntime,
    pub scan_cancel: Arc<AtomicBool>,   // 新增
    pub export_cancel: Arc<AtomicBool>, // 新增（或共用 TaskCancel）
}
```
新增命令：
```rust
#[tauri::command]
pub fn cancel_scan_cmd(state: State<'_, AppState>) -> Result<(), String> {
    state.scan_cancel.store(true, Ordering::SeqCst); Ok(())
}
```

`scan_folders` 需改签名，透传 `&AtomicBool`（或一个 `ProgressSink` trait 组合"上报 + 取消查询"）：
```rust
pub fn scan_folders(
    jpg_folder: &str, raw_folder: Option<&str>, sort_order: &str,
    cancel: &AtomicBool,
    mut report: impl FnMut(usize, usize),   // (done, total)
) -> Result<Option<FolderScanResult>, String>   // None = 已取消
```

**安全的检查点（放这些地方，已核对不影响正确性）：**
1. **阶段 1/2 枚举循环内**：`scan_directory` 每处理 `entry` 前查一次。取消则返回空 map（上层发现 `cancel` 直接短路）。
2. **逐组主循环（`scanner.rs:296` / `scanner.rs:351`）每次迭代开头**：这是最值钱的点——这里是 EXIF/XMP 读取（重 IO）所在，检查一次即可跳过单张的全部重活。
3. **排序前**（`scanner.rs:451` 之前）：排序已完成全部 IO，此点检查只是"别白排"，收益小但无害。
4. **不要在比较器内查**：`sort_by` 比较器被调 O(n log n) 次，且必须满足全序；在比较器里读 atomic 会导致排序不稳定/逻辑错乱。**这是必须避免的点。**

**取消后的副作用处理：**
- **缩略图缓存：不需要清理，也不应该清理。** `thumbnail.rs:59-87` 的缓存键 = `canonicalize(path) + mtime + width + orientation`（内容寻址）。它反映的是**某个文件的当前状态**，与"哪次扫描"无关。取消扫描不产生"半张缩略图"——`get_or_create_thumbnail` 是"要么写完整个文件、要么本次调用失败"（`thumbnail.rs:176-178` 先 `save_with_format` 再返回路径；无 tmp+rename，但写的是一个独立缓存文件，不会污染其他条目）。**结论：扫描取消后，已生成的缩略图缓存保留、复用，零清理成本。**

### 风险评估
- 风险等级：**中**（改动面覆盖命令签名 + AppState + 前端调用点，但每处都低耦合）。
- 性能/内存回归：进度回传引入 IPC 频率。**必须节流**：不要每张都 `send`，建议按 `max(1, total/200)` 或每 50ms 最多次上报一次，否则 1 万张 = 1 万个 IPC 事件，反而把 UI 主线程打满，得不偿失。
- 卡死风险：低。取消是协作式（轮询），只有当"单张 EXIF 读取本身卡死"（如网络盘掉线）时才无法及时响应——这属于底层 IO 不可中断，任何方案都无解，需在文档说明。
- 数据半成品：扫描**不写数据**，无此风险；导出见 §2。
- 需产品决策：取消后是"丢弃全部结果"还是"保留已完成部分"？**推荐扫描取消 = 丢弃全部结果**（半套列表没有意义，且会误导筛选计数）。
- 回滚方式：`Channel`/`emit` 与 `AtomicBool` 均为**新增**，不改变既有返回值；回滚 = 前端不传 `on_progress`、后端不 `send`（保留参数即可），一次性可回退。

### 验证方法
- **单元（Rust）**：给 `scan_folders` 注入一个"第 K 张后置位"的 `AtomicBool`，断言返回 `Ok(None)` 且不再继续读 EXIF（可用计数器注入）。
- **构造 1 万张压测库（无真实照片即可）**：见文末 §压测场景。
- **手动**：扫描 1 万张时观察进度条是否推进、点取消是否 ≤ 数百 ms 内停下（停止后无新 EXIF 读取——用 Process Monitor 看 open 计数停止增长）。

---

## M-17 每次 `selectedIndex` 变化都无防抖写 session

### 复核结论
**成立。**
`App.tsx:826-833`：
```tsx
// Save session when index changes
useEffect(() => {
  if (jpgFolder && selectedIndex >= 0) {
    api.saveSession(jpgFolder, rawFolder, selectedIndex, sortOrder)
      .catch((err) => console.error('Failed to save session:', err));
  }
}, [selectedIndex, jpgFolder, rawFolder, sortOrder]);
```
依赖 `selectedIndex`。调用链：`api.saveSession`（`api.ts:168`）→ `invoke('save_session_cmd')`（`commands.rs:279-291`）→ `db.save_session`（`db.rs:198-230`）= 一次 IPC + 一次 SQLite `INSERT ... ON CONFLICT UPSERT`。**无防抖、无节流。** 行号与汇报一致。

### 事实与根因
- 触发点：方向键/PageDown/PageUp 连按（`ThumbnailGrid.tsx:100-130`）、宫格点选、`handlePrev/handleNext`（`App.tsx:414-432`）。**每次选中变化 = 1 IPC + 1 次 SQLite 写。**
- 按 10 张/秒连续翻页 → 10 次/秒 IPC + SQLite 写。SQLite 写入走 `Arc<Mutex<Connection>>`（`db.rs:7, 205`），**串行且每次 fsync 级别提交**（rusqlite 默认 rollback journal，未显式开 WAL）。
- 后果：稳态下是"每翻一页一次磁盘写"，对 SSD 不是灾难，但在**外接机械盘 / 网络盘**上会拖慢翻页；且是无意义的写入放大（只有**最后一次**索引才有价值）。
- 额外浪费：`useEffect` 依赖里 `jpgFolder/rawFolder/sortOrder` 任一变化也会触发一次写（这倒是有意义的，但同样无合并）。

### 修复方案

**推荐：前端防抖 + 多路径 flush（后端仅加"关闭前"钩子做兜底）。**

**为什么放前端：** 后端 `db.rs` 层做"合并写"需要引入写入调度器/延迟队列，复杂且要处理进程退出；而"当前选中索引"**只有前端真正知道**，后端拿到的只是一串离散值。前端防抖是语义最贴合的位置。

**实现位置与形状（App.tsx）：**
```tsx
// 用 ref 持有最新值，避免每个 effect 重建定时器时闭包陈旧
const sessionRef = useRef({ jpgFolder, rawFolder, selectedIndex, sortOrder });
sessionRef.current = { jpgFolder, rawFolder, selectedIndex, sortOrder };

const flushTimer = useRef<number | null>(null);

const flushSession = useCallback((s = sessionRef.current) => {
  if (flushTimer.current) { window.clearTimeout(flushTimer.current); flushTimer.current = null; }
  if (!s.jpgFolder) return;
  void api.saveSession(s.jpgFolder, s.rawFolder, s.selectedIndex, s.sortOrder)
    .catch((e) => console.error('Failed to save session:', e));
}, []);

// 防抖：500ms 内的连续变化合并为一次写
useEffect(() => {
  if (!jpgFolder) return;
  if (flushTimer.current) window.clearTimeout(flushTimer.current);
  flushTimer.current = window.setTimeout(() => flushSession(), 500);
  return () => { if (flushTimer.current) window.clearTimeout(flushTimer.current); };
}, [selectedIndex, jpgFolder, rawFolder, sortOrder, flushSession]);
```

**关键风险：防抖会丢最后一次写入。** 必须在这三处 flush：
1. **组件卸载时**：`useEffect(() => () => flushSession(), [flushSession])`（挂载一次、cleanup 调 flush）。
2. **切换目录时**：`jpgFolder` 变化要**先 flush 旧目录的值再启新定时器**。上面的 effect 在依赖变化时会 clear 旧定时器——若不清就会丢旧目录。做法：在 effect 里先 `flushSession(prevRef)` 再设新定时器，或在 `handleScan`（`App.tsx:315`）开头显式 flush。
3. **应用关闭 / 窗口隐藏时**：**当前不存在任何钩子（§0.3 已验证）**，需要二选一：
   - **前端**：`getCurrentWindow().onCloseRequested(async (e) => { e.preventDefault(); await flushOnce(); await getCurrentWindow().destroy(); })`——注意这是异步竞态窗口极小的操作，但 Tauri v2 支持。
   - **后端（更稳，推荐）**：`lib.rs` 的 Builder 加
     ```rust
     .on_window_event(|window, event| {
         if let tauri::WindowEvent::CloseRequested { .. } = event {
             // 经 state 读回最后写入的会话并落盘；或依赖 db 已在内存中的最后值
         }
     })
     ```
     但后端**不知道**前端防抖中尚未发出的值——所以**兜底钩子只能保证"已发出的最后一次写"不丢**，"还在 500ms 窗口内的那次"仍会丢。
   - **因此更强方案**：前端在 `visibilitychange`/`beforeunload` 里同步 flush（`flushSession()` 同步调用 `invoke`，尽力而为）。综合建议：**前端防抖 + 前端卸载/目录切换 flush + 前端 close-requested flush**，后端不加钩子（避免"后端不知道前端内存值"的伪安全感）。

> 结论：**纯后端方案不可行**（后端拿不到未发送的值）；**纯前端防抖可行**，但必须补 3 个 flush 点，其中"关闭前"这一处是新增（当前无钩子）。若接受轻微丢失，可退化为"仅卸载+目录切换 flush"，风险等级低。

### 影响面与触发条件
- 数千张以上、用户用键盘快速翻页时。数量本身不改变每次写的成本（O(1)），所以**触发条件是"操作频率"而非"库规模"**。10 张/秒翻页即持续 IO。
- 用户感知：网络盘/机械盘上翻页迟滞；SSD 上基本无感。属于"MEDIUM 的正确性/整洁性问题"而非崩溃。

### 风险评估
- 风险等级：**低–中**。
- 性能/内存回归：防抖**减少**写入，无回归。
- 卡死风险：无。
- **数据风险（最重要）**：flush 缺失 → 关闭应用后"上次看到的照片"回到更早的位置。用户会觉得"记忆失灵"。可接受度取决于产品预期。
- 需产品决策：防抖窗口取 300ms / 500ms / 1000ms？**推荐 500ms**（翻页止住后 0.5s 落盘，符合直觉）。
- 回滚：把 effect 改回立即调用即可，纯前端、零后端影响。

### 验证方法
- 单元（vitest + jsdom）：mock `api.saveSession`，模拟 20 次快速 `selectedIndex` 变化，断言 500ms 内只调用 1 次；再断言卸载时补调 1 次（fake timers）。
- 手动：网络盘打开 1 万张库，连按方向键 5 秒，用 Process Monitor 对比防抖前后写入次数。

---

## L-02 / L-03 Toast 生命周期与无障碍语义

### 复核结论
**成立（三条子项全部命中）。**
- `Toast.tsx:32-36`：`DISMISS_MS = { success:4000, info:4000, error:7000 }` —— 错误 7 秒自动消失。**无历史记录**（`setToasts` 直接过滤，无归档）。
- `Toast.tsx:89`：`setToasts((prev) => [...prev.slice(-2), { id, message, variant }])` —— 保留最后 2 条 + 新条 = **最多同时 3 条**。汇报的"最多 3 条"**准确**（cap 逻辑是 `slice(-2)` 再追加）。
- `Toast.tsx:118-121`：容器 `role="status" aria-live="polite"`，**所有 variant 共用一个 live region**。错误与成功同语义。

### 事实与根因
- 共用 polite region：屏幕阅读器对错误提示的播报有延迟、且会被后续 polite 消息打断；错误属于"需要立即知晓"，语义上应是 `assertive`。
  - **无障碍依据（由 t5-a11y-copy 提供）**：WCAG 4.1.3 状态消息 + WAI-ARIA Authoring Practices —— `role="alert"`（或 `aria-live="assertive"`）用于**需要立即知晓**的错误，应与 polite 的成功/提示**分属不同的常驻 live region**。当前 `Toast.tsx:118-121` 是单容器共用，不满足。
- cap 3 的副作用：**错误风暴（同一失败源连发 N 条）** 会把前 2 条挤掉，且**没有去重**——例如批量标记 50 张都失败，会看到消息不断被覆盖、旧的静默消失，用户既读不完也不知道总共有多少。
- `Toast.tsx:74-83` 有 per-id timer 管理，卸载时清理（`:107-113`），这部分实现是干净的可复用。

### 修复方案

1. **live region 按 variant 分流**：渲染两个容器——
   - 错误：`role="alert" aria-live="assertive"`
   - 成功/提示：`role="status" aria-live="polite"`
   或保持单容器但把 `aria-live` 动态设为 `assertive`（当栈内存在 error 时）——**推荐前者**（两个独立的常驻区域，避免 polite/assertive 切换引发的播报抖动，也符合 `Toast.tsx:59-68` 注释里"区域常驻以便注册"的设计意图）。

2. **错误留存**：
   - 错误**不自动消失**（`DISMISS_MS.error = Infinity` 或极大值），必须用户点关闭。
   - 或折中：错误 15s 后转为"折叠的 N 条历史"入口，让用户可回看——**推荐**（既不被无限堆积占屏，也不丢信息）。最小实现：在容器底部加一个"最近的错误 (N)"按钮展开一个只读列表。

3. **去重与同源风暴抑制**（与 `:89` 的 cap 逻辑协同）：
   ```tsx
   // key = variant + message；同 key 在 3s 窗口内再次 push → 只自增计数，不新增条目
   const dedupeKey = `${variant}::${message}`;
   setToasts((prev) => {
     const idx = prev.findIndex(t => `${t.variant}::${t.message}` === dedupeKey && Date.now() - t.at < 3000);
     if (idx >= 0) {
       const next = [...prev];
       next[idx] = { ...next[idx], count: (next[idx].count ?? 1) + 1, at: Date.now() };
       return next;
     }
     // cap 逻辑升级：错误不计入 3 条上限，或上限提高到"3 条非错误 + 2 条错误"
     const nonErr = prev.filter(t => t.variant !== 'error');
     const errs   = prev.filter(t => t.variant === 'error');
     return [...nonErr.slice(-2), ...errs.slice(-1), { id, message, variant, count: 1, at: Date.now() }];
   });
   ```
   文案侧对 count>1 显示 `×N`。
   进一步：对"批量操作逐条失败"这类**已知同源错误**，调用方（如 `App.tsx:452-460 reportRatingFlagError`）应改为**汇总上报一次**（"50 张中有 12 张写入 XMP 失败，示例：…"），而不是循环 toast。这是治本，toast 层去重是兜底。

4. **历史**：至少保留"会话内最近 20 条"于一个 ref 数组，供需要时展示（可选的低成本实现）。

### 影响面与触发条件
- 屏幕阅读器用户：错误被当作普通状态播报，且可能被淹没。
- 所有用户：批量失败时信息丢失（cap 3 + 7s 自动消失）。
- 触发条件：任何错误风暴（批量导出失败、批量 XMP 写入失败、引擎抖动连续失败）。

### 风险评估
- 风险等级：**低**（纯前端、纯展示层）。
- 性能/内存：无。
- 卡死/数据风险：无。
- 需产品决策：错误是否允许"永久驻留+可折叠历史"，还是"15s 后自动收起"。**推荐后者**（不改变"非阻塞"的原始设计意图，见 `Toast.tsx:59-68`）。
- 回滚：还原 `DISMISS_MS` 与容器属性，纯前端一键回退。

### 验证方法
- 单元：断言 error toast 在 7s/15s 后仍在（fake timers）；断言同一 message 连发 5 次只产生 1 个条目且 count=5；断言两个 live region 的 `role`/`aria-live` 属性。
- 手动 + NVDA/VoiceOver：触发一个错误，确认被 assertive 播报。

---

## L-10 导出未校验"目标目录 = 源目录"（汇总时记为 **H-04**）

> 编号说明：本轨道原编号 L-10；因已升 HIGH，team-lead 裁决在汇总总表中以统一 ID **H-04** 记账。**原曾误用 L-10 指代的"空格键劫持"问题已移交 t5，改号 L-12**（见 `ux_fix_05_a11y_copy.md`）；`L-11` 为 t1 的"无撤销"。本报告中 L-10 一律专指"导出未校验目标目录=源目录"。

### 复核结论
**成立，定级 HIGH（经 t1-data-safety 交叉复核后上调；原初判 MEDIUM 偏保守）。**
`BatchExportModal.tsx:73-86`：
```tsx
if (!targetFolder.trim()) { onError('请先选择导出目标文件夹。'); return; }
if (exportCandidates.length === 0) { ... return; }
if (!includeRaw && !includeJpg) { ... return; }
```
**没有** `target === source` 的判断。确认。

### 事实与根因
后端 `batch_export_cmd`（`commands.rs:196-254`）：
```rust
let dst = target_dir.join(file_name);
if fs::copy(src, dst).is_ok() { exported += 1; }
```
若 `target_dir` 与源同目录 → `src` 与 `dst` **指向同一个文件路径**，随后执行 `std::fs::copy(src, dst)`。

**权威依据（由 t1-data-safety 独立复核提供，比本轨道的"可能"更硬）：**
Rust 标准库 `std::fs::copy` 文档原文：
> *"This function will overwrite the contents of `to`. **Note that if `from` and `to` both point to the same file, then the file will likely get truncated by this operation.**"*

平台落地行为：
- **Unix**：`to` 以 `O_WRONLY|O_CREAT|O_TRUNC` 打开 → **确定截断**（即源文件被清零为 0 字节）。
- **Windows**：走 `CopyFileEx` → 可能截断、也可能返回 `ERROR_SHARING_VIOLATION` 直接失败。**Windows 具体分支本轨道未实测**（只读约束）。

**两种结果都不可接受：**
- 若截断 → 用户原始 RAW/JPG 被清空，**不可逆、无备份**（本工具不备份）；
- 若失败 → 静默什么都没导出，用户不知原因（见下"静默失败"）。

**因此定级取下限 HIGH。** 无论 Windows 落在哪个分支，进入 copy 前的前置防护都必须存在。

**次要问题（同函数，t1 交叉确认）：**
- **静默失败**：`:218/:233` 用 `if fs::copy(...).is_ok()` 丢掉 `Err` → 共享冲突/权限不足时用户只看到"已导出 0 个文件"，无任何原因。
- **静默覆盖**：无 `COPY_FILE_FAIL_IF_EXISTS`、无存在性检查 → 目标目录同名无关文件被直接覆盖。
- `target_dir.join(file_name)` **拍平目录结构**，且不同源目录同名文件 → 后者覆盖前者，`exported` 计数与实际落盘文件数不符。
- XMP 复制（`commands.rs:238-243`）用 `let _ = fs::copy(...)` **吞掉错误**，失败静默。
- 无磁盘空间预检。

### 修复方案

> **归属与落点确认（team-lead 裁决，本轨道确认）**：本项的**强制修复必须落在后端**（`batch_export_cmd`）——`canonicalize` 归一后做"源集合 ∩ 目标目录"自检并**整体拒绝** + `.is_ok()` 改**错误累计** + 同名默认**跳过并报告**。**前端只做即时校验与禁用按钮，仅能防误操作，不能兜底**：前端拿不到"复制是否真的损毁/覆盖了目标已有文件"的真相（那是 `fs::copy` 的运行时行为），因此前端校验不构成防线。**结论：owner = t4（含后端改造），不是纯前端轨道。**

**前端（`BatchExportModal.tsx:handleExport` 前置校验，最小改动）：**
```ts
const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
if (norm(targetFolder) === norm(jpgFolder) /* 需要 props 传入 jpgFolder/rawFolder */) {
  onError('目标目录不能与源照片目录相同，否则会覆盖原片。请选择其他目录。');
  return;
}
```
需要把 `jpgFolder`/`rawFolder` 作为 props 传入 `BatchExportModal`（当前只有 `groups`）。
更稳的做法：**遍历 `exportCandidates`，用每个候选的 `jpg.path`/`raw.path` 的父目录**与目标比较（因为 photos 可能来自多个目录）。

**后端（不依赖前端，双保险，必须做）：**
```rust
// commands.rs batch_export_cmd 内，逐项：
let src_canon = fs::canonicalize(src).map_err(|e| format!("无法解析源路径: {}", e))?;
let dst_canon = if dst.exists() { fs::canonicalize(&dst).ok() } else {
    // dst 尚不存在时，比较其父目录 + 文件名
    dst.parent().and_then(|p| fs::canonicalize(p).ok()).map(|p| p.join(dst.file_name().unwrap()))
};
if let Some(d) = dst_canon { if d == src_canon { return Err("目标与源为同一文件，已阻止导出以避免覆盖原片".into()); } }
```
并在**进入 copy 前**对整个 items 做一次"源目录集合 ∩ 目标目录"检查，命中即整体拒绝（比逐项报错体验更好）。

**配套修正（与主修复同批做）：**
- 把 `if fs::copy(...).is_ok()` 改为**错误累计**，返回 `{ success: N, failed: M, errors: Vec<(PathBuf,String)> }`，前端提示"成功 N / 失败 M（原因…）"，消除静默失败。
- 同名文件默认策略改为**跳过并计入报告**（或后端预检存在性），消除静默覆盖。

### 影响面与触发条件
- 触发条件：用户在导出弹窗里粘贴/选择了与 JPG 或 RAW 相同的目录。**用户很容易犯**（"我就导出到原目录里挑出来的"）。
- 后果：**Unix 系确定截断源片为 0 字节**；Windows 要么截断、要么静默零导出。**Windows 上 `fs::copy` 同路径的真实分支仍需实机实测**（本轨道只读，未能跑）。

### 风险评估
- 风险等级：**HIGH**（后端数据安全；不可逆、无备份、用户极易触发）。前端校验本身为 LOW，但**不能只做前端**（后端才是最终防线）。
- 需产品决策：撞名（不同目录同名文件）时是**跳过并报告**、**自动加后缀**、还是**拒绝**？推荐默认**拒绝并列出冲突清单**，另提供"自动重命名"选项。
- 回滚：校验是纯新增分支；错误累计是返回值结构变更（需同步前端，属可控的接口演进）。

### 验证方法
- **必须在真实文件系统上验证 `fs::copy(same, same)` 行为**：造一个 1MB 文件，`fs::copy(&p, &p)`，检查返回与文件大小/内容。Windows + Linux 都要测（Unix 预期截断为 0；Windows 预期截断或 SharingViolation）。
- 单元（Rust）：测试名 **`export_rejects_target_equal_to_source_dir`** —— 传入 target==source，断言返回 `Err` 且**源文件字节数不变**；**该测试在修复前应失败**（t1 已将此列入其报告的验证清单）。
- 单元：mock 前端校验；手动：在导出弹窗把目标设为 JPG 目录，确认被拒绝且导出按钮禁用。

---

## 4. 万张规模的性能清单（逐项判断）

> 判断口径：**"是否有真实风险"**＝在 **1 万张、普通 SSD、默认设置**下是否会成为可感知瓶颈。每项注明证据与量化依据。

### (a) 虚拟化参数与 `style.height` 是否一致 —— **真实风险：低–中（存在固定漂移）**

- `ThumbnailGrid.tsx:79` `rowHeight = columns === 3 ? 140 : 118`，`:83` `estimateSize: () => rowHeight`。
- 实际行高：行容器 `className="grid gap-1.5 pb-1.5"`（`:290`），子格子 `style={{ height: columns === 3 ? '132px' : '110px' }}`（`:475`）。
  - `pb-1.5` = 6px，`gap-1.5` 在单行内只作用于列间距（不影响行高）。
  - **3 列：实际 132+6 = 138px vs 估算 140px（差 2px）**
  - **4 列：实际 110+6 = 116px vs 估算 118px（差 2px）**
- **关键放大因素**：代码**没有**在行 div 上挂 `ref={gridVirtualizer.measureElement}`（对比 `:275-291` 无 ref）。@tanstack/react-virtual 只有在调用 `measureElement` 时才用真实尺寸覆盖估算；**否则全程用 `estimateSize`**。
- 量化：1 万张 / 3 列 = 3333 行 × 2px = **累计漂移 ≈ 6666px**。表现为：滚动条长度偏差、`scrollToIndex`（`:88-96`，选中项滚入视野）落点偏移、快速拖到中段时渲染窗口与视觉位置错位。
- **判断：真实风险成立，但幅度小**（不会崩，只是"跳选中的那一行偶尔不在正中")。**证据充分，无需实机即可定性；具体像素漂移需实机可见验证。**

**修复：** 两选一——
1. 把 `estimateSize` 改成精确值（3 列 `138` / 4 列 `116`，注意 `pb-1.5` 与将来样式变更会再次失配）；
2. **推荐**：给行 div 加 `ref={gridVirtualizer.measureElement}` + `data-index={virtualRow.index}`，让虚拟化器自测（对样式改动免疫）。两条都做最稳。

### (b) 每格一次 `getThumbnail` IPC 在快速滚动时的请求量 —— **真实风险：中（有冗余请求，但被磁盘缓存兜住）**

- `ThumbnailGrid.tsx:387-436`：`GridPhotoCell` 的 `useEffect` 在挂载时调用 `api.getThumbnail(targetPath, 200)`（默认路径，`:421-431`）。**每个进入虚拟窗口的格子一次 IPC。**
- `api.getThumbnail`（`api.ts:39-45`）→ `invoke('get_thumbnail_cmd')` → `spawn_blocking(get_or_create_thumbnail)`（`commands.rs:36-45`）。
- `get_or_create_thumbnail`（`thumbnail.rs:149-193`）**每次调用都先做**：`read_orientation`（打开文件读 EXIF）+ `get_cache_path`（`fs::canonicalize` + `fs::metadata` + **`Sha256` 哈希**，`:59-87`）+ 缓存命中判断（2 次 `fs::metadata`）。**即使缓存命中也要付这些 CPU/IO 成本。**
- 量化：稳定态可见行 ≈ 视口高(≈900) / 行高(140) ≈ 7 行 + overscan 4×2 = 15 行 × 3 列 = **≈45 格同时挂载**。
  - **正常滚动**：45 次 IPC/帧窗口，成本可控。
  - **快速拖拽/滚轮**：react-virtual 会连续挂载新行；**短时间内可触发数百次 IPC**（每次约 5 个 fs 调用 + 一次 sha256）。**前端无请求去重/无 inflight 缓存**——来回滚动会对同一文件**重复发 IPC**。
  - 每次 `spawn_blocking` 落在 tokio 阻塞线程池（默认 512 线程），**后端可并发**，所以不是串行瓶颈；瓶颈在**主线程 IPC 编解码 + 事件循环**与**磁盘 syscall 风暴**。
- **判断：真实风险成立（中）**。缓解点：磁盘缓存命中时单次成本低（数十 µs CPU + 几次 stat），1 万张首次全量生成后（总量 ≈ 1 万 × 单张时间）趋于平稳。**具体"快速滚动时 IPC/秒"与是否掉帧，需实机测量。**

**修复建议：**
- 前端加 `Map<path, Promise<string>>` 的 inflight/结果缓存，滚动回来直接命中（`GridPhotoCell` 的 `group.jpg?.path` 稳定，适合做键）。
- 后端：把 `read_orientation` + `get_cache_path` 的重复开销缓存/短路——例如缓存键先只用 `canonicalize`+`mtime`+`width`（**注意 orientation 是缓存键的一部分**，因为旋转后会重存，不能简单去掉；但可在 cache 命中时跳过 orientation 重读——目前顺序是先 `read_orientation` 再算路径，可优化为"按 (path,mtime,width) 查一份间接索引，命中直接返回，未命中才算 orientation"）。
- 复用 `<img loading="lazy">` 已有（`:487`），但它**不阻止 useEffect 发 IPC**，所以不是解法。

### (c) `lumenGridThumbnails` 开启后每张 ~0.3s 串行解码 —— **架构层面【已验证】串行；具体耗时【需实机测量】**

- 开关：`App.tsx:107-108`（设置开且握手成功）。`ThumbnailGrid.tsx:392-419` 走 `api.getLumenPreview(raw.path, {width:200})`。
- 调用链：`getLumenPreview`（`api.ts:224`）→ `lumen_preview_cmd`（`commands.rs:364-472`）→ `spawn_blocking(ensure_preview(..., render_closure))`。
- `ensure_preview`（`lumen.rs:1533-1567`）：**缓存命中直接 return**（`:1541-1543`），**不进入 render 闭包 → 不碰运行时锁**。所以**只有冷缓存才付渲染代价**。
- 未命中时：`render_preview` → `render_via_mcp`（`lumen.rs:1192-1211`）→ **`self.inner.lock()` 拿全局 `Arc<Mutex<RuntimeInner>>`**（`lumen.rs:758-760`）→ 在**同一个常驻 `lumen-cli mcp --headless` 进程**上 `client.call_tool("render_preview")`。
- **这是硬串行：所有网格缩略图渲染请求排队通过一把互斥锁 + 一个 sidecar 进程。** 失败还会降级到 B 通道 `run_lumen` **重新 spawn 一个进程**（`lumen.rs:922`，注释明确"冷启动 ~2s"，`commands.rs:457`）。
- 量化（用汇报给的 0.3s/张作为假设）：一屏 ≈45 格未缓存 → **≈13.5s 才能把当前屏渲染完**；用户继续快速滚动 → 请求持续堆积，**越滚越慢，且期间 `apply_tone_cmd` 等同样需要 session 的操作会被同一个锁阻塞**。
- **判断：真实风险成立（HIGH，但仅在 `lumenGridThumbnails` 开启时）**。"0.3s/张"来自汇报，**我无法从源码证实**（渲染耗时取决于 sidecar 与机器），但**串行化这一结论已由源码确证**。

**修复建议：**
- 前端**并发节流**：网格渲染请求走一个有上限的队列（如并发 2–4），避免一次性压 45 个请求进锁队列；配合 inflight 去重。
- 后端**拆分缓存查路径**：缓存命中不应触发任何渲染请求——目前 `lumen_preview_cmd:436` 已经算过 `was_cached`，但**仍无条件进入 `spawn_blocking(ensure_preview)`**（虽然快速返回，但仍占用阻塞线程 + 读锁竞争前的路径）。可提前 return，减少排队。
- **产品层**：`lumenGridThumbnails` 应在设置里明确标注"用引擎渲染网格会显著变慢，建议仅对小目录开启"，或改为"仅对单图预览用引擎，网格始终用内嵌 JPEG"。**这是最省力的根治。**

### (d) `filteredGroups / filteredIndices / visibleGroups` 三重 useMemo 的重算成本 —— **真实风险：低（万级不构成瓶颈）**

- `App.tsx:153` `filteredGroups`：O(n) `filter`（依赖 `[groups, filterMode]`）。
- `App.tsx:177` `filteredIndices`：搜索非空时 O(n) `map` + `filter`，且**每元素 `g.baseName.toLowerCase()` 分配**；空搜索时 O(n) `map(i=>i)`。
- `App.tsx:185` `visibleGroups`：O(n) `map`（依赖 `filteredIndices, filteredGroups`）。
- 触发：`setGroups` 后 `groups` 引用变化 → 三个 memo 全重算（`filteredIndices` 依赖 `filteredGroups` → 级联）。
- 量化：10k 规模下一次全链路 ≈ 3 次 O(n) 遍历 + 搜索时 1 万次 `toLowerCase` 分配 ≈ **数万次操作，亚毫秒~1–2ms**。按每键盘操作触发一次，**远低于 16.7ms 帧预算**。
- **判断：真实风险不成立（在 1 万量级）**。10 万级、或 `baseName` 很长时才会开始显形。**依据：复杂度与常数分析（n=10^4，O(n)）。**"每次按键重算成本"的量级确定为亚毫秒，无需实机即可判定非瓶颈。

**可选低成本优化：** 预建 `lowerName` 字段随数据一次生成；或 `useMemo` 中先判 `filterMode==='all' && !search` 直接返回 `groups` 引用（省两次遍历）。**非必需。**

### (e) `setGroups` 每次标记全量 `prev.map()` —— **真实风险：低（但会连带 (d) + M-17）**

- `App.tsx:470-472`（handleRate）、`:493-495`（handleFlag）、`:556-560`（handleToneChange）、`:568-572`、`:618-624`、`:684-688`、`:805-809`、`:843-859`（handleMetadataUpdated）**均为 `prev.map(...)` 全量重建数组**。
- 量化：10k 数组 `map` 重建 + 命中项对象展开 ≈ 0.1–0.5ms。**单独看不构成风险**。
- 但**组合效应**：`setGroups` 一次 → 触发 (d) 的三重 memo → 重新计算 `visibleGroups` → `ThumbnailGrid` 收到新 `groups` prop → 虚拟窗口内 ~45 个 `GridPhotoCell` 重渲染（未 `React.memo`）→ 因 `useEffect` 依赖 `[group.jpg?.path, group.raw?.path, lumenThumbnails]` 未变，**不会重发缩略图 IPC**（这点是对的）。
- 另有 `filteredIndices.indexOf(selectedIndex)`（`:190-193`）在每次搜索/选择变化时 O(n) 线性查找。
- **判断：真实风险低**。真正的隐患是"**每次键盘标记 = 一次全量 map + 一次 saveSession IPC（M-17）+ 一次 XMP 写**"三者叠加在快速连打（如按 1–5 快速打星、连续空格标记）时。单点都不是瓶颈，**叠加 + 无防抖**才是。**依据：n=10^4 的 O(n) 分析 + 调用链叠加。**

**修复建议（组合拳，收益大于单项）：**
- 键盘高频操作（打星/标记）先把本地状态更新合批（React 18/19 已自动批处理同一事件内 setState，但跨 IPC 的 `await` 会打破批处理）——即"**先 setState，再 fire-and-forget IPC**"（现有代码已如此），重点是 **M-17 防抖**。
- `GridPhotoCell` 加 `React.memo` 减少无关重渲染（收益小，可选）。

---

## 性能问题分级表

| 瓶颈项 | 证据位置 | 是否真实风险 | 量化依据 | 建议动作 | 优先级 |
|---|---|---|---|---|---|
| 扫描全串行（rayon 未接线） | `scanner.rs:236-503`；`Cargo.toml` 声明 rayon 但 0 引用 | **是** | 1 万张 × （EXIF+XMP STAT）串行；无并行度 | 引入 rayon 并行 EXIF/XMP 阶段；先测基线 | P0 |
| 扫描配对 O(J×R) | `scanner.rs:344-349` `Vec::contains` | **是** | 1万×1万 ≈ 10^8 字符串比较 | 换 `HashSet` | P0（改动极小） |
| LUMEN 网格缩略图硬串行 | `lumen.rs:1192-1211` 单 `Mutex` + 单 sidecar；`ThumbnailGrid.tsx:392-419` | **是（仅开关开启）** | 一屏 ~45 格 × 0.3s ≈ 13.5s（0.3s 需实机）；渲染请求全排队 | 前端并发节流 + 去重；缓存命中提前 return；产品层默认关闭 | P0 |
| M-17 无防抖 session 写 | `App.tsx:826-833` | **是** | 每次选中变化 1 IPC + 1 SQLite 写 | 前端防抖 + 3 处 flush | P1 |
| 每格一次 getThumbnail IPC（含冗余） | `ThumbnailGrid.tsx:387-436`；`thumbnail.rs:149-168` | **是（中）** | 快滚时数百 IPC/s；缓存命中仍付 canonicalize+sha256+多 stat | 前端 inflight 去重缓存；后端命中路径短路 | P1 |
| 虚拟化行高 2px/行 漂移 | `ThumbnailGrid.tsx:79,83,290,475` | **是（低-中）** | 3333 行 × 2px ≈ 6666px 累计漂移 | 精确 estimateSize 或挂 measureElement | P2 |
| 三重 useMemo 重算 | `App.tsx:153-188` | **否（万级）** | 3×O(n) + 搜索 1 万次 toLowerCase ≈ 亚毫秒 | 可选：`all+无搜索` 短路 | P3 |
| setGroups 全量 map | `App.tsx:470,493,556,568,618,684,805,843` | **否（单点）** | 10k map ≈ 0.1–0.5ms | 与 M-17 防抖合并解决 | P3 |
| 排序比较器重复 toLowerCase | `scanner.rs:453,459,490` | **否** | O(n log n) 次 String 分配（~26 万） | 预建排序键（可选） | P3 |

---

## 后端改造清单

| 新增项 | 类型 | 文件 | 说明 |
|---|---|---|---|
| `scan_cancel: Arc<AtomicBool>` | AppState 字段 | `commands.rs:18-22` + `lib.rs:23-26` | 扫描取消标志 |
| `export_cancel: Arc<AtomicBool>` | AppState 字段 | 同上 | 导出取消标志（或与扫描共用一个 `TaskControl`） |
| `cancel_scan_cmd` | 新命令 | `commands.rs` | 置位取消标志 |
| `cancel_export_cmd` | 新命令 | `commands.rs` | 置位取消标志 |
| `ScanProgress` / `ExportProgress` 枚举 | 新类型 | `models.rs` 或 `commands.rs` | `#[serde(tag="kind")]` 事件负载 |
| `scan_folders_cmd` 增加 `on_progress: Channel<ScanProgress>`（路线 A）**或** `app: AppHandle` + `app.emit`（路线 B，推荐） | 命令签名变更 | `commands.rs:24-34` | 进度旁路；返回值不变 |
| `batch_export_cmd` 同上 + 目录自检 + 半成品收尾 | 命令变更 | `commands.rs:196-254` | 见 §2 / §L-10 |
| `scan_folders` 增加 `&AtomicBool` + 进度回调 | 签名变更 | `scanner.rs:236` | 在 §M-05 列出的安全点检查 |
| 配对 `Vec::contains` → `HashSet` | 内部实现 | `scanner.rs:344-349` | 消 O(J×R) |
| rayon 并行化 EXIF/XMP 阶段 | 内部实现 | `scanner.rs:296-448` | **先测基线再决定**；注意 `groups` 顺序须在排序阶段统一决定 |
| `lib.rs` 注册新命令 + 可选 `.on_window_event` | 注册 | `lib.rs:27-56` | 若采纳后端关闭钩子 |
| （可选）`batch_export` 清单文件写入 | 内部实现 | `commands.rs` | 见 §2 |

---

## §2 批量导出取消的原子性与副作用（专项）

### 现状
`batch_export_cmd`（`commands.rs:196-254`）在 `spawn_blocking` 内**串行 `fs::copy`**，累积 `exported`，正常结束才返回。**中途取消（无论用户强杀进程还是将来的协作式取消）会留下"目标目录里已复制一半"的状态**——这正是汇报指出的问题。**【已验证】**

当前**没有**：
- 任何取消路径；
- 任何清单/完成标记；
- 任何 tmp→rename 的原子写（直接用 `fs::copy` 落最终名，`commands.rs:218, 233`）。

### 收尾策略对比

**策略 1：删除已复制的文件（回滚到导出前）**
- 优点：目标目录状态干净，语义"取消=什么都没发生"。
- 缺点：**已有文件会被误删**。若目标目录里**本来就存在**同名文件（用户导出过一次），`fs::copy` 会**覆盖**它；取消时你无法区分"本次复制的"还是"本来就有的" → 删除会**毁掉用户原有文件**。除非配合清单记录"本次新建/覆盖了哪些"，否则不安全。
- 结论：**不推荐单独使用**。

**策略 2：保留已完成部分 + 报告（推荐）**
- 取消时**保留**已复制的文件，返回 `ExportOutcome { copied: Vec<PathBuf>, cancelled: bool, failed: Vec<(PathBuf,String)> }`。
- 前端提示："已取消，已复制 N 个文件，剩余 M 个未复制。"
- 优点：复制是**幂等且用户可理解**的（文件已在硬盘上，就是完成了一部分）；无"误删已有文件"风险；实现简单。
- 缺点：目标目录是"部分集合"。可用**清单文件**消解（见下）。

**策略 3：写到临时子目录 → 全部完成后原子搬迁（all-or-nothing）**
- 复制到 `target/.gallery-export-tmp-<uuid>/`，全部成功后再逐个 `rename` 到 `target/`（同卷 rename 是原子的）。
- 取消时直接**删临时目录**，目标目录零污染 → 真正的"取消=没发生"。
- 优点：**唯一能保证目标目录干净的方案**；无覆盖原文件风险（rename 前不碰目标名）。
- 缺点：需要**同卷**（跨卷 rename 会退化为 copy，那就失去原子性）；需要额外磁盘空间（临时目录 + 最终目录短暂双份）；`target` 下会出现临时目录（需防用户误入）。
- 结论：**如果产品要求"取消必须干净"，这是唯一正确解**。

### 我的推荐

> **推荐组合：策略 3（临时目录 + 原子搬迁）作为主路径，策略 2 的清单文件作为附加。**
> 若工期紧，退而求其次：**策略 2 + 清单文件**（实现成本最低、无数据破坏风险）。

**清单文件（无论选哪种都建议写）：** 在 `target/.gallery-export.json` 写入
```json
{ "version": 1, "startedAt": 0, "finishedAt": 0, "status": "completed|cancelled|failed",
  "includeJpg": true, "includeRaw": true,
  "items": [{ "src": "...", "dst": "...", "result": "copied|overwritten|skipped|failed", "error": null }] }
```
理由：
- 用户下次导出前能知道"上次是部分导出"；
- 若将来要"反悔/清理本次导出产物"，清单就是唯一可信依据（解决策略 1 的误删问题）；
- 冲突（同名覆盖）有据可查。

**为什么推荐原子搬迁而非"删除已复制"**：`fs::copy` 会**静默覆盖**目标同名文件（`commands.rs:218` 只判断 `.is_ok()`）。任何"取消后删除"的策略在"目标目录已有同名文件"时都会**删掉用户原本的文件**——这是数据破坏，不可接受。临时目录方案从根上回避了这个问题。

### 取消检查点（导出）
在 `commands.rs:210` 的 `for item in items` **每次迭代开头**查 `export_cancel`；在 JPG 复制后、RAW 复制后、XMP 复制后各一次（便于快速响应大文件）。**不要**在 `fs::copy` 进行中尝试中断（Rust 的 `fs::copy` 不可中断；大 RAW 单文件 20–80MB 通常 < 1s，可接受）。

### 验证方法
- 造 200 个各 10MB 文件，取消后在"策略 3"下断言目标目录**无新增文件**；在"策略 2"下断言清单 `status=cancelled` 且 `copied` 数量 = 实际落盘数。
- **覆盖场景专项**：目标目录预置一个与源同名的、内容不同的文件 → 取消 → 断言该文件**未被删除**（这是策略 1 失败、策略 2/3 通过的判定用例）。

---

## 优先级与依赖

| 优先级 | 事项 | 依赖关系 |
|---|---|---|
| **P0** | `scanner.rs:344-349` 换 `HashSet`（消 O(J×R)） | 无依赖，独立可做，收益/成本比最高 |
| **P0** | 扫描基线测量（先量化再决定是否上 rayon） | 无依赖 |
| **P0** | LUMEN 网格缩略图并发治理（前端节流 + 缓存命中提前 return） | 与 (b) 前端 inflight 缓存可合并 |
| **P1** | M-05 进度（选 B：全局 emit + 任务中心）+ 取消基础设施（AtomicBool + cancel 命令） | 需先定义 `TaskControl` 状态；与 M-17 关闭钩子可合并 |
| **P1** | M-05 导出进度 + 半成品收尾（策略 2/3） | 依赖取消基础设施 |
| **P1** | M-17 防抖 + flush | 依赖"关闭前钩子"决策（前端 `onCloseRequested` 或后端 `on_window_event`） |
| **P0** | L-10（汇总记为 **H-04**）目录自检（后端强制）＋ 错误累计（消除静默失败/覆盖） | 无依赖；**后端数据安全 HIGH，应立即做**（Unix 确定截断源片，已由 Rust stdlib 文档佐证）。**owner = t4（含后端），非纯前端轨道** |
| **P2** | (b) 前端缩略图 inflight 去重缓存 | 与 P0 LUMEN 节流合并 |
| **P2** | (a) 虚拟化 measureElement / 精确 estimateSize | 无依赖 |
| **P2** | L-02/L-03 Toast 策略 | 无依赖 |
| **P3** | (d)/(e) 微优化 | 无依赖，非必要 |

---

## 工作量估计（人天，假设：1 名熟悉本仓库的全栈开发者；含自测；不含产品评审等待）

| 条目 | 前端 | 后端 | 小计 | 假设 |
|---|---|---|---|---|
| P0 `scanner.rs` HashSet 修复 | 0 | 0.25 | 0.25 | 纯替换 + 单测 |
| P0 扫描基线测量 | 0 | 0.5 | 0.5 | 造压测库(§下) + 计时脚本 |
| P0 LUMEN 网格并发治理 | 0.75 | 0.5 | 1.25 | 前端节流队列 + 缓存命中提前 return |
| P1 M-05 进度基础设施（emit/Channel + TaskControl） | 0.75 | 1.0 | 1.75 | 一个可复用任务中心骨架 |
| P1 M-05 扫描进度 + 取消 | 0.5 | 1.0 | 1.5 | 检查点接入 + 前端进度 UI |
| P1 M-05 导出进度 + 取消 | 0.5 | 1.0 | 1.5 | 含临时目录/清单收尾 |
| P1 M-17 防抖 + 3 处 flush（含关闭钩子） | 0.75 | 0.25 | 1.0 | 前端为主；后端仅注册钩子 |
| P0 L-10 目录自检 + 错误累计（消除静默失败/覆盖） | 0.25 | 0.5 | 0.75 | 前后端各一次校验 + 返回结构改 + 单测 `export_rejects_target_equal_to_source_dir` |
| P2 (b) 缩略图 inflight 去重缓存 | 0.5 | 0.25 | 0.75 | 前端 Map 缓存 + 后端命中短路 |
| P2 (a) 虚拟化修正 | 0.25 | 0 | 0.25 | estimateSize/measureElement |
| P2 L-02/L-03 Toast 策略 | 0.75 | 0 | 0.75 | 双 live region + 去重 + 历史 |
| P3 微优化（d/e/排序键） | 0.25 | 0.25 | 0.5 | 可选，非必须 |
| **合计** | **5.25** | **5.5** | **10.75** | |
| **其中后端改造小计** | — | **5.5** | **5.5** | 扫描并行化若采纳再加 ~1.0（先测后决） |

**说明：** 若只做"止血"（HashSet + L-10 后端自检**＋错误累计** + M-17 防抖 + Toast），约 **2.25 人天**；完整 P0+P1 ≈ **7–7.5 人天**。

---

## 复核中发现的报告偏差

1. **M-05 阶段划分失准。** 原描述"枚举 → 配 JPG/RAW → 读 EXIF → **生成缩略图** → 读 XMP → 排序"暗示缩略图生成在扫描命令内。**实际 `scan_folders` 只写 `thumbnail_path: None`（`scanner.rs:339,445`），缩略图是渲染宫格时逐格惰性生成的（`get_thumbnail_cmd`）。** 且 XMP 与 EXIF 是在同一逐组循环内交替读取，并非两个独立串行阶段。**此偏差影响"扫描进度需要几个阶段"的 UI 设计**——扫描阶段实际只有：枚举 → 逐组(EXIF+XMP+精修探测) → 排序。

2. **"每张约 0.3 秒的串行解码"——"串行"已验证，"0.3s"未验证。** 串行由单 `Mutex`（`lumen.rs:758-760, 1192-1211`）+ 单 sidecar 进程确证；但 0.3s 是**外部假设**，源码无法给出。报告中已明确区分，不得当事实引用。另需注意：**缓存命中不进入渲染闭包、不碰锁**（`lumen.rs:1541-1543`），所以"万张滚动"的真实成本只发生在**冷缓存首刷**。

3. **"上万张秒级加载"与源码不符（新增偏差，原报告未提）。** `Cargo.toml` 声明 `rayon` 但 **0 引用**，扫描**纯串行**（`scanner.rs` 全线性）；配对分支还存在 **O(J×R)** 的 `Vec::contains`（`scanner.rs:344-349`）。这两点合起来，"秒级"在 1 万张规模下**很可能不成立**，需实测。建议把此项作为性能核查的第一优先级（成本最低、证伪/证实最快）。

4. **Toast cap 描述准确但易误读。** 原报告"最多同时 3 条"**正确**；其实现是 `slice(-2)` 后追加（`Toast.tsx:89`），即"保留最后 2 条 + 新条目"。补充：该 cap **对错误同样生效且无去重**，这才是错误风暴下信息丢失的根因（原报告只提数量，未提"无去重+错误无豁免"）。

5. **L-10（汇总总表统一编号 **H-04**）严重度被低估（本轨道结论经 t1 交叉复核后又上调）。** 原报告按 LOW 归类；同一代码路径上 `fs::copy(src, dst)` 在 `src==dst` 时，**Rust 标准库文档明确说明"同一文件很可能被截断"**（Unix 为 `O_TRUNC` 确定截断；Windows 走 `CopyFileEx`，截断或 SharingViolation 待实测）。**定级上调为 HIGH**，并补记"静默失败（`.is_ok()` 吞 Err）"与"静默覆盖（无 IF_EXISTS 检查）"两个次要缺陷。Windows 确切分支**仍待实机验证**，但不影响"必须先加后端防护"的结论。

6. **M-17 的"后端合并写"路线不可行（对原报告问题 3 的修正）。** 后端拿不到"防抖窗口内尚未发送"的选中索引，因此**不能靠后端单点解决丢写**；必须前端持有最新值并在 3 个 flush 点落盘，"关闭前钩子"是新增项（当前 `lib.rs` 无 `on_window_event`、前端无 `onCloseRequested`，已双双验证）。

---

## 压测场景构造（无真实照片库 → 1 万张）

**目标**：可复现地构造"1 万 JPG（+可选 1 万 RAW）"目录，用于扫描/滚动/导出压测。

**方案：用脚本合成小体积但结构真实的文件**
```bash
# 在 Windows Git Bash 下执行；每张 ~20–40KB（够触发 EXIF/XMP/缩略图路径，不占满盘）
mkdir -p /tmp/stress/jpg /tmp/stress/raw
python - <<'PY'
import os, struct, zlib, random
from pathlib import Path
# 最小合法 JPEG（1x1 灰）+ 可选最小 EXIF/APP1；RAW 用同尺寸伪文件（扩展名决定路径）
MIN_JPEG = bytes.fromhex('ffd8ffe000104a46494600010100000100010000ffdb004300ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda0008010100003f00d2cf20ffd9')
for i in range(10000):
    stem = f"IMG_{i:05d}"
    (Path('/tmp/stress/jpg')/f'{stem}.jpg').write_bytes(MIN_JPEG * 8)   # ~几百字节，可调大
    (Path('/tmp/stress/raw')/f'{stem}.cr3').write_bytes(b'\x00'*32768) # 伪 RAW，占位
    if i % 3 == 0:
        (Path('/tmp/stress/raw')/f'{stem}.xmp').write_text('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmp:Rating="3"/></rdf:RDF></x:xmpmeta>')
print('done')
PY
```
**注意与局限：**
- 合成 JPEG 的 EXIF 为空 → `read_exif_metadata` 仍会**打开文件并尝试解析**（成本相近），但 `try_extract_exif_thumbnail` 会失败 → 缩略图走"全图 decode"路径（`thumbnail.rs:183`），**与真实库（有内嵌缩略图）不同**。要更真实，需嵌入真实 APP1 缩略图（可用 exiftool 批量注入）。
- 伪 RAW 不是合法 RAW → **LUMEN 引擎路径无法真实渲染**。测 LUMEN 冷缓存串行需**真实 RAW**（哪怕 200 张真实 RAW 就足以量化"每张渲染耗时"并外推到 1 万）。
- **导出压测**要用**大文件**（10–80MB）才能体现耗时与取消体验：可把少数文件放大，或专门造一个"200 × 20MB"的小集合。

**测量点：**
1. 扫描耗时（分段打点：枚举 / EXIF+XMP / 排序）→ 决定是否上 rayon。
2. 冷启动宫格滚动 30 秒内的 IPC 次数与掉帧（DevTools Performance + Rust 侧计数）。
3. LUMEN 开关冷缓存首刷 200 张真实 RAW 的总时长 → 外推 1 万。
4. 导出 200×20MB 的耗时 + 取消响应延迟 + 目标目录残留（配合 §2 的策略对比）。

---

*（本文件为唯一写入产物；未修改任何现有源码。）*
