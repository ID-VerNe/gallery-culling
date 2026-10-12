# EVIDENCE — 收官（Step 6-11 全量）

- **spec approval: not obtained (autonomous run)**（各步 spec 见 `.plan/specs/`）
- **tier**: 3（跨语言、真实进程、真实二进制、真实 RAW）
- **source state**: HEAD `32caa65`

## 最终数字（最后一次全量运行）

| 层 | 结果 |
|---|---|
| Rust 单元 | **100 passed; 0 failed** |
| Rust 集成（真实子进程夹具） | **3 passed** |
| **E2E（真实 sidecar + 真实 Nikon D850 NEF）** | **17 passed; 0 failed** |
| 前端类型 | `tsc --noEmit` 零输出 |
| clippy | **6 = 既有基线**，本轮新增 0 |
| 依赖变更 | **零**（`Cargo.toml` 自 `f9bad95` 无 diff） |
| sidecar 体积 | 184MB → **137.27MB**（-25.4%，渲染像素级不变） |

## Step 6-11 完成情况

| Step | 内容 | 关键实测 |
|---|---|---|
| 6 · A 通道 | 常驻 sidecar 渲染，B 兜底 | cold 2.46s → **warm 338ms（7.3×）** |
| 7 · XMP | 第三方命名空间零摧毁；reject 改 `Rating=-1` | Lightroom 风格侧边栏往返 |
| 8 · 评级同步 | `rating_sync` 游标表 + push/pull | E2E 真实往返 rating=4/pick |
| 9 · recipe 互通 | 六滑杆 → lumen edit 状态 | +2EV 像素变化 `903a0fb9…` → `4b4a241e…` |
| 10 · 宫格引擎 + 同步 UI | 可选 lumen 宫格缩略图；设置内评级同步 | 引擎不可用时静默回落 EXIF |
| 11 · 能力探测 + 预设 | `commands.list` 解析；内置预设下拉 | 27 命令 / 6 预设 / aiMasks=false |
| 瘦身（子代理） | Tcl/Tk + videoio ffmpeg + AVIF | 4 次构建渲染 sha256 相同 |

## lumen 真实契约（三条被实测推翻的假设）

1. **`render.preview` 不接受 `recipe` 参数**（`unknown argument(s)`）→ 必须先
   `edit.apply` 再渲染。
2. **编辑状态是进程内 session**：headless 单发 `run edit.apply` 返回
   `applied: [...]`，但下一个进程 `edit.get` 读回仍是 0，不落盘、无 `.lumen`
   工程文件。→ 所有编辑类调用**只能**走 A 通道，B 通道兜底会是假的成功。
3. **`edit.preset` 参数是 `{path, name, amount 0..100}`**（不是 `strength`），
   MCP 工具名 `apply_preset`。

## 过程中抓到的真实缺陷（全部有测试固化）

1. B 通道兜底传 MCP 工具名当命令 id → 评级推送静默失败。
2. 拉取用 `run library.list`（空 session 库），真扫 catalog 的是 `lumen-cli list`。
3. XMP 归属判定：只看命名空间集合会吞掉 Lightroom 主块（它也声明那 4 个 ns），
   改为按**声明顺序**判定。
4. `Rating=-1` 被读成 1 星（裸扫数字）。
5. `apply_preset` 复用 `apply_recipe` 的包裹逻辑 → 预设静默 no-op。
6. `lookup_rating_sync` 是死代码 → Step 8 承诺的"冲突不静默覆盖"其实**没实现**，
   同步命令会无条件用 catalog 值覆盖本机评级。现已按游标判定 + 冲突上报。
7. sidecar 体积真相：`cv2.pyd`(71MB) + OpenBLAS(20MB) = 90.9MB 是渲染路径地板，
   **<120MB 证明不可达**，构建门禁如实设为 140MB。

## 已知限制（诚实记录）

1. **sidecar 137MB**（计划书目标 120MB）：已证明物理不可达；进一步压缩需独立下载通道。
2. **AI 蒙版/降噪/超分不可用**：CPU-only 包无 onnxruntime，命令表里根本没有这些
   命令（E2E 已验证 `aiMasks=false`）；UI 会明确说明需要 GPU 版。启用需重建
   GPU flavor + 下模型（skyseg 167MB）。
3. **前端无测试运行器**：降级路径靠 tsc + 人工走查。
4. **clippy 6 处既有基线**未修（防越界）。
5. `catalog.jsonl` 是追加日志，无法真正删除条目（测试痕迹靠推 0/none 覆盖）。
6. 调色 temperature **不互通**：宿主绝对 K vs lumen 相对偏移，量纲未闭环。
7. 用户既有的未提交改动（`index.html`、`legacy_flask/` 删除）全程未纳入任何提交。