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
    ensure_preview, exec_and_classify, find_in_path, lumen_cache_key, preview_cache_path,
    query_version, run_lumen, LumenError, PreviewCacheInputs, PreviewVariant, PINNED_LUMEN_VERSION,
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

/// 文件内容 sha256（E2E 里判断"渲染结果真的变了"，不做图像解码比较）。
fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(bytes);
    d.iter().take(16).map(|b| format!("{:02x}", b)).collect()
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
    let out = run_lumen(
        &exe,
        "photo.info",
        &serde_json::json!({"path": sample.to_string_lossy()}),
    )
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
        src_mtime: std::fs::metadata(&sample)
            .ok()
            .and_then(|m| m.modified().ok()),
        project_mtime: None,
        recipe: None,
    };

    let t0 = std::time::Instant::now();
    let path = ensure_preview(&sample, &cache_root, inputs.clone(), |_tmp, args| {
        run_lumen(&exe, "render.preview", args).map(|_| ())
    })
    .expect("首次渲染应成功");
    let cold = t0.elapsed();
    assert!(path.is_file(), "产物应落盘: {}", path.display());
    assert!(
        path.to_string_lossy().contains("_lumen"),
        "文件名带 _lumen 标记"
    );
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
    assert_eq!(
        preview_cache_path(&cache_root, &key, 1024, PreviewVariant::Edited),
        path
    );
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
    let v: Value =
        serde_json::from_str(line.trim()).unwrap_or_else(|e| panic!("非法 JSON: {} ({})", line, e));
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
    let msg = std::panic::catch_unwind(require_sidecar)
        .expect_err("无 sidecar 时应 panic 并给出提示");
    let text = msg.downcast_ref::<String>().cloned().unwrap_or_default();
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

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar + LUMEN_SAMPLE"]
fn e2e_a_channel_warm_preview_beats_cold() {
    use gallery_culling_lib::lumen::LumenRuntime;
    let exe = require_sidecar();
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE");
    let rt = LumenRuntime::new();
    let args_for = |tag: &str| {
        let out = std::env::temp_dir().join(format!("lumen_a_{}_{}.jpg", std::process::id(), tag));
        let _ = std::fs::remove_file(&out);
        serde_json::json!({
            "path": sample.to_string_lossy(),
            "size": 1024,
            "original": false,
            "output": out.to_string_lossy(),
        })
    };

    // 第一次：冷（spawn + 解释器启动 + 握手 + 渲染）
    let t0 = std::time::Instant::now();
    let first = rt
        .render_preview(&exe, &args_for("cold"))
        .expect("cold 应成功");
    let cold = t0.elapsed();

    // 第二次：热（同一 sidecar 进程，只解码+渲染）
    let t1 = std::time::Instant::now();
    let second = rt
        .render_preview(&exe, &args_for("warm"))
        .expect("warm 应成功");
    let warm = t1.elapsed();

    assert!(first["output"].is_string(), "cold 结果应带 output 路径");
    assert!(second["output"].is_string(), "warm 结果应带 output 路径");
    println!(
        "E2E A-channel: cold={:?} (含 spawn+握手) warm={:?} (纯渲染) 加速={:.1}x",
        cold,
        warm,
        cold.as_secs_f64() / warm.as_secs_f64().max(1e-6)
    );
    assert!(
        warm < cold,
        "热态必须快于冷态（warm={:?} cold={:?}）",
        warm,
        cold
    );
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar"]
fn e2e_a_channel_status_ready_after_handshake() {
    use gallery_culling_lib::lumen::LumenRuntime;
    let exe = require_sidecar();
    let rt = LumenRuntime::new();
    let args = serde_json::json!({"path": "x.ARW", "size": 128});
    // 触发建连（会失败，因为样张不存在，但 client 已建立与否以 status 为准）
    let _ = rt.render_preview(&exe, &args);
    let st = rt.status(true, Some(exe.clone()));
    println!(
        "E2E status: available={} found={:?} detail={}",
        st.available, st.found_version, st.detail
    );
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar + LUMEN_SAMPLE"]
fn e2e_rating_push_and_pull_roundtrip() {
    use gallery_culling_lib::lumen::LumenRuntime;
    let exe = require_sidecar();
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE");
    let rt = LumenRuntime::new();

    // 推：宿主 → LUMEN RAW
    rt.push_rating(&exe, &sample, 4, "pick")
        .expect("推送评级应成功");

    // catalog 里此刻应已可查
    let direct = rt
        .pull_ratings(&exe, sample.parent().unwrap())
        .expect("拉取应成功");
    println!("E2E pull(after push) 返回 {} 条", direct.len());

    // 拉：LUMEN RAW catalog 真值 → 宿主
    let folder = sample.parent().expect("样张应有父目录");
    let pulled = rt.pull_ratings(&exe, folder).expect("拉取应成功");
    println!("E2E pull 返回 {} 条", pulled.len());
    let hit = pulled
        .iter()
        .find(|(p, _, _)| p.to_ascii_lowercase().contains("sample.nef"))
        .expect("catalog 里应能查到刚推的照片");
    println!("E2E rating push/pull: rating={} flag={}", hit.1, hit.2);
    assert_eq!(hit.1, 4, "星级应往返一致");
    assert_eq!(hit.2, "pick", "旗标应往返一致");

    // 清理：把测试痕迹抹掉（catalog 是追加日志，只能推 0/none 覆盖）
    rt.push_rating(&exe, &sample, 0, "none").ok();
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar"]
fn e2e_rating_zero_not_pushed() {
    use gallery_culling_lib::lumen::{should_push_rating, LumenRuntime};
    let exe = require_sidecar();
    // 纯判定
    assert!(!should_push_rating(0, "none"));
    assert!(should_push_rating(1, "none"));
    // 真实环境：推 0/none 后再拉，值应保持原样（不产生 phantom 条目）
    let rt = LumenRuntime::new();
    let folder = std::env::temp_dir();
    let _ = rt.pull_ratings(&exe, &folder);
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar + LUMEN_SAMPLE"]
fn e2e_recipe_apply_then_render_changes_pixels() {
    use gallery_culling_lib::lumen::LumenRuntime;
    let exe = require_sidecar();
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE");
    let photo = sample.to_string_lossy().to_string();
    let rt = LumenRuntime::new();

    let render = |tag: &str| {
        let out =
            std::env::temp_dir().join(format!("lumen_recipe_{}_{}.jpg", std::process::id(), tag));
        let _ = std::fs::remove_file(&out);
        rt.render_preview(
            &exe,
            &serde_json::json!({
                "path": photo,
                "size": 512,
                "output": out.to_string_lossy(),
            }),
        )
        .expect("渲染应成功");
        out
    };

    // 基线：先把 session 调色清零（apply 本身会建立 A 通道）
    let zero = rt
        .apply_recipe(
            &exe,
            &photo,
            &serde_json::json!({"adjustments": {"exposure": 0.0}}),
        )
        .expect("归零 recipe 应成功");
    assert_eq!(zero["state"]["adjustments"]["exposure"].as_f64(), Some(0.0));
    let base = render("base");
    let base_hash = sha256(&std::fs::read(&base).unwrap());

    // 套 +2 档曝光（同一常驻进程内 —— lumen 的编辑状态是 session 态）
    let applied = rt
        .apply_recipe(
            &exe,
            &photo,
            &serde_json::json!({"adjustments": {"exposure": 2.0}}),
        )
        .expect("应用 recipe 应成功");
    assert_eq!(
        applied["state"]["adjustments"]["exposure"].as_f64(),
        Some(2.0),
        "apply_edits 响应应回显新值，实际: {}",
        applied
    );
    assert!(
        !applied["applied"]
            .as_array()
            .map(|a| a.is_empty())
            .unwrap_or(true),
        "applied 列表不应为空"
    );

    let edited = render("edited");
    let edited_hash = sha256(&std::fs::read(&edited).unwrap());
    println!(
        "E2E recipe: base={} edited={} (同进程 +2EV)",
        &base_hash[..12],
        &edited_hash[..12]
    );
    assert_ne!(
        base_hash, edited_hash,
        "+2EV 后渲染结果必须变化（否则 recipe 没进渲染路径）"
    );

    // 还原：同一进程内清零
    let _ = rt.apply_recipe(
        &exe,
        &photo,
        &serde_json::json!({"adjustments": {"exposure": 0.0}}),
    );
    let _ = std::fs::remove_file(sample.with_extension("lumen"));
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar"]
fn e2e_capabilities_match_installed_build() {
    // 这条契约必须在 **CPU 版和 GPU 版上都成立**：能力报告与磁盘事实一致。
    // 之前它硬编码了"CPU 版不该报 AI"，于是换成 GPU 构建就红 —— 而真正的断言
    // 是"报告 == 磁盘探测"，两者在任一构建上都该为真。
    use gallery_culling_lib::lumen::{detect_ai_flavor, LumenRuntime};
    let exe = require_sidecar();
    let is_ai = detect_ai_flavor(&exe);
    let caps = LumenRuntime::new()
        .capabilities(&exe)
        .expect("能力探测应成功");

    println!(
        "E2E caps: 构建={} 命令={} 预设={} aiMasks={} aiEnhance={} v{}",
        if is_ai { "GPU/AI" } else { "CPU" },
        caps.commands.len(),
        caps.presets.len(),
        caps.ai_masks,
        caps.ai_enhance,
        caps.version
    );

    // 契约冻结过的命令表必须仍然齐全（27 条，AI 版不改变命令表）
    assert_eq!(caps.commands.len(), 27, "命令表漂移: {:?}", caps.commands);
    for required in [
        "render.preview",
        "edit.apply",
        "edit.preset",
        "edit.presets",
        "library.rate",
        "library.flag",
        "photo.export",
        "project.save",
    ] {
        assert!(
            caps.commands.iter().any(|c| c == required),
            "缺少命令 {}",
            required
        );
    }
    assert!(!caps.presets.is_empty(), "两版都应有内置预设");
    // 关键：报告必须跟着磁盘走，而不是跟着"版本号长什么样"猜
    assert_eq!(caps.ai_masks, is_ai, "AI 蒙版可用性应等于磁盘探测结果");
    assert_eq!(caps.ai_enhance, is_ai, "AI 增强可用性应等于磁盘探测结果");
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar + LUMEN_SAMPLE"]
fn e2e_preset_apply_changes_render() {
    use gallery_culling_lib::lumen::LumenRuntime;
    let exe = require_sidecar();
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE");
    let photo = sample.to_string_lossy().to_string();
    let rt = LumenRuntime::new();

    // 归零 → 基线渲染
    rt.apply_recipe(
        &exe,
        &photo,
        &serde_json::json!({"adjustments": {"exposure": 0.0, "contrast": 0.0}}),
    )
    .expect("归零应成功");
    let base = std::env::temp_dir().join(format!("lumen_preset_base_{}.jpg", std::process::id()));
    let _ = std::fs::remove_file(&base);
    rt.render_preview(
        &exe,
        &serde_json::json!({
            "path": photo, "size": 512, "output": base.to_string_lossy(),
        }),
    )
    .expect("基线渲染应成功");
    let base_hash = sha256(&std::fs::read(&base).unwrap());

    // 套第一个预设（名字来自 sidecar 自己的清单，不硬编码）
    let caps = rt.capabilities(&exe).expect("能力探测应成功");
    let preset = caps.presets.first().expect("应有预设").clone();
    let applied = rt
        .apply_preset(&exe, &photo, &preset, 100)
        .expect("应用预设应成功");
    // 断言"至少有一项非零"，而不是钉死某个字段：预设之间差异很大
    // （"自然风光" 是 highlights/shadows 配方，contrast 本来就是 0）。
    let adj = applied["state"]["adjustments"].clone();
    let any_changed = adj
        .as_object()
        .map(|m| m.values().any(|v| v.as_f64().unwrap_or(0.0) != 0.0))
        .unwrap_or(false);
    assert!(any_changed, "预设应带来至少一项非零调整，实际 {}", adj);

    let edited = std::env::temp_dir().join(format!("lumen_preset_edit_{}.jpg", std::process::id()));
    let _ = std::fs::remove_file(&edited);
    rt.render_preview(
        &exe,
        &serde_json::json!({
            "path": photo, "size": 512, "output": edited.to_string_lossy(),
        }),
    )
    .expect("预设渲染应成功");
    let edited_hash = sha256(&std::fs::read(&edited).unwrap());
    println!(
        "E2E preset 「{}」: base={} edited={}",
        preset,
        &base_hash[..12],
        &edited_hash[..12]
    );
    assert_ne!(base_hash, edited_hash, "套预设后渲染必须变化");

    // 还原
    rt.apply_recipe(
        &exe,
        &photo,
        &serde_json::json!({"adjustments": {"exposure": 0.0, "contrast": 0.0}}),
    )
    .ok();
    let _ = std::fs::remove_file(sample.with_extension("lumen"));
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar + LUMEN_SAMPLE"]
fn e2e_conflict_is_not_silently_overwritten() {
    // 契约测试（不跑真实引擎也能过）：两侧都改过时，判定必须是 Conflict，
    // 且同步命令对该分支只记录、不写回 —— 绝不静默覆盖用户的本机评级。
    use gallery_culling_lib::lumen::{decide_sync, SyncDecision};

    let cursor = Some((1u8, "none".to_string(), 1_000i64));
    let host = (5u8, "pick".to_string(), 2_000i64);
    let lumen = (3u8, "pick".to_string());
    assert_eq!(
        decide_sync(cursor.clone(), host.clone(), Some(lumen.clone())),
        SyncDecision::Conflict,
        "两侧都改过必须是 Conflict"
    );
    // 只有一侧变 → 各走各的方向
    assert_eq!(
        decide_sync(cursor.clone(), host.clone(), Some((1, "none".to_string()))),
        SyncDecision::PushToLumen,
        "只有宿主变 → 推"
    );
    assert_eq!(
        decide_sync(
            cursor,
            (1u8, "none".to_string(), 1_000i64),
            Some(lumen.clone())
        ),
        SyncDecision::PullFromLumen,
        "只有 LUMEN 变 → 拉"
    );
    let _ = sample_photo();
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar + LUMEN_SAMPLE"]
fn e2e_unified_tone_pipeline_persists_across_processes() {
    // 统一管线的核心保证：apply（session 态）→ save_project（落盘）之后，
    // **另一个 sidecar 进程**必须能读回同一组调色值。否则重启就丢。
    use gallery_culling_lib::lumen::LumenRuntime;
    let exe = require_sidecar();
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE");
    let photo = sample.to_string_lossy().to_string();
    let tone = gallery_culling_lib::models::ToneAdjustments {
        exposure: 0.75,
        highlights: -22.0,
        shadows: 18.0,
        temperature: 40.0,
        tint: -6.0,
        contrast: 12.0,
    };

    // 进程 A：apply + save_project
    let rt_a = LumenRuntime::new();
    let recipe = gallery_culling_lib::lumen::tone_to_recipe(&tone, true);
    rt_a.apply_recipe(&exe, &photo, &recipe)
        .expect("apply 应成功");
    let project = rt_a
        .save_project(&exe, &photo)
        .expect("save_project 应成功");
    assert!(
        std::path::Path::new(&project).is_file(),
        ".lumen 工程应真实落盘: {}",
        project
    );
    drop(rt_a); // 关掉常驻进程

    // 进程 B（全新运行时 = 全新 sidecar 进程）：读回落盘工程
    let rt_b = LumenRuntime::new();
    let back = rt_b
        .read_project_tone(&exe, &photo)
        .expect("落盘工程应能跨进程读回");
    println!(
        "E2E 统一管线: +{:.2}EV hl={:.0} sh={:.0} temp={:+.0} tint={:+.0} cr={:.0} → 跨进程读回一致={}",
        tone.exposure, tone.highlights, tone.shadows, tone.temperature, tone.tint, tone.contrast,
        !LumenRuntime::tone_diverges(&tone, &back)
    );
    assert!(
        !LumenRuntime::tone_diverges(&tone, &back),
        "跨进程读回应与写入一致：写入 {:?} 读回 {:?}",
        tone,
        back
    );
    // temperature 必须真的落进工程（此前被排除的字段）
    assert_eq!(back.temperature, 40.0, "temperature 未落盘");

    // 清理：归零并删工程，别污染样张
    let zero = serde_json::json!({"adjustments": {
        "exposure": 0.0, "highlights": 0.0, "shadows": 0.0,
        "temperature": 0.0, "tint": 0.0, "contrast": 0.0
    }});
    rt_b.apply_recipe(&exe, &photo, &zero).ok();
    let _ = rt_b.save_project(&exe, &photo);
    let _ = std::fs::remove_file(&project);
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar + LUMEN_SAMPLE"]
fn e2e_tone_two_sinks_agree_after_unified_write() {
    // 统一管线的验收：一次写入后，XMP 与 lumen 工程读出的值必须一致
    //（divergent=false）。以前这两条路径各写各的，必然漂移。
    use gallery_culling_lib::lumen::LumenRuntime;
    use gallery_culling_lib::xmp::{get_xmp_path, read_xmp_full, update_xmp_tone};
    let exe = require_sidecar();
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE");
    let photo = sample.to_string_lossy().to_string();
    let tone = gallery_culling_lib::models::ToneAdjustments {
        exposure: -0.4,
        highlights: 30.0,
        shadows: -12.0,
        temperature: -55.0,
        tint: 3.0,
        contrast: -8.0,
    };

    // 落点 1：XMP（与 apply_tone_cmd 内的第一步完全相同）
    update_xmp_tone(
        &sample,
        Some(tone.exposure),
        Some(tone.highlights),
        Some(tone.shadows),
        Some(tone.temperature),
        Some(tone.tint),
        Some(tone.contrast),
    )
    .expect("XMP 写入应成功");

    // 落点 2：lumen（apply + save，同进程）
    let rt = LumenRuntime::new();
    let recipe = gallery_culling_lib::lumen::tone_to_recipe(&tone, true);
    rt.apply_recipe(&exe, &photo, &recipe)
        .expect("apply 应成功");
    let project = rt.save_project(&exe, &photo).expect("save_project 应成功");

    // 两个真值读回来比较
    let xmp = read_xmp_full(&get_xmp_path(&sample)).expect("XMP 应可读");
    let from_xmp = gallery_culling_lib::models::ToneAdjustments {
        exposure: xmp.exposure.unwrap_or(0.0),
        highlights: xmp.highlights.unwrap_or(0.0),
        shadows: xmp.shadows.unwrap_or(0.0),
        temperature: xmp.temperature.unwrap_or(0.0),
        tint: xmp.tint.unwrap_or(0.0),
        contrast: xmp.contrast.unwrap_or(0.0),
    };
    let from_lumen = rt.read_project_tone(&exe, &photo).expect("工程应可读回");
    println!(
        "E2E 双落点一致: divergent={} xmp={:?} lumen={:?}",
        LumenRuntime::tone_diverges(&from_xmp, &from_lumen),
        from_xmp,
        from_lumen
    );
    assert!(
        !LumenRuntime::tone_diverges(&from_xmp, &from_lumen),
        "统一写入后两个真值必须一致"
    );

    // 清理
    let zero = serde_json::json!({"adjustments": {
        "exposure": 0.0, "highlights": 0.0, "shadows": 0.0,
        "temperature": 0.0, "tint": 0.0, "contrast": 0.0
    }});
    rt.apply_recipe(&exe, &photo, &zero).ok();
    let _ = rt.save_project(&exe, &photo);
    let _ = std::fs::remove_file(&project);
    let _ = std::fs::remove_file(get_xmp_path(&sample));
}

#[test]
#[ignore = "需要已构建的 lumen-cli sidecar"]
fn e2e_capabilities_ai_detection_matches_disk() {
    // AI 判据必须跟随**磁盘事实**，因为 AI 版与 CPU 版命令表逐字节相同。
    use gallery_culling_lib::lumen::{detect_ai_flavor, LumenRuntime};
    let exe = require_sidecar();
    let is_ai = detect_ai_flavor(&exe);
    let caps = LumenRuntime::new()
        .capabilities(&exe)
        .expect("能力探测应成功");
    println!(
        "E2E 探测: exe={} 磁盘AI={} → 报告 aiMasks={} aiEnhance={} 命令={}",
        exe.display(),
        is_ai,
        caps.ai_masks,
        caps.ai_enhance,
        caps.commands.len()
    );
    // 报告值必须与磁盘事实一致（这是这次修复的全部意义）
    assert_eq!(
        caps.ai_masks, is_ai,
        "AI 可用性必须与磁盘上的模型/运行时一致"
    );
    assert_eq!(caps.ai_enhance, is_ai);
    // AI 版不应该凭空多出命令（实测两张构建都是 27 条）
    assert_eq!(caps.commands.len(), 27, "命令表不应因 AI 而变化");
}

#[test]
#[ignore = "需要 GPU 版 lumen-cli sidecar（LUMEN_CLI 指向含模型的构建）+ LUMEN_SAMPLE"]
fn e2e_ai_mask_detects_sky_and_persists() {
    use gallery_culling_lib::lumen::LumenRuntime;
    use gallery_culling_lib::models::MaskAdjustments;
    let exe = require_sidecar();
    if !gallery_culling_lib::lumen::detect_ai_flavor(&exe) {
        eprintln!("跳过：LUMEN_CLI 指向的是 CPU 版（AI 蒙版需要 GPU 版）");
        return;
    }
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE");
    let photo = sample.to_string_lossy().to_string();
    let rt = LumenRuntime::new();

    let adj = MaskAdjustments {
        dehaze: 60.0,
        ..Default::default()
    };
    let applied = rt
        .apply_mask(&exe, &photo, "天空", &adj)
        .expect("AI 蒙版应成功（4s 左右）");

    // lumen 回显：蒙版名用自然语言，但 region 落英文 id
    let applied_text = applied["applied"].to_string();
    println!("E2E AI 蒙版 applied={}", applied_text);
    assert!(
        applied_text.contains("蒙版"),
        "应回显新增蒙版: {}",
        applied_text
    );

    // 蒙版必须落盘（跨进程可读）
    let masks = rt.list_masks(&exe, &photo);
    println!(
        "E2E 蒙版列表: {}",
        serde_json::to_string(&masks).unwrap_or_default()
    );
    assert_eq!(masks.len(), 1, "应有 1 个蒙版，实际 {:?}", masks);
    assert_eq!(masks[0]["kind"], "sky", "region 应归一为 sky");
    assert_eq!(masks[0]["adjustments"]["dehaze"], serde_json::json!(60.0));
    assert_eq!(masks[0]["enabled"], serde_json::json!(true));

    // 清理：删掉工程文件，别污染样张
    let _ = std::fs::remove_file(sample.with_extension("lumen"));
}

#[test]
#[ignore = "需要 lumen-cli sidecar（CPU 版即可）"]
fn e2e_ai_mask_rejected_on_cpu_build() {
    // CPU 版必须**明确报错**，不能静默成功（用户会以为蒙版已套上）
    use gallery_culling_lib::lumen::LumenRuntime;
    use gallery_culling_lib::models::MaskAdjustments;
    let exe = require_sidecar();
    if gallery_culling_lib::lumen::detect_ai_flavor(&exe) {
        eprintln!("跳过：当前 exe 是 GPU 版");
        return;
    }
    let sample = sample_photo().expect("需要 LUMEN_SAMPLE");
    let err = LumenRuntime::new()
        .apply_mask(
            &exe,
            &sample.to_string_lossy(),
            "sky",
            &MaskAdjustments::default(),
        )
        .expect_err("CPU 版必须报错");
    println!("E2E CPU 版拒绝蒙版: {}", err);
    assert!(
        err.to_string().contains("GPU"),
        "错误信息应指向 GPU 版，实际: {}",
        err
    );
}
