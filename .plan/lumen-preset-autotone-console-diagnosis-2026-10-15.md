# LUMEN 预设 / 自动按钮 / 启动黑框 —— 诊断与修复方案

- 日期：2026-10-15
- 分支：`fix/lumen-preset-and-console-2026-10-15`（工作树干净，未动任何代码）
- 方法：全链路只读探索（前端 hook → Tauri command → A/B 通道 → Python sidecar），
  证据均带 `文件:行号`。

## 结论摘要

| # | 现象 | 根因 | 修复点 |
|---|------|------|--------|
| 一 | 选预设后滑杆/预览无变化 | `runtime.apply_preset` 只 apply 不 `save_project`，读回链路（B 通道新进程）读 `.lumen` 旧值 | `runtime.rs` 补一步 save（对齐 `apply_mask`） |
| 二 | 点「自动」无反应 | 视口 `<img>` 无 `crossOrigin` → asset 协议跨源 → canvas 被污染 → `getImageData` 抛 SecurityError → 静默返回全 0 | `PreviewViewport` 加 `crossOrigin="anonymous"` + 失败不再静默 |
| 三 | 启动/操作时弹控制台黑框 | 宿主 6 处 spawn 控制台程序均未设 `CREATE_NO_WINDOW` | 新建 `proc::silent()` helper，6 处替换 |

三个问题相互独立，无共同根因；均已在代码层定位到具体行。

---

## 问题一：LUMEN RAW 预设不生效

### 现象

调色面板下拉选预设 → 确认 → toast 显示「已应用预设」，但滑杆不动、
预览无变化，像什么都没发生。

### 链路与断点

```
前端 handleApplyLumenPreset          useToneEditing.ts:279-297
  ├─ api.applyLumenPreset()  ──────→ lumen_apply_preset_cmd  lumencmds.rs:400-416
  │                                    └─ runtime.apply_preset  runtime.rs:421-438
  │                                         └─ A 通道 apply_preset 工具 ✅ 成功
  │                                            （只改 session 内存态）
  │                                    ✗ 没有 save_project ←── 断点在这里
  └─ api.getToneState()  ──────────→ get_tone_state_cmd     tone.rs:115-152
                                       └─ read_project_tone   runtime.rs:175-187
                                          └─ B 通道 run_lumen("edit.get")
                                             = 新进程读 .lumen 落盘文件
                                             → 旧值 / 无工程 → 回填旧值
                                             → 滑杆不动 =「不生效」
```

### 证据

1. **实现与注释契约脱节（铁证）**：`useToneEditing.ts:276` 的注释白纸黑字
   写着「编辑态是进程内 session，**后端保证 apply+save 同进程**」——契约写了，
   后端实现漏了。
2. **同文件的正例对照**：`apply_mask`（runtime.rs:208-225）是标准两步：
   ```rust
   let applied = self.apply_recipe(exe, photo, &changes)?;
   // 落盘：不 save_project 蒙版下次就没了
   self.save_project(exe, photo)?;
   ```
   而 `apply_preset`（runtime.rs:421-438）只有 `call_session_tool(...)` 一步。
3. **落盘语义的文档**：`save_project`（runtime.rs:158-161）doc comment：
   「**必须与 `apply_edits` 同进程**：编辑态是 session 态，不落盘。少了这一步，
   调色在下次预览/重启后就消失了（`.lumen` 文件是跨进程唯一可读回的形式）」。
4. **读回路径确认**：`read_project_tone` 走 B 通道 `run_lumen`（runtime.rs:180-184）
   = 一次性新进程，只能读 `.lumen` 文件，读不到 A 通道 session 内存态。
5. Python 侧 `session.apply`（lumen-raw/lumen/session.py:122-125）确认：只改
   `documents[path]['edits']` 内存 dict；`save_project`（136-139）是唯一落盘入口。

### 修复方案

`src-tauri/src/lumen/runtime.rs` —— `apply_preset` 尾部补一步（与 `apply_mask`
完全同构）：

```rust
        // 必须走 apply_preset 工具：**不能**复用 apply_recipe —— 后者会把载荷
        // 包进 {"changes": ...}，而 edit.preset 的参数是 {path, name, amount}。
        // 包错了会静默变成 no-op（预设"应用成功"但什么都没变）。
        let applied = self.call_session_tool(exe, "apply_preset", &args)?;
        // 落盘：不 save_project，前端随后的 get_tone_state（B 通道新进程读
        // .lumen）看不到这次应用 → 滑杆读回旧值 =「预设不生效」。
        // 与 apply_mask 的 apply+save 两步语义一致。
        self.save_project(exe, photo)?;
        Ok(applied)
```

同时更新该函数的 doc comment，把「apply+save 两步、为什么必须 save」写进去。

### 验证

- 自动化：无（该路径依赖真实 sidecar，Rust 单测不可达；e2e 无 LUMEN 基建）。
- 手工：应用预设后 ①滑杆立即变为预设值；②同目录出现/更新 `.lumen` 文件
  （看 mtime 与内容中的 edits）。
- 回归：`getToneState` 的既有行为不变（它本来就以落盘值为真值）。

---

## 问题二：「自动」按钮不生效

### 现象

调色面板点「自动」→ 按钮闪一下「计算中…」→ 结束，滑杆纹丝不动。

### 链路与断点

```
TonalAdjuster 自动按钮             TonalAdjuster.tsx:439-451
  └─ triggerAutoTone → onAuto      TonalAdjuster.tsx:202-205
     └─ handleAutoTone             useToneEditing.ts:139-200
        ├─ 单图模式 + previewImageRef 有效？
        │   → finish(rendered)  ←── rendered = PreviewViewport 的 <img>
        │      └─ computeAutoTone(img)     autoTone.ts:16-144
        │         ├─ ctx.drawImage(img)    ✅
        │         ├─ ctx.getImageData()    ✗ SecurityError（canvas 被污染）
        │         └─ catch → 静默返回全 0  autoTone.ts:140-143 ←── 断点
        └─ 否则走 tempImg（带 crossOrigin）路径 ← 永远轮不到
```

### 证据

1. **视口 `<img>` 没有 `crossOrigin`**：`PreviewViewport.tsx:147-160`。
   该 img 经 `onImageElement={setPreviewImage}`（App.tsx:498）注册进
   `useToneEditing` 的 `previewImageRef`（useToneEditing.ts:56-58），
   是 `handleAutoTone` 的**首选采样源**（useToneEditing.ts:160-170）。
2. **跨源事实**：该 img 的 src 是 asset 协议 URL（`convertFileSrc`）。
   页面 origin 是 `http://tauri.localhost`（dev 为 `http://localhost:1420`），
   资源 origin 是 `http://asset.localhost` → **跨源**。无 `crossOrigin` 时
   浏览器以 no-cors 加载并**标记 canvas 为污染**，`getImageData` 必抛
   `SecurityError`。
3. **静默失败**：`computeAutoTone` 的 catch（autoTone.ts:140-143）只
   `console.warn` 后 `return {...DEFAULT_TONE}`（全 0）。`handleAutoTone`
   的 `finish`（useToneEditing.ts:141-144）不校验结果，直接
   `handleToneChange(全 0)` → 滑杆从 0 到 0 = 用户看到「没反应」。
4. **对照组**：同文件 `tempImg.crossOrigin = 'anonymous'`（useToneEditing.ts:148）
   ——全项目唯一一处 crossOrigin，说明作者知道 CORS 这回事，但只加在了
   兜底路径上；主路径（rendered 直采）没有。
5. **修复可行性已验证**（读 Tauri 2.11.5 源码）：
   `~/.cargo/registry/.../tauri-2.11.5/src/protocol/asset.rs` 第 21、39 行：
   所有响应（含 403/404/500）都带 `Access-Control-Allow-Origin: <window_origin>`。
   → 给 img 加 `crossOrigin="anonymous"` 后 CORS 校验通过，图片正常加载，
   canvas 不再污染。
6. 仅 `PreviewViewport` 注入 `onImageElement`（App.tsx:498 是唯一传点；
   SplitCompare / BeforeAfter 视口不注入）→ 修复面收敛为单文件。

### 修复方案（两层）

**a. 根修** —— `src/components/PreviewViewport.tsx` 的 `<img>` 加属性：

```tsx
        <img
          ref={zoom.imageRef}
          src={image.src}
          alt={group.baseName}
          draggable={false}
          // 自动调色会对这张图做 canvas 采样（getImageData）。asset:// 是跨源
          // 资源，不带 crossOrigin 时 canvas 被污染、采样必抛 SecurityError
          // （表现为「自动按钮无反应」）。asset 协议对所有响应返回
          // Access-Control-Allow-Origin（tauri protocol/asset.rs），可安全启用。
          crossOrigin="anonymous"
          onError={image.markBroken}
          ...
```

**b. 防再犯** —— 失败不再静默：

- `src/utils/autoTone.ts`：`computeAutoTone` 返回类型改
  `ToneAdjustments | null`；`!ctx` 与 catch 两处都返回 `null`（替代全 0）。
- `src/hooks/useToneEditing.ts`：`finish` 返回 `boolean`；主路径
  `finish(rendered)` 失败时回退 `loadAndFinish(rendered.src)`（带 CORS 的
  副本重采样）；副本也失败才 `toast.error('无法读取该照片的像素数据（画布
  采样被拦截），自动调色已取消。')`。

调用方核对：`computeAutoTone` 全项目仅 `useToneEditing.ts:142` 一处生产
调用，测试无直接调用 → 改签名零涟漪。

### 验证

- 新增 vitest：
  1. `PreviewViewport.test.tsx`：img 的 `crossOrigin === 'anonymous'`
     （变异：删属性 → 红）。
  2. 新建 `src/utils/autoTone.test.ts`：mock `getContext` 返回假 ctx、
     `getImageData` 抛 `DOMException('...','SecurityError')` → 断言返回
     `null`（变异：改回返回全 0 → 红）；另补一个 happy-path 断言非 null。
- 手工：真窗口点「自动」→ 滑杆出现非 0 值（6 条中至少曝光/对比度变化）。
- 注意：jsdom 无 canvas 实现（`getContext` 默认返回 null）→ 测试需显式
  mock，别依赖默认行为。

---

## 问题三：启动/操作时弹控制台黑框

### 现象

启动应用、开调色面板、读写 XMP 等时，屏幕闪出 `lumen-cli.exe` 等控制台
窗口。根因单一：**宿主是 GUI 子系统进程，spawn 控制台程序时未设
`CREATE_NO_WINDOW`，Windows 为每个子进程分配可见控制台窗口**。

### 全部命中点（生产代码 6 处）

| # | 位置 | spawn 的目标 | 触发时机 |
|---|------|-------------|---------|
| 1 | `lumen/transport.rs:68` `ProcessTransport::spawn` | `lumen-cli mcp --headless` | A 通道拉起（每次首次操作） |
| 2 | `lumen/cli.rs:61` `run_lumen` | `lumen-cli run ... --headless` | B 通道每次调用 |
| 3 | `lumen/cli.rs:71` `run_cli` | `lumen-cli list ...` | 直调 CLI |
| 4 | `lumen/status.rs:57` `query_version` | `lumen-cli --version` | 状态探测（启动时） |
| 5 | `lumen/discovery.rs:38` `find_in_path` | `where` | 查找 sidecar（启动时） |
| 6 | `commands/apps.rs:44` `open_in_default_app_cmd` | `cmd /c start` | 用默认程序打开 |
| 7 | `luminar.rs:10/36` `find_luminar_executable` | `reg query` ×2 | Luminar 探测 |

（`apps.rs:30` Photoshop、`luminar.rs:126` Luminar 是 GUI 程序，不弹控制台，
不在修复范围；`transport.rs` 测试夹具 `#[cfg(test)]` 不参与生产构建，同样不动。）

### 佐证

Python 侧已经踩过这个坑：`lumen-raw/lumen/catalog.py:362` 与
`lumen-raw/lumen/white_balance.py:43` 都用
`creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)` —— 侧车内部
spawn 子进程时静默；宿主侧遗漏。

### 修复方案

新建 `src-tauri/src/proc.rs`（`lib.rs` 加 `mod proc;`）：

```rust
//! 静默子进程构造：Windows 上不弹控制台黑框。
//!
//! 宿主是 GUI 子系统进程，spawn 控制台程序（lumen-cli.exe / where.exe /
//! reg.exe / cmd.exe）时若不带 CREATE_NO_WINDOW，Windows 会为子进程分配
//! 可见控制台窗口。stdout/stderr 管道不受该标志影响。
//! 与 Python 侧做法对齐（lumen/catalog.py 的 creationflags）。

use std::ffi::OsStr;
use std::process::Command;

/// Windows `CREATE_NO_WINDOW`（0x08000000）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 构造「不弹控制台窗口」的 Command。**生产代码所有 spawn 控制台程序
/// 的位置都应经由此函数**。
pub fn silent(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
```

替换 7 处调用（`Command::new(...)` → `proc::silent(...)`）。

### 验证

- 新增 `proc.rs` 单测：`silent("cmd").args(["/c","echo","ok"]).output()` 断言
  stdout 正常（防 flags 破坏 IO 的回归）。
- **诚实口径**：自动化无法断言「窗口没弹」（无 API 可观测）；黑框消失靠
  真机手工验证（启动 + 打开调色 + 保存 + 打开外部程序，全程观察）。

---

## 实施顺序与验证矩阵

| 步骤 | 内容 | 验证 |
|------|------|------|
| 1 | 写新测试（PreviewViewport crossOrigin / autoTone null / proc smoke） | 全红（改前基线） |
| 2 | 变异验证网有效（故意改坏断言瞄准的子串） | 逐条确认红 |
| 3 | 还原 + 实施三个修复 | — |
| 4 | `npx tsc --noEmit` + 全量 vitest | 绿 |
| 5 | `cargo test`（grep 掉 lock file 噪音）+ `cargo clippy` | 绿 |
| 6 | 手工验证：预设滑杆 / 自动滑杆 / 无黑框 | 见各节 |
| 7 | 更新 execution-log + 本轮台账 | — |

## 风险与备选

- **问题一修法**：`apply + save` 立即落盘，与 `apply_mask` 语义一致；若想
  「预设只试看不落盘」，备选是把 apply 返回值直接回传前端（改 cmd 签名 +
  前端），但偏离现有 `getToneState` 回填架构，不推荐。
- **问题二 `crossOrigin` 的回归面**：若某环境 asset 协议不返回 ACAO 头，
  图片会加载失败（当前 no-cors 下能显示）。已读 Tauri 2.11.5 源码确认
  所有响应路径均带头（含错误路径），风险可忽略；且失败时会走 `onError`
  显示既有破图占位，不会白屏。
- **问题三**：`creation_flags` 仅 Windows 有；非 Windows 分支保持
  `Command::new` 等价（代码里已 `#[cfg]` 隔离）。

---

# 第二部分：实施、e2e 真窗口验证与 WebView2 崩溃排查

> 以下为 2026-10-15 13:00–18:40 的实施与验证全过程记录。
> 第一部分（上文）是**方案**；本部分记录**实际做了什么、怎么验证的、遇到什么**。

## 0. 摘要

1. 三个修复全部实施；过程中 **e2e 调试又发现 2 个额外 bug（A/B）** 并一并修复；
2. 因 WebView2 CDP 不可用，自建 **Plan B「应用内驱动」e2e 基建**（VITE_E2E_SCENARIO
   → Vite 中间件 → e2eRunner 操作真实 DOM → POST 落盘），实现真窗口全链路验证；
3. run5 首次跑通但暴露 Bug A/B 与检查逻辑缺陷（已修）；
4. **run6 系列遭遇阻塞性环境问题：WebView2 GPU 子进程 9 连崩 → 浏览器进程自杀**
   （白屏 + `msedgewebview2 has stopped working`）。经 7 轮实验定位，
   `--in-process-gpu` 完全解决（run6h 实测 0 崩溃）；
5. 修复已固化为代码默认行为（`main.rs` set_var，尊重用户覆盖），
   run6i 在**无任何环境变量**下复验全绿。

## 1. 实施清单

| # | 内容 | 文件 | 验证方式 |
|---|------|------|---------|
| 一 | `apply_preset` 补 `save_project` 落盘 | `src-tauri/src/lumen/runtime.rs` | e2e 场景 A（run6h/run6i）：滑杆读回 20/-25 + `.lumen` 落盘 |
| 二 | `crossOrigin="anonymous"` + `computeAutoTone` 返回 `null` + 失败 toast | `PreviewViewport.tsx` / `autoTone.ts` / `useToneEditing.ts` | vitest 新增 4 用例 + e2e 场景 B（滑杆 -0.1/-40/25） |
| 三 | `proc::silent()`（`CREATE_NO_WINDOW`）替换 12 处 spawn | `proc.rs`（新建）+ 6 文件 | cargo test 2 用例 + **黑框消失待目视** |
| A | settings 回填不再触发静默扫描（来源标记） | `useFolderScan.ts` / `App.tsx` | `App.scanRestore.test.tsx` 3 用例 + e2e 扫描段 |
| B | 扫描窗口内用户点击不被会话恢复覆盖 | `App.tsx` / `useFolderScan.ts` | 同上 + e2e 选中态演化采样 |
| W | WebView2 GPU 崩溃 workaround（`--in-process-gpu`） | `src-tauri/src/main.rs` | run6h（带环境变量）+ run6i（零环境变量，验证固化） |

## 2. 额外破案：Bug A / Bug B（e2e 调试中发现）

两个 bug 均由 run5 的「怪现象」逆向查出，直接破坏 e2e 的可信度，必须先修。

### Bug A：打开应用即静默扫描

- **现象**：`IMG_011.lumen` 在无人操作它时被写入；e2e 场景里同目录出现两次扫描。
- **根因**：`useFolderScan` 用「跳过首次」guard（`sortOrderInitialised`）想挡住
  settings 回填的 `sortOrder`，但 settings 是**异步**加载（`useAppSettings` 在
  useEffect 里 fetch），回填必然晚于 effect 首次运行——guard 早已置位，
  迟到的变化照样触发扫描。`setSortOrder(saved)` 就这样在启动后几百 ms
  触发了一次用户没有请求的扫描。
- **修复**：改为**来源标记** `sortOrderChangedByUser`——只有经
  `handleSortOrderChange`（用户在 TopBar 的操作）的改动才重扫；
  settings 回填走裸 `setSortOrder`，不置标记、不触发。
  `App.tsx` 的 `onSortChange` 相应改为 `handleSortOrderChange`。

### Bug B：扫描完成覆盖用户选择

- **现象**：e2e 点击 IMG_010 后，选中被翻回 IMG_011（会话恢复值）；
  随后的 apply 写错文件（IMG_011.lumen 的另一半谜底）。
- **根因**：扫描是异步的（几百 ms~几秒）。`handleScanned` 拿到 `historyIndex`
  后**无条件** `setSelectedIndex(historyIndex)`——若用户在扫描窗口内点了别的
  照片，点击先落地、扫描完成再把选中翻回会话位置。
- **修复**：扫描**启动前**快照 `selectedIndexAtStart`（`getSelectedIndex` 经
  ref 镜像读当前值），完成时判定
  `userMovedDuringScan = selectedIndexAtStart !== 当前值`：
  - 用户动过 → 只把旧索引钳制到新集合范围，**不做会话恢复**；
  - 没动过 → 照旧恢复会话位置。
- **测试**：`src/App.scanRestore.test.tsx`（3 用例，含变异验证）。

### e2e 检查逻辑修正（同批）

- 「扫描完成」判定从底栏计数（12ms 假阳性）改为「单元格 ≥12 **且** 扫描按钮恢复」；
- 基线读取前 `sleep(800)`（等 `getToneState` 异步回填落地，消除 run5 的
  「迟到读回被误判为 apply 效果」假阳性）；
- A2 toast 改为独立轮询（run5 在 A1 后 35ms 检查到 false 的教训）；
- 选中态演化采样（`readSelectedCells()`）——点击后 200/300/300ms 三次采样，
  直接暴露「点击被覆盖」类问题。

## 3. e2e 真窗口验证基建（Plan B：应用内驱动）

**为什么**：本机 WebView2 的 `--remote-debugging-port` 只服务第一个 HTTP 请求，
之后永久卡死（HTTP 与 WS 均实测确认；同版本 Edge 内核正常）→ Playwright
`connectOverCDP` 不可用。

**架构**：

```
VITE_E2E_SCENARIO=lumen-preset  npm run tauri dev
  └─ vite.config.ts 中间件
       ├─ /__e2e_scenario  → 把场景名喂给前端
       ├─ /__e2e_log       → 每条日志 append 落盘 e2e/.tmp/e2e-app.log
       └─ [req] 墙钟时间戳  → 重建「页面加载序列」（GET / → trap → main.tsx → …）
  └─ main.tsx（仅 DEV + 场景名存在时）动态 import('./devtools/e2eRunner')
       └─ e2eRunner 操作真实 DOM（点击 / 键盘 / 受控组件原生 setter）
            → 走完整 前端→IPC→Rust→lumen-cli sidecar 链路
            → 每步 raw() 双写 console + POST /__e2e_log
```

- **e2eErrorTrap**（vite.config.ts 注入 `<head>` 的最早内联脚本）：捕获
  error / unhandledrejection / console.warn|error → POST。首行
  `[html] inline trap installed` 是「页面开始加载」的最可靠信号。
- **场景**（`src/devtools/e2eRunner.ts`，392 行）：
  - 场景 A（预设）：IMG_010 → 开面板 → 读基线 → 选「自然风光」→ 套用并保存
    → 轮询滑杆变化（断言 A1）→ 等 toast（断言 A2）；
  - 场景 B（自动）：IMG_011 → 点「自动」→ 读前后滑杆（断言 B1）。
- **存活监控**（`e2e/.tmp/watch-app.mjs`，用户建议）：进程出现后 **60s 内
  无 trap = 判定崩溃**（`CRASH_SUSPECTED_NO_TRAP_IN_60s`）；同时监控
  wv2 日志的 `GPU process isn't usable. Goodbye.` 铁证行。
- 生产构建不含本模块（`import.meta.env.DEV` 为 false 时 tree-shake）。

## 4. run5：首次跑通 + 暴露问题（15:35）

- 结果：场景全链路跑通，但出现三个「怪现象」：滑杆读数矛盾（25.187 时刻
  20/-25 vs apply 日志 26.273）、`IMG_011.lumen` 归属不明、A2 toast 时点性
  false。日志归档 `e2e/.tmp/e2e-app-run5-mixed.log`（195 行）。
- 逆向破案 → Bug A + Bug B + 检查逻辑缺陷（见 §2），全部修复后进入复验。

## 5. WebView2 GPU 崩溃排查（run6 → run6h，阻塞性环境问题）

### 5.1 症状

复验（run6）启动即挂：窗口白屏，随后 Windows 弹
**`msedgewebview2 has stopped working` / `Error launching CrashSender.exe`**。
`e2e-app.log` 停在首行 trap（页面开始加载但渲染未完成）。

### 5.2 证据链（run6d 取证，`--enable-logging`）

```
GPU process exited unexpectedly: exit_code=7   ×9 次
  ↓（其间伴随）
persistent_cache_sandboxed_file_factory.cc:153
  Failed to open persistent cache files ... DawnGraphiteCache\<HASH>
  error: 0: 另一个程序正在使用此文件 (0x20)
  ↓
FATAL: gpu_data_manager_impl_private.cc:408  GPU process isn't usable. Goodbye.
  ↓
浏览器进程主动退出 → 宿主收到进程崩溃 → WER 对话框
```

- `exit_code=7` = 子进程 **STATIC_INIT 阶段**异常（启动早期，尚未进入功能代码）；
- 崩溃发生在页面加载 **2 秒内**（`GET / → trap → @vite/client → main.tsx → 崩`）；
- Crashpad 转储：`EBWebView/Crashpad/reports/d813a4ad-…dmp`（8.2MB，15:58:25）。

### 5.3 排除矩阵（7 轮实验，全部有日志）

| 实验 | 假设 | 操作 | 结果 |
|------|------|------|------|
| run6b | profile 损坏 | 重建 `EBWebView`（备份 `.broken-1611`） | **仍崩** |
| run6c | GPU 加速路径 | `--disable-gpu` | **仍崩**（参数已确认生效，features/开关合并规则见 WebView2 文档） |
| run6d | 取证 | `--enable-logging` | 拿到 9 连崩 + Goodbye 完整链条 |
| run6e | GPU 持久缓存损坏 | 清 `GPUPersistentCache`（备份 `.broken-1812`） | **仍崩** |
| run6f | 应用代码改动 | `git stash` 还原 proc::silent 6 文件 | **仍崩 → 排除代码因素** |
| run6g | Skia Graphite（155 灰度） | `--disable-features=SkiaGraphite` | **仍崩**（DawnGraphiteCache 访问路径照旧活跃） |
| **run6h** | **GPU 子进程环境** | **`--in-process-gpu`** | **✅ 0 崩溃，e2e 全绿** |

辅助对照（同机同时段）：
- **clash-verge（同为 Tauri 2 + WebView2 155）正常运行**——155 未全局损坏；
- headless Edge 155 正常（`--dump-dom` 带/不带 `--disable-gpu`）；
- 用户重启电脑后 run6d/e/f 仍崩——非瞬时状态、非僵尸进程；
- 12 个 msedgewebview2 残留经 `--webview-exe-name=` 证实属其他应用（SearchHost/
  Teams/GameViewer/magpie/cc-switch/clash-verge），非本应用。

### 5.4 根因分析（诚实口径）

- **直接原因（已实证）**：GPU **子进程**在 STATIC_INIT 连续崩溃 →
  Chromium 判定 GPU 不可用 → 浏览器进程主动退出。
- **深层根因（未完全定位，属系统/驱动层）**：环境特征为 NVIDIA RTX 4060 +
  Intel 双显卡、两个虚拟显示器驱动（Meta Virtual Monitor 2023 老驱动、
  GameViewer Virtual Display Adapter）、多次 GPU hang（LiveKernelEvent 141）
  历史 + WebView2 155。`--disable-gpu` 无效而 `--in-process-gpu` 有效，
  指向**「GPU 子进程的创建/沙箱路径」在此环境损坏**，而非 GPU 功能本身。
- 已知同类案例：OmniStudio（GitHub）记录完全相同的症状链
  （`GPU process exited unexpectedly` + `Goodbye`）并给出同一解法。

### 5.5 修复与固化

**修复**：`src-tauri/src/main.rs` 在 `run()` 前设置（仅 Windows；尊重用户
已有设置不覆盖）：

```rust
if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--in-process-gpu");
}
```

**为什么用 set_var 而不是 `tauri.conf.json` 的 `additionalBrowserArgs`**：
后者会**替换** wry 默认参数（`--disable-features=msWebOOUI,msPdfOOUI,
msSmartScreenProtection`，schema 明确警告），需手动带上；环境变量方式为
**追加**，wry 默认参数保持原样（run6i 命令行实证两者共存）。

**撤回条件**：显卡驱动 / WebView2 更新修复根因后，删除该段即恢复默认多进程
渲染路径。注释已写明完整背景（含已排除项）。

## 6. 最终验证记录

### run6h（带环境变量，2026-10-15 18:19–18:22）

- wv2 日志 39 行：**0 次 GPU 崩溃、0 FATAL**（对照 run6g 的 9 连崩）；
- 32 行场景日志全绿：套用前全 0 → 套用后 **阴影 20 / 高光 -25**（A1 ✓）、
  toast（A2 ✓）、自动调色 -0.1/-40/25（B1 ✓）；
- `IMG_010.lumen` **18:20 落盘**（3189B）——问题一修复的真窗口实证。

### run6i（零环境变量，2026-10-15 18:26–18:28，固化验证）

- **未设置任何环境变量**启动，应用存活（watcher：6s 进程出现、20s trap）；
- **决定性证据**：msedgewebview2 浏览器进程命令行含
  `--disable-features=msWebOOUI,… --in-process-gpu …`——main.rs 的 set_var 生效；
- 36 行场景日志全绿（A1/A2/B1 全 true）；`IMG_010.lumen` **18:27 再次落盘**。

## 7. 验证矩阵汇总

| 项 | 方式 | 结果 |
|----|------|------|
| 类型检查 | `npx tsc --noEmit` | exit 0 |
| 前端测试 | `npx vitest run --pool=vmForks` | **51 文件 / 343 用例全过**（默认 pool 有已知 Windows 竞态，需逃生阀） |
| Rust 测试 | `cargo test` | lib 130 passed + contract 3 passed + sidecar 21 ignored（需真 sidecar） |
| Rust lint | `cargo clippy` | 无源码告警（唯一 warning 为 incremental 锁环境噪音，已 grep 核实） |
| e2e（真窗口） | run6h + run6i | 双场景断言全绿 + `.lumen` 落盘 |

## 8. 遗留事项与风险

1. **问题三「黑框消失」待真机目视确认**——自动化不可观测（诚实口径），
   修复本身有单测 + 12 处替换已核实；
2. **WebView2 workaround 为长期方案**（直至驱动/WebView2 环境更新）——
   副作用评估：GPU 崩溃不再被进程隔离（但此环境下原本即不可用）；
3. 清理诊断临时设施：`e2e/.tmp/` 下的探测脚本（poll-cdp / port-probe /
   observe / ocr / proxy-test / ws-race / probe-timeline / edge-dump-profile 等）
   与 `*.broken-*` / `*.bak-run5` 备份目录；保留 watch-app.mjs 与各 run 日志；
4. `e2e/suites/08-lumen-preset.mjs`（CDP 模式套件）因 CDP 不可用未接入运行链，
   当前由 `src/devtools/e2eRunner.ts`（Plan B）承担同等场景——保留待 CDP
   环境恢复后再评估。

---

## 9. 后续修复：预设下拉套用后显示已套用名（2026-10-15 晚，用户报告）

### 9.1 缺陷与根因

- **报告**：套用预设成功后，下拉框仍显示「选择预设…」，而不是所选预设名。
- **根因**：C4 落地时下拉是**非受控**组件（`defaultValue=""` + onChange 里
  `e.target.value = ''` 手动复位）——复位本身是为了「确认前不显示未生效的
  名字」，但成功路径**没有任何回写**，名字永远不会出现。属设计缺口。

### 9.2 修复设计（显示 = 事实）

- 新增 `appliedPreset` 状态 + 受控 `<select value={appliedPreset ?? ''}>`；
- `onApplyPreset` 契约升级：**成功必须 resolve `true`、失败 `false`**
  （`handleApplyLumenPreset` 的 early return / catch 均返回 false）。
  名字只在拿到 `true` 后写入 —— 绝不先于事实显示；
- 边界（均有单测）：
  1. 确认前下拉保持原值（受控 value 使原生控件回弹）；
  2. 套用失败不写标记（保留上一次成功名；首次失败停在占位）；
  3. 取消不改标记；
  4. 换照片（`photoId` prop 变化）**同一帧**重置（渲染期 setState，免闪
     旧名帧）——箭头键切图时面板不卸载，名字不许跨照片残留；
  5. 连续套用序号仲裁（`applySeqRef`）：前一次仍在飞行时又确认了新的，
     迟到的旧结果被丢弃（与 Bug B 同类：异步结果不得翻转用户最新动作）。

### 9.3 验证

- 单测（`TonalAdjuster.test.tsx` 预设组 6 用例，替换旧「复位到占位项」断言）
  覆盖：确认前 / 成功 / 失败 / 取消 / 换图 / 连续套用；
- **变异验证三轮，全部精准命中**（方法论：替换断言瞄准的子串）：
  | 变异 | 预期失败 | 实测 |
  |------|---------|------|
  | 去 seq 仲裁 + 去换图守卫 | 连续套用、换照片 | 恰好 2 条失败 ✓ |
  | 去 `ok` 判断 | 失败不写标记 | 恰好 1 条失败 ✓ |
  | `value=""`（等价旧缺陷） | 显示相关用例 | 恰好 5 条失败 ✓ |
- e2e **run7**（零环境变量、fixtures 重建、watcher 监控）：
  - **断言 A3 = true（显示="自然风光"）**，A1/A2/B1 全绿；
  - `IMG_010.lumen` 19:24 落盘，md5 `614ed220…` —— **第五次运行逐字节一致**；
  - WebView2 命令行实证 `--in-process-gpu` 与 wry 默认参数共存；
  - watcher：进程 20s 出现、41s trap、无 60s 超时。
- run6k（附加数据点）：改动经 HMR 触发的整页重载自动重跑，A3 首验 true；
  fixtures 未重建，基线语义弱于 run7。
- 门禁：`tsc --noEmit` exit 0；vitest 51 文件 / **348 用例**（+5 新用例）。

### 9.4 涉及文件

| 文件 | 改动 |
|------|------|
| `src/components/TonalAdjuster.tsx` | `appliedPreset` + 受控下拉 + `photoId` 守卫 + 序号仲裁 + `handleConfirmPreset` |
| `src/hooks/useToneEditing.ts` | `handleApplyLumenPreset` 返回 `Promise<boolean>` |
| `src/App.tsx` | 传 `photoId={currentGroup?.id}` |
| `src/components/TonalAdjuster.test.tsx` | 预设组 6 用例（含变异验证） |
| `src/devtools/e2eRunner.ts` | 场景 A 新增断言 A3 |


