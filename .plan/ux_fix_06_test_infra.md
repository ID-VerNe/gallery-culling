# UX 修复轨道 06 —— 测试基础设施（Vitest）调查报告

- 轨道：t6-test-infra（工程效能 / 测试架构）｜只读调查
- 项目：`gallery-culling` v1.1.1（Tauri 2.0 + React 19 + Vite 6.4.4 + Vitest 4.1.11 + jsdom）
- 环境实测：`node v22.19.0` / `vitest 4.1.11 win32-x64` / `vite 6.4.4` / `jsdom 29.1.1` / Windows 11
- 唯一写入产物即本文件；未改动任何现有文件（`vitest.config.ts` / `package.json` / `src/test/setup.ts` 均未动，`git status` 可证）
- 前提：调查期间工作树被其它 5 条轨道并行修改（`M src/components/*.tsx` 等），但本轨道涉及的 4 类文件均未被改动，结论对其成立。

> **摘要**：lead 报告的第 1–7 条**一条也没复现出失败**。默认 `pool: 'forks'` 下连续 6 次 + 3 并发全部 `9 passed / 104 passed / exit 0`。判定为 **vitest 4.1.x 在 Windows 上的「安装后冷状态 + pool 启动竞态」瞬时故障**（上游 vitest#10812 / #8861 逐条吻合），**不是**本仓库确定性配置 bug。因此**不建议**在 config 里固定 pool。

---

## 1. 复现记录

| # | 现象 | 报错原文（截断） | 判定 | 证据来源（命令） |
|---|---|---|---|---|
| 1 | 默认配置 9/9 文件启动失败、0 用例执行 | —（未出现任何错误行） | **复现失败**（实际全绿） | `npx vitest run` ×6 次：均 `Test Files 9 passed (9)` / `Tests 104 passed (104)` / `EXIT=0` |
| 2 | setup 内 `beforeEach` 抛 `internal state` | —（未出现） | **复现失败** | 同上 6 次全量运行 grep `internal state` 无命中 |
| 3 | 测试文件 `import { describe } from 'vitest'` 抛 `reading 'config'` | —（未出现） | **复现失败**，且与事实矛盾 | 9 个测试文件**全部**显式 `import ... from 'vitest'`，`EXIT=0` |
| 4 | 去掉 `setupFiles` 仍失败（对照项 A） | — | **未验证**（改 config 违反只读约束） | 未执行 |
| 5 | `globals:true` 全局 `it()` 探针通过 / 显式 import 失败 | — | **复现失败**（显式 import 明确通过） | 见 #3；无探针文件（只读约束） |
| 6 | 同一文件移到项目根外（`/tmp`）通过（对照项 B） | — | **未验证**（需在库外新建文件） | 未执行 |
| 7 | `--pool=vmForks`（或 `vmThreads`）9 文件 / 104 用例全绿 | — | **复现成功，但非 vmForks 独有** | `--pool=vmForks`/`threads`/`forks` **三者均** `9 passed / 104 passed`；vmForks 10.82s / threads 10.19s / forks 10.07s |
| 8 | `npm ls` 干净、单一 4.1.11、无 `.pnpm`/软链/嵌套副本 | — | **部分成功** | `npm ls`：vitest 4.1.11、`@vitest/runner@4.1.11`、`@vitest/expect@4.1.11` 均 deduped；`node_modules` 内无嵌套副本、无软链。**但根目录存在 `node_modules__pnpm_backup/`（含 `.pnpm/`）** |

补充实测：

```
npx vitest run src/utils/toneToRecipe.test.ts   → 1 passed / 20 passed, EXIT=0
npx vitest run --help | grep pool               → --pool <pool> ... (default: forks)
npx vite --version                              → vite/6.4.4  （package.json 字面为 ^6.1.1）
并发压测 for i in 1 2 3; ... & wait             → 三个进程均 9 passed / 104 passed / exit=0
```

未验证项与原因：对照项 A（#4）需改 `vitest.config.ts`、对照项 B（#6）需在库外新建测试文件，均超出「只读、仅可写本 `.plan` 文件」的硬约束。授权后可在临时副本补做失败率矩阵。

---

## 2. 根因结论

### 2.1 【已验证】（每条可由 §1 命令复现）

1. 默认 pool = `forks`（`vitest --help` 明示），且**默认 pool 全绿**：6 次串行 + 3 并发无一失败。
2. **pool 不是变量**：`forks` / `threads` / `vmForks` 三种 pool 全部 `9 passed / 104 passed`。
3. **显式 `import from 'vitest'` 不是触发条件**：9 个测试文件全部显式导入且全绿 → lead 的「显式 import 失败」不成立。
4. **两个模块级单例真实存在**：`@vitest/runner` 的 `runner`（`node_modules/@vitest/runner/dist/chunk-artifact.js:1626`，`getRunner()` 在 `:1638-1641` 经 `assert()` 取值，报错文案为 **`Vitest failed to find the runner`**）；`vitest` 包的 `workerState`（`node_modules/vitest/dist/chunks/utils.*.js:10`，报错文案 `Vitest failed to access its internal state`）。
5. **依赖树干净**：单一 `vitest@4.1.11`，无嵌套/重复副本，无软链；`realpath(cwd) === cwd`（排除路径软链/盘符大小写）。
6. **存在 pnpm→npm 迁移残留**：根目录 `node_modules__pnpm_backup/`（含 `.pnpm/`、`.modules.yaml`，Sep 17）+ `pnpm-lock.yaml` + `pnpm-workspace.yaml`，与 `package-lock.json`（Oct 12 10:29）并存；`node_modules` 于 Oct 12 10:28–10:33 全新 npm 安装。
7. 失败不可复现：3 并发施压亦未触发任何 `internal state` / `find the runner` / `reading 'config'`。

> ⚠️ 关于 lead 原报告所述「支撑证据」的核对：**`npm ls` 去重干净 → 已验证成立**；**「全局 `it()` 通过」与「显式 `import` 失败」→ 均未验证，且后者与事实相反**（显式 import 全绿）。因此「默认 forks 池下模块实例重复」**不能**列为已验证结论。

### 2.2 【推断】（未证实，附依据与证伪/证实方法）

**推断 A（主因）：这是一次「安装后冷状态 + Windows + vitest 4.1.x pool 启动竞态」的瞬时故障，而非本仓库确定性 bug。**

依据（逐条吻合上游 **vitest-dev/vitest#10812**，标题 *"Intermittent 'Vitest failed to find the runner' — every test file fails at suite scale on Windows"*）：全套文件级全灭 / 0 用例 / 含 `Cannot read properties of undefined (reading 'config')` 变体 / 重跑即过 / 小规模通过 / **4.1.9 只在 `npm install` 后第一次失败** / 4.1.10 比 4.1.9 更频繁。其环境 `Windows 11 + Node 24 + vitest 4.1.10 + vite 6.4.2` 与本机同族。旁证 **vitest#8861**（`forks` **与** `vmForks` 都随机出错，`threads` 正常）。

机制描述（推断）：`vitest` 的 `workerState` 与 `@vitest/runner` 的 `runner` 必须由 worker 引导流程在用户代码求值**之前**完成注册。pool 启动与求值竞态时读到 `undefined` → 表现为上述两种报错之一（同一根因的两种表现）。时间线吻合：`node_modules` 于 10-12 10:28 新装，lead 的二分定位正落在这个「安装后第一次」窗口内。

**证伪/证实方法**：固定 `--pool` / `--no-file-parallelism` / `--isolate` 记录失败率矩阵；同一 commit 上 `npm ci` 后立刻跑（预期高失败率）→ 重跑（预期恢复），复现 #10812 特征。

**推断 B（放大因素）：双包管理器残留。** `node_modules/.vite` 依赖缓存是在 pnpm→npm 切换的临界状态下重建的，可能残留指向旧布局的解析结果。证伪/证实：干净副本上删除 `node_modules__pnpm_backup/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 与 `node_modules/.vite`，`npm ci` 后跑 20 次统计失败率，与保留残留的对照组比较。

**明确「不是根因」（已验证）**：显式 `import from 'vitest'`、`setupFiles` 内容、`globals: true`、pool 选择本身、依赖重复/嵌套副本、路径软链/盘符大小写。

---

## 3. 修复路线对比与推荐

| 路线 | 改动量 | 是否治本 | 对现有 104 用例的影响 | 风险 / 回滚 |
|---|---|---|---|---|
| **① 锁 `pool: 'vmForks'`** | 1 行 | 否 | 用例逻辑不变，均绿（已实测）；但 VM 上下文更强隔离，`import.meta`/`process`/`node:` 语义与 `forks` 有差异，更慢更吃内存（需关注 `vmMemoryLimit`） | 中。**上游 #8861 显示 vmForks 同样会命中该竞态，不保证修好**；回滚 = 删该行 |
| **② 锁 `pool: 'vmThreads'`** | 1 行 | 否 | 用例逻辑不变（预期均绿）；共享进程/线程池语义，`process.exit` 与全局污染风险高于 forks | 中。语义差异大，不建议写入默认 config |
| **③ 测试改为不依赖 vitest 全局注入**（去掉显式 import、只靠 `globals`） | 大（9 文件） | 否 | **无收益**：9 文件本来就显式导入且全绿；反而丢失类型显式性与 tree-shaking | 高，且与实测矛盾 |
| **④（推荐）环境治理 + 依赖锁定，config 不动** | 小（删残留 + `^`→精确版本 + CI 用 `npm ci`） | 针对推断 B 治本；对推断 A 消除最可疑冷状态 | **零影响**（不改 pool、不改测试语义） | 低。回滚 = 恢复被删文件 / 改回 `^` |

**推荐：路线 ④。一句话理由**：当前默认配置**全绿**、没有任何失败样本，此时改 pool 等于在无证据下改变模块求值语义，风险 > 收益；唯一有实证且零风险的异常点是 pnpm→npm 残留 + 安装后冷状态，正是 #10812 的高发窗口。

**对现有 104 个用例的影响**：路线 ④ = **零影响**；路线 ①/② 理论上不改变用例逻辑（已实测全绿），但改变了隔离模型这一「传递语义」，属隐性风险。若日后 CI 上真的复现竞态，用**命令行逃生阀**（`npx vitest run --pool=vmForks` 或 `--maxWorkers=1`）而非写进 config，便于随时回滚。

---

## 4. 最小修复补丁

### 4.1 推荐（保持 `vitest.config.ts` 不变，仅补注释说明）

> 说明：本次唯一的「修复」是**环境治理**（删 `node_modules__pnpm_backup/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`node_modules/.vite`；`package.json` 把 `vitest`/`vite` 的 `^` 改精确版本）。`vitest.config.ts` **原文照抄即可**，无需改动：

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * 前端测试基座（LUMEN RAW 集成回归）。
 *
 * 与 `vite.config.ts` 的关系：应用构建仍然只读 `vite.config.ts`；本文件只在
 * vitest 下生效，并复用同一个 react 插件，保证 JSX 转换行为一致。
 * 注意：**不要**在这里写 `test:` 之外的构建/插件配置，否则会和 vite.config.ts
 * 分叉。
 *
 * ── pool 说明（2026-10-12 调查结论）──────────────────────────────
 * 默认 pool 为 `forks`，实测 9 文件 / 104 用例全绿。曾观察到「安装后第一次
 * 全量运行、9/9 文件启动失败、0 用例执行」的瞬时故障，判定为 vitest 4.1.x
 * 在 Windows 上的 pool 启动竞态（上游 vitest-dev/vitest#10812 / #8861），
 * 与 setupFiles / 显式 import / 本仓库配置无关。
 * 若 CI 上再次复现，请在**命令行**加 `--pool=vmForks`（或 `--maxWorkers=1`），
 * 不要在此处永久固定 pool —— 便于随时回滚，且避免改变模块求值语义。
 * ─────────────────────────────────────────────────────────────
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // describe/it/expect 走全局，测试文件顶部不必重复 import；
    // tsconfig.json 已注入 `vitest/globals` + `@testing-library/jest-dom` 类型。
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // 套件只覆盖 `src`，src-tauri / scripts 不进 jsdom 环境。
    exclude: ['node_modules/**', 'dist/**', 'src-tauri/**', '.venv/**'],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
});
```

### 4.2 备选（仅当 CI 上确认复现竞态时才启用，其余内容同上）

只加一行、放在 `test: {` 之后：

```ts
    // 备选逃生阀：仅当 CI 上确认复现 #10812 竞态时启用。
    // 代价：VM 级隔离更慢更吃内存；且 #8861 显示 vmForks 也可能命中该竞态。
    pool: 'vmForks',
```

> `package.json` 脚本**无需**为修复而改（`"test": "vitest run"` 保持）；可选新增 `"test:ci": "vitest run --reporter=verbose"`。

---

## 5. 现有回归网清单（104 用例保护了什么）

| 测试文件 | 用例 | 实际保护的行为 | 缺口 |
|---|---|---|---|
| `utils/toneToRecipe.test.ts` | 20 | recipe↔tone 跨语言契约：≤4 位量化、`NaN/±Inf` 归零、`temperature` opt-in、双向夹紧 `[-100,100]`、脏值归零、`toneIsDirty` | 纯函数；不覆盖 XMP 读写与 `apply_tone_cmd` 往返 |
| `hooks/useLumenPreview.test.tsx` | 10 | 「何时**不**发请求」：引擎禁用/JPG 优先/无 RAW → 零 invoke；`MAX_ATTEMPTS=2`；换图同步作废旧 URL；卸载丢弃迟到响应；失败无未处理 rejection | 不覆盖成功后再失败、A→B→A 快速切换 |
| `hooks/useLumenStatus.test.tsx` | 7 | `enabled=false` 零请求；1.5s 延迟握手；`detail` 透传；抛错静默降级；`true→false` 取消握手 | 不覆盖握手成功后掉线、重试 |
| `components/ThumbnailGrid.test.tsx` | 12 | 缩略图来源选择、引擎失败回落、`aria-label` 徽标、`aria-activedescendant`、空态 | 不覆盖滚动窗口、键盘上下选择、`pinnedId` 视觉 |
| `components/ThumbnailGrid.fallback.test.tsx` | 2 | 引擎 + 回落**双失败**不停在「加载中」、无未处理 rejection | 仅 1 组照片，不覆盖部分失败混合 |
| `components/TonalAdjuster.test.tsx` | 23 | 保存回调/成功反馈/`isSaving` 渲染/分歧提示/预设下拉/六滑杆/重置/自动/关闭 | **假护栏**：`不会重复触发保存` 只点击**一次**，从未双击 |
| `components/TonalAdjuster.masks.test.tsx` | 8 | 保存失败出口（`role=alert`、无未处理 rejection、可重试）；AI 蒙版控件/检测中禁用/失败复位 | 不覆盖真实计时器/debounce、蒙版与调色同时保存 |
| `components/SettingsModal.test.tsx` | 16 | 开关依赖顺序、握手 `detail`、`aria-live` 播报、保存整份设置、失败走 `onError`、读取失败、取消、评级同步 | 不覆盖**脏检查**、Esc/遮罩关闭 |
| `components/SettingsModal.ai.test.tsx` | 6 | GPU 期望 vs 实际构建不匹配的即时警告、能力未探测不误报、`lumenExpectAi` 上报 | 不覆盖保存后再打开 |

合计 20+10+7+12+2+23+8+16+6 = **104**，与实跑一致。结构性缺口：**没有任何 `App.tsx` 集成测试**，且 9 文件中 7 个与 LUMEN RAW 直接相关。

---

## 6. 关键路径零覆盖清单

| 模块 | 文件:行 | 为什么关键 | 建议补的用例数 |
|---|---|---|---|
| 快捷键守卫与作用域（含 `<select>`/按钮聚焦） | `hooks/useKeyboardShortcuts.ts:59-66,198` | 无测试文件；`<select>` 聚焦时按 `1-5/a/d/p/x/空格/…` 会同时改下拉值并触发全局动作（误评级/误淘汰/误翻页） | 5 |
| 调色保存并发/重复提交 | `App.tsx:1015-1032`、`TonalAdjuster.tsx:401-422` | App **未**传 `isSaving`，组件也不置本地 saving → 保存期间按钮不禁用 → 连点发两次 `apply_tone_cmd` | 4 |
| 批量元数据默认范围 | `MetadataEditorModal.tsx:43` | 默认 `syncScope='all'` → 填个镜头型号点保存会写**全部已扫描照片** XMP（破坏性） | 4 |
| 对比视图「独立缩放」仍联动 | `SplitCompareViewport.tsx:74-87` | `zoomBy` 无 `isLeft`，`else` 分支对两窗格同时 `setScale` | 4 |
| 扫描/导出进度与取消 | `BatchExportModal.tsx`、`App.tsx:315-372` | 无进度、无取消；长任务不可中断 | 6 |
| 搜索态计数不同源 | `App.tsx:214,1035,1048,1059` | 宫格用 `visibleGroups`、中心视口用 `filteredGroups[selectedIndex]`、底栏用 `filteredGroups.length` → 三者不一致 | 4 |
| 评级/旗标 XMP 写入失败路径 | `App.tsx:463-504,452-460` | 乐观更新后 `update_rating_flag_cmd` 失败只弹 toast，无重试/回滚断言 | 3 |
| 扫描会话保存/恢复 | `App.tsx:315-372,826-833` | 仅存 `selectedIndex`；重扫 `setPinnedId(null)` 静默丢钉基准 | 3 |
| 设置弹窗脏检查 | `SettingsModal.tsx` | 改一半直接关/取消无提示；未改动是否允许保存无护栏 | 3 |
| Toast live region 语义 | `components/Toast.tsx:119-120` | `role=status`/`aria-live=polite` 是否全覆盖；`error` 是否应 `assertive` | 3 |
| 三个视口缩放与翻页 | `PreviewViewport.tsx`、`BeforeAfterViewport.tsx` | M-01 即由此漏出 | 4 |
| `App.tsx` 筛选×搜索×钉基准三态组合 | `App.tsx:153-260` | 5 套索引（`groups/filteredGroups/filteredIndices/visibleGroups/selectedVisibleIndex`） | 5 |

**条目数：12。**

---

## 7. 各修复轨道的测试护栏清单

> 控制面更正：`src/test/setup.ts` **无** `mockInvokeHandler`。实际导出：`mockInvokeCommand`、`mockInvokeError`、**`setInvokeHandler`**、`invokeCalls`、`invokeCount`、`lastInvokeArgs`、`allInvokeCalls`、`resetInvokeMocks`、类型 `InvokeArgs`。未注册命令默认抛 `UnmockedCommandError`（不静默返回 `undefined`），每条用例须先声明用到的命令。

| 轨道 | 测试文件 | 用例名 | mock 设定 | 断言要点 |
|---|---|---|---|---|
| H-01 | `hooks/useKeyboardShortcuts.test.tsx`（新） | `select 聚焦时数字/字母快捷键不触发全局动作` | 无 IPC；`renderHook` + 全 `vi.fn()` 回调；元素 `appendChild`+`focus()` 后 `fireEvent.keyDown` | `<select>`/按钮聚焦 → 回调 0 次；body 聚焦 → 1 次；`role=dialog[aria-modal=true]` 存在 → 0 次 |
| H-01 | 同上 | `按钮聚焦时空格不触发「设为基准」` | 同上 | `onPinRight` 0 次（现 `case ' '` 双触发） |
| H-02 | `components/TonalAdjuster.test.tsx`（改假护栏） | `保存进行中双击不会触发第二次 onSave` | `onSave = vi.fn(() => gate)`（挂起），**不传** `isSaving` | `click`×2 → `onSave` 1 次；按钮 `toBeDisabled()`、文案含「保存中…」 |
| H-02 | `App.toneSave.test.tsx`（新） | `保存挂起期间双击「保存调色」，apply_tone_cmd 只发一次` | `mockInvokeCommand('lumen_status_cmd'/'get_tone_state_cmd', …)`；`setInvokeHandler` 让 `apply_tone_cmd` 返回挂起 Promise | `invokeCount('apply_tone_cmd') === 1` |
| H-03 | `components/MetadataEditorModal.test.tsx`（新） | `默认同步范围是「仅当前选中照片」` | `mockInvokeCommand('batch_update_metadata_cmd', 1)`；`currentGroup`=1、`filteredGroups`=2、`allGroups`=5 | 默认 radio `toBeChecked()`；footer「将更新 **1** 张照片」；`lastInvokeArgs(...).filePaths.length === 1` |
| M-01 | `components/SplitCompareViewport.test.tsx`（新） | `关闭联动后放大只改变左窗格缩放` | 无 IPC；传 `jpg.path`（`convertFileSrc` 已 mock）；先点 `aria-label="切换双图联动同步缩放"` | 左 `<img>` `scale` 变化、右 `scale` 保持 1；联动开启时两者相等 |
| M-05 | `components/BatchExportModal.test.tsx` + `App.scan.test.tsx`（新） | `导出/扫描进行中禁用并显示进度，取消后不再 invoke` | `setInvokeHandler(cmd => cmd==='batch_export_cmd' ? new Promise(()=>{}) : …)`；扫描同理 | 按钮「导出中…」+disabled；存在 `aria-live` 进度；点取消后 `invokeCount` 不再增长 |
| M-07 | `App.searchCounter.test.tsx`（新） | `搜索态下宫格高亮/中心视口/底栏计数指向同一张` | `mockInvokeCommand('scan_folders_cmd', {groups:[a,b,c,d,e]})`、`load_session_cmd → null`、`get_settings_cmd → {...}` | 底栏 `共 M 张` 中 M = 可见集大小（预期 `1 / 1`）；中心视口 `baseName==='c'`；宫格 `aria-activedescendant` 亦为 `'c'` |

---

## 8. 风险评估

- **改 config 的风险**：`forks→vmForks` 更慢更吃内存，`import.meta`/`process`/`node:` 语义有差异；`threads` 共享进程（`process.exit`、全局污染）；`server.deps.inline` 属盲试。当前默认 pool 全绿 → 改 pool 是「无失败样本时改传递语义」，风险 > 收益。
- **CI 风险**：双包管理器残留让 `npm ci`/缓存不确定 → 先清理并锁定单一 lockfile。本 bug 是 **Windows 特有**，只跑 ubuntu 会「CI 绿而开发机偶发红」，建议 ubuntu 主任务 + Windows 定时观测任务。CI 上的 `npm ci` 恰是 #10812 高发窗口，建议首次接 CI 时**显式**带 `--pool=vmForks` 作稳定器并在注释说明「规避上游竞态，非终态」。
- **vmForks 已知差异**：vm 上下文重建模块图，隔离更强但内存/启动开销更大；上游 #8861 明确 **forks 与 vmForks 都会出错**，把 vmForks 当解药无据；未来若引入 WASM/native addon 需重评。

---

## 9. 工作量估计（人天）

| 项 | 估计 |
|---|---|
| 环境治理（删残留、清缓存、精确版本、`npm ci` 验证 20 次） | 0.5 |
| 复现矩阵补做（对照项 A/B + 失败率统计，需授权写探针文件） | 0.5 |
| CI workflow + 脚本调整 + 首次验证 | 0.5 |
| H-01 / H-02 / H-03 护栏 | 0.5 + 0.75 + 0.5 |
| M-01 / M-05 / M-07 护栏 | 0.5 + 1.0 + 0.75 |
| 盲区补测（Toast、会话、导出、键盘等） | 1.0 |
| **合计** | **约 6.5–7.5** |

---

## 10. 复核中发现的报告偏差

1. **【M-16 核心表述不成立】** `UX-AUDIT-2026-10-12.html:306` 写「默认 `pool` 下 `pnpm test` **9/9 测试文件全部启动失败、0 个用例执行**」→ **未复现**：默认 `forks` 下连续 6 次 + 3 并发全部 `9 passed / 104 passed`。该表述仅在**瞬时状态**下成立，不宜作为「事实」写入审计表。
2. **【M-16 修复处方需修正】** 同一处建议「在 `vitest.config.ts` 固定 `pool: 'vmForks'`」→ **不建议**：`forks`/`threads`/`vmForks` 三者均绿（`vmForks` 非独有解），且 #8861 显示 vmForks 同样会命中竞态。建议改为「不动 config，逃生阀放 CI 命令行」。
3. **【M-16 里的 `pnpm test` 已过时】** 项目已于 10-12 迁到 **npm**（`package-lock.json` 与 `node_modules` 均为当日新建），`pnpm-lock.yaml`/`pnpm-workspace.yaml`/`node_modules__pnpm_backup/` 是残留。正确命令是 `npm test` / `npm ci`；保留 pnpm 表述会误导执行者。
4. **【审计「已执行并通过」行的根因表述不准确】** 原文「默认 `forks` 池下**模块实例重复**，`vmForks` 恢复正常」→ 「模块实例重复」是**推断**（未证实）；且「默认 forks 池下」这一前提在本机**无法复现**。其列举的三条支撑中，仅「`npm ls` 去重干净」成立；「全局 `it()` 通过」未验证；「显式 import 失败」**与事实相反**（9 文件全用显式 import 且全绿）。
5. **【审计「项目唯一的自动化回归手段实际处于失效状态」过重】** 当前默认 pool 全绿，回归手段**可用**；应表述为「存在偶发启动失败风险（安装后冷状态/Windows），需环境治理与 CI 兜底」。
6. **【`reading 'config'` 的来源需更正】** 本版本 `@vitest/runner` 的 `getRunner()` 走 `assert()`（`chunk-artifact.js:1631,1638-1641`）抛 `Vitest failed to find the runner`，**不会**直接抛 `reading 'config'`。该串见于上游 #10812 的现象描述，属同源竞态在另一访问路径上的表现；建议表述为「同一单例缺失症状的两种表现」，勿写成 `getRunner()` 返回 `undefined`。
7. **【对照项 A/B 未验证】** 「去掉 `setupFiles` 仍失败」「同文件移到项目根外可通过」两条均**未验证**（需改 config / 库外建文件，违反只读约束）。它们在逻辑上也被现有事实削弱：9 文件全用显式 import 且全绿，说明失败不依赖 setup 与项目内位置。
8. **【控制面命名】** 任务描述中的 `mockInvokeHandler` 实际是 **`setInvokeHandler`**（见 §7 顶部）。
9. **【依赖版本】** `package.json` 字面 `vite: ^6.1.1`，**实际安装 `vite 6.4.4`**（vitest 4.1.11）；上游 #10812/#8861 的报告环境为 `vite 6.4.2 + vitest 4.1.x + Windows`，同族 → 强化「上游竞态」解释。
10. **【现有「不会重复触发保存」是假护栏】** `TonalAdjuster.test.tsx:73-90` 全程只 `click` 一次，从未双击，且显式注入 `isSaving`，与 App 真实集成（不传 `isSaving`）脱节。
11. **【五套索引而非三套】** `App.tsx` 中 `filteredGroups`、`filteredIndices`、`visibleGroups`、`selectedIndex`、`selectedVisibleIndex` 并存，M-07 护栏须同时断言三处指向同一张，否则只能修一半。

---

### 附：本次调查执行的只读命令（可复现）

```
npx vitest --version | npx vitest run | npx vitest run --pool=vmForks
npx vitest run --pool=threads | npx vitest run --pool=forks
npx vitest run src/utils/toneToRecipe.test.ts | npx vitest run --help
npm ls vitest @vitest/runner @vitest/expect | npm ls vite jsdom ...
npx vite --version | node -e "fs.realpathSync/lstatSync" | git status --short
```

未执行：`npm/pnpm install`、任何改 `node_modules`/lockfile、任何联网/推送，以及对照项 A/B（需新建/改文件）。
