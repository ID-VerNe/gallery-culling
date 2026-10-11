# SPEC — Step 5：前端 P0 接线（状态徽标 + 预览 hook + 大图切换 + 设置开关）

> old-coder Tier 2（UI 接线）。对应 `.plan/lumen_raw_integration_steps.md` §7（步 4.1–4.4）。
> **spec approval: not obtained (autonomous run)**。前置：Step 2 命令已注册（`lumen_status_cmd` / `lumen_preview_cmd`）。

## 1. 目标

让 RAW 检视大图走 LUMEN RAW 渲染（而非把 RAW 字节直接喂 `<img>`），带状态徽标与设置开关；
引擎不可用时**静默降级**回现有内嵌 JPEG/CSS filter 路径，UI 零报错。

## 2. 行为规格

### B1 `useLumenStatus()`（`src/hooks/useLumenStatus.ts`）
- 应用挂载后 1500ms 调用一次 `api.getLumenStatus()`（不阻塞首屏）；
- 返回 `{available, enabled, pinnedVersion, foundVersion, detail}`；请求失败 → `available:false` + detail="无法连接 LUMEN RAW"；
- `settings.lumenEnabled === false` → **完全不发起请求**（零 invoke）。

### B2 `useLumenPreview(group, opts)`（`src/hooks/useLumenPreview.ts`）
- `group.jpg` 存在 → 直接用 jpg（不请求）；
- `status.available === false` → 返回 `null`（调用方走旧路径）；
- RAW_ONLY + available → `api.getLumenPreview(raw.path, {width:1600})`；
  - `previewPath === null` → `null`（静默降级）；
  - 否则 `api.toAssetUrl(previewPath)`；
- 失败或超时 → `null`；同一 group 重试上限 2 次（`attemptsRef`），之后不再请求；
- group 切换时旧结果立即作废（防串图）。

### B3 `PreviewViewport.tsx`
- 数据源改为 `useLumenPreview`；有预览 URL 时 **filter 置 `'none'`**（防二次显影）；
- `<img onError>` → 回落旧 `convertFileSrc` 路径；
- 加载中显示现有 loading 态，不新增 spinner 变体。

### B4 `SettingsModal` + `App.tsx`
- 设置新增：启用开关、sidecar 路径（browse 过滤 exe）、引擎状态行（`detail` + 版本）；
- 保存走既有 `saveSettings`（后端已支持两个新键）。

## 3. 不变量

N1 `tsc --noEmit` 零错误；N2 不改 `App.tsx` 既有状态流（新增只挂 hook 调用点，≤3 处改动）；N3 无新的前端依赖；N4 lumen 关闭时行为与集成前逐屏一致。

## 4. 测试与门禁

前端无测试运行器（无 vitest/jest）→ **跳过并如实记录**；门禁 = `npx tsc --noEmit` + 手工验收矩阵（引擎关/引擎开/引擎崩）。

## 5. Gauntlet

tsc 零错误；Rust 全量零回归（前端不改 Rust）；人工对抗：引擎返回 null / onError / 快速切图三种降级路径逐一走查。