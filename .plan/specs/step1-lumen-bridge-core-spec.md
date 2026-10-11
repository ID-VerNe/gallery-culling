# SPEC — Step 1：`lumen.rs` B 通道基础设施（lumen-cli 封装核心）

> old-coder Tier 2（normal bug fix/small feature）。本单元只碰 Rust 后端，无 UI、无新依赖。
> **spec approval: not obtained (autonomous run — 用户指令"开始开工吧"即授权执行；未做事前审批)**
> 对应实施计划：`.plan/lumen_raw_integration_steps.md` §4 阶段 1（步 1.1–1.3 的后端部分）。

## 1. 目标与边界

新增 `src-tauri/src/lumen.rs`，提供宿主调用 `lumen-cli`（lumen-raw sidecar）的**基础设施**：
可执行文件定位、参数拼装、退出码分类、预览缓存键。**本单元不含** Tauri 命令注册、不含常驻 MCP（Step 2/3）、不含前端。

## 2. 行为规格（可执行验收标准）

### B1 `first_existing(candidates: &[PathBuf]) -> Option<PathBuf>`
- Given 候选列表 `[a, b, c]`，When `a` 不存在、`b` 与 `c` 存在，Then 返回 `Some(b)`（**首个**存在者，顺序即优先级）。
- Given 全部不存在，Then `None`。

### B2 `lumen_candidates(settings.lumen_cli_path, local_appdata, program_files) -> Vec<PathBuf>`
- Given 设置路径非空，Then 它是**第一个**候选。
- Given 设置路径为空字符串，Then 跳过（不进候选列表）。
- Then 依次追加 `<local_appdata>\Programs\LUMEN RAW\lumen-cli.exe`、`<program_files>\LUMEN RAW\lumen-cli.exe`。
- 纯函数（环境目录由参数注入，不在函数内读 env —— 可测性）。

### B3 `find_lumen_cli(settings) -> Option<PathBuf>`
- 优先级：候选路径首个存在 → `where lumen-cli`（PATH 查找）→ `None`。
- `where` 的子进程本身不可用或其退出码非 0 → 视作未找到（不 panic）。

### B4 `build_run_args(command, args_json) -> Vec<String>`
- Then 恰为 `["run", command, compact_json, "--headless"]` 四元素，**`--headless` 恒在末位**（B 报告铁律：禁止误连本机 GUI）。
- compact_json 为 `serde_json::to_string` 无空格序列化。

### B5 `classify_exit(code: Option<i32>, stdout, stderr) -> Result<Value, LumenError>`
| 输入 | Then |
|---|---|
| `Some(0)` + 合法 JSON（含美化缩进多行） | `Ok(Value)` 原样解析 |
| `Some(0)` + 非 JSON | `Err(Protocol)` |
| `Some(1)` | `Err(Command)`，stderr 去掉 `lumen-cli: ` 前缀后的正文 |
| `Some(2)` | `Err(Usage)`（宿主拼参缺陷，须与业务错误区分） |
| `None`（被信号杀死） | `Err(Exit)` 语义的崩溃类错误 |
| `Some(其他)` | `Err(Exit(code))` |

### B6 `run_lumen(exe, command, args) -> Result<Value, LumenError>`
- 真实 spawn `exe` + B4 的参数；exe 不存在/起不来 → `Err(NotInstalled)`。
- 其余经 B5 分类。（真实子进程执行，禁止 mock 被测逻辑。）

### B7 `lumen_cache_key(src, width, variant, lumen_version, src_mtime, project_mtime) -> String`
- 确定性：同输入两次调用 → 相同字符串。
- 敏敏性：`width`、`variant`（Edited/Original）、`lumen_version`、`src_mtime`、`project_mtime`（None↔Some）**任一变化 → key 变化**。
- 格式：16 位小写 hex（sha2，已有依赖）。
- 不同 src → 不同 key（无碰撞的常识性断言）。
- 相对路径必须先 canonicalize（失败则原样使用）。

### B8 `preview_cache_path(cache_root, key, width, variant) -> PathBuf`
- Then `<cache_root>/lumen/<key>_<width>[_orig]_lumen.jpg`；Original 变体带 `_orig`，Edited 不带。
- 与宿主现有缩略图缓存（`app_cache/` 根下的旧 key 格式）**零串扰**：所有产物在 `lumen/` 子目录且文件名带 `_lumen` 标记。

### B9 错误消息（Display）为用户可读中文，句式对齐 `luminar.rs:64`：
`NotInstalled` 含「未检测到」，`Usage` 标明「应用内部缺陷」。

## 3. 不变量（必须存活的负面约束）

| # | 不变量 | 验证方式 |
|---|---|---|
| N1 | 既有 6 个测试全绿，`xmp.rs/thumbnail.rs/scanner.rs/models.rs` 零改动 | 全量 suite |
| N2 | **不引入任何新 crate**（不用 base64、不用 roxmltree、不加 walkdir 类）| `Cargo.toml` diff 为空 |
| N3 | tokio features 仍为 `["rt"]` 不变 | `Cargo.toml` diff 为空 |
| N4 | `mod lumen;` 之外，`lib.rs` 的 `generate_handler!` 注册表本单元不改 | diff 检查 |
| N5 | clippy `-D warnings` 零告警；`cargo fmt --check` 干净 | gauntlet |
| N6 | Windows 目标（产品即 Windows-first；非 Windows 代码路径允许编译但本单不测）| clippy 全 targets 通过 |

## 4. 测试清单（RED → GREEN 顺序）

内联单测（`lumen.rs` #[cfg(test)]）：`first_existing` ×2、`lumen_candidates` ×2、`find_lumen_cli`（where 真子进程）×2、`build_run_args` ×1、`classify_exit` ×6、`lumen_cache_key` ×7、`preview_cache_path` ×1、`run_lumen` 真实 spawn ×2（exe 缺失 → NotInstalled；`cmd.exe` 吃 `run` 参数 → exit 1 → Command）、Display 中文 ×1 —— 共 25 项。
集成测试（`src-tauri/tests/lumen_cli_contract.rs` + `tests/fixtures/*.cmd` 真实批处理夹具）：exit 0 + JSON、exit 0 + 坏 JSON、exit 1 + stderr 前缀剥离 —— 共 3 项（走 `exec_and_classify`，fixture 是真实进程边界，不 mock 被测逻辑）。

## 5. Setup 计划（获批即授权环境变更）

- **工具**：零新增（sha2/tokio 已在）。工具链现状：cargo 1.97 / clippy / rustfmt 齐；**无覆盖率工具、无变异测试工具** → 按 old-coder 规则降级为手动层并在 EVIDENCE 如实记录。
- **git**：用户明确要求每步一 commit。只 `git add` 本单元文件（工作区存在**用户既有的未提交改动** —— `src/` 组件、`legacy_flask/` 删除等；严禁 `git add -A`/`git commit -a`）。每个 commit 前 `git diff --cached --stat` 核对清单。
- **新增文件**：`src-tauri/src/lumen.rs`、`src-tauri/tests/lumen_cli_contract.rs`、`src-tauri/tests/fixtures/lumen_fixture_{ok,badjson,fail}.cmd`、`.plan/specs/`、`.plan/evidence/`。
- **修改文件**：仅 `src-tauri/src/lib.rs` 加一行 `pub mod lumen;`。

## 6. Gauntlet 计划（每层命令）

1. `cargo test --manifest-path src-tauri/Cargo.toml --lib`（基线 6 + 本单 25）
2. `cargo test --manifest-path src-tauri/Cargo.toml --test lumen_cli_contract`（+3）
3. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
4. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
5. 变更行覆盖：**无工具 → 跳过并记录**，用手动映射表（每函数→测试名）代替
6. 手动变异 5 个（见 EVIDENCE 模板）：first_existing 取末位、cache key 丢 width、cache key 丢 project_mtime、classify exit1 落入 ok 分支、build_run_args 丢 `--headless` —— 每个必须被指定测试击杀，然后逐一还原（编辑逆操作，不用 git stash）
7. 供应链：无新依赖 → 记录"依赖集未变"；diff 无 secrets
