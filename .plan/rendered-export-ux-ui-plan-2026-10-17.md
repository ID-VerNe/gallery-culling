# 渲染成片导出：UX / UI 设计与工程结构实施计划

> 日期：2026-10-17
> 配套：`.plan/rendered-export-design-2026-10-17.md`（后端契约、LUMEN 源码链路、风险清单）
> 本文只解决三件事：**用户怎么用（UX）**、**界面长什么样（UI）**、**代码怎么拆（SRP/DRY + step by step）**。

---

## 1. UX 现状评分

按 Nielsen 十项 + Krug 快速诊断，对「批量挑选导出」弹窗评分：

**当前 7/10**（复制原片任务可用；成片任务完全缺失）

| # | 问题 | 严重度 | 影响 | 修复 |
|---|---|---|---|---|
| 1 | 无法导出调好色的图 | **4 Catastrophic**（对该任务） | 用户只能导出原片，必须去 LUMEN 里重做一遍 | 新增「调色成片」模式 |
| 2 | 取消文案「目标目录未产生任何文件」与事实不符（仍会写 `.gallery-export.json`） | **3 Major** | 用户以为目录干净，实际多出清单文件 | 改为「未产生成片」/「未产生导出文件」 |
| 3 | 导出进行中，输入控件仍可修改 | 2 Minor | 完成文案用的是旧闭包值，界面却显示新值 | 运行时禁用全部输入 |
| 4 | 底部「预计导出: N 组照片」与结果「已导出 N 个」单位不一致 | 1 Cosmetic | 用户不确定 1 组算几个 | 按模式给单位：组 / 张 |
| 5 | LUMEN 不可用时没有任何可见性 | 2 Minor（新增功能后升为 3） | 用户不知道为什么按钮点不了 | 三态门禁 + 去设置引导 |

**设计后目标 9/10**：唯一扣分点是「成片渲染单张不可中断」（LUMEN 命令层限制，只能做到张间取消）。

---

## 2. 三条设计原则

1. **模式先行**：导出内容决定后面所有选项的形态，必须放在第一个决策位。
2. **默认不改行为**：默认仍是「原片复制」，老用户不看新选项也能照旧完成。
3. **不可用时给路，不给墙**：LUMEN 不可用不锁死模式选择，而是说明原因 + 提供「去设置启用」。

---

## 3. 信息架构

```
┌─ 批量挑选导出 ─────────────────────────────── × ┐
│                                                  │
│  导出内容                                        │
│  ┌────────────────────┬────────────────────┐    │
│  │ ● 调色成片          │ ○ 原片复制          │    │
│  │   按调色渲染成片     │   复制 RAW / JPG    │    │
│  └────────────────────┴────────────────────┘    │
│                                                  │
│  目标导出目录                                    │
│  [ D:/export                              ] [浏览]│
│                                                  │
│  导出范围                                        │
│  ┌────────────────────┬────────────────────┐    │
│  │ ● 已保留或已打星 (42)│ ○ 仅标记保留 Pick   │    │
│  └────────────────────┴────────────────────┘    │
│                                                  │
│  ── 模式相关区（二选一渲染）──────────────────    │
│  A. 原片复制：包含文件类型                        │
│     ☑ 复制 RAW 原片及 XMP 侧边栏                  │
│     ☑ 复制对应 JPG 预览                           │
│  B. 调色成片：成片输出                            │
│     格式[JPEG ▾]  质量[92]  长边[原始 ▾]          │
│                                                  │
│  ⚠ LUMEN RAW 引擎不可用：未检测到 lumen-cli       │
│    [去设置启用]                                   │
│                                                  │
│  [进度条 + 当前文件]  [取消]                      │
│  [结果条]                                        │
├──────────────────────────────────────────────────┤
│ 预计生成: 42 张成片        [关闭] [开始生成成片]  │
└──────────────────────────────────────────────────┘
```

顺序理由：模式 → 目标 → 范围 → 模式选项。用户先回答「我要什么」，再回答「从哪来、到哪去」，避免填完文件类型才发现要切成片。

---

## 4. 逐区 UX 规格

### 4.1 导出内容（新增，置顶）

- 控件：`fieldset + legend` + 原生 radio（两列，`grid-cols-1 sm:grid-cols-2`）。
- 每个选项 = 主标签 + 一行 10px 说明：
  - `调色成片` / `按 .lumen 调色渲染成片`
  - `原片复制` / `复制 RAW / JPG 原文件`
- 默认 `copy`。
- 导出中：整组 `disabled`（`fieldset[disabled]` 天然生效）。
- **不要**把不可用的模式做成 disabled radio——用户会不知道为什么。

### 4.2 目标导出目录（保留）

- 逻辑与文案完全复用（`BatchExportModal.tsx:262-299`）。
- 成片模式仍禁止「目标 = 源目录」：不是因为会截断原片，而是避免 `.lumen`、临时文件污染源目录，以及扫描器把成片当原片。
- 新增：成片模式下，若目标目录已存在同名成片，不报错（后端跳过并计数）。

### 4.3 导出范围（保留）

- 4 个 `FILTERS` 不变，计数随模式变化（成片与复制候选相同，源由后端 `raw ?? jpg` 决定）。
- 底部预计数单位改为按模式：`预计导出: N 组照片` / `预计生成: N 张成片`。

### 4.4 模式相关区

**A. 原片复制**：现有两个 checkbox 原样保留（`BatchExportModal.tsx:332-358`）。

**B. 调色成片**：

```
格式 [JPEG ▾]   质量 [92]   长边 [原始 ▾]
```

- 三列 `grid sm:grid-cols-3 gap-3`，label 在上、控件在下（`text-white/80 font-medium` + 控件 `bg-background-base border border-border-default rounded-md px-2 py-1.5`）。
- 格式：`JPEG` / `TIFF` / `DNG`。PNG 不进 UI（摄影出片价值低，LUMEN 支持但不必暴露）。
- 质量：`number` 输入，`min=50 max=100`，失焦夹取；**TIFF/DNG 时 `disabled` 并显示 `—`**（保留位置，避免布局跳动）。
- 长边：`原始 / 4096 / 2560 / 1600`（对齐 LUMEN 的 SIZES 档位）。不提供自由输入，避免非法值。
- 提示行（`text-[10px] text-white/60`）：`成片按每张照片的调色渲染；原片不会被修改。`

### 4.5 LUMEN 门禁（三态）

| 状态 | 表现 | 开始按钮 |
|---|---|---|
| 探测中（`lumenStatus == null` 或 probing） | 不显示提示 | 可用（避免闪烁禁用） |
| 不可用（`available === false`） | `role="alert"` 琥珀条：`LUMEN RAW 引擎不可用：{detail}` + 次要按钮「去设置启用」 | 禁用 |
| 可用 | 不显示任何提示 | 可用 |

- 只有**成片模式**渲染这块提示；复制模式完全不受影响。
- 「去设置启用」：先关导出弹窗，再开设置（避免两层 Modal 叠加）。
- 文案里不出现 `lumen-cli.exe` 这类内部名词，用「LUMEN RAW 引擎」；路径细节放 `detail`。

### 4.6 进度

- 复用 `TaskProgressBar`，`label` 按模式：`正在导出照片` / `正在生成成片`。
- `current` 显示文件名（后端每张开始发一次）。
- 首张开始即发 `0/N`，避免空白。
- 取消：文案改为 `已取消导出：目标目录未产生成片。`（copy 模式同步改为「未产生导出文件」）。
- 已知限制：单张渲染不可中断。取消后按钮显示「取消中…」，等当前张结束。

### 4.7 结果条

- 结构不变：失败琥珀 `role="alert"` / 成功或取消绿 `role="status"`。
- 文案由 `buildOutcomeMessage()` 统一生成（见 §6.2）。
- 失败明细仍截断前 3 条。

### 4.8 底部

- 左：预计数（按模式）。
- 右：`关闭`（运行时 disabled）+ 主按钮。
- 主按钮文案：`开始导出` / `开始生成成片`；运行中：`导出中…` / `成片生成中…`。

---

## 5. 文案单一真值表

| key | copy | render |
|---|---|---|
| 模式名 | 原片复制 | 调色成片 |
| 模式说明 | 复制 RAW / JPG 原文件 | 按 .lumen 调色渲染成片 |
| 主按钮 | 开始导出 | 开始生成成片 |
| 运行中 | 导出中… | 成片生成中… |
| 进度 label | 正在导出照片 | 正在生成成片 |
| 预计数 | 预计导出: {n} 组照片 | 预计生成: {n} 张成片 |
| 成功 | 导出完成：已导出 {n} 个 | 成片生成完成：已生成 {n} 张 |
| 部分失败 | 导出未完全成功：失败 {n} 个，成功 {m} 个 | 成片生成未完全成功：失败 {n} 张，成功 {m} 张 |
| 跳过 | 跳过 {n} 个（目标已存在同名文件） | 跳过 {n} 张（目标已存在同名成片） |
| 取消 | 已取消导出：目标目录未产生导出文件。 | 已取消导出：目标目录未产生成片。 |
| 无候选 | 当前导出范围内没有照片，请先给照片打星或标记保留。 | 同左（复用） |
| 类型全不选 | 请至少勾选一种要复制的文件类型。 | —（不适用） |
| 引擎不可用 | — | LUMEN RAW 引擎不可用：{detail} |

---

## 6. SRP / DRY 设计

### 6.1 职责拆分

现状 `BatchExportModal.tsx` 394 行，塞入模式后会到 600+。按单一职责拆成 1 个容器 + 4 个展示组件 + 2 个 hook + 1 个文案模块。

| 单元 | 单一职责 | 明确不做 |
|---|---|---|
| `BatchExportModal`（容器） | 分区顺序、Modal 壳、footer 组装 | 不持有表单逻辑、不拼文案 |
| `useExportForm` | 表单 state、派生候选、校验、canRun | 不发请求、不碰 DOM |
| `useExportRun` | 执行、结果文案、取消、进度收尾 | 不渲染、不校验 |
| `ExportModeSelector` | 模式单选 | 不知道 LUMEN 状态 |
| `CopyOptions` | RAW/JPG 复选 | 不知道模式 |
| `RenderOptions` | 格式/质量/长边 | 不做全局校验 |
| `ExportResultPanel` | 结果条呈现 | 不生成文案 |
| `LumenGateNotice` | 三态提示 + 去设置 | 不做可用性判断（只读 props） |
| `exportMessages.ts` | 全部文案与结果拼装 | 无 React 依赖 |

**目录**：

```
src/components/export/
  BatchExportModal.tsx      ← 现有文件迁入（或原地保留，子组件放子目录）
  ExportModeSelector.tsx
  CopyOptions.tsx
  RenderOptions.tsx
  LumenGateNotice.tsx
  ExportResultPanel.tsx
  exportMessages.ts
src/hooks/
  useExportForm.ts
  useExportRun.ts
```

> 迁移策略：先原地拆子组件（`src/components/export/`），`BatchExportModal.tsx` 保留在原路径，避免 App.tsx 与测试的 import 大改。等稳定后再决定是否搬文件。

### 6.2 DRY 清单

| 重复点 | 单一来源 | 说明 |
|---|---|---|
| 校验顺序与文案 | `useExportForm().validation` | 空目标 → 目标=源 → 无候选 → 模式专属（类型全不选 / 引擎不可用） |
| 结果文案 | `buildOutcomeMessage({ mode, outcome, targetFolder })` | 取消优先、失败数最前、明细截断 3 条 |
| 执行流程 | `useExportRun` | copy/render 只注入不同的 `run()` |
| 模式差异 | `EXPORT_MODES` 配置表 | 标签/说明/按钮/进度/单位全部查表，不写 if-else |
| 候选计算 | `exportCandidates` | 两模式共用（成片不筛 RAW） |
| 目标=源判定 | `normalizeDir` + `parentDirOf` | 现有函数不动 |
| 进度与取消 | `useTaskProgress('export')` | 复用同一事件与命令 |

### 6.3 关键签名

```ts
// src/components/export/exportMessages.ts
export type ExportMode = 'copy' | 'render';
export type RenderFormat = 'jpg' | 'tif' | 'dng';

export const EXPORT_MODES: Record<ExportMode, {
  label: string; description: string;
  action: string; running: string;
  progressLabel: string; unit: '组' | '张';
}>;

export function buildOutcomeMessage(args: {
  mode: ExportMode;
  outcome: ExportOutcome;
  targetFolder: string;
}): { message: string; failed: boolean };

export function buildValidationMessage(args: {
  mode: ExportMode;
  targetFolder: string;
  targetIsSourceDir: boolean;
  candidateCount: number;
  includeRaw: boolean;
  includeJpg: boolean;
  lumenAvailable: boolean;
  lumenDetail?: string;
}): string | null;   // null = 可执行
```

```ts
// src/hooks/useExportForm.ts
export function useExportForm(groups: PhotoGroupInfo[]): {
  mode: ExportMode; setMode: (m: ExportMode) => void;
  targetFolder: string; setTargetFolder: (v: string) => void;
  exportFilter: ExportFilter; setExportFilter: (f: ExportFilter) => void;
  includeRaw: boolean; setIncludeRaw: (v: boolean) => void;
  includeJpg: boolean; setIncludeJpg: (v: boolean) => void;
  renderFormat: RenderFormat; setRenderFormat: (f: RenderFormat) => void;
  renderQuality: number; setRenderQuality: (v: number) => void;
  renderLongEdge: number; setRenderLongEdge: (v: number) => void;
  candidates: PhotoGroupInfo[];
  targetIsSourceDir: boolean;
  validation: { canRun: boolean; message: string | null };
  resetResultSignal: number;   // 任一输入变化 +1，供 useExportRun 清结果
};
```

```ts
// src/hooks/useExportRun.ts
export function useExportRun(args: {
  mode: ExportMode;
  onSuccess?: (m: string) => void;
  onError?: (m: string) => void;
}): {
  isRunning: boolean;
  progress: { processed: number; total: number; current?: string } | null;
  cancelRequested: boolean;
  result: { message: string; failed: boolean } | null;
  run: (invoke: () => Promise<ExportOutcome>, targetFolder: string) => Promise<void>;
  cancel: () => Promise<void>;
};
```

### 6.4 组件 props

```ts
<ExportModeSelector
  value={mode} onChange={setMode} disabled={isRunning}
/>

<CopyOptions
  includeRaw={includeRaw} includeJpg={includeJpg}
  onChangeRaw={setIncludeRaw} onChangeJpg={setIncludeJpg}
  disabled={isRunning}
/>

<RenderOptions
  format={renderFormat} quality={renderQuality} longEdge={renderLongEdge}
  onChangeFormat={setRenderFormat} onChangeQuality={setRenderQuality}
  onChangeLongEdge={setRenderLongEdge} disabled={isRunning}
/>

<LumenGateNotice
  status={lumenStatus} onOpenSettings={onOpenSettings} disabled={isRunning}
/>

<ExportResultPanel result={result} />
```

---

## 7. Step by step 实施计划

> 每步都可独立提交、独立验收。顺序保证「先有单一真值，再拆组件，最后接后端」。

### Step 1 — 契约与类型（0.5h）

- 改 `src/types/index.ts`：加 `ExportMode`、`RenderFormat`；`ExportOutcome` 保持不动。
- 新增 `src/components/export/exportMessages.ts` 的 `EXPORT_MODES` 常量。
- 验收：`npx tsc --noEmit`。

### Step 2 — 文案工厂 + 单测（1h）

- 实现 `buildOutcomeMessage` / `buildValidationMessage`（纯函数，无 React）。
- 新增 `src/components/export/exportMessages.test.ts`：
  - copy 成功 / 部分失败 / 跳过 / 取消
  - render 同四态，断言单位是「张」、动词是「生成」
  - 失败明细 >3 条时截断并带「等」
  - 校验：空目标 / 目标=源 / 无候选 / 类型全不选（仅 copy）/ 引擎不可用（仅 render）
- 验收：`npx vitest run src/components/export/exportMessages.test.ts --pool=vmForks`。

### Step 3 — `useExportForm`（2h）

- 抽出全部表单 state、`candidates`、`targetIsSourceDir`、`validation`、`resetResultSignal`。
- 规则：任何输入变化 → `resetResultSignal += 1`（替代现有 4 项依赖数组，DRY）。
- 新增 `src/hooks/useExportForm.test.tsx`：
  - 切换模式清结果信号 +1
  - 目标=源判定（大小写 / 尾斜杠）
  - 成片模式不因 `!includeRaw && !includeJpg` 被拦
  - 质量越界夹取到 50/100
- 验收：单测绿。

### Step 4 — 拆展示组件（重构，2h，不改行为）

- 新建 `ExportModeSelector` / `CopyOptions` / `RenderOptions` / `LumenGateNotice` / `ExportResultPanel`。
- 类名沿用现有风格：容器 `bg-background-base p-2.5 rounded border border-border-default`；label `focus-ring flex items-start gap-2 cursor-pointer rounded p-1.5 hover:bg-background-surface-hover transition-colors`；radio `accent-white mt-0.5`。
- `BatchExportModal` 改为组装这些组件，**默认 copy 模式下 DOM 与文案保持不变**。
- 验收：现有 `BatchExportModal.test.tsx` 5 条全绿（这是重构安全网，必须先绿再进 Step 5）。

### Step 5 — 接入模式与执行分支（2h）

- `useExportRun` 实现：`run()` 接收注入的 invoke，内部统一处理 `cancelled` / `failed` / 异常 / `finally finish()`。
- `BatchExportModal` 组装新顺序；条件渲染 `CopyOptions` / `RenderOptions`；footer 文案查表。
- 新增 props：`lumenStatus?: LumenStatus | null`、`onOpenSettings?: () => void`；`App.tsx` 透传（`App.tsx:215-219`、`:630-636`）。
- 验收：新增 `BatchExportModal.modes.test.tsx`（F1-F9，见 §8）。

### Step 6 — 后端命令对接（依赖后端，前端可先 mock）

- 后端按 `.plan/rendered-export-design-2026-10-17.md` §3.3-3.4 实现 `batch_render_export_cmd`。
- 前端 `api.batchRenderExport(items, targetFolder, { format, quality, longEdge })`。
- 联调断言：成片模式只调 render 命令，不调 copy 命令。
- 验收：Rust 单测 R1-R9 + 一次真实导出。

### Step 7 — LUMEN 门禁三态（1h）

- `LumenGateNotice` 接 `lumenStatus`；探测中不显示、不可用显示 alert + 去设置、可用不显示。
- `onOpenSettings` 由 App 实现：关导出 → 开设置。
- 验收：F3；手动验证「探测中 → 不可用 → 启用 → 可用」四种状态切换不闪烁。

### Step 8 — e2e + 全量回归（1h）

- 新增 `e2e/suites/09-render-export.mjs`（真 LUMEN 门禁 + 2 张 JPG + sha256 ≠ 源 + manifest）。
- 回归：`npx tsc --noEmit`、`npx vitest run --pool=vmForks`、`cargo test --lib`、`npm run e2e:app`。
- 验收：全绿；`05-export` 不受影响。

---

## 8. 测试矩阵（前端）

| 编号 | 用例 | 断言 |
|---|---|---|
| F1 | 默认 copy | 调 `batch_export_cmd`，不调 render；文案为「开始导出」 |
| F2 | 切 render | 调 `batch_render_export_cmd`，args 含 format/quality/longEdge |
| F3 | LUMEN 不可用 | 可见 `role=alert` + 「去设置启用」；开始按钮 disabled；零 invoke |
| F4 | 探测中 | 无 alert；按钮可用（不因探测禁用） |
| F5 | 模式切换 | 文件类型区隐藏、成片区出现；旧结果清空 |
| F6 | TIFF/DNG | 质量输入 disabled；切回 JPEG 恢复 |
| F7 | 质量越界 | 输入 200 → 失焦后 100；输入 10 → 50 |
| F8 | 进度 | `aria-valuenow` 随事件更新；current 显示文件名 |
| F9 | 取消 | 只发一次 `cancel_export_cmd`；按钮「取消中…」；文案「未产生成片」 |
| F10 | 运行中 | 模式与所有输入 disabled；X/Esc 锁定 |

---

## 9. 不做什么（范围控制）

- 不做导出后「打开目标目录」——现有弹窗没有，不新增。
- 不做水印/裁切/蒙版配置——完全复用 `.lumen` 里的设置。
- 不做格式记忆/预设——首版不引入持久化。
- 不做 PNG 入口——LUMEN 支持，但摄影出片用不到。
- 不新增进度事件通道——复用 `export-progress`，避免扩 `TaskKind`。

---

## 10. 交付判定

1. 默认路径（copy）视觉与行为零变化，现有 5 条测试全绿。
2. 成片路径：选模式 → 选目录 → 选范围 → 出片，全程无「huh?」时刻。
3. 引擎不可用时，用户能在 2 步内（看到提示 → 点去设置）知道怎么修。
4. 所有文案来自 `exportMessages.ts`，组件里不再出现硬编码结果句。
5. `BatchExportModal` 容器 ≤ 220 行，每个子组件 ≤ 120 行。
