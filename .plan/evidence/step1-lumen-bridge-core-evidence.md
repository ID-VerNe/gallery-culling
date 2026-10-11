# EVIDENCE — Step 1：`lumen.rs` B 通道基础设施

- **spec approval: not obtained (autonomous run)** — 用户指令"开始开工吧"授权执行，spec（`.plan/specs/step1-lumen-bridge-core-spec.md`）未经事前审批，置信度相应下调；spec 本身作为事后审查 artifact 留在仓库。
- **source state**: commit `239cd27`（GREEN checkpoint，变异还原的 git 参照）+ 工作区一处 additions（find_lumen_cli 测试）后为最终态；本文件与最终 commit 一并落库。
- **tier**: 2（normal, 小特性）。工具链：cargo 1.97.0 / clippy 0.1.97 / rustfmt 1.9.0-stable。
- **环境变更**：无（未装任何包；`Cargo.toml`/`package.json` diff 为空）。

## 1. 行为 → 测试映射（spec §2 每条都有对应测试）

| Spec | 行为 | 测试 |
|---|---|---|
| B1 | first_existing 首个存在 | `first_existing_returns_first_match`、`first_existing_none_when_missing` |
| B2 | candidates 顺序/空设置跳过 | `lumen_candidates_settings_path_first`、`lumen_candidates_skips_empty_setting` |
| B3 | find_lumen_cli 显式设置优先 | `find_lumen_cli_returns_explicit_setting` |
| B3b | where 解析/未找到 | `where_lumen_cli_parses_real_output`、`where_lumen_cli_missing_returns_none` |
| B4 | argv 形状+--headless | `build_run_args_shape` |
| B5 | 六种退出码分类 | `classify_exit_ok_parses_pretty_json`、`classify_exit_ok_invalid_json_is_protocol`、`classify_exit_1_strips_prefix`、`classify_exit_2_is_usage`、`classify_exit_signal_killed`、`classify_exit_unexpected_code` |
| B6 | spawn 失败/真实 exit1 | `run_lumen_missing_exe_not_installed`、`run_lumen_exit1_real_spawn`（真实 spawn where.exe） |
| B6 | 真实子进程全链路 | `exec_and_classify_ok_parses_json`、`exec_and_classify_bad_json_is_protocol_error`、`exec_and_classify_exit1_strips_lumen_prefix`（集成测试，cmd /C 真实 .cmd 夹具） |
| B7 | 键确定性/canonicalize/5 项敏感/hex16/去重 | `cache_key_is_deterministic`、`cache_key_canonicalizes_relative_paths`、`cache_key_changes_with_width`、`cache_key_changes_with_variant`、`cache_key_changes_with_version`、`cache_key_changes_with_src_mtime`、`cache_key_changes_with_project_mtime`、`cache_key_is_hex16`、`cache_key_distinct_paths` |
| B8 | 缓存路径形状 | `preview_cache_path_shape` |
| B9 | 中文消息 | `display_messages_are_user_facing_chinese` |
| N1 | 既有 6 测试不回归 | 见 §3 全量结果 |
| N2/N3 | 无新依赖/tokio 不变 | §5 供应链层 |
| N4 | generate_handler 未动 | diff 见 `239cd27`（lib.rs 仅 +1 行 `pub mod lumen;`） |
| N5 | clippy/fmt 零新增告警 | §3/§4 |
| N6 | 全 targets 编译 | §3 |

## 2. RED 证据

- 25/25 新测试以 `todo!()` 断言级失败（"not yet implemented"），**非编译失败**；`display_messages` 1 项在桩态即过（Display 枚举本身已实现）→ 按规则记为"既有行为，保留作回归装甲"。
- 每项真实断言写入后、实现前再次全红（25 failed）。
- 修过的两处测试自身问题（记录以示未掩盖）：`first_existing` 测试的 move 编译错（改 `Some(b.clone())`）；`run_lumen_exit1_real_spawn` 最初用 `cmd.exe` 当 exit-1 发生器不可靠（无 `/C` 时恒 exit 0，暴露为 Protocol 而非 Command）→ 换 `where.exe` + 保证不存在的模式（确定性 exit 1）。夹具路径的 `cmd /C` 双层引号问题 → 去掉手动引号由 Rust 转义。

## 3. Gauntlet 各层（最终态全新运行，数字为原文粘贴）

| 层 | 命令 | 结果 |
|---|---|---|
| 全量测试×2（flake） | `cargo test --manifest-path src-tauri/Cargo.toml` | `32/33 lib passed; 0 failed` + `3 integration passed; 0 failed`（两次一致，最终态 **36 passed 0 failed**） |
| 基线 | 变更前同命令 | `6 passed; 0 failed` → 零新增失败 |
| clippy | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | **5 errors，全部为既有基线**：`commands.rs:72,149`、`db.rs:152,153`、`scanner.rs:464`（`git status` 证明 src-tauri 于变更前干净=HEAD 既有）。**我的文件 0 告警**。按 old-coder 基线规则不越界修复 |
| fmt | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 7 处 diff **全部为既有文件**（commands.rs:282、luminar.rs:8,29,118、xmp.rs:86,164,180）。我的 2 个文件已单独 rustfmt 干净 |
| 手动变异 | 见 §4 | **5/5 killed** |
| 变更行覆盖 | **跳过：本机无 llvm-cov/tarpaulin（命令不存在）** | 用手动映射代替：§1 表即"每函数→测试"映射；如实记录 1 个未触达分支：`find_lumen_cli` 内 `find_in_path("lumen-cli")` 那行仅在"未装 LUMEN RAW 的机器"被执行，任何测试都无法在不做机器状态假设的前提下断言它 → **已知未覆盖分支，下个 Step 装好 sidecar 后用真实冒烟覆盖** |
| 供应链 | `git diff HEAD --stat -- src-tauri/Cargo.toml package.json` | 空：依赖集零变更（无新 crate；sha2/既有） |
| secrets | 新增文件 grep api_key/password/secret/token | `NO-SECRETS` |
| 套件健康 | 同上命令跑 2 次 | 两次均 36 green，无 flake |

## 4. 手动变异结果（无变异工具，按规章 5 个手写变异）

| # | 变异 | 击杀测试 | 还原验证 |
|---|---|---|---|
| M1 | `first_existing` 改 `rev().find()` 取末位 | `first_existing_returns_first_match` FAILED | `git checkout` 后 diff 空 |
| M2 | cache key 丢 width | `cache_key_changes_with_width` FAILED | 同上 |
| M3 | cache key 丢 project_mtime | `cache_key_changes_with_project_mtime` FAILED | 同上 |
| M4 | `classify_exit` 的 exit 1 落入 JSON 分支 | `classify_exit_1_strips_prefix` **和** 集成 `exec_and_classify_exit1_strips_lumen_prefix` 双杀 | 同上 |
| M5 | `build_run_args` 丢 `--headless` | `build_run_args_shape` FAILED | 同上，最终 `git status -- src-tauri/` 空 |

## 5. 如实记录的问题与已知限制

1. **spec 未获事前审批**（autonomous run）→ 置信度下调：本单证明"代码满足 spec"，不证明"spec 表达了一切要紧的事"。
2. **1 个分支未覆盖**（§3 覆盖层行）。
3. **既有 clippy×5 / fmt×7 基线债务**未修（防 scope creep），建议单开一个 chore step。
4. `find_in_path`/`where_lumen_cli_parses_real_output` 依赖 Windows `where.exe`+`notepad.exe`（产品即 Windows-first，spec N6 已声明）。
5. 未跑真实应用（`pnpm tauri dev` 需 GUI 会话）："真实执行"层由 3 个真实子进程夹具 + 2 个真实 spawn 测试代理；剩余真实链路（sidecar 尚不存在）等 M0 完成后补。

## 6. 复现方式

```bash
cargo test --manifest-path src-tauri/Cargo.toml          # 36 passed
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings   # 5 = 基线
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check                          # 7 = 基线
```
全部命令与夹具均为仓库内持久化文件（`src-tauri/tests/`、`.plan/specs/`）。
