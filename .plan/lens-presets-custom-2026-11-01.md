# 镜头快捷预设改为用户自定义 — 实施方案（2026-11-01）

对应 issue：#4 `feat(metadata): 常用手动镜头快捷预设改为用户自定义`

---

## 1. 现状

`src/components/MetadataEditorModal.tsx` 里 `COMMON_MANUAL_LENSES` 是 6 条写死的常量，
直接 `.map` 成按钮。点一下把 `name / focal / aperture` 灌进三个输入框，之后用户自己
再改。没有任何持久化、没有增删入口、换一条要改代码发版。

## 2. 存储选型（这是本方案唯一有争议的决定）

| 方案 | 好处 | 为什么不选 |
|---|---|---|
| A. 加进 `AppSettings`（第 10 个字段） | 复用现有 `get/save_settings_cmd`，改动最小 | `SettingsModal` 的保存是「打开时读全量 → 用户改 → 整体写回」。预设改在**另一个弹窗**里，用户在设置页开着时新增预设、再点保存，就会把旧的预设数组写回去 —— **静默丢数据**。另外 `isDirty` 用 `!==` 逐键比较，数组字段会引入引用比较的噪声 |
| B. localStorage | 前端独立完成，零 IPC 改动 | 与「应用状态一律落 SQLite」的既有约定不一致；WebView2 profile 被清就没了，也不进用户的 `gallery_culling.db` 备份 |
| **C. 复用 `settings` 表 + 独立键 `lens_presets` + 独立命令** | 与 A 一样落在同一个库；`save_settings` 只写它那 9 个键，**不会碰** `lens_presets`，没有整表写回的覆盖风险 | — |

选 **C**。

## 3. 契约（先定死，代码照此实现）

**存储**
- 键：`settings.lens_presets`，值 = JSON 数组字符串 `[{"name":"…","focal":"…","aperture":"…"}]`。
- **缺键** = 从未自定义过 → 返回内置默认 6 条（升级用户零感知）。
- **键存在且为 `[]`** → 返回空数组。用户主动删空就是空，**不复种默认值**。
  「缺键」与「空数组」必须能区分 —— 这是本次唯一容易写错的地方。
- **JSON 损坏** → 返回默认 6 条，且**不覆盖**库里的坏值（读路径只读；下次保存才覆盖）。
- 保存时后端再 sanitize 一次：字段 `trim`、丢弃 `name` 为空的项。前端已校验，后端不信任前端。

**IPC**
- `get_lens_presets_cmd() -> Vec<LensPreset>`
- `save_lens_presets_cmd(presets: Vec<LensPreset>) -> bool`
- 参数名即 IPC 契约（camelCase 由 serde `rename_all` 保证，字段都是单词，实际无差异）。

**不进 `AppSettings`**，因此不触碰 `settings_pairs` / `apply_setting` 的既有 9 键，
`settings_pairs_contains_lumen_keys` 里 `map.len() == 9` 的断言保持不动。

## 4. 改动清单

### Rust
| 文件 | 改动 |
|---|---|
| `src-tauri/src/models.rs` | 新增 `LensPreset { name, focal, aperture }` + `builtin_lens_presets()`（默认 6 条，与前端常量同源同序） |
| `src-tauri/src/db.rs` | `LENS_PRESETS_KEY`；`load_lens_presets()` / `save_lens_presets()`；保存前 `sanitize_lens_presets()` 纯函数 |
| `src-tauri/src/commands/settings.rs` | 两个 `#[tauri::command]` 薄封装 |
| `src-tauri/src/commands.rs` | 显式转发宏（含 `__cmd__` 与 `__tauri_command_name_`），见 AGENTS.md 第 4 节 |
| `src-tauri/src/lib.rs` | `generate_handler` 注册（限定路径） |

### 前端
| 文件 | 改动 |
|---|---|
| `src/types/index.ts` | `LensPreset` 接口 |
| `src/services/api.ts` | `getLensPresets()` / `saveLensPresets()` |
| `src/utils/lensPresets.ts`（新） | `BUILTIN_LENS_PRESETS`、`sanitizeLensPresets(unknown)`、`validateLensPresetDraft(draft, presets, editingIndex)` |
| `src/hooks/useLensPresets.ts`（新） | 加载（失败回退内置 + `console.error`）、`add/update/remove/restoreDefaults`；**先写库、成功再更新内存**，失败回滚并 `onError` |
| `src/components/MetadataEditorModal.tsx` | chips 改为动态列表；新增「编辑预设」折叠面板：行内 编辑 / 删除 + 新增表单 + 「恢复默认」两步确认 + 空态文案 |

### 文档
- `.plan/adr-013-user-lens-presets.md`：记录第 2 节的选型与代价。
- `AGENTS.md` 文档索引补一行（只加索引，不改红线）。

## 5. 测试计划（先写测试，后改实现）

**Rust（`db.rs` 内联测试，真 tmpdir）**
1. 缺键 → 默认 6 条，且首条是 `Voigtlander APO-LANTHAR 50mm F2`；
2. 存 → 读 roundtrip，顺序与中文/空格原样保留；
3. 存 `[]` → 读回 `[]`（**变异点**：把 `None` 与 `Some("[]")` 合并就会红）；
4. 库里塞坏 JSON → 读回默认，且库值未被改写；
5. 保存时 `"  "` 名字被丢弃、字段被 trim；
6. `save_settings(&AppSettings::default())` 之后 `lens_presets` **仍在**（防整表写回覆盖）。

**前端**
1. `lensPresets.test.ts`：sanitize 容错（非数组 / 缺字段 / 类型不对）、校验边界（空名、重名大小写与空格、编辑自身不算重名）；
2. `MetadataEditorModal.presets.test.tsx`：
   - 后端返回自定义预设 → 渲染的是自定义而不是内置；
   - 点 chip → 三个输入框被填充；
   - 新增 → `save_lens_presets_cmd` 收到含新项的完整数组；
   - 删除 → 收到不含该项的数组；
   - 恢复默认 → 两步确认，第一步不发请求；
   - `get_lens_presets_cmd` 抛错 → 回退内置 6 条，不炸界面。

**变异验证**（AGENTS.md 红线 6）
- 把 `load_lens_presets` 的 `None => 默认` 改成 `None => vec![]` → 测试 1 必须红；
- 把 `Some("[]")` 分支去掉、直接 `unwrap_or_default()` → 测试 3 必须红；
- 把 `sanitize` 里的 `trim` 删掉 → 测试 5 必须红。
- 变异前 `cp` 备份到 `/tmp`，还原用 `cp` 回写（**不用 `git checkout --`**）。

## 6. 风险与回滚

- **老库升级**：只多一个键，`apply_setting` 对未知键是空操作 → 零迁移风险。
- **数据丢失**：所有写路径都是「先写库成功、再更新 UI」，写失败保留用户输入并报错。
- **回滚**：本次不改任何既有表结构、不改 `AppSettings` 形状，revert 单个提交即可；
  残留的 `lens_presets` 键会被旧代码忽略。
- **性能**：一次读写一行 KV，无感知。

## 7. 验收

见 issue #4 的验收清单，逐条在 PR 描述里回填。
