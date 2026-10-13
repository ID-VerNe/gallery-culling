//! 常驻 MCP 客户端：initialize -> tools/list -> tools/call。
//!
//! 与 cli.rs 的区别：这里是长连接 + 协议握手，不是一次性 spawn。

use serde_json::Value;

use super::transport::LineTransport;
use super::{LumenError, LEGACY_PROTOCOL_VERSION, PINNED_LUMEN_VERSION, READ_TIMEOUT, rpc_encode};

/// 常驻 MCP 客户端（legacy）：initialize → tools/list → tools/call。
pub struct McpClient<T: LineTransport> {
    transport: T,
    next_id: i64,
    server_version: Option<String>,
    tools: Option<Vec<Value>>,
}

impl<T: LineTransport> McpClient<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            next_id: 1,
            server_version: None,
            tools: None,
        }
    }

    /// 发一次请求并等待 id 匹配的应答（跳过通知与异 id 帧）。
    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, LumenError> {
        let id = self.next_id;
        self.next_id += 1;
        self.transport
            .write_line(&rpc_encode(method, &params, id))?;

        loop {
            match self.transport.read_line(READ_TIMEOUT)? {
                // 超时：进程还在，可原样重试。
                None => return Err(LumenError::Timeout),
                // 进程已退出：read_line 已返回 ProcessExited，此处不重复包装。
                // 调用方（render_preview 等）据此走"重启 sidecar"而非"再试一次"。
                Some(line) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue; // 空行跳过（mcp.py:105 同义）
                    }
                    let msg: Value = serde_json::from_str(line)
                        .map_err(|e| LumenError::Protocol(format!("RPC 帧解析失败: {}", e)))?;
                    // 通知（无 id）与异 id 帧都跳过；宿主自己严格校验 id。
                    if msg.get("id").and_then(Value::as_i64) != Some(id) {
                        continue;
                    }
                    if let Some(err) = msg.get("error") {
                        let message = err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("未知 RPC 错误");
                        return Err(LumenError::Command(message.to_string()));
                    }
                    return msg.get("result").cloned().ok_or_else(|| {
                        LumenError::Protocol("RPC 应答既无 result 也无 error".into())
                    });
                }
            }
        }
    }

    /// initialize（legacy，断言版本钉死）+ tools/list 缓存。
    pub fn handshake(&mut self) -> Result<(), LumenError> {
        let result = self.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": LEGACY_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "gallery-culling", "version": env!("CARGO_PKG_VERSION")},
            }),
        )?;

        let version = result
            .get("serverInfo")
            .and_then(|s| s.get("version"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                LumenError::Protocol("initialize 应答缺少 serverInfo.version".to_string())
            })?
            .to_string();
        if version != PINNED_LUMEN_VERSION {
            return Err(LumenError::Protocol(format!(
                "LUMEN RAW 版本不匹配（需要 {}，实际 {}）",
                PINNED_LUMEN_VERSION, version
            )));
        }

        let tools = self.request("tools/list", serde_json::json!({}))?;
        let list = tools
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| LumenError::Protocol("tools/list 应答缺少 tools 数组".into()))?
            .clone();

        self.server_version = Some(version);
        self.tools = Some(list);
        Ok(())
    }

    /// tools/call：双错误通道（JSON-RPC error 与 result.isError）。
    pub fn call_tool(&mut self, name: &str, args: &Value) -> Result<Value, LumenError> {
        let result = self.request(
            "tools/call",
            serde_json::json!({"name": name, "arguments": args}),
        )?;
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            // 业务错误：content[].text 即 str(exc)（mcp.py:185）
            let text = result
                .get("content")
                .and_then(Value::as_array)
                .and_then(|blocks| {
                    blocks
                        .iter()
                        .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                        .cloned()
                })
                .and_then(|b| b.get("text").cloned())
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "LUMEN RAW 工具调用失败".to_string());
            return Err(LumenError::Command(text));
        }
        // 成功：解析 text 块中的 JSON（比 structuredContent 更省事，mcp.py:193）
        result
            .get("content")
            .and_then(Value::as_array)
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            })
            .and_then(|b| b.get("text"))
            .and_then(Value::as_str)
            .ok_or_else(|| LumenError::Protocol("tools/call 应答缺少 text 内容块".into()))
            .and_then(|text| {
                serde_json::from_str(text)
                    .map_err(|e| LumenError::Protocol(format!("工具结果 JSON 解析失败: {}", e)))
            })
    }

    /// 服务器版本（握手成功后有值）。
    pub fn server_version(&self) -> Option<&str> {
        self.server_version.as_deref()
    }

    /// 测试专用：取出传输层以断言发出的行。
    #[cfg(test)]
    pub(crate) fn transport_ref_for_test(&self) -> &T {
        &self.transport
    }

    /// 测试专用：tools/list 缓存数量。
    #[cfg(test)]
    pub(crate) fn tools_len_for_test(&self) -> usize {
        self.tools.as_ref().map(|t| t.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;
    use super::*;
    use crate::lumen::*;
    use super::super::next_backoff;

// ---- Step 3: scripted 传输层 + MCP 客户端 ----

/// 测试用传输层：预写应答队列，记录发出的行；读空 → 模拟超时。
struct ScriptedTransport {
    incoming: StdMutex<VecDeque<String>>,
    outgoing: StdMutex<Vec<String>>,
}

impl ScriptedTransport {
    fn new(script: Vec<&str>) -> Self {
        Self {
            incoming: StdMutex::new(script.into_iter().map(String::from).collect()),
            outgoing: StdMutex::new(Vec::new()),
        }
    }
    fn sent(&self) -> Vec<String> {
        self.outgoing.lock().unwrap().clone()
    }
}

impl LineTransport for ScriptedTransport {
    fn write_line(&self, line: &str) -> Result<(), LumenError> {
        self.outgoing.lock().unwrap().push(line.to_string());
        Ok(())
    }
    fn read_line(&self, _timeout: std::time::Duration) -> Result<Option<String>, LumenError> {
        Ok(self.incoming.lock().unwrap().pop_front())
    }
}

#[test]
fn rpc_encode_single_line_compact() {
    let line = rpc_encode("initialize", &serde_json::json!({"a":1}), 7);
    assert!(line.ends_with('\n'), "必须带行尾换行");
    assert_eq!(line.matches('\n').count(), 1, "必须单行");
    // 键序无关（JSON-RPC 语义；serde_json Map 为字母序）→ 语义相等 + 无空格紧凑
    let parsed: Value = serde_json::from_str(&line).expect("必须是合法 JSON");
    assert_eq!(
        parsed,
        serde_json::json!({"jsonrpc":"2.0","id":7,"method":"initialize","params":{"a":1}})
    );
    assert!(!line.contains(": "), "紧凑序列化不得含空格: {}", line);
    assert!(line.contains(r#""jsonrpc":"2.0""#));
    assert!(line.contains(r#""id":7"#));
}

#[test]
fn request_matches_id_skips_noise() {
    let t = ScriptedTransport::new(vec![
        r#"{"jsonrpc":"2.0","method":"notification"}"#, // 通知：无 id → 跳过
        r#"{"jsonrpc":"2.0","id":99,"result":{"wrong":true}}"#, // 异 id → 跳过
        r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#, // 匹配
        r#"{"jsonrpc":"2.0","id":2,"result":{"ok":false}}"#, // 后续帧不被消费
    ]);
    let mut client = McpClient::new(t);
    let got = client
        .request("ping", serde_json::json!({}))
        .expect("应拿到 id=1 应答");
    assert_eq!(got, serde_json::json!({"ok": true}));

    let sent = client.transport_ref_for_test().sent();
    assert!(sent[0].contains(r#""method":"ping""#));
}

#[test]
fn request_timeout_when_silent() {
    let t = ScriptedTransport::new(vec![]); // 读空 = 超时语义
    let mut client = McpClient::new(t);
    let err = client
        .request("ping", serde_json::json!({}))
        .expect_err("无应答应超时");
    assert!(matches!(err, LumenError::Timeout), "实际: {:?}", err);
}

#[test]
fn request_error_frame_maps_to_command() {
    let t = ScriptedTransport::new(vec![
        r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#,
    ]);
    let mut client = McpClient::new(t);
    let err = client
        .request("bogus", serde_json::json!({}))
        .expect_err("error 帧应 Err");
    match err {
        LumenError::Command(m) => assert!(m.contains("Method not found")),
        other => panic!("应 Command，实际: {:?}", other),
    }
}

#[test]
fn handshake_pins_version() {
    let t = ScriptedTransport::new(vec![
        r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"lumen-raw","version":"1.7.0"}}}"#,
    ]);
    let mut client = McpClient::new(t);
    let err = client.handshake().expect_err("版本不符应 Err");
    match err {
        LumenError::Protocol(m) => {
            assert!(
                m.contains("1.7.0") && m.contains("1.6.0"),
                "消息应含双方版本: {}",
                m
            )
        }
        other => panic!("应 Protocol，实际: {:?}", other),
    }
}

#[test]
fn handshake_success_caches_tools() {
    let t = ScriptedTransport::new(vec![
        r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"lumen-raw","version":"1.6.0"}}}"#,
        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"render_preview"},{"name":"apply_edits"}]}}"#,
    ]);
    let mut client = McpClient::new(t);
    client.handshake().expect("1.6.0 应握手成功");
    assert_eq!(client.tools_len_for_test(), 2);

    let sent = client.transport_ref_for_test().sent();
    assert!(
        sent[0].contains(r#""protocolVersion":"2024-11-05""#),
        "必须 legacy 握手: {}",
        sent[0]
    );
    assert!(
        !sent.iter().any(|l| l.contains("_meta")),
        "legacy 客户端不得发 _meta"
    );
}

#[test]
fn handshake_malformed_result_is_protocol() {
    let t = ScriptedTransport::new(vec![r#"{"jsonrpc":"2.0","id":1,"result":{"nope":1}}"#]);
    let mut client = McpClient::new(t);
    let err = client.handshake().expect_err("结构异常应 Err");
    assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
}

#[test]
fn call_tool_iserror_maps_to_command() {
    let t = ScriptedTransport::new(vec![
        r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"version":"1.6.0"}}}"#,
        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#,
        r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"unknown argument(s) for rate_photos"}],"isError":true}}"#,
    ]);
    let mut client = McpClient::new(t);
    client.handshake().unwrap();
    let err = client
        .call_tool("rate_photos", &serde_json::json!({"oops":1}))
        .expect_err("isError 应 Err");
    match err {
        LumenError::Command(m) => assert!(m.contains("unknown argument")),
        other => panic!("应 Command，实际: {:?}", other),
    }
}

#[test]
fn call_tool_success_parses_text_block() {
    let t = ScriptedTransport::new(vec![
        r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"version":"1.6.0"}}}"#,
        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#,
        r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"image","data":"x"},{"type":"text","text":"{\"path\":\"a.ARW\",\"width\":1600}"}]}}"#,
    ]);
    let mut client = McpClient::new(t);
    client.handshake().unwrap();
    let got = client
        .call_tool("render_preview", &serde_json::json!({"path":"a.ARW"}))
        .expect("成功应 Ok");
    assert_eq!(got["path"], serde_json::json!("a.ARW"));
    assert_eq!(got["width"], serde_json::json!(1600));
}

#[test]
fn call_tool_missing_text_block_is_protocol() {
    let t = ScriptedTransport::new(vec![
        r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"version":"1.6.0"}}}"#,
        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#,
        r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"image","data":"x"}]}}"#,
    ]);
    let mut client = McpClient::new(t);
    client.handshake().unwrap();
    let err = client
        .call_tool("render_preview", &serde_json::json!({}))
        .expect_err("无 text 块应 Err");
    assert!(matches!(err, LumenError::Protocol(_)), "实际: {:?}", err);
}

#[test]
fn backoff_doubles_and_caps() {
    assert_eq!(next_backoff(0), std::time::Duration::from_millis(500));
    assert_eq!(next_backoff(1), std::time::Duration::from_millis(1000));
    assert_eq!(next_backoff(2), std::time::Duration::from_millis(2000));
    assert_eq!(next_backoff(5), std::time::Duration::from_millis(8000));
    assert_eq!(next_backoff(50), std::time::Duration::from_millis(8000));
}

}
