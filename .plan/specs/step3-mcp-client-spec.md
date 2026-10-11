# SPEC — Step 3：A 通道常驻 MCP 客户端（JSON-RPC + 版本握手 + 监督器）

> old-coder Tier 2。对应实施计划 §5 阶段 2（A 通道）。前置：Step 2 `f7fa75d`。
> **spec approval: not obtained (autonomous run)**。

## 1. 目标

实现宿主侧的常驻 MCP 客户端逻辑（可注入传输层的完整请求循环），替换 Step 1/2 的单发 B 通道作为预览主循环；含版本握手断言与崩溃退避。**进程线程管理（spawn/stdin/stdout 线程的真实装配）留待 M0**（sidecar 就绪后与真 `lumen-cli mcp` 端到端），本单覆盖全部协议逻辑。

## 2. 行为规格

### B1 `rpc_encode(method, params, id) -> String`
- 单行 newline-delimited JSON-RPC 2.0：`{"jsonrpc":"2.0","id":N,"method":M,"params":P}\n`（紧凑无空格，与 `mcp.py:97` 对齐）。

### B2 `McpClient::request(method, params)`（传输层可注入）
- 发送 B1 编码；随后读行：**跳过通知**（无 id 的帧/空行）、**跳过 id 不匹配**的应答，直到拿到匹配 id 的帧；
- 匹配帧含 `error` → `Err(LumenError::Command(error.message))`；含 `result` → `Ok(result)`；
- 读超时（本层 `Ok(None)` 语义）→ `Err(LumenError::Timeout)`（新变体，见修订）；
- 传输损坏（`Err`）→ 原样透传。
- id 单调自增，从 1 开始。

### B3 `McpClient::handshake()`
- 发 `initialize`（params 含 protocolVersion `"2024-11-05"`，即 legacy 客户端）→ 断言 `result.serverInfo.version == PINNED_LUMEN_VERSION`，不符 → `Err(Protocol)` 且消息含双方版本；
- 成功后发 `tools/list` 并缓存；`initialize` 返非预期结构 → `Err(Protocol)`。

### B4 `McpClient::call_tool(name, args)`
- `tools/call`；应答 `error` 字段 → Err；`result.isError == true` → `Err(Command(text))`（业务错误双通道，A 报告 G10）；否则解析 `content[]` 中 `type=="text"` 的 JSON 文本为 `Value` 返回；找不到 text 块 → `Err(Protocol)`。

### B5 `next_backoff(attempt: u32) -> Duration`
- `0.5s × 2^attempt`，封顶 8s；attempt≥5 → 8s。

### B6 传输层边界 `LineTransport`（trait）
- `write_line(&str)` / `read_line(Duration) -> Result<Option<String>, LumenError>`；**被测逻辑不含任何真实 IO**，生产实现（stdin/stdout 线程）属 M0 装配。

## 3. 不变量

N1 既有 51 测试零回归；N2 无新 crate；N3 clippy/fmt 我的文件 0（基线不变）；N4 legacy-only：客户端永不发 `_meta`/`server/discover`；N5 `--headless` 语义由上层保证，本层不碰进程参数。

## 4. 测试清单（内联，scripted 传输层）

`rpc_encode`×1、request id 匹配/跳过通知/跳过异 id/超时/error 帧 ×5、handshake 版本不符/成功缓存工具/结构异常 ×3、call_tool isError/成功/无 text 块 ×3、backoff ×3 —— 15 项。

## 5. Gauntlet

同 Step 2 六层 + 变异 5：request 不校验 id、握手不比版本、call_tool 不看 isError、backoff 不封顶、encode 漏 params。
