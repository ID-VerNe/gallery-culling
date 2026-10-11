# EVIDENCE — Step 4：生产 `ProcessTransport` + 监督器

- **spec approval: not obtained (autonomous run)**；spec：`.plan/specs/step4-process-transport-spec.md`
- **tier**: 3（并发/进程边界 —— 按 Tier 3 加了真实子进程测试与 stderr 阻塞场景）
- **source state**: commits `feat(lumen): production ProcessTransport...` + `test(lumen): cover transport timeout...` + `test(lumen): cover stderr isolation...` + `test(lumen): cover Drop-closes-stdin...`

## 行为 → 测试（Tier 3：真实进程）

| Spec | 测试 | 性质 |
|---|---|---|
| B1/B2 write/read | `process_transport_roundtrip_real_process` | 真实 duplex 子进程（line_echo.cmd 回显） |
| B2 超时 | `process_transport_timeout_is_none` | 发送端存活但不投递 → recv_timeout |
| B2 EOF | `process_transport_eof_is_none` | 子进程退出 → 通道断 → None |
| B1 spawn 失败 | `process_transport_spawn_failure` | 不存在 exe → NotInstalled |
| B2 stderr 隔离 | `noisy_stderr_child_still_serves_protocol_cleanly` | 2000 行 stderr（>64KB 管道缓冲）→ 协议流仍干净且不阻塞 |
| B2 干净回收 | `drop_closes_stdin_so_child_exits` | 阻塞在 set /p 的子进程在 Drop 后退出并写标记 |
| B3 状态机 | `supervisor_state_machine_and_backoff`、`supervisor_max_restarts_stops_auto_retry`、`supervisor_ready_short_circuits_spawn` | 纯逻辑 |
| B3 ensure_running | `supervisor_ensure_running_marks_dead_on_bad_exe`（坏 exe）、`ensure_running_rejects_non_mcp_child`（垃圾对端 → 必须握手失败 + Dead） | 真实进程 |

## 过程修正（全部如实记录）

1. **实现漏洞（变异未跑到就被发现）**：`ensure_running` 在 spawn 失败时未 `mark_dead` → 补上；由 `supervisor_ensure_running_marks_dead_on_bad_exe` 断言。
2. **测试自身缺陷 3 处**：① 夹具用相对正斜杠路径（cmd 当开关）→ 改绝对反斜杠；② 忘记 `drop(transport)` 就断言；③ `ProcessTransport::spawn` 不透传 env → 改为测试侧手工装配同一结构体。
3. **跨平台/工具事实**：Rust `Command` 可直接 spawn `.cmd`；`cmd /C <path>` 在 Rust 的 argv 转义下报"系统找不到指定的路径"（诊断实验证实），测试统一走直 spawn。
4. **变异发现的覆盖缺口 ×2**：M1（read_line 超时分支）与 M2（stderr 排空）最初**存活** → 补测试后再验证击杀。
5. 批处理 for 循环变量必须 `%%i`（`%i` 是命令行参数语法）。

## 变异结果

| # | 变异 | 结果 |
|---|---|---|
| M1 | `recv_timeout` 超时返 `Err` 而非 `Ok(None)` | killed（补测试后） |
| M2 | stderr 不排空（保留 piped 不读） | killed（补噪声测试后，30s 超时失败） |
| M3 | `mark_dead` 不递增 attempt | killed（`supervisor_max_restarts_stops_auto_retry` + `state_machine_and_backoff`） |
| M4 | `Drop` 不关 stdin | **等价变异**：ChildStdin 随结构体析构本就关闭，Drop impl 是冗余保险。按 old-coder 规则归类为 equivalent，不补无意义测试 |
| M5 | `ensure_running` 跳过握手直接 Ready | killed（`ensure_running_rejects_non_mcp_child`） |

## Gauntlet

| 层 | 结果 |
|---|---|
| `cargo test --manifest-path src-tauri/Cargo.toml` | **71 lib + 3 integration passed; 0 failed** |
| clippy `--all-targets -D warnings` | 5 = 既有基线（commands.rs×2、db.rs×2、scanner.rs）；本 step 全部修净（unused import / flatten 死循环 / never-waited） |
| fmt | 仅格式化 `lumen.rs`（未触碰 lib.rs，避免跟随 mod 波及全 crate）；我的文件 0 |
| 供应链 | 无新 crate（仅 std threads + std mpsc） |
| 覆盖层 | 无工具 → 行为映射表 + 真实进程测试作为更强代理 |

## 已知限制

- `ProcessTransport::spawn` 丢弃 Child 句柄（靠 stdin EOF 自回收）——若 sidecar 忽略 EOF 会成为孤儿进程；M0 真实冒烟时用任务管理器核对（E2E 清单含此项）。
- 无真实 `lumen-cli` 端到端（sidecar 构建被网络阻塞，见 M0 状态）。