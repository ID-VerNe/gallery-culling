# SPEC — Step 9：调色 recipe 互通（六滑杆直连 LUMEN RAW）

> old-coder Tier 2。**spec approval: not obtained (autonomous run)**。
> 前置：Step 6（A 通道常驻）、Step 8（评级同步）。
> 目标：宿主调色面板的 6 个滑杆写入 lumen recipe，预览实时反映；不做双向（编辑态在宿主）。

## 1. 契约（已用真实 sidecar 核对）

lumen `edit.get full=true` → `state.adjustments` 含 16 个字段，与宿主 `ToneAdjustments`
（exposure/highlights/shadows/temperature/tint/contrast）**同名**；
`edit.apply {changes:{adjustments:{...}}}` 接受**最终值**（非增量）。

**量纲警告（F 报告 §4.3-2）**：lumen 的 `temperature` 是**相对偏移**（默认 0.0），
宿主写进 XMP 的是**绝对 K**（默认 5350）。未闭环前 **temperature 禁止透传**。

## 2. 行为规格

### B1 `tone_to_recipe(tone, include_temperature=false) -> Value`
- 输出 `{adjustments:{exposure,highlights,shadows,tint,contrast}}`（**5 个**，不含 temperature）；
- 值原样透传（最终值语义）；`include_temperature=true` 时才加 temperature（供未来闭环）。

### B2 `recipe_to_tone(changes) -> ToneAdjustments`
- 从 lumen 的 `state.adjustments` 读回 5 个字段；缺失字段 → 0。

### B3 `lumen_get_recipe_cmd(file_path) -> LumenRecipeSnapshot`
- `{available, adjustments, monochrome, hasMask?}`；引擎不可用 → available=false（零请求）。

### B4 `lumen_apply_recipe_cmd(file_path, changes) -> ()`
- 调 `edit.apply`（A 通道优先，B 兜底）；失败 → 中文 Err。

### B5 `lumen_preview_cmd` 支持 recipe
- 新增 `recipe: Option<String>`（JSON 文本）；传了则并入 `render_preview` 参数；
  缓存键**必须**纳入 recipe 的规范化哈希（否则改色后返旧图）。

### B6 前端 `utils/toneToRecipe.ts`
- `toneToRecipe(tone)` / `recipeToTone(adjustments)` 纯函数 + 单元契约由 tsc 保证；
- TonalAdjuster 保存按钮：引擎可用 → 「套用到 LUMEN RAW」；否则 → 「同步 XMP」（现状不变）。

## 3. 不变量

N1 既有 90+3+13 零回归；N2 无新 crate；N3 **temperature 永不透传**（有测试钉死）；
N4 recipe 参与缓存键（改色必重渲染，有测试）；N5 引擎关闭时前端行为与今天逐像素一致。

## 4. 测试

单元：`tone_to_recipe_excludes_temperature`、`recipe_to_tone_defaults`、`cache_key_includes_recipe`。
E2E：`e2e_recipe_apply_then_render_changes_image`（真实 sidecar：apply 曝光 → 渲染 → 与原图 sha 不同）。

## 5. Gauntlet

同前六层 + 变异 3：temperature 被透传、recipe 不进缓存键、B3 忽略 available。