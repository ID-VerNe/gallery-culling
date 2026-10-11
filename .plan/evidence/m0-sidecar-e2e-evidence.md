# EVIDENCE — M0：headless sidecar 构建 + E2E 打通

- **spec approval: not obtained (autonomous run)**；计划：`.plan/lumen_raw_integration_steps.md` §3/§8
- **tier**: 3（跨进程/跨语言边界 + 真实二进制分发）
- **source state**: commit `698c863`；sidecar 产物在仓库外（`lumen-sidecar/dist/lumen-cli/`），由 `.plan/patches/build_lumen_sidecar.ps1` 可复现

## 1. 实际交付（超出 Step 1-4 的纯代码，进度报告）

| 项 | 结果 |
|---|---|
| Qt 泄漏修复 | **5 处**（比 D/E 报告多 2 处）：`session.py:108`、`commands.py:549`、`commands.py:583`、**`control.py:129`（新发现，阻断整条 B 通道）** |
| 依赖 | numpy 2.5.4 / opencv-python-headless 4.14 / Pillow / rawpy 0.27 / tifffile / pyinstaller 6.22；**零 PySide6** |
| sidecar 体积 | **184MB**（onedir）—— 超 120MB 目标，Top 大头：cv2.pyd 71MB + ffmpeg 29MB + openblas 20MB。**待优化**（可去 videoio/PIL avif） |
| Qt 门禁 | `find -iname "*Qt6*" "*PySide6*"` → **0 命中** ✅ |
| 真实 RAW | Nikon D850 12bit NEF（38MB，raw.pixls.us CC0），8288×5520 解码 ✅ |
| 契约冻结 | `commands` = **27 命令 / 24 工具 / 3 无工具** —— 与 A 报告预测**逐字一致** ✅ |

## 2. E2E 结果（`--ignored --test-threads=1`，环境变量注入）

| 测试 | 结果 |
|---|---|
| `e2e_sidecar_version_matches_pin` | ok —— `LUMEN RAW 1.6.0` == 宿主钉死版本 |
| `e2e_b_channel_info_on_real_photo` | ok —— 8288×5520 NEF 经 `run_lumen` 真实往返 |
| `e2e_render_preview_produces_jpeg_and_caches` | ok —— cold=2.13s；产物 JPEG 魔数校验；缓存命中由"会 panic 的渲染器"证明未被调用 |
| `e2e_supervisor_handshakes_with_real_mcp_server` | ok —— `ensure_running` → Ready{1.6.0}；Ready 后短路 |
| `e2e_mcp_jsonrpc_over_stdio_roundtrip` | ok —— stdio JSON-RPC initialize 往返，serverInfo.version 校验 |
| `e2e_error_contract_exit1_is_command` | ok —— 不存在照片 → exit 1 → `Command` 分类 |
| `e2e_exec_and_classify_missing_exe_is_not_installed` | ok |
| `e2e_requires_sidecar_message_is_actionable` | ok —— 无 sidecar 时提示可操作 |

**默认 suite**：71 lib + 3 integration + **8 E2E（ignored，需 sidecar）** —— 零回归。

## 3. 过程中如实记录的问题

1. **新发现的第 4 处 Qt 泄漏**（`control.py:129` 模块级 `_qt()`）——静态分析（6 个子代理）全部漏判；只有真实构建 + 真实 `run` 才暴露：它让 `--headless` 也 import 失败，**整条 B 通道不可用**。已加进 `apply_slim_patch.py` 并复验。
2. **补丁脚本幂等性 bug**：batch_export 的跳过判断引用了从未插入的 marker → 第二次运行崩溃。已改为按类存在性判断。
3. **pip 内置下载器在 >12MB 文件上必断**（IncompleteRead，阿里/官方源均现）：绕过方案 = curl 下载 wheel + `pip install --no-index`。
4. sidecar 体积 184MB 超预算 —— 已知缺口（§4）。

## 4. 已知限制（honest）

- **体积 184MB > 120MB 预算**：影响 NSIS 安装包体积与 updater 全量下载；缓解路径 = 剔 videoio/avif 或改 onefile（见计划 §5 方案二）。**P2 前必须处理**。
- CPU-only sidecar：无 ORT → AI 蒙版/增强（P2）需另装 GPU flavor 或按需下载权重。
- E2E 依赖外部 sidecar，故 `#[ignore]`（无 sidecar 的机器不该红）；交付前必须 `--ignored` 实跑（本次已跑并记录）。
- 前端（Step 5）尚未接线：目前 RAW 真实预览只能通过 Tauri 命令手动调用。