# SPEC — Step 2：`lumen_preview_cmd` / `lumen_status_cmd` / settings 迁移

> old-coder Tier 2。对应实施计划 §4 阶段 1（步 1.3 命令层 + 1.4 状态查询 + 1.5 前端类型/api 打底）。
> **spec approval: not obtained (autonomous run)**。
> 前置：Step 1（`239cd27`/`df010ee`）`lumen.rs` 基础设施已 GREEN。

## 1. 目标

把 Step 1 的纯基础设施接成可用的 Tauri 命令与设置项：RAW 走 sidecar 渲染真预览、落盘缓存、命中直接返回；设置里新增 lumen 开关与 sidecar 路径（旧库无这两个键 → 默认关闭，零迁移风险）。

## 2. 行为规格

### B1 `parse_lumen_version(stdout) -> Option<String>`
- `"LUMEN RAW 1.6.0\r\n"` → `Some("1.6.0")`；`"1.6.0"` → `Some("1.6.0")`
- 空串 / `"LUMEN RAW"` / `"garbage"` → `None`。只取**首行**的第一个语义版本（`\d+\.\d+\.\d+`）。

### B2 `preview_args(src, width, variant, output) -> Value`
- 恰含 4 键：`path`（src 字符串）、`size`（width）、`original`（Original=true / Edited=false）、`output`（output 字符串）。
- additionalProperties=false 的 lumen schema 下**不得多键**。

### B3 `cached_preview(cache_root, key, width, variant) -> Option<PathBuf>`
- 目标文件存在且 `is_file()` → Some；不存在 / 是目录 → None。

### B4 `ensure_preview(src, cache_root, width, variant, version, src_mtime, project_mtime, render) -> Result<PathBuf, LumenError>`
`render: impl FnOnce(&Path /*tmp*/, &Value /*args*/) -> Result<(), LumenError>` 是**进程边界注入**（不是被测逻辑的 mock）：
- 缓存命中（B3 Some）→ **不调用 render**，直接返回既有路径；
- 未命中 → `create_dir_all` 父目录 → 调 `render(tmp, args)`（tmp 与最终路径同目录、`.tmp` 后缀）→ tmp 不是文件 → `Err(Protocol)`（渲染输出缺失）；
- render 返回 Err → 原样透传，最终路径不得存在；
- 成功 → `fs::rename(tmp → final)`，返回 final；tmp 不得残留。

### B5 `lumen_status_from(enabled, exe_found: Option<PathBuf>, version: Option<String>) -> LumenStatus`
- `enabled=false` → `available:false`；
- `enabled=true, exe=None` → false；
- `enabled=true, exe=Some, version=Some(v)` 且 `v == PINNED`（"1.6.0"）→ true；
- `version != PINNED` 或 None → false（协议漂移保护，A 报告 G4）。
- `found_version` 原样带回（诊断用），中文 `detail` 面向用户。

### B6 `lumen_preview_cmd(file_path, width?, original?) -> Result<LumenPreviewResult, String>`
- settings.lumen_enabled=false 或 exe 找不到 → `Ok(LumenPreviewResult{ preview_path: None, .. })`（前端静默降级，**不报错**）；
- width 缺省 1600；clamp 到 128..=1600（B 报告：`render.preview` 源上限 1600）；
- 正常路径：读源文件 mtime → 找兄弟 `.lumen`（`<stem>.lumen`，同目录同名）→ 取其 mtime（存在则）→ ensure_preview → `Ok(Some(path))`；
- sidecar 业务错误 → `Err(中文消息)`（Display 已保证）。

### B7 settings 迁移（`db.rs`）
- `AppSettings` 增 `lumen_enabled: bool`（默认 **false**）、`lumen_cli_path: String`（默认 ""）；
- load/save 增两个 key（`lumen_enabled` 存 `"true"/"false"`）；旧行缺失 → 默认值，**既有 5 键行为零变化**；
- 映射抽成纯函数 `settings_pairs()` / `apply_setting()` 便于单测（commands.rs 不动）。

### B8 前端（`src/types/index.ts` + `src/services/api.ts`）
- `AppSettings` 加 `lumenEnabled: boolean`、`lumenCliPath: string`；
- 新增 `LumenPreviewResult { previewPath: string|null, width: number, cached: boolean }`、`LumenStatus { available, enabled, pinnedVersion, foundVersion, detail }`；
- `api.getLumenPreview(path, {width, original})` / `api.getLumenStatus()`，camelCase + 唯一 invoke 出口约定。

## 3. 不变量

- N1 既有 36 测试零回归；N2 无新 crate（不引 base64）；N3 tokio features 不变；N4 settings 旧键读写逐字节兼容（load_settings 对旧库输出与今天一致）；N5 clippy/fmt 零**新增**告警；N6 `npx tsc --noEmit` 零错误。

## 4. 测试清单

Rust 内联：`parse_lumen_version`×5、`preview_args`×2、`cached_preview`×2、`ensure_preview`×4（命中不调 render / 渲染缺失 Protocol / render Err 透传 / 成功 rename）、`lumen_status_from`×4、`settings_pairs`×2、`apply_setting`×3（新 bool 键、旧键不受影响、垃圾值容错）—— 22 项。
前端：无测试运行器 → **跳过并记录**，以 `tsc --noEmit` 为门禁（honest skip）。

## 5. Setup 计划

零新依赖、零环境变更。新增文件：无（只改既有文件 + 测试）。commit 授权同 Step 1（只 add 明确路径；工作区有用户未提交改动，严禁 `-A`）。

## 6. Gauntlet

1. `cargo test --manifest-path src-tauri/Cargo.toml`（36 基线 + 22）
2. `cargo clippy ... --all-targets -- -D warnings`（基线 5，我的 0）
3. `cargo fmt -- --check`（我的文件先单独 rustfmt；基线 7）
4. `npx tsc --noEmit`（前端类型门禁）
5. 覆盖层：无工具 → 手动映射 + 已知缺口记录
6. 手动变异 5 个：缓存命中不判 is_file、ensure_preview 不 create_dir_all、preview_args 丢 output、status 的版本钉死比较反向、settings 的 bool 存 "1" 与 load 的 "true" 不匹配
7. flake：suite 跑 2 次

---

## 修订记录（实现揭示的 spec 缺口，显式修订而非静默漂移）

- **R1（B4）**：新增 `LumenError::Io(String)` 变体 —— 实现时发现 create_dir_all/rename 的磁盘故障与"协议错误"语义不同，需要独立分类。Display: "LUMEN RAW 预览缓存写入失败: {m}"。
- **R2（B4）**：`ensure_preview` 的 6 个缓存键输入打包为 `PreviewCacheInputs` 结构体 —— REFACTOR 阶段 clippy `too_many_arguments (8/7)` 触发（-D warnings 下是真失败），断言不变、纯签名重构。
- **R3（附带）**：`commands.rs:282` 的既有 rustfmt drift 在本 step 格式化该文件时被顺带修复（该文件本就在改动范围内）。

