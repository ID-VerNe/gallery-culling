# ADR-007：任务互斥表与后端任务槽

- 日期：2026-10-18
- 状态：已采纳
- 相关：报告 `docs/lumen-benchmark-2026-10-18.md` §5.8、FR-09
- 参考实现：`lumen-raw/lumen/scheduler.py:39-49`（`EXCLUSIVE` / `BLOCKED_BY`）

## 背景

扫描/导出/渲染/AI 各自有 flag，但没有一张表回答「现在能不能开始导出」。已知后果：

- `scan_cancel` / `export_cancel` 是 `AppState` 上的**全局**标志。两次扫描并发时，
  第二次入口的 `cancel.store(false)` 会把第一次的取消请求抹掉；
- 两个导出并发会互相覆盖临时目录，并共用同一个取消标志；
- 扫描完成回调会覆盖用户在扫描期间的选择（2026-10-15 e2e 实锤）；
- 用户在扫描中导出，导出范围来自一个尚未定稿的集合。

报告给出的落地方式是「Rust 侧 `WorkState` + `try_begin`」，本 ADR 在此基础上补了
前端一层：**UI 要能解释为什么点不了**，而不只是后端拒绝。

## 决策

### 1. 互斥表是前端唯一真值，后端持有一份子集

前端 `src/utils/taskMutex.ts` 定义 7 种活动与 `BLOCKED_BY`；后端 `taskgate.rs` 只覆盖
4 种（扫描/导出/渲染/AI），因为批量写盘与套用调色是**前端逐张循环**，后端每次命令
调用都是独立的，没有可抢占的长事务。

两份表跨语言无法共享常量，这是已知代价。缓解：两边各有「对称性」与「不自阻」测试，
改动时测试会逼你两边一起改。注释里明确写了这一点。

### 2. 表必须对称，且不自阻

- **对称**：`A 挡 B` 等价于 `B 挡 A`。不对称会造出「A 在跑时 B 进不来，B 在跑时 A
  却能进」的矛盾状态 —— 两个入口的可用性互相打架，用户无法建立心智模型。
- **不自阻**：`BLOCKED_BY[a]` 不含 `a`。同一活动的并发由 `canStart` 的「自占用」
  判断处理（`active.has(activity)` → false），表本身保持结构性质。

把「自占用」放在判定层而不是表里，是为了让「对称性」这条测试能成立 —— 否则
`BLOCKED_BY[a]` 含 `a` 而 `BLOCKED_BY[a]` 不含 `b` 时，对称性检查会把自阻误报成不对称。

### 3. 只禁真正危险的组合

六种长任务两两互斥，理由分三类：

| 冲突来源 | 涉及活动 |
|---|---|
| 共享全局取消标志 | scan / export / render |
| 共享 LUMEN 常驻进程编辑态 | render / ai / apply-tone |
| 改写同一批 XMP 文件 | batch-write / apply-tone |

`thumbnail`（LUMEN 宫格缩略图）只被 export / render 阻塞：它读内嵌预览，与扫描不冲突，
但与导出争磁盘 IO。报告明确警告「过度互斥导致什么都不能点」，所以扫描与缩略图是
唯一被允许并行的组合。

### 4. 后端用 RAII 任务槽，三条无死锁保证

```rust
let _guard = state.tasks.try_begin(Activity::Scan)?; // 函数结束自动释放
```

1. 只有一把 `Mutex<HashSet<Activity>>`，临界区内不做 IO、不 await；
2. `try_begin` **永不阻塞等待**：要么立即拿到，要么立即 `E_BUSY`；
3. 释放靠 `Drop`，任务 panic / 提前 return 也会解锁。

`E_BUSY: 正在导出照片，暂时不能扫描照片。` 前缀让前端可以把「忙」与真实失败分开显示。

**抢占必须在碰取消标志之前**：`scan_folders_cmd` 原来第一行就是
`cancel.store(false)`。如果重入先复位，正在跑的第一次扫描的取消请求会被静默撤销。

### 5. Context Provider，而不是 props 链

导出运行态在 `BatchExportModal` 内部、AI 蒙版在 `TonalAdjuster` 内部、扫描在
`useFolderScan` 里。汇总到 App 至少要三条回调链，且每加一个任务就再改一次 App。
`TaskMutexProvider` 让「谁在跑」与「谁想知道」直接对接。

`useActivity(activity, running)` 把已有的布尔状态接进表，绑定组件生命周期：
`running` 变 false 或组件卸载都会释放。异步任务用 `begin()` + `finally` 释放，
**release 幂等**（重复调用不会误放别人的 token）。

### 6. 原因必须画在屏幕上

disabled 按钮不可聚焦，`title` / `aria-describedby` 键盘与读屏都拿不到。所有阻塞原因
都用可见文本：

- 扫描按钮右侧（`role="status"`）；
- 导出弹窗 footer 的常驻状态位（与 validation 同一位置）；
- 调色面板的 AI 蒙版说明区、套用按钮下方。

### 7. 打开导出弹窗不禁用，禁用「开始导出」

打开弹窗没有副作用，禁用它只会让用户困惑。真正写盘的是「开始导出」按钮，它才是
互斥的落点。扫描按钮则直接禁用（点击即启动任务）。

## 测试

- `src/utils/taskMutex.test.ts`（14 例）：表结构（完整性、不自阻、对称、引用有效）、
  判定（空集、单阻塞、多阻塞、自占用、未知值）、原因文案。
- `src/hooks/useTaskMutex.test.tsx`（9 例）：注册/释放、release 幂等、同活动多 token、
  卸载释放、`useActivity` 跟随、Provider 边界。
- `src/App.taskMutex.test.tsx`（2 例）：批量写盘 → 扫描禁用 + 可见原因；
  批量写盘 → 导出按钮禁用 + 可见原因。
- `src-tauri/src/taskgate.rs`（9 例）：首次占用、同活动重入、跨活动互斥、Drop 释放、
  多 guard 独立、错误文案、对称性、中文标签。

变异验证：

- 前端 6 处全部被抓住（对称性、不自阻、自占用判定、原因含自己、release 幂等、卸载释放）；
- 后端 3 处：2 抓 1 等价存活（删掉 `conflicts` 里的 `a == b` —— 因为 `EXCLUSIVE`
  包含所有活动，同活动必然两边都 `contains`，该条件是冗余的）。

## 代价与风险

- 两份表跨语言漂移。缓解：各自对称性测试 + 注释；若未来加活动，必须同时改两处。
- `thumbnail` 目前没有接入点（LUMEN 宫格缩略图没有独立的 running 状态），表里先保留，
  接入时只需一行 `useActivity('thumbnail', ...)`。
- 互斥粒度偏保守：AI 蒙版运行 4 秒期间不能批量写盘。这是有意的 —— 两者都写 XMP/工程，
  并发会让「谁最后写」不可预测。
