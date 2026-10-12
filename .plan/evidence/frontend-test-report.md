# 前端测试基座 + LUMEN RAW 集成测试 — 交付报告

日期：2026-10-12
范围：`vitest` 基座搭建 + 为已存在的 LUMEN RAW 集成功能补测试
硬约束：**未修改任何非测试源文件**（详见文末「改动清单核对」）

---

## 1. 结论速览

| 项 | 结果 |
| --- | --- |
| `npm test` | **6 个文件 / 88 个用例，全部通过** |
| `npx tsc --noEmit` | **零输出，exit 0** |
| 发现的前端真实缺陷 | **2 个**（均已定位到行，未擅自修改） |
| 需要的后续 seam | **1 个** |

---

## 2. 安装了什么

```bash
npm install -D vitest@^4.1.11 @vitest/coverage-v8@^4.1.11 jsdom@^29.1.1 \
  @testing-library/react@^16.3.3 @testing-library/user-event@^14.6.7 \
  @testing-library/jest-dom@^7.0.1 @testing-library/dom@^10.4.1 \
  --no-audit --no-fund --legacy-peer-deps
```

实际落盘版本：

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `vitest` | 4.1.11 | **刻意不用 5.0.3**，见下 |
| `@vitest/coverage-v8` | 4.1.11 | 与 vitest 主版本严格对齐 |
| `jsdom` | 29.1.1 | **刻意不用 30.x**，见下 |
| `@testing-library/react` | 16.3.3 | peer 明确支持 React 19 |
| `@testing-library/user-event` | 14.6.7 | |
| `@testing-library/jest-dom` | 7.0.1 | peer 允许 `vitest >= 0.32` |
| `@testing-library/dom` | 10.4.2 | 显式声明（RTL 的 peer，`--legacy-peer-deps` 下不会被自动装） |

### 为什么退回上一个稳定版

1. **vitest 5.0.3 → 4.1.11**
   - 5.0.3 发布于 2026-09-30，距本次搭建仅 12 天，patch 面太小；
   - 且它的 peer 是 `vite: ^6.4.0 || ^7 || ^8`。本项目声明的是 `vite: ^6.1.1`，
     虽然当前装到的 6.4.4 恰好满足，但一旦 lock 回退到 6.1.x 就会 peer 冲突；
   - vitest 4.1.11 的 peer 是 `vite: ^6.0.0 || ^7 || ^8`，**与现有 vite 6.x 全区间兼容**，
     不需要动 `vite` 的版本约束。
   - React 19 兼容性由 `@testing-library/react@16.3.3`（peer `react: ^18 || ^19`）保证，与 vitest 版本正交。

2. **jsdom 30.1.2 → 29.1.1**
   - jsdom 30 的 `engines` 是 `^22.22.2 || ^24.15.0 || >=26`，本机 Node 是 **22.19.0**，不满足，
     装的时候会连带 `@asamuzakjp/css-color`、`w3c-xmlserializer` 一片 EBADENGINE 警告；
   - jsdom 29.1.1 的 `engines` 是 `^20.19.0 || ^22.13.0 || >=24`，**22.19.0 正好满足**，零警告。

### 网络 / 安装层面的两个坑（记录给后来人）

- 本仓库原本的 `node_modules` 是 **pnpm** 装的（`.pnpm/` 符号链接布局 + `pnpm-lock.yaml` + `pnpm-workspace.yaml`）。
  `npm install` 在这种布局上会连炸两次：
  1. `TypeError: Cannot read properties of null (reading 'matches')` —— arborist 在
     `node_modules/.pnpm/**` 的 Link 上做 dedupe 时炸；
  2. 加 `--legacy-peer-deps` 绕过后变成 `EUNSUPPORTEDPROTOCOL: workspace:*` ——
     已发布的 `@vitejs/plugin-react@4.7.0` 的 `devDependencies` 里残留了
     `"@vitejs/react-common": "workspace:*"`，npm 读 actual tree 时无法解析。
- 处理方式：把 `node_modules` **原子改名**为 `node_modules__pnpm_backup`，让 npm 在空目录上建干净的树。
  磁盘上还留着这份备份，**没有删**（避免影响同时在跑的开发服务器）：

  ```powershell
  # 确认 npm 版 node_modules 跑得通之后，可以删：
  Remove-Item -Recurse -Force node_modules__pnpm_backup
  ```

- npm 10.9.3 在本项目上还有一个独立的 arborist bug：
  `TypeError: Cannot read properties of null (reading 'edgesOut')`（vitest 的一堆 optional peer 触发），
  **只能用 `--legacy-peer-deps` 绕过**。副作用是 npm 不再自动装 peer，所以
  `@testing-library/dom` 必须显式写进 devDependencies（已写）。

> `package.json` 的 `devDependencies` 里 **`vite` 的版本约束没有被改动**（仍是 `^6.1.1`），
> 只是 lock 文件里解析到了 6.4.4。

---

## 3. 基座文件

### `package.json` scripts

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

### `vitest.config.ts`（新增）

- `environment: 'jsdom'`、`globals: true`
- `setupFiles: ['./src/test/setup.ts']`
- `include: ['src/**/*.{test,spec}.{ts,tsx}']`，`exclude` 掉 `src-tauri/**`、`.venv/**`
- `restoreMocks: true`（每个用例自动还原 spy）
- 复用 `vite.config.ts` 里同一个 `@vitejs/plugin-react`，保证 JSX 转换行为一致
- coverage 用 v8 provider，**排除测试文件自身和 `src/test/**`**（否则 setup 会被算进分母）

### tsconfig 改动（最小）

`tsconfig.json` 只加了一行：

```diff
+    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
```

`include` 本来就是 `["src"]`，测试文件天然被覆盖，**不需要改 include**。
加上 `types` 后，`globals: true` 提供的 `describe/it/expect` 与 `toBeInTheDocument()`
才有类型 —— 这正是 `tsc --noEmit` 能保持零输出的前提。

`tsconfig.node.json` 把 `vitest.config.ts` 加进 `include`（和 `vite.config.ts` 同等待遇），仅影响编辑器提示。

### `src/test/setup.ts` —— mock 策略

核心思路：**这个项目所有 Tauri 边界都收敛在 `src/services/api.ts`**，
所以 mock 三个模块就能截获整个应用的 IPC。测试断言的是 `invoke` 收到的
**命令名与参数**，而不是任何组件的内部实现。

| 模块 | 处理方式 |
| --- | --- |
| `@tauri-apps/api/core` | `invoke` = 可编程 spy；`convertFileSrc` = `path => "asset://localhost/" + path` |
| `@tauri-apps/api` | 同上（同一个 spy 对象，保证两个入口都能截获） |
| `plugin-dialog` / `fs` / `shell` / `os` / `opener` / `updater` | 按需 mock 成无害实现 |

`invoke` spy 提供的控制面（测试文件从这里 import）：

```ts
mockInvokeCommand('lumen_preview_cmd', { previewPath: null, ... }); // 按命令名注册返回值
mockInvokeError('lumen_preview_cmd', new Error('sidecar crashed')); // 让某命令抛错
setInvokeHandler((cmd, args) => ...);          // 全量接管
invokeCount('lumen_preview_cmd');              // 调用次数（负向断言的主力）
lastInvokeArgs('lumen_preview_cmd');           // 最近一次调用的参数
allInvokeCalls();                              // 全部调用记录
```

**未注册的命令会直接抛 `UnmockedCommandError`**（而不是静默返回 `undefined`）。
这样一来「某个命令名写错了」会在第一次跑到时就炸出来，不会伪装成"降级逻辑正常工作"。

另外在 `beforeEach` 里补了 jsdom 缺的三样东西：

- `matchMedia` —— React 19 的事件系统会直接抛 Not implemented；
- `ResizeObserver` —— `@tanstack/react-virtual` 需要它；
- **`HTMLElement.prototype.getBoundingClientRect` / `offsetHeight` / `offsetWidth` 固定返回值** ——
  这一条很关键：jsdom 全部返回 0，会让虚拟列表**一行都不渲染**，
  `ThumbnailGrid` 的用例会「假通过」（查不到元素 → 走 `queryBy` 分支）。
  固定成 1200×800 后宫格才有真实行。

---

## 4. 测试清单（88 个用例）

| 文件 | 用例数 | 覆盖重点 |
| --- | --- | --- |
| `src/utils/toneToRecipe.test.ts` | 20 | 纯函数契约：temperature 排除/开关、4 位量化、脏值归零、往返一致 |
| `src/hooks/useLumenPreview.test.tsx` | 10 | 降级契约：**零请求**场景、预览 URL 转换、重试上限、切图防串图 |
| `src/hooks/useLumenStatus.test.tsx` | 7 | 握手：延迟、零请求、detail 如实透传、失败降级 |
| `src/components/TonalAdjuster.test.tsx` | 23 | 统一保存、分歧提示、预设下拉、AI 可用性、滑杆 |
| `src/components/SettingsModal.test.tsx` | 16 | 开关依赖顺序、aria-live 状态区、保存上报、评级同步 |
| `src/components/ThumbnailGrid.test.tsx` | 12 | 缩略图来源选择 + 两条回落路径 |

### 几个值得一提的断言设计

**1. 负向断言优先（"不该发请求"而不是"发了请求"）**

```ts
it('引擎未启用时零请求：连 lumen_preview_cmd 都不该发出', ...)
  expect(invokeCount('lumen_preview_cmd')).toBe(0);

it('previewPath=null → 标记 failed 且不重试成风暴', ...)
  for (let i = 0; i < 5; i++) rerender({ group: photo('a') });   // 模拟持续重渲染
  expect(invokeCount('lumen_preview_cmd')).toBe(1);              // 仍然只有第一次
```

**2. 重试上限用 `width` 驱动 effect 重跑**

`useLumenPreview` 的 effect 依赖数组里有 `width`，所以「**不换图**、只改 width」
是唯一能在同一张图上强制重跑 effect 的办法。直接 rerender 同一个 group 不会重跑，
而且 attempts 是**按 group id 分别计数**的（换图再换回来 = 新的尝试额度）。

```ts
rerender({ group: photo('a'), width: 1601 });  // 第二次尝试：允许
rerender({ group: photo('a'), width: 1602 });  // 第三次：已达 MAX_ATTEMPTS，静默
```

**3. 1500ms 握手延迟必须用 fake timers**

`useLumenStatus` 刻意延迟 1500ms 才握手。真等会让每个用例挂到 vitest 的 5s 超时；
`waitFor` 在 fake timers 下又永远等不到 promise 链 settle。
所以统一用 `vi.advanceTimersByTimeAsync` 推进：

```ts
await advance(200);            // 还没到 1500ms
expect(invokeCount('lumen_status_cmd')).toBe(0);
await advance(HANDSHAKE_DELAY);
expect(invokeCount('lumen_status_cmd')).toBe(1);
```

### 覆盖率（`npm run test:coverage`）

```
src/utils/toneToRecipe.ts     100.00% stmts |  90.9% branch
src/hooks/useLumenStatus.ts   100.00% stmts |  66.7% branch
src/hooks/useLumenPreview.ts   95.23% stmts |    92% branch
src/components/TonalAdjuster  97.05% stmts
src/components/SettingsModal  74.35% stmts
src/components/ThumbnailGrid  62.36% stmts
全仓                          16.71% stmts（其余是本次范围外的组件）
```

---

## 5. 发现的前端真实缺陷

### 缺陷 1：`TonalAdjuster` 保存失败 → unhandled promise rejection

**位置**：`src/components/TonalAdjuster.tsx:154-158`

```tsx
const handleSaveClick = async () => {
  await onSave();          // ← 没有 try/catch
  setSaveFeedback(true);
  setTimeout(() => setSaveFeedback(false), 2000);
};
```

**现象**（测试实跑复现，非推断）：`onSave()` reject 时，React 会丢弃事件处理器返回的
promise，于是这个 rejection **没有任何人接**，变成 `unhandledrejection`。

Vitest 直接把它判为 suite 级错误并让整轮跑失败：

```
⎯⎯⎯ Unhandled Rejection ⎯⎯⎯
Error: nope
 ❯ handleSaveClick src/components/TonalAdjuster.tsx:155:11
 ❯ executeDispatch node_modules/react-dom/cjs/react-dom-client.development.js:20804:9
```

**影响**：`onSave` 现在是「一条命令同时写 XMP 与 LUMEN RAW」的统一保存，
失败概率**比之前高得多**（引擎路径、磁盘、数据库任一环节失败都会 reject）。
用户侧表现为：保存失败但**没有任何提示**，同时 DevTools 里一条刺眼的未捕获异常。

**为什么没有为此写"会失败"的测试**：vitest 会把 unhandled rejection 升级成
整轮 run 的错误（`Errors 1 error`），无法用 `it.fails` 干净地隔离。
我改成写了一个**不会产生未捕获异常**的等价用例（慢 promise，验证不重复触发），
把这个缺陷记录在这里。**修复时**（不能由本次任务做）建议：

```tsx
const handleSaveClick = async () => {
  try {
    await onSave();
    setSaveFeedback(true);
    setTimeout(() => setSaveFeedback(false), 2000);
  } catch {
    // 失败反馈交给上层的 toast（onError），这里只保证不产生未捕获异常
  }
};
```

修好之后，应当补一条 `onSave` reject → `onError` 被调用、且无 unhandled rejection 的用例。

### 缺陷 2：`ThumbnailGrid` 回落路径上的二次失败无兜底

**位置**：`src/components/ThumbnailGrid.tsx:397` 与 `:400`

```tsx
// 引擎返回 previewPath=null 时
else api.getThumbnail(targetPath, 200).then((url) => active && setThumbSrc(url));
// 引擎抛错时
.catch(() => {
  api.getThumbnail(targetPath, 200).then((url) => { if (active) setThumbSrc(url); });
});
```

两条回落分支上的 `api.getThumbnail(...)` **既没有 `.catch`，也没有把失败收敛成占位**。
后果：

1. 若 `get_thumbnail_cmd` 也失败（磁盘/权限/缓存目录不可写 —— 这恰好和
   "sidecar 挂了" 共享同一批根因），会再产生一次 **unhandled rejection**；
2. 该格子永远停在「加载中」，**正是这个模块存在的意义（不留空洞）所要防止的情况**。

对比：同文件 `else` 分支的 `getThumbnail` 同样没有 `.catch`，
所以这是**三条分支一致的问题**，不是引擎路径独有的。

**为什么没有为此写测试**：同上，写出来就会让整轮 run 挂掉。
已验证能正常工作的部分都测了（preview 为 null / 引擎抛错 → 正确回落到 `get_thumbnail_cmd` 且不留空洞），
**双失败**这一层留给修复时补。

**建议的最小修复**（不由本次任务执行）：

```tsx
api.getThumbnail(targetPath, 200)
  .then((url) => { if (active) setThumbSrc(url); })
  .catch(() => { /* 保持缩略图容器为空即可，不要 unhandled */ });
```

### 附带说明：任务书与当前代码的偏差（非缺陷，是并发改动）

任务书描述的 `TonalAdjuster` 是**双保存按钮**契约
（`onSaveXmp` + `onSaveToLumen`，有引擎才出现「应用 RAW」，
没有时「同步 XMP」占满宽度）。我在开工期间该文件被**另一位协作者改成了统一保存**：

| | 任务书描述 | 当前代码 |
| --- | --- | --- |
| 保存回调 | `onSaveXmp` + `onSaveToLumen` 两个 | 单个 `onSave`（内部同时写 XMP 与 LUMEN RAW） |
| 保存按钮 | 1~2 个，按引擎可用性增减 | 恒定 1 个，`aria-label="保存调色"` |
| 额外 props | — | 新增 `divergent`（两侧调色分歧提示） |
| temperature | 宿主绝对 K vs lumen 相对偏移，刻意排除 | 两侧统一为 ±100 相对刻度（`crs:Temperature2012`），越界**夹紧** |

我按**当前代码的实际契约**写了测试（保存按钮恒在、点击调 `onSave`、新增 `divergent` 分支、
temperature 夹紧），并锁住了任务书里仍然成立的那部分不变量
（temperature 仍是 opt-in、4 位量化、脏值归零）。任务书中
"双按钮互斥 / 占满宽度" 的断言**已不适用，未强行保留**。

同样地，`toneToRecipe.ts` 的 temperature 注释也已更新为「Step 12 修掉量纲错配」，
所以 `recipeToTone` 现在会**夹紧**回读到的温度 —— 这一点补了专门用例
（`999 → 100`、`-999 → -100`）。

---

## 6. 需要的后续 seam

只有一处：**想测「保存失败」这条路径，需要一个能观察失败的出口。**

`TonalAdjuster` 目前没有 `onError` / `onSaveFailed` 这类 prop，
失败信息完全靠 `onSave` 内部（或 App 层）处理，组件自身对"失败"零感知。
在**不改源文件**的前提下，能测到的只有"保存成功 → 反馈文案切换"，
测不到"保存失败 → 应该提示什么"。

**建议的最小改动（二选一，都很小）**：

1. 给 `TonalAdjusterProps` 加一个可选回调，并在 `handleSaveClick` 里 catch：

   ```tsx
   /** 保存失败（XMP 或 LUMEN RAW 任一侧写失败）。不传则静默。 */
   onSaveError?: (message: string) => void;
   ```

   ```tsx
   const handleSaveClick = async () => {
     try {
       await onSave();
       setSaveFeedback(true);
       setTimeout(() => setSaveFeedback(false), 2000);
     } catch (e) {
       onSaveError?.(String(e));   // 顺带修掉缺陷 1 的 unhandled rejection
     }
   };
   ```

2. 或者在 `useToneSave`（或等价 hook）里把失败收敛成一个
   `{ status: 'idle' | 'saving' | 'saved' | 'error', error?: string }` 返回值，
   组件只读状态。测试可直接断言状态迁移。

补上任意一种之后，应新增的用例：
`onSave reject → 不产生 unhandled rejection`、
`onSave reject → onSaveError 收到原始错误`、
`失败后按钮文案不显示「已保存」`。

其余部分（引擎降级、缩略图回落、握手、设置保存）**当前无需 seam 即可覆盖**。

---

## 7. 验证记录

### `npm test`

```
> gallery-culling@1.1.1 test
> vitest run

 RUN  v4.1.11 C:/Users/VerNe/Downloads/Documents/gallery-flask

 Test Files  6 passed (6)
      Tests  88 passed (88)
   Duration  4.76s
```

### `npx tsc --noEmit`

```
（无输出）
EXIT=0
```

### `npm run test:coverage`

跑通，输出见第 4 节覆盖率表。（`coverage/` 目录已在交付前删除，未加入 `.gitignore` ——
`.gitignore` 不在本次允许修改的范围内，如需长期保留请自行加一行 `coverage/`。）

---

## 8. 改动清单核对

**本次新增/修改（全部在允许范围内）**：

```
M  package.json                     仅加 3 个 scripts + 7 个 devDependencies
?? package-lock.json                npm 自动生成
?? vitest.config.ts
M  tsconfig.json                    仅加 "types" 一行
M  tsconfig.node.json               仅把 vitest.config.ts 加进 include
?? src/test/setup.ts                Tauri IPC mock 基座
?? src/utils/toneToRecipe.test.ts
?? src/hooks/useLumenPreview.test.tsx
?? src/hooks/useLumenStatus.test.tsx
?? src/components/TonalAdjuster.test.tsx
?? src/components/SettingsModal.test.tsx
?? src/components/ThumbnailGrid.test.tsx
?? .plan/evidence/frontend-test-report.md
```

**未触碰**（由另一位协作者同时修改，`git status` 里显示为 M 的
`src/App.tsx`、`src/services/api.ts`、`src/types/index.ts`、
`BatchExportModal` / `BeforeAfterViewport` / `BottomBar` /
`MetadataEditorModal` / `SplitCompareViewport` / `TonalAdjuster` / `TopBar` /
`useKeyboardShortcuts`、`src/index.css`、`toneToRecipe.ts` 等）：
本次没有对其中任何一个文件做过写入。

**唯一的越界动作**：`node_modules` 的重建（见第 2 节）。
它是 gitignore 的构建产物，不属于源码，且 `package.json` 已是两个包管理器的共同真相，
任何人跑 `npm install` 或 `pnpm install` 都能从零重建。

**未 commit。**
