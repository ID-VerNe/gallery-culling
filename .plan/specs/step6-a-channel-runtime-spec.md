# SPEC — Step 6：A 通道常驻渲染运行时（预览主循环从 B 切到 A）

> old-coder Tier 3（并发 + 进程生命周期 + 跨语言）。**spec approval: not obtained (autonomous run)**。
> 前置：Step 3/4（`b16c776`/`daec4f3`，MCP 客户端 + 传输层 + 监督器已就绪且 E2E 握手通过）。
> 目标：把 `lumen_preview_cmd` 从「每张 spawn 一个 lumen-cli（2.1s）」切到「常驻 sidecar（热态 <0.5s）」。

## 1. 背景与实测

E2E 实测：B 通道单发 cold=2.09s（Python 解释器冷启动 + LibRaw 解码 + 渲染）。
A 通道：sidecar 常驻，只有解码+渲染成本（无进程启动）。

## 2. 行为规格

### B1 `LumenRuntime::new()` / `call_render_preview(args) -> Result<Value, LumenError>`
- 首次调用：spawn `lumen-cli mcp --headless` → `handshake()`（版本钉死 1.6.0）→ 缓存客户端；
- 后续调用：复用同一 `McpClient`（`render_preview` 工具）；
- 任一步失败：`mark_dead` + **单次 B 通道兜底**（`run_lumen("render.preview", args)`），
  兜底成功则返回其结果（不缓存 ready 状态，因 sidecar 未握手）；
- 连续失败计数达 `MAX_RESTARTS` 后不再自动重连（防风暴），直接走兜底。

### B2 `status(enabled) -> LumenStatus`
- 复用 Step 2 的 `lumen_status_from`；`enabled=false` → 不可用且**零请求**；
- `version` 取自已握手客户端（缓存），未握手则 None。

### B3 `shutdown()`
- 显式关闭：丢弃客户端（Drop 关 stdin → 子进程退出），状态回 `Down`。

### B4 `lumen_preview_cmd` 接线
- settings 启用 + exe 存在 → 走 `LumenRuntime`（A 通道，B 兜底）；
- 渲染边界闭包改为调用 runtime；缓存逻辑（`ensure_preview`）完全不变（命中零 RPC）。

## 3. 不变量

N1 既有 72+3+9 测试零回归；N2 无新 crate；N3 `AppState` 生命周期不被 db 耦合（独立字段，默认值构造）；
N4 兜底路径必须真实可用（B 通道已 E2E 验证）；N5 线程安全：`LumenRuntime` 用 `Mutex`，Tauri 命令在 `spawn_blocking` 内调用。

## 4. 测试清单

单元（内联）：`runtime_call_without_exe_is_dead`、`runtime_status_matrix`（复用 Step 2 映射）、
`runtime_dead_count_stops_reconnect`、`runtime_shutdown_clears_state`。
E2E（`lumen_sidecar_e2e.rs` 新增）：`e2e_a_channel_warm_preview_faster_than_cold` ——
首次（B 通道 cold）vs 第二次（A 通道 warm），断言 warm < cold 且两张都产图；`e2e_a_channel_status_ready`。

## 5. Gauntlet

同前六层 + 变异 5：兜底不生效、状态不置 Dead、ready 后重复握手、shutdown 不清状态、B2 忽略 enabled。