# EVIDENCE — P0 收官（前端接线 + 打包 + 全量 E2E）

- **spec**: `.plan/specs/step5-frontend-p0-spec.md`；**spec approval: not obtained (autonomous run)**
- **tier**: 3（跨语言 + 真实进程 + 真实二进制）
- **source state**: HEAD `cd40b0c`

## 最终数字（最后一次代码编辑之后的全新运行）

| 层 | 命令 | 结果 |
|---|---|---|
| Rust 单元 | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | **72 passed; 0 failed** |
| Rust 集成（夹具子进程） | 同上 `--test lumen_cli_contract` | **3 passed** |
| **E2E（真实 sidecar）** | `--test lumen_sidecar_e2e -- --ignored --test-threads=1` | **9 passed; 0 failed** |
| 前端类型 | `npx tsc --noEmit` | 零输出（clean） |
| clippy | `--all-targets -D warnings` | **5 = 既有基线**（commands.rs×2、db.rs×2、scanner.rs）；本轮新增 0 |
| fmt | `cargo fmt -- --check` | 我的文件 0（未触碰 lib.rs，避免 mod 跟随波及全 crate） |
| 供应链 | `Cargo.toml` / `package.json` diff | 空 —— 零新依赖（Rust 与 TS 两侧） |

## E2E 覆盖矩阵（全部 `#[ignore]`，需 sidecar；本次实跑）

| 测试 | 验证的生产路径 |
|---|---|
| `e2e_sidecar_version_matches_pin` | 版本钉死：`LUMEN RAW 1.6.0` == `PINNED_LUMEN_VERSION` |
| `e2e_bundled_sidecar_discovery` | 打包资源探测 → `binaries\lumen-cli\lumen-cli.exe` |
| `e2e_b_channel_info_on_real_photo` | B 通道 `photo.info` 真实 NEF 往返（8288×5520） |
| `e2e_render_preview_produces_jpeg_and_caches` | `ensure_preview` 落盘 + JPEG 魔数 + **缓存命中由"会 panic 的渲染器"证明未被调用**；cold=2.09s |
| `e2e_supervisor_handshakes_with_real_mcp_server` | `Supervisor::ensure_running` → 真实 MCP initialize → `Ready{1.6.0}`；Ready 后短路 |
| `e2e_mcp_jsonrpc_over_stdio_roundtrip` | stdio JSON-RPC 帧格式与真实 sidecar 一致 |
| `e2e_error_contract_exit1_is_command` | exit 1 → `Command` 分类（不误判为协议错） |
| `e2e_exec_and_classify_missing_exe_is_not_installed` | spawn 失败 → `NotInstalled` |
| `e2e_requires_sidecar_message_is_actionable` | 缺 sidecar 时提示可操作（指明 `LUMEN_CLI`） |

## P0 用户可感知验收

1. ✅ RAW 检视大图显示**真实 16-bit LibRaw 解码 + 显影**（今天是把 RAW 字节喂 `<img>`，必裂）
2. ✅ 命中磁盘缓存时零进程调用、零 RPC
3. ✅ lumen 渲染成功时 CSS filter 强制 `none`（防二次显影）
4. ✅ `onError` / `previewPath=null` / 引擎不可用 → 静默回退旧路径，零报错弹窗
5. ✅ `lumenEnabled=false` 时**零 invoke**（hook 层保证）
6. ✅ sidecar 随包分发 + 运行时自动发现；git 不含二进制

## 已知限制（如实记录）

1. **sidecar 184MB > 120MB 预算**：cv2.pyd 71MB + ffmpeg 29MB + openblas 20MB 是大头。NSIS 安装包会随之变大（updater 全量下载）。缓解路径：剔 videoio/avif 插件（预计 -30MB）或改 onefile。**P1 前必须处理**。
2. **CPU-only sidecar**：无 onnxruntime → AI 蒙版/增强（P2）需另装 GPU flavor 或按需下载权重。
3. **前端无测试运行器**（无 vitest）：降级路径靠 tsc + 人工走查（spec 已声明）。
4. **A 通道尚未接管预览主循环**：当前 `lumen_preview_cmd` 走 B 通道（单发，每张约 2.1s 含冷启动）；Step 3/4 的常驻 MCP 客户端已就绪并通过真实握手 E2E，但**尚未接入渲染路径** —— 这是下一步（性能从 2.1s/张降到热态 <0.5s）。
5. clippy 5 处 / fmt 6 处既有基线债务未修（防越界）。
6. Windows-only 假设（产品定位）。