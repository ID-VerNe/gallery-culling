# ADR-002：写盘合并与待写盘意图表（FR-03）

- 状态：已采纳（2026-10-18）
- 关联：ADR-001（旗标存储）、`docs/lumen-benchmark-2026-10-18.md` §5.2

## 背景

ADR-001 之后，一次按键（`1..5` / `P` / `X` / `U`）会产生两条写盘路径：

1. `.gallerycull.json` 的整份读-改-写（`cullstore::upsert`）；
2. XMP 侧边栏的整份读-改-写（`write_xmp`）。

连按五次就是十次重写。更严重的是**失败语义**：写盘抛错时前端只是把格子标成
「未同步」，磁盘上没有任何记录；用户关掉应用，这次改动就彻底消失。

报告 §5.2 的验收标准是「同一照片 500ms 内 5 次改动只落盘 1 次；崩溃后回放；
已确认操作零丢失」。

## 决策

**先记意图，再由合并队列折叠写盘。**

### 1. `pending_xmp` 只记意图，不是第二份真值

```sql
pending_xmp(photo_path PRIMARY KEY, rating, flag, updated_at)
```

- 写入顺序：**先 `enqueue_pending`（同步、毫秒级）→ 再进合并队列**。
  进程在两步之间被杀，下次启动能回放。
- 落盘成功（本地存储 + XMP 都写完）才删行；失败保留。
- **任何读路径都不读它**。真值仍是 `xmp:Rating` 与 `.gallerycull.json`。
  它只回答一个问题：「用户做过、但磁盘上还没有」的动作有哪些。

### 2. 同一照片 400ms 静默窗口折叠

`syncqueue::Coalescer` 以照片路径为键：后到的意图**覆盖**先到的，窗口重新计时；
窗口结束由其中一个等待者执行落盘，其余等待者共享同一结果。

- 键是路径字符串（前端传什么就存什么），不同照片互不干扰；
- 落盘在锁外执行 —— 一张照片的写盘不能挡住另一张；
- 不用后台常驻线程：等待者用 `Condvar` 语义的通道超时自己触发落盘，
  没有线程生命周期、没有退出时 flush 的悬案。

### 3. 命令仍然**阻塞到真正写完**

`update_rating_flag_cmd` 不返回「已排队」，而是返回磁盘结果。

- 保留现有错误契约：写失败 → `Err` → 前端 `markUnsynced` + toast；
- 批量进度条的「成功/失败张数」仍然准确；
- 折叠掉的 N 个调用方共享同一个结果，谁都不会误以为写成功。

代价：一次按键的 IPC 最多多等 400ms。界面是乐观更新，用户看不到延迟。

### 4. `coalesce = false` 给「每张只改一次」的路径

批量写盘、重试、撤销传 `false`，立即落盘。否则 200 张的批量会凭空多等
80 秒（每张都要等一个完整的静默窗口）。

### 5. 回放：外部改动优先

启动时在后台线程回放。逐条判断：

- 侧边栏 mtime **晚于** `updated_at` → 用户改完之后又被 Lightroom / Bridge
  改过 → **不覆盖**，删掉这条过期意图并打日志；
- 否则重新走一遍 `DiskSink`（本地存储 + XMP），成功即删行。

覆盖别人刚写的数据，比丢掉一次自己没落盘的改动严重得多。

### 6. LUMEN 推送只在 `wrote = true` 的那次做

折叠掉的调用方如果各推一遍，会对着同一文件连开 N 个 sidecar 进程，而且推的是
被覆盖掉的过期值。`Outcome.wrote` 是唯一的去重依据。

## 失败语义

| 场景 | 结果 |
|---|---|
| 本地存储写失败 | 命令返回 `Err`，pending 行保留，下次启动重试 |
| XMP 写失败 | 同上（本地旗标已写成功，重试是幂等的） |
| 队列锁中毒 | 命令返回 `Err`，pending 行保留 |
| 进程被杀 | 已 `enqueue` 的意图全部在表里，下次启动回放 |
| 照片所在盘未挂载 | 回放失败并打日志，行保留（盘插回来还能补） |

## 明确不做

- **`label` 列**：色标还没落地（FR-02）。等色标 UI 上线再加列，别先占位。
- **pending 表 TTL / 上限**：失败的行会一直留着。这是刻意的 —— 丢掉用户标记
  比留几行垃圾严重。真要清理，等有「同步失败」面板时一起做。
- **跨进程写盘协调**：本应用单进程；LUMEN 是独立进程但只读我们写好的侧边栏。
- **退出前强制 flush**：没必要。意图已经在表里，下次启动补写即可。

## 验收（已落地为测试）

| 用例 | 位置 |
|---|---|
| 5 次并发提交只写 1 次，且写的是最新值 | `syncqueue::tests::burst_writes_once_with_latest_value` |
| 折叠的每个调用方都拿到结果 | `syncqueue::tests::every_waiter_sees_the_result` |
| 只有一个调用方 `wrote = true` | `syncqueue::tests::exactly_one_caller_reports_wrote` |
| 后到的提交把窗口往后推 | `syncqueue::tests::later_submit_extends_the_window` |
| 不同照片不合并 | `syncqueue::tests::distinct_paths_are_not_merged` |
| `coalesce = false` 不等窗口 | `syncqueue::tests::coalesce_false_writes_without_waiting` |
| 写失败传给每个等待者 | `syncqueue::tests::write_error_reaches_every_waiter` |
| 上一轮结束后能开新一轮 | `syncqueue::tests::submit_after_flush_starts_a_new_write` |
| 意图跨进程存活 | `db::tests::pending_survives_reopen` |
| 回放写出侧边栏并删意图 | `commands::xmprw::tests::replay_writes_sidecar_and_clears_intent` |
| 外部改动优先，不覆盖 | `commands::xmprw::tests::replay_skips_intent_older_than_external_edit` |
| 批量关闭合并 | `useBatchOps.test.tsx` |
| 撤销关闭合并、按键开启 | `App.undo.test.tsx` |
