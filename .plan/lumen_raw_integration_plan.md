# LUMEN RAW 集成实施计划（lumen-raw → Gallery Culling）

- **日期**: 2026-10-11
- **宿主**: gallery-flask（Gallery Culling）— Tauri 2.0 + Rust + React 19 + TypeScript 选片应用，MIT
- **客体**: lumen-raw 1.6.0（commit `43b4ebe2a84284098523219d597873a52197a1b7`）— Python/PySide6 非破坏性 RAW 编辑器，MIT
- **依据**: glue-engineer Deep Mode 源码级分析（`.glue/deep/`：架构报告 33 条证据、comparison、integration-plan.md）
- **目标**: 把 lumen-raw 的 RAW 解码 / 调色 pipeline / 评级能力接入选片应用，实现"RAW 真预览 + 调色互通 + 评级双向同步"，远期接入 AI 增强与镜头校正。

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 可行性 | ✅ 可行（deep-compare 评分 0.89，coverage 0.83，confidence 0.85） |
| 集成模式 | **进程级 sidecar**：A（MCP stdio 常驻，主干）+ B（`lumen-cli run` 单发，重活）+ C（命名管道直连，可选） |
| 否决方案 | D. PyO3/FFI 嵌入（无绑定 + GIL + 崩溃隔离丢失 + LGPL 静链风险）；E. Rust 移植（2–3 个月到配方对齐 + 永久双维护） |
| 关键前置 | ① 打 2 行 Qt 懒导入补丁去掉 PySide6；② 修 `xmp.rs` 整文件覆盖缺陷（互通前必须） |
| 总工期预估 | P0 ≈ 1.5–2 周；P1 ≈ 1–1.5 周；P2 ≈ 2–3 周（含上游小改 + 可选下载通道） |

---

## 1. 总体架构

### 1.1 拓扑

```
React UI（PreviewViewport / 评级栏 / 调色面板）
   │  invoke()
   ▼
src/services/api.ts ── 新增: renderLumenPreview / lumenGetRecipe / lumenApplyRecipe
                              / lumenSyncRatings / lumenEnhance
   ▼
Tauri commands（src-tauri/src/commands.rs，注册进 lib.rs generate_handler!）
   ▼
src-tauri/src/lumen_bridge.rs   ← 新增，独占 sidecar 生命周期
   ├─ [A] MCP 客户端：换行分隔 JSON-RPC 2.0 常驻子进程 ──► `lumen-cli mcp`
   ├─ [B] 单发执行器：serde_json 请求 + 超时等待   ──► `lumen-cli run <cmd> <json>`
   └─ [C] 管道客户端（#[cfg(windows)]）           ──► `\\.\pipe\lumen-raw-control-<user>`
```

- `lumen_bridge.rs` 内部只有一个 API：`async fn call(tool, args) -> Result<serde_json::Value>`；
  按 MCP request `id` 多路复用；启动时做健康检查（`lumen-cli commands` 自省）+ 版本钉死校验；
  优先级镜像 lumen 自己的 dispatcher（`mcp.py:72-84`）：**C（活着的编辑器）> A（自起 sidecar）**，C 不可用时透明降级到 A。
- 渲染结果：sidecar 返回 base64 JPEG（`render_preview`，`commands.py:524-537`、`mcp.py:190-192`）→
  bridge 解码写入现有缩略图缓存目录（复用 `thumbnail.rs:10-24` 的 cache dir 逻辑，子目录 `lumen/`）→
  前端 `convertFileSrc` 照常取图（同 `api.getThumbnail` 模式）。
- sidecar 可执行文件路径进 settings（复用 `open_in_photoshop_cmd` 的配置模式，`commands.rs:84-112`），
  默认指向随包的 `lumen-cli.exe`（PyInstaller onedir 先例：`LumenRAW.spec:30-33`）。

### 1.2 三条通道的分工

| 通道 | 用途 | 特性 |
|---|---|---|
| A. MCP stdio 常驻 | 预览渲染、recipe get/apply 等**交互主循环** | 热进程，半尺寸解码 ~0.3–1s/张；约 30 个 schema 化工具运行时可得 |
| B. `lumen-cli run` 单发 | AI 增强、XMP 批量同步、导出等**低频重活** | 冷启动 0.5–1.5s + 解码；JSON stdout，出错 exit 1（`cli.py:154-157,209-221`）；Luminar roundtrip 同款先例 |
| C. 命名管道 | 用户开着完整 LUMEN RAW 时"深链直连" | 零成本待机；JSON lines `{id,command,args}→{id,ok,result|error}`（`control.py:34-49`）；**可选特性** |

---

## 2. P0 — RAW 真预览（sidecar 打通 + 网格/检视真实解码）

> 用户可感知验收：**RAW 文件在选片网格和检视大图里显示真实 16-bit 解码 + 色调映射的预览**，替换今天的"内嵌 JPEG 或直接喂原始字节 + CSS filter"方案（`PreviewViewport.tsx:132-136`）。

### 2.0 前置：sidecar 构建（P0 内的硬前置，mvp-scope 归为 P2 但依赖上必须提前）

1. **Qt 懒导入补丁（2 行）** — 在 `.plan/patches/` 下维护对钉死 commit 的 quilt 式补丁：
   - `lumen/session.py:108`：`from .lens_panel import auto_enable` → 函数内懒导入；
   - `lumen/commands.py:549`：`from . import batch_export` → 函数内懒导入。
   - 验收：装了 rawpy/numpy/opencv/onnxruntime/tifffile、**没装 PySide6** 的 venv 里
     `lumen-cli run edit.get '{"path":"<某张.ARW>"}'` 返回合法 recipe JSON。
2. **瘦身 sidecar 打包** — 基于 `LumenRAW.spec` 复制出 `LumenCLI.spec`（只留 `cli.py` 入口）：
   - onedir（非 onefile，利于差分更新）；排除 PySide6/Qt、GUI 资源、九国语言包、语音模型；
   - 包含：Python runtime、rawpy（LibRaw）、numpy、opencv-headless、tifffile、onnxruntime（DirectML flavor）、
     内嵌的 `lumen-cli`（spec:30-33 已有先例）；
   - ExifTool（P0 阶段可选：预览渲染不需要它；评级同步 P1 需要）。
   - 目标体积 **< 120 MB**；验收：`lumen-cli info` / `lumen-cli render <arw>` 在干净目录可跑。
3. **钉死版本** — sidecar 内置版本号 = lumen commit `43b4ebe`；宿主启动握手时校验（见 2.2）。

### 2.1 宿主侧新增：`src-tauri/src/lumen_bridge.rs`

```
pub struct LumenBridge { child: Option<Child>, next_id: AtomicI64, ready: RwLock<bool> }

impl LumenBridge {
    pub async fn ensure_started(&self) -> Result<()>;   // 幂等拉起 + initialize 握手 + 工具表断言
    pub async fn call(&self, tool: &str, args: Value) -> Result<Value>;  // id 多路复用 + 超时(默认 30s)
    pub async fn render_preview(&self, path: &str, width: u32, recipe: Option<Value>)
        -> Result<PathBuf>;                              // base64 → 缓存文件
    pub async fn one_shot(&self, cmd: &str, args: Value) -> Result<Value>; // Option B 通道
    fn pipe_call(&self, cmd: &str, args: Value) -> Result<Value>;          // Option C，#[cfg(windows)]
}
```

要点：
- 状态挂 `tauri::State`（同 `AppState { db }` 模式，`lib.rs:22`）；
- 所有调用跑在 `spawn_blocking`/async，**严禁同步等待**（Luminar 命令阻塞是前车之鉴，`commands.rs:279-284`）；
- sidecar 崩溃 → 标记 not ready → 宿主自动回退到现有内嵌 JPEG 路径（`thumbnail.rs:90-118`），下次调用再尝试拉起；
- 握手断言工具表包含 `render_preview`、`edit.get`、`edit.apply`、`rate_photos` 等 P0/P1 所需工具，缺任一 → 视为协议漂移，走降级。

### 2.2 宿主侧命令（`commands.rs` 新增 + `lib.rs` 注册）

| 命令 | 签名（camelCase JSON） | 说明 |
|---|---|---|
| `lumen_status_cmd` | `() -> {available, backend: "editor"|"sidecar"|"none", version}` | 前端显示集成状态；settings 里可整体开关 |
| `lumen_render_preview_cmd` | `(filePath, width, recipeJson?) -> {previewUrl, width, height, cached}` | 写入 `app_cache/lumen/`，返回 asset URL |

### 2.3 前端改动

| 文件 | 改动 |
|---|---|
| `src/services/api.ts` | 新增 `lumenStatus()` / `lumenRenderPreview()`（保持唯一 invoke 出口约定） |
| `src/components/PreviewViewport.tsx` | `:132-136` 的 RAW-bytes + CSS filter 路径改为：lumen 可用时请求渲染预览，加载中显示现有 loading 态，失败/不可用回退旧路径；`:187` 的 CSS filter 只作降级样式 |
| `src/components/ThumbnailGrid.tsx` | 可选（P0 不做）：宫格仍用 EXIF 内嵌预览（快、够用）；仅检视大图走 lumen |
| `src/App.tsx` / `SettingsModal.tsx` | 集成开关、sidecar 路径、预览尺寸（默认 1600px，对齐 lumen 的 `preview_limit`）、状态徽标 |

### 2.4 P0 验收标准

- [ ] 打开含 ARW/CR2/NEF 的文件夹，检视大图显示真实解码预览（16-bit 线性 + 显影曲线），非内嵌 JPEG；
- [ ] sidecar 整体崩溃（手动 kill）后继续浏览不报错，预览自动回退内嵌 JPEG；
- [ ] sidecar 安装包 < 120 MB，无 PySide6/Qt DLL；
- [ ] 冷启动到首张预览 < 3s，热切换 < 1s（1600px，中端机）；
- [ ] lumen 关闭（settings）时零开销，行为与今天完全一致。

---

## 3. P1 — 评级/recipe 双向互通（XMP 无损合并为闸门）

> 用户可感知验收：**在 Gallery 里打的星级/旗标，LUMEN RAW 里直接可见；在 LUMEN RAW 里调的色，Gallery 检视图能渲染出来；互相不丢数据。**

### 3.0 闸门任务：`xmp.rs` 整文件覆盖缺陷修复 ⚠️

现状：`write_xmp_full`（`xmp.rs:118-206`）用固定模板**重写整个侧边栏**，解析是裸字符串搜索（`extract_tag_value` `xmp.rs:37-60`）→ 会抹掉 lumen 写入的 `lumen:` 命名空间、Lightroom 的 develop history、关键词、GPS 等一切第三方标签。

修复方案（二选一，推荐 ①）：
1. **roxmltree DOM 合并**：读旧文件 → 保留所有非本方命名空间的 `rdf:Description` → 只替换/追加本方的 `xmp:Rating` / `xmp:Label` / `aux:*` / `exif:*` / `crs:*` 块 → 序列化回 xpacket；
2. 委托模式：侧边栏已存在时改走 `lumen-cli run xmp write`（ExifTool 合并写入，`catalog.py:417-440`），lumen 不可用时才用 ①。

验收（回归测试必须写）：
- [ ] 写星级 → 原文件中人为塞入的 `<lumen:Recipe>` / `<lr:hierarchicalSubject>` 标签 100% 存活；
- [ ] 无旧侧边栏 → 生成文件与今天模板逐字段一致（不破坏 Lightroom 兼容）；
- [ ] `xmp:Rating` / `xmp:Label` 读写与现有 `scanner.rs:367-403` 读取路径互通。

### 3.1 评级双向同步

**映射表（唯一实现处：`lumen_bridge.rs`）**：

| Gallery 侧 | lumen 侧 | XMP 落点 |
|---|---|---|
| rating 0–5 | rating 0–5 | `xmp:Rating` |
| flag `pick` | flag `pick` | `xmp:Label = Green`（Gallery 现约定 `xmp.rs:213-217`） |
| flag `reject` | flag `reject` | `xmp:Rating = -1`（Lightroom 约定，`catalog.py:425`；lumen 的 Label 语义按其源码对齐） |
| flag `none` | rating>0, flag none | `xmp:Rating` 保留，Label 空 |

**命令**：
- `lumen_sync_ratings_cmd (folder, direction) -> {imported, exported, conflicts}`：
  - export：Gallery SQLite/会话内的新评级 → 逐张 `lumen-cli run rate/flag`（写 catalog.jsonl + XMP，lumen 侧天然有日志）；
  - import：扫目录侧边栏（`xmp read` 或 roxmltree 直读）→ 合并进 Gallery 的 XMP 读取流（`scanner.rs:367-403` 已有读取，主要做冲突检测）；
  - 冲突策略：**last-writer-mtime**，冲突列表返回前端让用户决定；
- 前端触发点：文件夹切换/刷新时静默增量同步 + Settings 里的手动"同步评级"按钮。

### 3.2 调色 recipe 互通

- `lumen_get_recipe_cmd (filePath) -> recipeJson`：`edit.get`（最终值词表，`commands.py:367-376`）；
- `lumen_apply_recipe_cmd (filePath, recipeJson) -> ok`：`edit.apply`（最终值，非增量；含 `masks:[{region:"sky",...}]` 时走 AI 蒙版，见 `commands.py:379-395`）；
- Gallery 检视图渲染：`lumen_render_preview_cmd` 带 recipe 参数（P0 已留口子）→ 即"在选片界面看到 lumen 调色后的效果"；
- recipe 落盘：lumen 侧由 `project.save` 写 `.lumen` JSON（`model.py:193-217`）；Gallery 只读不写 `.lumen`；
  scanner（`scanner.rs:16-52` 的 edited 检测扩展）识别同名 `.lumen` 存在 → 缩略图角标"已调色"；
- 批量"套用调色到选中"：走 Option B 单发循环（低频重活不占常驻通道）。

### 3.3 P1 验收标准

- [ ] XMP 往返测试全绿（3.0 三项）；
- [ ] Gallery 打 3 星 + pick → LUMEN RAW 打开同目录立即可见；反向亦然；
- [ ] LUMEN RAW 调曝光 → Gallery 按 C 键对比/检视能渲染带 recipe 的预览；
- [ ] 双方同时改同一张的冲突被列出且可人工裁决，无静默覆盖。

---

## 4. P2 — AI 增强 / 镜头校正 / 跨平台（远期）

1. **AI 降噪/超分**：
   - 上游（或本地 fork）加 `photo.enhance` 命令 ≈30 行，仿 `photo.export` 模式（`commands.py` + `cli.py`），
     弥合 `ai_dialog.py:124-129` 的 GUI-only 缺口，调用 `restoration.tiled` / `denoise.process`（worker 进程隔离，`ai_worker.py:151`）；
   - 宿主 `lumen_enhance_cmd` → Option B 单发；结果 DNG 副本落回原目录，走现有 `*_edit.*` edited 检测；
   - **模型权重不进安装包**：首次使用时按需下载（lumen 本来就是构建时 `tools/fetch_assets.py` 拉取，不在 git）；
   - GPU flavor 选择：Windows 默认 DirectML（`requirements-directml.txt`），无 GPU 自动 CPU（有 numpy 兜底）。
2. **镜头校正**：lensfun 数学已在 `lumen/lens.py` 自实现（不链 LGPL 库），只需把 recipe 的 lens 字段并入
   `edit.apply`；数据库（CC BY-SA 3.0）作为可选数据包附带 + 署名。
3. **跨平台**：`lumen_bridge.rs` 核心走 MCP stdio（天然跨平台），管道路径 `#[cfg(windows)]`；
   macOS sidecar（CoreML/CPU flavor）作为独立构建矩阵，非阻塞。
4. **Option C 深链**："在 LUMEN RAW 中编辑"菜单项（仿 Luminar roundtrip 的用户心智），活着就直连，没活就提示启动或走 A。

---

## 5. 打包与更新策略（对齐现有发布链）

- `tauri.conf.json`：新增 `bundle.externalBin`（`lumen-cli` 重命名为 `lumen-cli-x86_64-pc-windows-msvc.exe`）；目前该字段为空（`tauri.conf.json:40-51` 只有 icons）；
- `scripts/release.mjs`（:26-52 现在期望恰好 1 个 setup.exe + sig）：
  - 方案一（P0 简单版）：sidecar 进 NSIS 主包 → 安装包 + 更新包体积 +120MB，先接受；
  - 方案二（P1/P2 演进）：sidecar 独立版本号 + 独立下载通道（首启按需拉取 + 哈希校验），
    宿主 updater 保持轻量；sidecar 变更频率 ≈ 宿主的 1/10，长期明显省带宽；
- 体积预算：P0 硬门槛 <120MB；AI 权重永远按需（+150–400MB 只给开了 AI 的用户）。

## 6. 许可证合规清单（打进 MIT 安装包前逐项过）

聚合模式：`lumen-cli` 是**随附的独立进程程序**，不传染宿主代码，但分发义务随包走。

- [x] lumen-raw 本体 MIT → 收入 `THIRD-PARTY-NOTICES.txt`；
- [ ] **rawpy(MIT) 包的 LibRaw(LGPL-2.1/CDDL)**（`THIRD_PARTY.md:11-12`）：保持动态链接、不修改、可替换；
      附 LGPL-2.1 全文 + LibRaw 对应版本源码的获取途径（书面要约或 URL）；
      用 `dumpbin /imports` 抽查无静链（这也是否决 PyO3 嵌入方案的原因之一）；
- [ ] **PySide6(Qt) LGPL-3**：P0 打补丁后**不随包**（最干净）；若未来必须带 → 动态、未修改、可替换的 Qt DLL + LGPL-3 文本；
- [ ] **lensfun 数据库 CC BY-SA 3.0**：只带数据 + 署名 + share-alike 声明（库未链接，数学自实现）；
- [ ] **ONNX 权重**：Real-ESRGAN BSD-3 / BasicSR Apache-2 / SkySeg MIT / U²-Net Apache-2 / MiDaS MIT /
      DRUNet/NAFNet MIT / TorchVision BSD-3 逐项列出；**排除 SenseVoice**（FunASR Model License 1.1，选片用不到）；
- [ ] **ExifTool Artistic/GPL**：独立进程调用（合规），附许可与"未修改分发"声明；
- [ ] CI 闸门：跑 `tools/fetch_assets.py` / `tools/fetch_exiftool.py`（钉 URL+hash）→ 从 manifest 生成 notices。

## 7. 风险登记册（Top 9，详见 `.glue/deep/integration-plan.md §5`）

| # | 风险 | 缓解 |
|---|---|---|
| r1 | sidecar 120–200MB vs updater 全量重下 | 去 Qt 补丁（最大单项节省）；onedir 差分；独立更新通道；AI 权重按需 |
| r2 | XMP 整文件覆盖静默丢标签 | P1 闸门：roxmltree 合并 + 往返测试（本计划 §3.0） |
| r3 | MCP 工具表运行时生成，上游漂移 | 钉 commit + 启动断言工具表 + 漂移即降级回内嵌 JPEG |
| r4 | 权重/ExifTool 不在 git | CI 跑 fetcher + 启动自检；P0 不含 AI |
| r5 | Windows-only 起步 | 核心走 stdio（跨平台），管道 `#[cfg(windows)]`，macOS P2 |
| r6 | 无头路径 Qt 泄漏 | 2 行懒导入补丁，维护为钉死 commit 的 patch 文件，CI 冒烟 |
| r7 | 子进程阻塞 UI | 全异步 + 显式超时(30s) + kill；MCP 按 id 复用 |
| r8 | 评级语义错位（Green label vs -1 rating） | 映射表唯一实现 + 双向集成测试 |
| r9 | lumen 命令层 2000 张库上限（`commands.py:248-249`） | 只做单张/按文件夹分块同步，不整库导入 |

## 8. 测试计划

- **单元**：`lumen_bridge.rs` 的 JSON-RPC 帧编解码、id 复用、超时/崩溃恢复（mock 子进程）；
- **契约**：钉死版本握手断言（工具表快照对比）；
- **集成**（`tests/` 目录，需要样张）：CC0 样张（raw.pixls.us）×{ARW, CR2, NEF, RAF, DNG} →
  预览渲染、recipe 往返、评级往返、XMP 无损合并；
- **回归**：lumen 不可用（未安装/被 kill/版本漂移）时全部功能回退现状，UI 无报错弹窗；
- **性能**：热预览 P95 < 1s（1600px）；1000 张评级同步 < 30s；内存常驻 sidecar < 500MB。

## 9. 里程碑与工作量

| 里程碑 | 内容 | 预估 | 出口 |
|---|---|---|---|
| M0 | Qt 补丁 + `LumenCLI.spec` + 干净 venv 冒烟 | 2–3 天 | 无 PySide6 环境 `lumen-cli render` 出图 |
| M1 | `lumen_bridge.rs` + `lumen_render_preview_cmd` + api.ts + PreviewViewport 切换 | 4–5 天 | P0 验收全绿 |
| M2 | xmp.rs 合并修复 + 往返测试 | 3–4 天 | §3.0 三项全绿 |
| M3 | 评级同步 + recipe 互通 + 冲突裁决 UI | 4–5 天 | P1 验收全绿 |
| M4 | 发布链（externalBin/release.mjs/体积预算） | 2 天 | 安装包/更新包出货 |
| M5（P2） | photo.enhance 上游小改 + AI 按需包 + 镜头校正 + Option C 深链 | 2–3 周 | AI 增强一键可用 |

## 10. 附录：关键文件索引

**lumen-raw 侧（钉死 commit `43b4ebe`）**
- 引擎核心：`lumen/engine.py:126-198`（load_image）/ `:896-952`（process 分级缓存）/ `:270`（内嵌 JPEG 兜底）
- 命令层：`lumen/commands.py:49-56`（REGISTRY）/ `:354-608`（edit.*、project.save）/ `:524-537`（render_preview）
- CLI：`lumen/cli.py:118-221`（render/info/list/rate/flag/label/xmp read|write/run/mcp）
- MCP：`lumen/mcp.py:41-55`（工具生成）/ `:87-194`（stdio JSON-RPC）
- 控制管道：`lumen/control.py:34-49`（`\\.\pipe\lumen-raw-control-<user>`）
- 评级：`lumen/catalog.py:107-264`（catalog.jsonl）/ `:359-440`（XMP 读写，reject=-1 在 :425）
- Qt 泄漏点（补丁目标）：`lumen/session.py:108`、`lumen/commands.py:549`
- 打包：`LumenRAW.spec:30-33`（lumen-cli.exe 先例）、`tools/fetch_assets.py`、`tools/fetch_exiftool.py`

**Gallery Culling 侧**
- 桥接新文件：`src-tauri/src/lumen_bridge.rs`（新建）
- 命令注册：`src-tauri/src/lib.rs:23-38`（generate_handler!）、`src-tauri/src/commands.rs`
- XMP 修复目标：`src-tauri/src/xmp.rs:37-60`（裸解析）、`:118-206`（整文件重写）
- 预览替换点：`src/components/PreviewViewport.tsx:132-136,187`
- 缩略图缓存参考：`src-tauri/src/thumbnail.rs:10-24,90-118`
- roundtrip 先例：`src-tauri/src/luminar.rs`、`commands.rs:84-112,279-284`
- 发布链：`src-tauri/tauri.conf.json:40-51`、`scripts/release.mjs:26-52`
- 前端出口：`src/services/api.ts`（唯一 invoke 出口约定）
