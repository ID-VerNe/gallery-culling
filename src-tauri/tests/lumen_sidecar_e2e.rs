//! E2E：宿主生产代码 × 真实 lumen-cli sidecar。
//!
//! 门禁：需要已构建的 sidecar。运行方式：
//! ```powershell
//! $env:LUMEN_CLI = "C:\...\lumen-cli.exe"
//! $env:LUMEN_SAMPLE = "C:\...\sample.nef"        # 可选：真实 RAW 样张
//! cargo test --manifest-path src-tauri/Cargo.toml --test lumen_sidecar_e2e -- --ignored --nocapture
//! ```
//!
//! 默认 `#[ignore]`（无 sidecar 的机器不该红）；CI/交付前用 `--ignored` 显式运行（本次已实跑）。

use std::path::{Path, PathBuf};
use std::time::Duration;

use gallery_culling_lib::lumen::{
    ensure_preview, exec_and_classify, find_in_path, preview_cache_path, query_version,
    run_lumen, lumen_cache_key, LumenError, PreviewCacheInputs, PreviewVariant,
    PINNED_LUMEN_VERSION,
};
use serde_json::Value;

fn sidecar() -> Option<PathBuf> {
    // 优先环境变量；否则回落到 PATH 里的 lumen-cli
    std::env::var_os("LUMEN_CLI")
        .map(PathBuf::from)
        .or_else(|| find_in_path("lumen-cli"))
}

fn require_sidecar() -> PathBuf {
    sidecar().unwrap_or_else(|| {
        panic!(
            "E2E 需要已构建的 sidecar：设置 LUMEN_CLI=<lumen-cli.exe 路径>，\
             或把它放进 PATH。构建见 .plan/lumen_raw_integration_steps.md §8。"
        )
    })
}

fn sample_photo() -> Option<PathBuf> {
    std::env::var_os("LUMEN_SAMPLE").map(PathBuf::from)
}

fn temp_cache(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lumen_e2e_{}_{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar（设置 LUMEN_CLI 后用 --ignored 运行）"]
fn e2e_sidecar_version_matches_pin() {
    let exe = require_sidecar();
    let version = query_version(&exe)
        .unwrap_or_else(|| panic!("--version 应成功（sidecar: {}）", exe.display()));
    assert_eq!(
        version, PINNED_LUMEN_VERSION,
        "sidecar 版本必须与宿主钉死版本一致（协议漂移保护）"
    );
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar"]
fn e2e_b_channel_info_on_real_photo() {
    let exe = require_sidecar();
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE=<真实照片路径>");
    // photo.info 是 read_only 命令（B 通道最轻的真实往返）
    let out = run_lumen(&exe, "photo.info", &serde_json::json!({"path": sample.to_string_lossy()}))
        .expect("photo.info 应成功");
    assert!(out["width"].as_u64().unwrap_or(0) > 0, "应有宽度: {}", out);
    assert!(out["height"].as_u64().unwrap_or(0) > 0, "应有高度: {}", out);
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar + LUMEN_SAMPLE"]
fn e2e_render_preview_produces_jpeg_and_caches() {
    let exe = require_sidecar();
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE");
    let cache_root = temp_cache("preview");
    let inputs = PreviewCacheInputs {
        width: 1024,
        variant: PreviewVariant::Edited,
        lumen_version: PINNED_LUMEN_VERSION,
        src_mtime: std::fs::metadata(&sample).ok().and_then(|m| m.modified().ok()),
        project_mtime: None,
    };

    let t0 = std::time::Instant::now();
    let path = ensure_preview(&sample, &cache_root, inputs, |_tmp, args| {
        run_lumen(&exe, "render.preview", args).map(|_| ())
    })
    .expect("首次渲染应成功");
    let cold = t0.elapsed();
    assert!(path.is_file(), "产物应落盘: {}", path.display());
    assert!(path.to_string_lossy().contains("_lumen"), "文件名带 _lumen 标记");
    assert!(path.to_string_lossy().ends_with(".jpg"), "应为 jpg");

    // 真的是 JPEG（魔数 FF D8 FF）
    let head = std::fs::read(&path).unwrap_or_default();
    assert_eq!(&head[..3], &[0xFF, 0xD8, 0xFF], "应为合法 JPEG 头");

    // 二次调用命中缓存（renderer 不会被调用 → 用会 panic 的闭包证明）
    let key = lumen_cache_key(
        &sample,
        inputs.width,
        inputs.variant,
        inputs.lumen_version,
        inputs.src_mtime,
        inputs.project_mtime,
    );
    assert_eq!(preview_cache_path(&cache_root, &key, 1024, PreviewVariant::Edited), path);
    let again = ensure_preview(&sample, &cache_root, inputs, |_tmp, _args| {
        panic!("缓存命中时绝不能调用渲染边界")
    })
    .expect("缓存命中应直接返回");
    assert_eq!(again, path);

    println!(
        "E2E: cold={:?} (含 Python 冷启动), 1024px 真实 RAW 渲染+缓存命中 OK",
        cold
    );
    let _ = std::fs::remove_dir_all(&cache_root);
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar"]
fn e2e_supervisor_handshakes_with_real_mcp_server() {
    let exe = require_sidecar();
    let mut sup = gallery_culling_lib::lumen::Supervisor::default();
    let version = sup
        .ensure_running(&exe)
        .unwrap_or_else(|e| panic!("真实 MCP 握手应成功: {:?}", e));
    assert_eq!(version, PINNED_LUMEN_VERSION);
    assert!(matches!(
        sup.state(),
        gallery_culling_lib::lumen::SupervisorState::Ready { .. }
    ));
    // Ready 后短路
    assert_eq!(sup.ensure_running(Path::new("nope.exe")).unwrap(), version);
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar"]
fn e2e_error_contract_exit1_is_command() {
    let exe = require_sidecar();
    // 不存在的照片 → exit 1 + `lumen-cli: ` 前缀 → Command 分类
    let err = run_lumen(
        &exe,
        "photo.info",
        &serde_json::json!({"path": "Z:/definitely/missing.ARW"}),
    )
    .expect_err("不存在的照片必须失败");
    match err {
        LumenError::Command(m) => assert!(!m.trim().is_empty(), "错误消息不应为空"),
        other => panic!("应分类为 Command，实际: {:?}", other),
    }
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar"]
fn e2e_mcp_jsonrpc_over_stdio_roundtrip() {
    // 直接验证 Step 3 的协议编解码与真实 sidecar 对得上（不经宿主 client）
    let exe = require_sidecar();
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["mcp", "--headless"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().expect("mcp 应可 spawn");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().unwrap();
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}\n")
            .unwrap();
        stdin.flush().unwrap();
    }
    use std::io::BufRead;
    let stdout = child.stdout.take().unwrap();
    let mut reader = std::io::BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).expect("应读到一行");
    let v: Value = serde_json::from_str(line.trim()).unwrap_or_else(|e| panic!("非法 JSON: {} ({})", line, e));
    assert_eq!(v["id"], 1);
    assert_eq!(v["result"]["serverInfo"]["version"], PINNED_LUMEN_VERSION);
    drop(child.stdin.take());
    let _ = child.wait();
}

#[test]
#[ignore = "内部：确认 E2E 在缺少 sidecar 时给出可读提示"]
fn e2e_requires_sidecar_message_is_actionable() {
    if sidecar().is_some() {
        return; // 环境已配置，跳过断言（非测试目标）
    }
    let msg = std::panic::catch_unwind(|| require_sidecar())
        .expect_err("无 sidecar 时应 panic 并给出提示");
    let text = msg
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_default();
    assert!(text.contains("LUMEN_CLI"), "提示应指明如何配置: {}", text);
}

#[test]
#[ignore = "内部：exec_and_classify 对真实 sidecar 的非零退出处理"]
fn e2e_exec_and_classify_missing_exe_is_not_installed() {
    let mut cmd = std::process::Command::new("Z:/nope/lumen-cli-xyz.exe");
    let err = exec_and_classify(&mut cmd).expect_err("应失败");
    assert_eq!(err, LumenError::NotInstalled);
    let _ = Duration::from_secs(0);
    let _ = Path::new("").exists();
}
#[test]
#[ignore = "需要已构建的 lumen-cli sidecar"]
fn e2e_bundled_sidecar_discovery() {
    // 打包资源探测：src-tauri/binaries/lumen-cli/lumen-cli.exe（开发态路径）
    let found = gallery_culling_lib::lumen::find_lumen_cli("");
    if let Some(p) = found.clone() {
        println!("E2E: find_lumen_cli(\"\") → {}", p.display());
        let v = query_version(&p).expect("发现的 sidecar 应可执行");
        assert_eq!(v, PINNED_LUMEN_VERSION);
    } else {
        // 未安装到 PATH 且无打包资源 → None（合法降级）
        println!("E2E: find_lumen_cli(\"\") → None（本机未安装，走静默降级）");
    }
}
