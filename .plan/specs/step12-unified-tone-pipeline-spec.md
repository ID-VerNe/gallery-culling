# SPEC — Step 12：调色管线统一（单一写入路径 + 单位对齐）

> old-coder Tier 3（跨语言、真实二进制、真实 RAW、真实第三方格式语义）。**spec approval: not obtained (autonomous run)**。
> 前置：Step 9（recipe 互通，当时 temperature 因"量纲不同"被排除）、Step 11（能力探测）。

## 1. 问题陈述（现状是两条互不相通的管线）

```
                  ┌─ 宿主: ToneAdjustments ─→ crs:* 写 XMP ─→ CSS filter 预览
六滑杆 tone ──────┤
                  └─ lumen: adjustments   ─→ .lumen session ─→ lumen 渲染
```

同一组滑杆值落在**两个不同的真值存储**上，单位还差一个量纲（见 §2），于是：
- 引擎关闭时宿主写 `crs:Temperature=+30`，Lightroom 读成 **30 Kelvin**（深蓝，废片）；
- 引擎开启时滑杆值被丢弃 temperature（Step 9 的临时禁令），两边永远对不上；
- 无法回答"两边现在一致吗"，也就无法安全地只保留一条路径。

## 2. 关键实测（决定了设计）

用真实 sidecar（`1.6.0`）探针实测：

| 事实 | 证据 |
|---|---|
| `edit.apply` 是**进程内 session**，不落盘 | 单发 `run edit.apply` 返回 `applied:[...]`，下一进程 `edit.get` 读回 0 |
| `project.save` **落盘且跨进程可读** | `.lumen` 4059 字节 JSON；新进程 `get_edits` 读回 exposure=1.25 / contrast=8.0 |
| lumen `adjustments.temperature` 是 **±100 相对偏移**，会被截断 | 传 500 → 存 100；传 -300 → 存 -100 |
| lumen `.lumen` 里另有 `white_balance.kelvin/camera_kelvin`（绝对，估测值） | 始终 5290，不随 temperature 变化 |
| 宿主 UI 滑杆范围 | `-100..+100`，describe = "冷暖偏移" |

**结论**：lumen 的 temperature 与宿主滑杆是**同一单位**（±100 相对偏移，等同 Lightroom 的
`crs:Temperature2012`）。Step 9 的"量纲不同"结论是错的——真正量纲不同的是宿主写的
`crs:Temperature`（绝对 Kelvin 语义）。修掉宿主的标签选择，两边就通了。

## 3. 行为规格

### B1 单位对齐（xmp.rs）
- 写入改用 **`crs:Temperature2012`**（±100 相对，与滑杆/lumen 一致）。
- 读取：优先 `crs:Temperature2012`；缺失时回退 `crs:Temperature`，
  但**旧文件里的绝对值（>1000）不再灌进滑杆**（那正是历史 bug 的产物），按 0 处理。
- 旧的 `crs:Temperature` 标签在写出时不再产生（避免继续毒化 Lightroom）。

### B2 单一写入命令 `apply_tone_cmd(file_path, tone)`
- 总是写 XMP（互操作：Lightroom / Capture One / Photoshop）。
- 引擎可用时：**同一 A 通道进程内** `apply_edits` → `save_project`（落盘持久）。
  - 不落盘就等于没写：下次预览/重启都拿不到。
  - 失败不回滚 XMP（XMP 是互操作底线），失败信息进返回报告。
- 返回 `ToneWriteReport { xmp_written, lumen_applied, project_path, warnings }`。

### B3 单一读取命令 `get_tone_state_cmd(file_path)`
- 读 XMP tone（互操作真值）+ lumen `get_edits`（渲染真值，跨进程可读）。
- 两者都存在且不相等 → `divergent = true` 并同时返回两侧值（前端据此提示）。
- 引擎不可用 → 只返回 XMP 值，`lumen_available = false`（零请求）。

### B4 temperature 直通
- `tone_to_recipe` 默认**包含** temperature（单位已对齐）。
- 前端 `toneToRecipe` 同步；调色面板不再有"保存到哪"的二选一。

### B5 前端单一保存按钮
- 调色面板一个「保存调色」按钮 → `applyTone`；引擎不可用时行为与今天一致（只写 XMP）。
- 打开面板时用 `getToneState` 读回真实值（含 lumen 侧），滑杆反映真值。

## 4. 不变量

N1 既有 100 + 3 + 17 零回归；N2 无新 crate；N3 **引擎关闭时前端行为逐像素不变**（仍只写 XMP、仍 CSS filter）；N4 XMP 写入永远先于/独立于引擎，引擎失败不回滚；N5 temperature 直通（单位已对齐，有测试钉死）；N6 引擎失败时预览自动回落（既有行为）。

## 5. 测试

单元：`xmp_writes_temperature2012_not_absolute`、`read_prefers_2012_over_absolute`、`legacy_absolute_ignored`、`tone_to_recipe_includes_temperature`、`tone_state_divergence_rules`。
E2E：`e2e_unified_tone_pipeline`（真实 sidecar：apply → save_project → **新进程** get_edits 读回 + XMP 里有 Temperature2012）、`e2e_tone_roundtrip_matches_lumen`（两侧值一致 → divergent=false）。

## 6. Gauntlet

同前六层 + 变异：temperature 又被排除、写回 crs:Temperature、引擎失败回滚 XMP、分歧判定反向、save_project 缺失导致重启丢调色。