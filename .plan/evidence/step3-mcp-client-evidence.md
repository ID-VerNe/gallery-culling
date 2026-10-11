# EVIDENCE — Step 3：A 通道常驻 MCP 客户端

- **spec approval: not obtained (autonomous run)**
- **source state**: commit `feat(lumen): resident MCP client...`（GREEN checkpoint）+ 本文件
- **tier**: 2。spec：`.plan/specs/step3-mcp-client-spec.md`

## 行为 → 测试（11/11）

| Spec | 测试 |
|---|---|
| B1 rpc_encode | `rpc_encode_single_line_compact`（单行+紧凑+语义相等） |
| B2 request | `request_matches_id_skips_noise`、`request_timeout_when_silent`、`request_error_frame_maps_to_command` |
| B3 handshake | `handshake_pins_version`、`handshake_success_caches_tools`（含 legacy 协议版本断言+禁 _meta）、`handshake_malformed_result_is_protocol` |
| B4 call_tool | `call_tool_iserror_maps_to_command`、`call_tool_success_parses_text_block`、`call_tool_missing_text_block_is_protocol` |
| B5 next_backoff | `backoff_doubles_and_caps` |
| N1 | Step 1/2 的 48 个测试全绿（59 lib = 48 + 11） |

## RED→GREEN 记录

- RED：11/11 以 `todo!()` 断言级失败。
- 过程修正 2 处（如实记录）：
  1. `rpc_encode` 测试最初断言**字节精确键序**（`jsonrpc` 在前）——serde_json Map 是 BTreeMap（字母序）。JSON-RPC 键序无语义、spec B1 也从未要求 → 改为"语义相等 + 单行 + 无空格"的真实契约断言（非弱化：断言语义严格于原字节串）；
  2. `call_tool` isError 分支 `Value::as_str` 链类型不匹配编译错 → 改闭包转换。

## Gauntlet 最终数字（最后一次编辑后全新运行）

| 层 | 结果 |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml` | **59 lib + 3 integration passed; 0 failed** |
| clippy `--all-targets -D warnings` | **5 errors = 既有基线**（commands.rs:73/150、db.rs:168/169、scanner.rs:464）；我的文件 0 |
| `cargo fmt -- --check` | 6 处 diff = 既有文件（luminar×3、xmp×3）；我的文件干净 |
| flake | 同命令两轮一致 |
| 供应链 | Cargo.toml diff 空（零新依赖） |
| secrets | 无 |
| 覆盖层 | 无工具 → §行为映射即手动覆盖表；已知缺口见 §5 |

## 手动变异 5/5

| # | 变异 | 击杀测试 |
|---|---|---|
| M1 | request 不校验 id（`if false` 替换 id 比较） | `request_matches_id_skips_noise` |
| M2 | handshake 跳过版本钉死 | `handshake_pins_version` |
| M3 | call_tool 忽略 isError | `call_tool_iserror_maps_to_command` |
| M4 | backoff 不封顶（`.max(8000)` 反转） | `backoff_doubles_and_caps` |
| M5 | rpc_encode 丢 params（恒 `{}`） | `rpc_encode_single_line_compact` + `handshake_success_caches_tools` |

全部 `git checkout` 还原，`git status -- src-tauri/` 空。

## 5. 已知限制（honest limits）

1. **无真实子进程的 MCP 端到端**：scripted 传输层覆盖全部协议逻辑；真实 spawn/线程装配 + 与真 `lumen-cli mcp` 握手 = **M0 门禁**（sidecar 构建完成后）。
2. `LineTransport` 生产实现（ChildStdin/ChildStdout + 读线程 + mpsc + recv_timeout）尚未编写——下一个 Step（M0 之后）装配；本单的 trait 边界即为其契约。
3. clippy/fmt 基线债务同前，不越界修复。

## 6. 复现

```bash
cargo test --manifest-path src-tauri/Cargo.toml    # 62 passed
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings  # 5 = 基线
```
