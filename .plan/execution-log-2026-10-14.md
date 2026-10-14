# 执行日志 — 2026-10-14（SRP 巨石拆分与后端 DRY 收尾）

> 对应 handoff：`.handoffs/handoff-2026-10-14.md`
> 基线 commit `c362d55`，HEAD `12aa9e4`，**39 个 commit**
> 本文是**操作手册**：每个 commit 为什么这么做、坑在哪、哪些事我没做。

---

## 0. 开始前的状态与策略

上一份 handoff 留了一整套 80 条计划 + 逐条裁决台账，并派了 5 个并行 explore subagent
勘察剩余工作。本轮的工作顺序由用户指定：

> BL-04 → FE-06 → FE-07 → 剩下全部

选这个顺序的理由（我在本轮开头论证的）：
- **BL-04 先行**：lumen.rs 是被 commands.rs 依赖的下游，先稳定它的 `pub` API 面，
  FE-07 拆 commands 时面对的是不动的靶子。
- **FE-06 次之**：前端测试护栏最好（9 个 App 黑盒测试一行不改），回归面虽宽但可验证。
- **FE-07 最后**：BE-03/BE-04 已铺好公共 helper，搬运量最小。

**质量门**（每个 commit 都跑，无一例外）：
```bash
npx tsc --noEmit                                   # 前端类型
npm test                                           # 前端测试（297 -> 316）
cd src-tauri && cargo test --lib                   # Rust（126 恒定）
cd src-tauri && cargo clippy --all-targets -- -D warnings   # 零告警
```

**全程红线**：39 个 commit 没有一个留在红状态。任何一步验证不过就停下修，
不带着 broken 往下一步走。

---

## 1. BE-12 / BE-13（`d161b80`）—— 先拆一颗定时炸弹

**发现**：上一份 handoff 与 commit `5ae7378` 的 message 都声称 BE-12/BE-13 已完成，
但 `git show 5ae7378 --stat` 显示该 commit **不含 `xmp.rs`**。实测
`write_xmp_full`（`xmp.rs:404-406` 纯透传）与 `#[allow(dead_code)] pub fn read_xmp`
（`:138-141`，仅被 2 处测试自用）都还在。

**为什么这项排第一**：这是最危险的一类偏差——文档说做完了，所以后面没人会再碰。
不先拆掉，后面所有基于「已完成清单」的决策都会错。

**做法**：
- 删 `write_xmp_full`，3 处调用点改直调 `write_xmp_preserving`
- 删 `read_xmp`，2 处测试改用 `read_xmp_full(&xmp).rating` / `.label`
- `cargo test --lib xmp` 21/21 通过

---

## 2. BE-04（`10ada00`）—— 20 处 spawn_blocking 样板

**目标形态**（探索报告给了草案，我按实测修正）：

```rust
async fn blocking<F, T, E>(msg: &str, f: F) -> Result<T, String>
where F: FnOnce() -> Result<T, E> + Send + 'static, E: Display + Send + 'static
async fn blocking_value<F, T>(msg: &str, f: F) -> Result<T, String>
where F: FnOnce() -> T + Send + 'static
```

**必须是两个函数，不能合成一个带 `kind` 枚举的**：差异来自 lumen 公开方法的返回类型
（`query_version -> Option<String>` / `read_project_tone -> Option<..>` / `list_masks -> Vec<Value>`，
这三者不是 `Result`），是外部事实而非调用点口味。强行合并需要为 `Infallible` 再开一个
`E: Display` 实现，净增复杂度。

**踩的坑（三个，都靠编译器兜住）**：

1. **`?` 数量不能照搬**。原代码是 `.await.map_err(...)?` 或 `??`，helper 内部已经
   flatten 了内层错误，所以 20 处**全部**要改成单 `?`。
2. **有 2 处是尾部表达式不能带 `;`**（函数签名是 `pub async fn -> Result<_, String>`，
   `blocking(...).await?;` 会让函数返回 `()`）。12 处需要裸 `.await` 不带 `?`。
3. **`apply_tone_cmd` 的 apply_recipe 分支必须保留外层 `Result`**，否则
   `match applied` 的 warning 记账失效——那处是「XMP 已写成功、引擎失败只记账」的语义。
   这个如果图省事会**静默改变降级行为**，没有任何测试会红。

**净收益**：commands.rs 减少 21 行。

---

## 3. BE-03（`4c06d4a`）—— 11 处 Lumen 守卫

同样两个 helper：`require_lumen`（不可用即 Err）与 `lumen_exe`（不可用即 None）。

**修正了探索报告的一处错误**：报告称 `lumen_status_cmd` 的两个分支
「降级值完全相同可合并」。实测**不同**：
```rust
// !lumen_enabled  -> lumen::lumen_status_from(false, None, None)
// find_lumen_cli None -> state.lumen.status(false, None)
```
我在用 `replaceAll` 批量替换时发现并保留了原状。**这是本轮「不能全信探索报告」的
第一个实证**，后面还有两处。

`apply_tone_cmd` 的守卫（`commands.rs:1229-1243`）**刻意未动**：它在 XMP 已落盘之后，
走 `report.warnings` 记账而非 `?` 早退。改成 `?` 会把「XMP 已写成功」报成失败，
UI 状态再也回滚不了。留给 FE-07 步骤 11。

---

## 4. FE-09（`c874dd6`）—— TopBar 359 → 92 行

**拆法**：`SourceRow`（照片从哪来 + 系统入口 + 扫描按钮）+ `ToolbarRow`（筛选/排序/
视图/调色/Luminar/导出）。边界天然——`<header>` 下恰好两个 `<div>`，两者不共享局部变量。

**props 刻意显式转发而不是 `{...props}` 铺开**：这次拆分要澄清的就是 prop 面，
铺开会让边界重新糊回去。

**顺带做了 UX-14 / UX-15**：
- UX-14 扫描中显示「已发现 N 张」而非只有转圈。复用已有的 `scanTask.progress`
  （`useTaskProgress.ts:204-206`），无需新后端。
- UX-15 扫描失败原因常驻顶栏（`role="alert"` + 可「忽略」）。原实现只走一次 toast，
  批量扫描时用户同时盯着宫格和进度条，3 秒后已不知道哪一步坏了。

**修正了计划文档的一处实质错误**：计划称「扫描按钮在 ToolbarRow」，实际在 Row 1
`SourceRow`（`:188-206`）。照计划接线会挂错行。

**新增 4 条测试**（`App.scanProgress.test.tsx`）。踩的坑：`role="alert"` 不唯一
（`ToastViewport` 也有），改成 `data-testid="topbar-scan-error"`。
另一坑：`isTaskCancelled` 按哨兵**精确比对**，mock 取消必须 `throw TASK_CANCELLED_SENTINEL`
裸字符串，包成 `Error` 会变成 `"Error: 任务已取消"` 绕过判定。

---

## 5. FE-03a（`649fe8a`）—— 三视口坐标系统一

**计划中的坐标系分歧属实**：Preview 用绝对系（`dragStart = client - pos`），
Split/BeforeAfter 用增量系（`dx = client - dragStart` 再回写 dragStart）。

**统一到绝对系的理由不是风格**：增量系把 `dragStart` 放进 React state，
同帧内派发的两个 pointermove 会被批处理成读到**同一个旧 dragStart**，
dx 被重复计算、位移丢一帧。快速拖拽/低帧率下放大成可见抖动。绝对系天然免疫。

**这一段有严重的局限，必须让下一个 agent 知道**（详见 handoff 3.3 第 1 条）：
我写了 6 条拖拽测试，然后**故意把 Preview 改回增量系去验证测试能否抓住**，
结果全绿。RTL 的 `fireEvent` 是同步的，增量系缺陷在 jsdom 里复现不出来。
这 6 条测试锁的是净位移不变量与联动一致性，**坐标系正确性本身靠推理，不是实测**。
局限已写进测试文件注释，没有假装覆盖。

---

## 6. BL-04（`3d950ca` … `ec30c63`，12 个 commit）—— lumen.rs 3101 → 58 行

### 6.1 迁移顺序与每步的坑

| 步 | commit | 模块 | 行数 | 坑 |
|---|---|---|---|---|
| 1 | `3d950ca` | `error.rs` | 56 | 零依赖叶子，起步选它 |
| 2 | `9bd2db4` | `discovery.rs` | 85 | `find_bundled_lumen_cli` 被测试 mod 直接调，需提 `pub(super)` |
| 3 | `1bb8f2a` | `cli.rs` | 74 | 两块不相邻（`run_cli` 在 `:309-318`），合并搬 |
| 7 | `dc6ebb9` | `tone.rs` | 97 | **提前于 step 4**，见 6.2 |
| 4 | `a1c31b1` | `cache.rs` | 205 | 同上 |
| 5 | `29bcb8c` | `transport.rs` | 147 | `ProcessTransport` 的 2 个字段被测试直接构造，提 `pub(super)` |
| 6 | `2cd1ef9` | `mcp.rs` | 366 | `ScriptedTransport` 必须跟着 `McpClient` 走 |
| — | `b207d04` | `sync`/`capabilities`/`status` | 259 | 三个零依赖叶子，一次提交 |
| — | `c16f289` | `tools.rs` | 72 | 删死代码 `MASK_REGIONS` |
| 11 | `4c9761a` | `runtime.rs` | 439 | **唯一难点**，见 6.3 |
| 12 | `ec30c63` | 门面 + 测试归位 | 58 | 83 条测试按组搬进各自模块 |

### 6.2 计划顺序有一处隐性反向依赖

计划把 `tone` 排第 7 步、`cache` 排第 4 步。但 `cache` 的缓存键要调 `recipe_hash`，
而 `recipe_hash` 的宿主在 `tone.rs`。**照原顺序 cache 那一步编译不过。**
我把 tone 提前到 cache 之前，并在 commit message 里记了这一笔。

### 6.3 唯一难点：runtime.rs

`impl LumenRuntime` 386 行，12 个 pub 方法共享 `RuntimeInner`，`inner.lock()` 出现 11 次。

**砍掉自己写的投机 import**：我一开始给 runtime.rs 写了
`use super::{decide_sync, should_push_rating, SyncDecision, normalize_mask_region}`，
编译器报 unused。实测这几个函数在**生产代码里只被测试调用**。已删，不留投机 import。

**`call_session_tool` 与 `render_via_mcp` 刻意不合并**：两份近似的 spawn+握手+降级重连，
合并是行为变更，不属于「拆模块」的范围。

### 6.4 测试归位（step 12）

83 条测试从单一 `mod tests` 拆进 8 个子模块。规则：测试跟着它的**实现**走。
`ScriptedTransport` impl 的是 `LineTransport`，`spawn_echo` 构造的是 `ProcessTransport`
的私有字段——留在原处就得把模块边界反向拆开。

新增 `lumen/test_support.rs`（仅 `#[cfg(test)]`）：`tmp` / `t_plus` / `ep_inputs`
三个跨模块夹具。`tmp()` 生成临时文件名必须跨模块唯一，否则并行测试互删对方文件。

### 6.5 对外 API 面核对

用脚本比对拆分前后的全部 `pub` 项：
- **消失 1 项** —— `MASK_REGIONS`（已确认的死代码）
- `json_f32` / `canonical_json` / `tool_to_command_id` 拆分前是文件私有
  （不出现在 lumen.rs 顶层），拆分后仍是 `pub(super)`，**API 面未变**

---

## 7. FE-06（`990b196` … `d8412d2`，9 个 commit）—— App.tsx 1810 → 850 行

### 7.1 顺序修正：按扇入从小到大

计划里有三处倒挂，我按探索报告的建议改成扇入升序：

| 计划顺序 | 倒挂问题 |
|---|---|
| `useFolderScan` 排第一 | 它是**最大扇入点**，`handleScan` 写 6 类 state 全归属还不存在的 hook |
| `useGridSearch` 排在 collection 之后 | `filteredIndices` 与救援 effect **同时**依赖两者 |
| `useSettings` 排最后 | `settings` 是 5 个地方的输入，必须最先就位 |

最终顺序：`Step0 纯DRY → useAutoUpdate → useAppSettings → useFolderScan →
useCollection(含搜索) → useComparePin → useToneEditing → useRatingFlagSync → useBatchOps`

### 7.2 每个 hook 的核心决策

| 步骤 | hook | 关键决策 |
|---|---|---|
| 0 | — | 抽 `groupPath()`（12 处重复），让「RAW 优先」只有一处真值。`handleSyncLumenRatings` 那处**故意不动**：它兜底是 `\|\| ''` 且串了三个来源，语义不同 |
| 1 | `useAutoUpdate` | 必须是 **`.tsx`**（返回 JSX）。顺带修 bug：原先「读设置」与「检查更新」是同一个 effect（依赖都是 `[toast]`），职责混在一起 |
| 2 | `useAppSettings` | 回填走 `onFoldersLoaded` 回调而非直接持有 scan 的 setter —— 两个 hook 互相需要，回调解环 |
| 3 | `useFolderScan` | `onScanned` 回调而非传 8-10 个 setter。**修了一个真实回归**，见 7.3 |
| 4 | `useCollection` | **`selectedIds` 放进集合 hook 而非批量 hook**：多选本质是「选区」，切筛选时必须清空 |
| 5 | `useComparePin` | 无基准时的「交换」改 `selectedIndex/compareIndex`，由 App 通过 `onSwapIndices` 提供 |
| 6 | `useToneEditing` | 两个跨领域出口走回调：`onGroupsPatched` / `onMasksLoaded`。Esc 关闭面板与焦点归还也搬进 hook |
| 7 | `useRatingFlagSync` | **撤销栈只有一份**，见 7.3。`pendingBatch` 归本 hook 而非批量 hook（三个入口都在这） |
| 8 | `useBatchOps` | 批量确认框的三条文案**逐字保留**（有测试断言） |

### 7.3 本轮唯二的真实回归（都被测试抓住）

1. **重扫 effect 依赖写错**（step 3）。我把 `[sortOrder]` 写成 `[handleScan]`
   （照搬代码里那句「handleScan identity covers ...」的注释）。但 `handleScan` 的
   identity 会被 `persistFolders`（settings 读回后重建）与 `onScanned` 带动而抖动
   —— 挂在它上面会让**设置加载完就凭空扫一次目录**。已改回 `[sortOrder]`。
   **教训：注释里的「identity covers X」不等于「应该依赖 identity」。**

2. **两个 `useRatingUndo` 实例**（step 7）。曾一度在 App 与本 hook 各建一个，
   扫描前清空的那个清不到真正在用的那个。合并为单实例，App 通过
   `clearRatingUndo` 引用同一个。

### 7.4 没做的部分

`AppModals` 按约定**没做**：15 个 props 换 96 行 JSX 搬家，正是项目规则
「避免投机抽象与间接层」反对的。用户已确认接受这个判断。

---

## 8. FE-12（`e60ff66`）—— 删死命令

`update_tone_adjustments_cmd` 确认零调用（`api.updateToneAdjustments` 在
`src/**/*.{ts,tsx}` 零命中）。三处一起删：Rust 命令、lib.rs 注册、api.ts 方法。
排在 FE-07 之前，少迁一个马上要消失的命令。

---

## 9. FE-07（`1531fc2` … `93fb713`，7 个 commit）—— commands.rs 1673 → 523 行

### 9.1 必须先解决的机制问题

**`#[tauri::command]` 生成的宏跨不了模块**。这是拆 commands.rs 的**前置阻塞项**，
我花了一整轮才定位：

属性宏在定义它的模块内生成 `macro_rules!`（`__cmd__xxx` 与
`__tauri_command_name_xxx`），带 `#[macro_export]`。**glob 导入带不出 `macro_rules!`**。

解法有两条，都必须满足：
1. `lib.rs` 的 `generate_handler!` 里写**路径限定** —— `commands::xxx_cmd`
   （让宏解析发生在 commands 模块内，而非 crate root）
2. 每个命令子模块的 4 个宏名在 `mod.rs` 逐个显式转发

**最初我走错过一条路**：试图把 `use commands::*` 改成显式导入列表，
那需要重写整个 handler 列表且没解决问题，已回退。最终解法是先抽一个模块验证通过，
再批量套用。

### 9.2 命名避让

`xmprw`（不叫 `xmp`）、`lumencmds`（不叫 `lumen`）—— 否则与顶层的
`use crate::xmp` / `use crate::lumen` 同名冲突（`E0255`）。

### 9.3 一次真实的自我损伤

FE-07 期间我用 Python 做批量区间删除，两次切片位置重叠，把 `ExportOutcome` /
`ExportFailure` 的结构体切坏了。靠 `git show HEAD:` 逐段比对修回。

**教训（写进了 handoff）**：批量删 Rust 顶层 item 时，
用「一次性读全文 → 切两段 → 拼回」，**不要两次独立切片**。
每个 commit 前 `git diff --stat` 确认只有目标文件被改。

### 9.4 每步的搬运内容

| 步 | commit | 模块 | 行数 |
|---|---|---|---|
| 1 | `1531fc2` | `xmprw` | 81（首个，验证机制） |
| 2 | `5e1ab12` | `apps` | 82 |
| 3 | `ecd7290` | `thumbnail` + `settings` | 70 |
| 4 | `a967e18` | `scanner` | 90（`ProgressThrottle` 留 mod.rs，导出也用它） |
| 5 | `fe69337` | `export` | 397 |
| 6 | `9e182b6` | `tone` | 166 |
| 7 | `93fb713` | `lumencmds` | 470 |

remaining mod.rs 内容：`AppState` / `ProgressThrottle` / `now_epoch_secs` /
`blocking` / `blocking_value` / `require_lumen` / `lumen_exe` / 8 个 mod 声明 / 290 行测试块。

---

## 10. BE-05 / BE-14 / BE-15（`5f703bf`）

**BE-14 是本轮最有价值的一项 DRY**：命名空间 URI 此前有**三重定义**
（`OURS_NAMESPACES` / `build_our_description` 的 `format!` 字面量 / `short_prefix` 反查表）。
改一处漏两处会让写出的块与认回的块对不上——症状是「写进去了但下次不认」，极难排查。
现在 `OURS_NAMESPACES: [(prefix, uri); 4]` 是唯一真值，反查表一并删除。

**`parse_rating` 刻意不走 `extract_tag_value`**：那条按「标签缺失/值非数字即 None」处理，
而 Rating 必须区分 `-1`（reject）与 `0..5`，且不能丢符号——旧实现用裸数字扫描把 `-1`
读成 1 星，是一次静默数据损坏。这条不变量写进了函数文档。

**read-modify-write 只抽 read 一半**，不做计划里的 `modify_xmp(image, f)` 闭包封装：
`write_xmp` 的 reject 分支要中途提前 `return` 另走分支，套进闭包只会把控制流藏起来。
计划里的 `modify_xmp` 是个不存在的占位名，此处按真实形态落地。

---

## 11. BE-08a / BE-08b（`55bb38a`）

**BE-08a 落点与计划不同**：计划写抽 `exif::Reader::new()`，实测那是零参零状态的工厂，
抽出来只省 3 个 token。改为抽 `scanner.rs` 的 5 处 `display_value().trim_matches('"').trim()`
拷贝。**ISO 字段刻意不套**——它是数值字段不带引号，套上去属于「以为统一了其实改了行为」。

**BE-08b 分成两个函数**：`scanner::secs_from_meta(Option<&Metadata>)` 收已取到的
metadata（调用方为拿 `len()` 顺带），`thumbnail::file_mtime_secs(&Path)` 自己 stat。
缺省值也**没有**统一：`db::file_mtime_secs` 用 `-1` 且判 `> 0`，与这里的 `0` 语义不同，
合并会破坏 lumen 的「有没有 mtime 基准」判定。

`thumbnail.rs:468` 那处 mtime 重复是 `cache_path_matches_legacy_algorithm` 测试里的
「旧算法」内联块——它必须独立复现旧实现才能验证迁移正确性，**刻意保留**。

---

## 12. FE-11（`c5a25f0` / `245c0e3`）

- `read_exif_metadata` → `scanner/metadata.rs`（109 行）。`secs_from_meta` 留在
  scanner.rs：它被两处遍历路径调用，不属于 metadata 模块。
- 缩略图缓存 → `thumbnail/cache.rs`（139 行）。`read_orientation` /
  `apply_orientation` / `file_fingerprint` 留在 thumbnail.rs：属于「变换与来源」而非缓存布局。
- `cache_path_for` 的文件名格式由两条测试锁死，改动前先看它们——改了会让磁盘上
  全部存量缓存失效。

---

## 13. FE-08（`287b5ce` / `12aa9e4`）—— 先补网再拆

**`handleListKeyDown` 这 48 行逻辑原本零测试覆盖**（4 个 ThumbnailGrid 测试文件里
没有任何 pointer/keyboard 事件断言）。

**先写测试再动代码**，而且**验证了网有效**：把 `ArrowDown` 故意改回 `+1`，
2 条用例立刻红，还原后全绿。然后才抽 `useGridKeyboard`。

**为什么三者必须同处一个 hook**：`handleCellClick` / `handleListKeyDown` /
`handleSearchKeyDown` 共享 Shift 范围选择的锚点（`anchorIndexRef`）与当前选区
（`activeIds`）。拆成两个 hook 就要跨 hook 同步这两份状态，而同步本身就是 bug 来源。

**修正了一处「过度健壮化」**：`activeGroup` 在 `selectedIndex` 越界时是 `undefined`
而不是回退到第一格。hook 里照实保留了这个 `undefined`，没有"顺手改好"。

---

## 14. 本轮全部未做的项

### 14.1 有实质收益但没开始

| 项 | 预估收益 | 未做原因 |
|---|---|---|
| **FE-03b** 三视口共享层 | 净减 600-700 行 | 只做了坐标系统一（FE-03a），共享层本身未抽。**抽之前必须先给三个视口补 wheel/双击缩放测试**（目前同样零覆盖） |
| **FE-06 剩余 hook** | App.tsx 850 → ~500 | `useLumenOrchestration` / `useExternalApps` / `useAppModals` |
| **FE-07 收尾** | — | 290 行测试块仍在 `commands.rs` 未归位；`lib.rs` 仍是 `use commands::*` |

### 14.2 核查后确认不必做

| 项 | 核查结论 |
|---|---|
| FE-14 `DEFAULT_TONE` 搬家 | 它住在 `autoTone.ts` 与 `computeAutoTone` / `getToneFilterString` 同文件，职责连贯 |
| FE-15 autoTone 加 clamp | `Math.max(-40, Math.min(40, ...))` 双边界钳制已覆盖全部 6 个字段 |
| BE-16 `pickFile()` | 不存在（计划里的幻影目标） |
| BE-17 `convertFileSrc` → `toAssetUrl` | api.ts 仅两处裸调，抽一个 alias 收益低于成本 |

### 14.3 沿用上一份裁决

- **FE-01 Button 原子**：53 处重复但完全相同的一行最多出现 2 次，抽象只增间接层
- **BL-04 的 `call_session_tool` / `render_via_mcp` 合并**：属行为变更，不属拆模块范围

---

## 15. 给下一个 agent 的要点

1. **先跑 5.1 的四条验证命令确认基线**，再决定从哪开始。
2. **FE-03b 是剩余项里收益最大的一块**，但前置条件是补 wheel/双击缩放测试。
   本轮 FE-03a 的教训：**拖拽/缩放逻辑的测试证明力有限**，同步 `fireEvent` 复现不出
   React 批处理缺陷。补测试时先按 13 节的办法「故意改坏验证网有效」。
3. **不要再全信探索报告**。本轮实证了三处错误：BE-03 的降级值「可合并」、
   FE-08 的 `beforeGroup`/`afterGroup`（实为单一 `group`）、
   `syncZoom`/`syncLock` 是内部 state 不是 prop。一律 grep 实测。
4. **批量删 Rust 顶层 item 用一次性拼接，不要两次独立切片**（详见 9.3）。
5. **`cargo fmt` 不要裸跑**，它会重排整个 crate。每个 commit 前 `git diff --stat`。
6. **LUMEN 全链路未实机验证**：e2e 测试全部 `ignored`，本轮动了几十条命令的归属。
   合入前实机走一遍扫描 → 调色保存 → 预设 → AI 蒙版。

---

## 16. FE-03b 三视口共享层（`51ee720` → `27bf24c`，5 个 commit）

### 16.1 先补网再动手（`51ee720`）

`ViewportZoomGestures.test.tsx` 9 条：Preview 双击切换/拖偏后回正/滚轮触底夹紧；
Split 联动/独立双击；BA 联动/独立双击/滚轮命中口径。**实证网有效**：把三处
`handleDoubleClick` 故意改坏（Preview 2.5→2 且去掉回正；Split/BA 忽略 sync 分支），
对应 4 条立刻红、未碰的逻辑保持绿，还原后全绿。

### 16.2 step1-4（`ff763dc` / `4fb5ced` / `b50cfd7` / `27bf24c`）

| step | 产出 | 视口改动 |
|---|---|---|
| 1 | `utils/viewportZoom.ts`：三视口缩放几何单一真值 | 三视口删本地常量 |
| 2 | `hooks/useZoomPan.ts` + Preview 改接 | PreviewViewport 482 → 370 |
| 3 | `hooks/useDualZoomPan.ts` + Split/BA 改接 | Split 665 → 460、BA 643 → 448 |
| 4 | `utils/viewportImage.ts`（纯函数）+ `hooks/useViewportImage.ts` | 三视口图片解析收编 |

**总量（诚实口径）**：三个视口 1790 → 1278 行（**净减 512**）；新增共享层生产
代码 605 行、测试 314 行；全局生产代码净 **+89 行**。handoff 里「净减 600-700」
指视口内重复 Machinery 的消除量（实际 512），不是全局行数——共享层带完整 JSDoc
与类型，行数换来了单一真值与可测性：C2 规则、绝对系拖拽、M-08 命中锚点、联动
夹紧公共边界，从此只写一处、只测一处。

两处语义偏差在**自查中发现并修正后才提交**（useDualZoomPan 初版，未入 commit）：
① 联动分支 `zoomBy` 误加 `pos: FIT` 回正（原实现只改比例、不动平移）；
② 默认 activePane 用了第一栏——BA 的调色结果在右侧，加 `initialActivePane`
参数传 `PANES[1]`。另外拖拽抓取偏移从 React state 改 **ref**：绝对系下拖动期间
恒定，少一次 state 更新，结构上排除读到旧 dragStart。

step4 的 Preview RAW-only 路径此前**零覆盖**，补 4 条（解码成功/解码失败/引擎
未启用/onError latch 回落占位）后做变异验证：A（C2 规则改坏——RAW-only 无 LUMEN
时回落 .NEF）→ 5 条精准红；B（`markBroken` 置空）→ latch 测试精准红。还原后全绿。

### 16.3 step5 裁决：RatingFlagBar / ZoomControls 均不抽

按「最简实现（不投机抽象）」与 FE-01 Button 原子先例，实测三变体后裁决**不做**，
理由记录备查：

- **RatingFlagBar**：Preview 与 BA 字符级相同（仅 3 个令牌级差异：分组 div 的
  `border-r pr-3`、按钮 `border` 摆放位置、未选中 `bg-white/10` vs
  `bg-transparent`），但 Split 是**结构性不同**的 UI——窗格内小胶囊
  （bottom-3 / px-3.5 / gap-2.5 / 无 shadow）、w-3.5 图标、单层 aria +
  baseName 模板、`onRate(group, n)` 回调签名、保留/淘汰中文文案。覆盖三者的
  组件需要 6-8 个 prop + variant 开关，典型「为抽象而抽象」。
- **ZoomControls**：唯一同构的一对（Split/BA 顶栏胶囊）差异全在读数文案
  （L/R vs 前/后、aria 的「双图」后缀、text-white/60 vs /45）。外壳抽取要把
  读数做成 ReactNode 逃生阀——抽完最重复的读数条件块仍在调用方，净省 ~20 行。
  Preview 的结构（底部操作条内、单读数、无联动概念）无法入列。

前端测试 316 → 336（+20）。Rust 未触（126/126 与 clippy 零告警维持基线）。
