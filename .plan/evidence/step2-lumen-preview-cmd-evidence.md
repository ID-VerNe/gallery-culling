# EVIDENCE — Step 2：`lumen_preview_cmd` / `lumen_status_cmd` / settings 迁移

- **spec approval: not obtained (autonomous run)**（同 Step 1）
- **source state**: commit `f7fa75d`（GREEN checkpoint，含全部实现+15 个新测试）；本文件与 spec 修订为最终态追加
- **tier**: 2。spec：`.plan/specs/step2-lumen-preview-cmd-spec.md`（含 3 条显式修订 R1/R2/R3）

## 1. 行为 → 测试映射

| Spec | 测试 |
|---|---|
| B1 parse_lumen_version | `parse_lumen_version_standard_output`、`parse_lumen_version_rejects_junk` |
| B2 preview_args | `preview_args_four_keys_exact`、`preview_args_original_flag` |
| B3 cached_preview | `cached_preview_hit_and_miss` |
| B4 ensure_preview | `ensure_preview_cache_hit_skips_render`、`ensure_preview_success_writes_tmp_then_renames`、`ensure_preview_missing_output_is_protocol_error`、`ensure_preview_propagates_render_error_and_leaves_no_file` |
| B5 lumen_status_from | `status_from_matrix` |
| B5 query_version | `query_version_real_spawn_of_fixture`（真实 spawn .cmd 夹具，成功路径 Some("1.6.0")+失败路径 None） |
| B6/B8 命令层 | `lumen_status_cmd`/`lumen_preview_cmd` 已注册（lib.rs generate_handler）；其 IO 编排的真实端到端依赖 sidecar 存在 → **M0 冒烟门禁**（见 §4 缺口登记） |
| B7 settings 纯函数 | `settings_pairs_contains_lumen_keys`、`apply_setting_lumen_roundtrip`、`apply_setting_existing_keys_unchanged`、`apply_setting_junk_values_tolerated` |
| N1 旧测试 | 36 个 Step-1 测试全绿（48 = 33 Step1-lib + 15 Step2） |

## 2. RED→GREEN 过程记录（含如实记录的问题）

- RED：15 个新测试以 `todo!()` 断言级失败。
- 绿的过程中暴露并**修正了 3 个测试自身的错误**（记录以示未掩盖）：
  1. `ensure_preview_cache_hit/success` 最初硬编码 key（"hitkey"/"okkey"），与实现的 hash key 不符 → 测试假设错误，改为经 `inputs.key(src)` 推导（断言语义不变）；
  2. 命中测试 helper 的 `src_mtime` 与调用参数不一致（None vs Some）→ 统一为参数化 helper；
  3. `query_version` 原断言"spawn .cmd 必失败 → None"，实测 Rust `Command` **可直接执行 .cmd** 且返回 Some("1.6.0") → 该测试升级为覆盖成功解析路径（更强的断言，非弱化）。
- 实现期 1 个真实编译错误（`LumenStatus` 缺 Serialize，Tauri `async_kind` 报错）→ 补 derive。
- REFACTOR：clippy `too_many_arguments (8/7)` → `PreviewCacheInputs` 打包，**测试只改调用点、断言零变化**，重构后 48 仍全绿。

## 3. Gauntlet 最终数字（最后代码态之后的两次全新运行）

| 层 | 命令 | 结果 |
|---|---|---|
| 全量测试 run1 | `cargo test --manifest-path src-tauri/Cargo.toml` | **48 lib + 3 integration passed; 0 failed** |
| flake run2 | 同命令 | 51 个 `ok`，一致，无 flake |
| clippy | `cargo clippy --all-targets -- -D warnings` | **5 errors = 基线**（commands.rs:73/150、db.rs:168/169、scanner.rs:464，全在 HEAD 既有代码；**我的文件 0**） |
| fmt | `cargo fmt -- --check` | 6 处 diff 全为既有文件（luminar.rs×3、xmp.rs×3）；我的文件干净。R3：commands.rs:282 顺带修复 |
| 前端类型 | `npx tsc --noEmit` | 零输出，通过 |
| 手动变异 | 见 §4 | **5/5 killed** |
| 供应链 | Cargo.toml/package.json diff | 空（零新依赖） |
| secrets | 新增文件 grep | 仅 fixture/env 无关内容，NO-SECRETS |
| 变更行覆盖 | 无工具（llvm-cov/tarpaulin 不存在） | 手动映射（§1 表）；缺口见 §5 |

## 4. 手动变异 5/5

| # | 变异 | 击杀测试 |
|---|---|---|
| M1 | `cached_preview` 改 `exists()`（目录也判命中） | `cached_preview_hit_and_miss` |
| M2 | `ensure_preview` 删"输出缺失"检查 | `ensure_preview_missing_output_is_protocol_error` |
| M3 | `preview_args` 丢 `output` 键 | `preview_args_four_keys_exact` |
| M4 | 版本钉死比较反向（`!=`） | `status_from_matrix` |
| M5 | `lumen_enabled` 存 "1"/"0" 而 load 认 "true" | `settings_pairs_contains_lumen_keys` |

全部 `git checkout` 还原后 `git status -- src-tauri/` 为空。

## 5. 已知缺口（honest limits）

1. **`lumen_preview_cmd`/`lumen_status_cmd` 无端到端测试**：Tauri 命令需要 app runtime；其可测部分（查找/键/编排/映射）已单测，进程边界已夹具覆盖。真实 sidecar 端到端 = M0（第一步：装好 lumen-cli 后手工冒烟 `lumen_status_cmd`）。
2. **clippy/fmt 基线债务**（5+6 处）未修，防 scope creep，建议单独 chore step。
3. **rustfmt 跟随 mod 的教训**：对 `lib.rs` 跑 rustfmt 会重排整个 crate（曾把 luminar.rs/xmp.rs 既有 drift 格式化，已 `git checkout` 回滚）。以后只格式化明确列出的文件，或接受并在 evidence 记录。
4. `git status` 中 `src/**`、`legacy_flask/` 等为用户既有未提交改动，全程未触碰、未提交。

## 6. 复现

```bash
cargo test --manifest-path src-tauri/Cargo.toml                # 51 passed
npx tsc --noEmit                                              # clean
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings  # 5 = 基线
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check       # 6 = 基线
```
