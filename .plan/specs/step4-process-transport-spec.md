# SPEC — Step 4：生产 `LineTransport`（子进程管道）+ 监督器

> old-coder Tier 2。对应 `.plan/lumen_raw_integration_steps.md` §5 阶段 2（步 2.1–2.5 的进程装配）。
> **spec approval: not obtained (autonomous run)**。前置：Step 3 `b16c776`。

## 1. 目标

把 Step 3 的 `LineTransport` trait 接到真实子进程（stdin 写 / stdout 读线程 / mpsc 超时），
并实现崩溃退避监督器；`ensure_running` 负责"拉起 → 握手 → Ready / Dead"。

## 2. 行为规格

### B1 `ProcessTransport::spawn(exe, args) -> Result<Self>`
- `stdin/stdout/stderr` 全 piped；**stderr 不并入协议流**（另起线程丢弃，防污染，A 报告 G6）；
- stdout 读线程按行投递 `mpsc`；EOF 或读错投递 `Err`；
- spawn 失败 → `Err(LumenError::NotInstalled)`。

### B2 `LineTransport for ProcessTransport`
- `write_line`：加锁写 stdin 并 flush（`mcp.py:98-100` 的写互斥语义）；
- `read_line(timeout)`：有行 → `Ok(Some)`；超时 → `Ok(None)`；通道断开/读错 → `Err`；
- `Drop`/`close`：关闭 stdin → 子进程按 `mcp.py:102-104` 自行退出（干净回收）。

### B3 `Supervisor`（纯状态机 + 真实 spawn）
- `state`：`Down | Ready{version} | Dead{attempt}`；
- `mark_ready(version)` / `mark_dead()`（attempt+1，退避 `next_backoff`）；
- `ensure_running(&exe)`：`Ready` 直接 Ok；否则 spawn + `McpClient::handshake()` → Ready；失败 → Dead + Err；
- 达到 `MAX_RESTARTS=8` 次后不再自动重启（防无限风暴），返回最后一次错误。

### B4 `preview_via(exe, src, cache_root, inputs) -> Result<PathBuf>`（接线）
- 复用 Step 2 `ensure_preview`，把渲染边界从 B 通道换成 A 通道 `call_tool("render_preview", args)`；
- 缓存命中路径零 RPC（Step 2 已保证）。

## 3. 不变量

N1 既有 62 测试零回归；N2 无新 crate（只用 std：process/io-util 线程 + std mpsc）；N3 clippy/fmt 我的文件 0；N4 永不传 `--headless` 以外语义变化（spawn 时固定 `["mcp", "--headless"]`）。

## 4. 测试清单（真实子进程夹具）

`line_echo.cmd`（`set /p` 回显 stdin 一行）夹具：
- `process_transport_roundtrip`：写一行 → 读回应相等（真实 duplex 进程）
- `process_transport_eof_is_none`：子进程输出完退出 → 读尽 → `Ok(None)`
- `process_transport_spawn_failure`：不存在 exe → `Err(NotInstalled)`
- `supervisor_state_machine`：Down→Dead→退避递增→Ready→版本记录
- `supervisor_ensure_running_rejects_non_mcp`：对回显夹具握手 → Err + state Dead（真实进程）
- `supervisor_max_restarts`：连续 8 次失败后停止自动重启

## 5. Gauntlet

同前六层 + 变异 5：read_line 超时返 Err、spawn 不截 stderr、supervisor 不递增 attempt、Drop 不关 stdin、ensure_running 不做握手直接 Ready。