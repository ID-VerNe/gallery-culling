# 渲染成片导出方案（Rendered Export）

> 日期：2026-10-17
> 状态：方案待评审（未实施）
> 目标：在现有「批量挑选导出」（复制原片）之外，新增「调色成片导出」——由 LUMEN RAW 按每张照片的 `.lumen` 工程渲染出 JPEG / PNG / 16-bit TIFF / 线性 DNG。

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 现在有导出调好色的图吗？ | **没有**。`batch_export_cmd` 只做 `fs::copy`，复制 JPG/RAW/XMP，不渲染。 |
| LUMEN 有能力吗？ | **有**。`photo.export`（单张，自动 open + 读 `.lumen`）、`photo.export_batch`（批量，但要求照片已在 session）。 |
| 推荐接入方式 | **逐张 B 通道单发** `lumen-cli run photo.export`，写入 `.gallery-export-tmp-*`，成功后原子搬迁。不占用常驻 MCP 锁、不受 120s 读超时约束、不污染失败计数。 |
| 源文件选择 | `raw_path ?? jpg_path`，与 `groupPath()`（`src/utils/groupPath.ts:13-15`）一致。选错源会**静默丢失调色**。 |
| 主要风险 | 通道选错导致超时/毒化、未落盘编辑丢失、并发取消标志冲突、commit 阶段覆盖、进度与取消看门狗不匹配。见 §6。 |

---

## 1. 现状审计

### 1.1 现有导出（复制原片）

| 层 | 事实 | 证据 |
|---|---|---|
| 命令 | `batch_export_cmd(items, targetFolder, includeRaw, includeJpg)` → `ExportOutcome` | `src-tauri/src/commands/export.rs:224-232` |
| 返回 | `{exported, skipped, failed[{path,reason}], cancelled}`，**计数单位是文件**（RAW/JPG/XMP 各计一次） | `export.rs:36-55`、`:151-179` |
| 取消 | `cancel_export_cmd` 置 `state.export_cancel`；每项开头 + JPG/RAW/XMP 后共 4 个检查点；返回 `Ok(cancelled=true)` | `export.rs:30-34`、`:318-353`、`:374` |
| 暂存 | 目标目录内建 `.gallery-export-tmp-<uuid>`，逐文件 `fs::rename` 提交 | `export.rs:307-310`、`:167-182` |
| 清单 | 目标目录 `.gallery-export.json`，`{version,startedAt,finishedAt,status,includeJpg,includeRaw,items[]}` | `export.rs:57-91`、`:197-222` |
| 进度 | `export-progress {processed,total,current}`，节流：首项 / ≥80ms / ≥32 项 / 末项 | `export.rs:19-26`、`commands.rs:104-138` |
| 前端 | `useTaskProgress('export')` + `TaskProgressBar`，单通道、无 task_id | `BatchExportModal.tsx:81`、`taskApi.ts:28-31` |

### 1.2 调色落在哪

- `apply_tone_cmd` **一条命令两个落点**：总是写 XMP；引擎可用时 `apply_edits` + `save_project` 落 `.lumen`（`commands/tone.rs:24-98`）。
- 调色目标路径 = `raw.path || jpg.path`（`src/utils/groupPath.ts:13-15`，`useToneEditing.ts:226-231`）。
- **推论**：成片必须从同一路径渲染。JPG+RAW 的组若从 JPG 渲染，`.lumen` 挂在 RAW 上，调色全丢。
- `lumen_apply_recipe_cmd`（预览用）只 apply **不 save**（`commands/lumencmds.rs:361-379`）；`apply_tone` / `apply_preset` 才 save。所以「已保存的调色」都在 `.lumen` 里。

### 1.3 LUMEN 能力（1.6.0）

| MCP 工具 | 命令 id | 关键参数 | 返回 |
|---|---|---|---|
| `export_photo` | `photo.export` | `output`（必填）、`path`、`quality` 50-100、`long_edge` 16-20000、`overwrite` | `{path, output}` |
| `export_photos` | `photo.export_batch` | `folder`、`paths`、`format` jpg/png/tif/dng、`quality`、`long_edge` | `{exported[], failed[]}` |

证据：`lumen-raw/lumen/commands.py:540-600`。

---

## 2. LUMEN 导出实现（源码级）

### 2.1 主链路

```
photo.export
  → _target(context, path)            # commands.py:150-162
      ├─ resolve(path)
      ├─ path != current → context.open(path)
      │     └─ Session.open 读同目录 <photo>.lumen   # session.py:62-90
      └─ 返回照片路径
  → context.edits(path)               # session.py:113-117
  → batch_export.run([(path, edits, initialized)], opts)
      ├─ engine.load_image(path, None, develop_reference=not initialized)  # 全尺寸解码
      ├─ model.validate(edits)
      ├─ lens.prepare(edits['lens'], info['lens_match'])   # 按本图重匹配镜头
      ├─ engine.process(source, edits, backend)            # 渲染
      ├─ fit_long_edge(result, long_edge)                  # 只缩不放，INTER_AREA
      ├─ watermark.apply(result, edits['watermark'], photo)# 按输出坐标系
      └─ engine.export_image(target, result, quality)      # 编码 + 原子写
```

证据：`batch_export.py:108-160`、`engine.py:896-960`、`engine.py:1275-1307`。

### 2.2 渲染顺序（`engine.process`）

镜头校正 → 白平衡/develop 基准 → tone/color → 局部蒙版 → finishing（暗角/颗粒）→ `crop_rotate`（裁切与旋转在最后，坐标始终基于原图）。证据：`engine.py:917-953`。

### 2.3 加载语义（三个必须记住的坑）

1. `photo.export` 传 `path` 时**会自动 open**，所以未打开过的照片也能直接导出（`commands.py:150-162`）。
2. `Session.open` 会读同目录 `<photo>.lumen`；读取失败只记日志，不报错（`session.py:66-84`）。
3. **陷阱**：若照片不是 current，显式传 `path` 会重新 `open()`，同目录 `.lumen` 会**覆盖 session 内未保存的 edits**（`session.py:84-88`）。安全用法是先 `open_photo` 再省略 `path`——但单发进程本来就没有 session 态，不受影响。

### 2.4 命名、覆盖与原子性

| 场景 | 行为 | 证据 |
|---|---|---|
| 批量 | `<stem>-Lumen<ext>`；已存在 / 本轮已占用 / 等于源文件 → `-Lumen-2`、`-3`…；**永不覆盖** | `batch_export.py:88-97` |
| 单张 | 完全按 `output` 写，不加后缀、不编号 | `commands.py:548-569` |
| 单张覆盖 | `overwrite=false` 且存在 → `CommandError`；`true` → `os.replace` | `commands.py:558-559`、`engine.py:1304` |
| 原片保护 | `output == resolve(path)` 直接拒绝，`overwrite=true` 也不行 | `commands.py:554-555` |
| 原子写 | 先写 `<stem>.lumen-tmp<ext>`，`os.replace`，`finally` 清理 | `engine.py:1284-1307` |

### 2.5 编码

| 格式 | 实现 |
|---|---|
| JPEG | 8-bit sRGB，Pillow，`subsampling=0`（4:4:4），带 ICC，不写 EXIF |
| PNG | 8-bit RGB + sRGB ICC（无 16-bit 选项） |
| TIFF | 16-bit sRGB，`tifffile`，`rowsperstrip=64`，ICC 在 tag 34675 |
| DNG | 16-bit **LinearRaw**（photometric 34892），写 ColorMatrix/AsShotNeutral；`software` 硬编码 `LUMEN RAW 1.2.2` |

证据：`engine.py:1288-1303`、`dng.py:43-61`、`large_image.py:8-10`。

### 2.6 进度与取消

- GUI 批量：`threading.Event`，每张开始前检查，**只在张间生效**；progress 每张一次（`batch_export.py:113-116`、`library.py:202-209`）。
- 命令层（CLI/MCP）：传 `_Never()`，**没有进度、不能取消**（`commands.py:565-574`、`:593-596`）。
- 结论：宿主只能自己按「张」做进度与取消，单张渲染内部不可中断。

### 2.7 性能与边界

- 4 亿像素上限：`MAX_PIXELS=400_000_000`（`large_image.py:8`），水印加边框后再查一次（`watermark.py:110`）。
- 大图：`source.nbytes > 256MiB` 走分条渲染；有空间类编辑（dehaze/clarity/texture/sharpness/denoise/蒙版/修复/暗角/颗粒）时改整图，按 100 bytes/像素预检内存（`large_image.py:113-129`）。
- 实测：一张 12MP JPG 单发导出 **1.6s**（含进程启动），输出 5.9KB（合成测试图）。
- 24MP RAW 预计 3–10s/张；100 张批量 = 5–15 分钟（每张一个 sidecar 进程）。
- MCP 服务端单线程 + `Dispatcher._lock`，同时两个调用会串行（`mcp.py:102-118`、`:83-84`）。

---

## 3. 方案设计

### 3.1 数据流

```
BatchExportModal（模式 = 调色成片）
  │ items: [{baseName, jpgPath, rawPath}]  ← 源 = raw ?? jpg
  │ format / quality / longEdge
  ▼
api.batchRenderExport → invoke('batch_render_export_cmd')
  ▼
Rust: render_export_items(...)          ← 纯函数，可注入 renderer
  ├─ 目标目录自检（复用 export.rs:286-303）
  ├─ 建 .gallery-export-tmp-<uuid>
  └─ for each item:
       ├─ cancel? → mark_cancelled + 删 tmp + 返回
       ├─ 目标名 = {baseName}-Lumen.{ext}，存在则 -2/-3
       ├─ render(src, tmp_out)  ← 注入点
       │     └─ lumen::export_photo(exe, src, tmp_out, quality, long_edge)
       │           └─ lumen-cli run photo.export {path, output, quality, long_edge, overwrite:false}
       ├─ 校验 tmp_out 存在（LUMEN 返回 Ok 但没写文件 → 记 failed）
       └─ 进度事件 export-progress
  ├─ commit：fs::rename 逐文件进目标
  └─ 写 .gallery-export.json（mode:"render"）
  ▼
ExportOutcome（与复制导出同形状）→ 前端同一套结果呈现
```

### 3.2 通道选择裁决：B 通道单发（逐张）

| 维度 | A：常驻 session `export_photo` | B：单发 `run photo.export` |
|---|---|---|
| 锁 | 全程持 `inner.lock()`，预览/状态/设置全部排队 | 不占锁 |
| 超时 | `READ_TIMEOUT=120s`，超时丢 client + `failures+=1` | `Command::output()` 无超时 |
| 失败计数 | 累计 8 次后 A 通道永久 `Timeout` | 不污染 |
| 未落盘编辑 | 可见 | 不可见（只读 `.lumen`） |
| 启动开销 | 复用进程，快 | 每张冷启动（实测 1.6s 含启动） |

**裁决：B 通道**。理由是 120s 对全尺寸 RAW 渲染明显不够，而 A 通道超时会丢 client、污染预览的重连预算，并摧毁未落盘的 session 编辑态。代价是每张冷启动，可接受。

**补偿**：导出前若 `runtime.has_live_client()` 为真，对当前照片尝试一次 `save_project`（尽力而为，失败不阻断）。正常流程中 `apply_tone` 已落盘，此步只兜底预览级临时调整。

### 3.3 后端命令契约

```rust
#[tauri::command]
pub async fn batch_render_export_cmd(
    state: State<'_, AppState>,
    items: Vec<ExportItem>,          // {baseName, jpgPath?, rawPath?}
    target_folder: String,
    format: String,                  // "jpg" | "png" | "tif" | "dng"，默认 "jpg"
    quality: Option<u8>,             // 50..=100，默认 92（仅 jpg）
    long_edge: Option<u32>,          // 16..=20000；None = 原始尺寸
) -> Result<ExportOutcome, String>;
```

- 复用 `ExportOutcome` / `ExportFailure`（`export.rs:36-55`），前端结果呈现零改动。
- 复用 `export-progress` 与 `cancel_export_cmd`，不新增事件通道。
- LUMEN 未启用 / 找不到 CLI → 立即 `Err`，**不静默回退到复制**。
- 目标目录 = 源目录 → 拒绝（复用同一文案与 canonicalize 检查）。

### 3.4 后端实现步骤

1. `src-tauri/src/lumen/runtime.rs` 新增：

```rust
pub fn export_photo(
    &self, exe: &Path, photo: &str, output: &str,
    quality: u8, long_edge: Option<u32>,
) -> Result<String, LumenError> {
    let mut args = serde_json::json!({
        "path": photo, "output": output,
        "quality": quality.clamp(50, 100) as i64,
        "overwrite": false,
    });
    if let Some(le) = long_edge {
        args["long_edge"] = serde_json::json!(le.clamp(16, 20_000) as i64);
    }
    let out = lumen::run_lumen(exe, "photo.export", &args)?;
    out.get("output").and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| LumenError::Protocol("photo.export 未返回 output".into()))
}
```

注意：`long_edge=None` 必须**省略键**，发 `null` 会被 schema 拒绝（`commands.py:87-110`）。

2. `src-tauri/src/commands/export.rs` 新增纯函数（仿 `ensure_preview` 的闭包注入，`lumen/cache.rs:171-176`）：

```rust
fn render_export_items(
    items: &[ExportItem],
    target: &Path,
    format: &str,
    quality: u8,
    long_edge: Option<u32>,
    cancel: &AtomicBool,
    render: impl FnMut(&Path, &Path) -> Result<(), String>,
    on_progress: impl FnMut(usize, usize, &str),
) -> Result<ExportOutcome, String>
```

3. 命令层薄封装：读设置 → `require_lumen` → `blocking("渲染导出任务异常", ...)`。
4. `commands.rs` 显式转发 `export_rendered_cmd`（宏不随 glob 传递，`commands.rs:11-16`）；`lib.rs:39-67` 注册。
5. 清单增加 `mode: "render"`、`format`、`quality`、`longEdge`；`items[].result` 用 `"rendered"`，不复用 `"copied"`。

### 3.5 前端改动

**Props**：`lumenStatus?: LumenStatus | null`、`onOpenSettings?: () => void`（由 `App.tsx:215-219` 透传，避免弹窗内重复探测）。

**State**：`exportMode: 'copy' | 'render'`（默认 copy）、`renderFormat: 'jpg' | 'tif' | 'dng'`、`renderQuality`（默认 92）、`renderLongEdge`（0 = 原始）。

四个新 state 必须加入「输入变化清结果」依赖（`BatchExportModal.tsx:95-97`）。

**UI**：

| 模式 | 显示 |
|---|---|
| 原片复制 | 现有「包含文件类型」（RAW / JPG） |
| 调色成片 | 格式（JPEG / TIFF / DNG）、质量（仅 JPEG）、长边（原始 / 4096 / 2560 / 1600）；隐藏文件类型 |

- 模式控件用 `fieldset + legend + 原生 radio`（不要用按钮模拟单选）。
- LUMEN 未就绪：允许选中，显示 `role="alert"` 说明 + 「去设置启用」；开始按钮禁用。
- 导出中禁用**所有**输入（现有输入未 disabled，是既存缺口，`BatchExportModal.tsx:276-355`）。
- 按钮文案：copy = `开始导出`（保持测试兼容）；render = `开始生成成片`。

**候选**：仍用 `exportCandidates`，**不筛 RAW**——JPG-only 组也能由 LUMEN 渲染（`.lumen` 挂在 JPG 上）。源路径 `raw ?? jpg` 在后端决定。

**文案**：

| 场景 | copy 模式（现状） | render 模式（新增） |
|---|---|---|
| 成功 | `导出完成：已导出 N 个…` | `成片生成完成：已生成 N 张…` |
| 部分失败 | `导出未完全成功：失败 N 个…` | `成片生成未完全成功：失败 N 张…` |
| 跳过 | `跳过 N 个（目标已存在同名文件）` | `跳过 N 张（目标已存在同名成片）` |
| 取消 | `已取消导出：目标目录未产生任何文件。` | `已取消导出：目标目录未产生成片。` |

> 取消文案建议同时修正 copy 模式：后端取消时仍会写 `.gallery-export.json`（`export.rs:365-372`），「未产生任何文件」字面不成立。

### 3.6 manifest 扩展

```json
{
  "version": 1,
  "mode": "render",
  "format": "jpg",
  "quality": 92,
  "longEdge": 4096,
  "startedAt": 0, "finishedAt": 0,
  "status": "completed",
  "items": [{ "src": "...", "dst": "...", "result": "rendered" }]
}
```

`mode` 缺省视为 `"copy"`，保持向后兼容；e2e 的 `05-export` 断言不变。

---

## 4. 测试方案

### 4.1 Rust（不依赖真 LUMEN）

| 编号 | 用例 | 断言 |
|---|---|---|
| R1 | 2 项渲染成功 | `exported=2`；目标字节 = fake renderer 写入值；manifest `mode=render`、`result=rendered`；无 tmp |
| R2 | 单张 renderer 失败 | `exported=1`、`failed=1`、其余仍在；manifest `failed` |
| R3 | renderer 返回 Ok 但未写文件 | 该张记 `failed`，不得算 `exported` |
| R4 | 取消（首张后置位） | `cancelled=true`、目标无成片、无 tmp、manifest `cancelled` |
| R5 | 目标同名 | `skipped=1`、renderer 不被调用、原文件字节不变 |
| R6 | 目标 = 源目录 | Err 精确文案、renderer 不被调用 |
| R7 | 空 items / 源缺失 | 不 panic，记账符合契约 |
| R8 | 参数构造 | `long_edge=None` 时 args 不含该键；quality 夹取 50-100 |
| R9 | 原子性 | renderer 收到的 output 在 `.gallery-export-tmp-*` 内；提交前目标不存在 |

### 4.2 前端

| 编号 | 用例 | 断言 |
|---|---|---|
| F1 | 默认 copy | 调 `batch_export_cmd`，不调 render 命令 |
| F2 | 切 render | 调 `batch_render_export_cmd`，args 含 format/quality/longEdge |
| F3 | LUMEN 未就绪 | 可见 alert + 按钮 disabled + 零 invoke |
| F4 | 模式切换 | 文件类型区隐藏；旧结果清空 |
| F5 | 进度 | `aria-valuenow` 随事件更新，current 显示文件名 |
| F6 | 取消 | 只发一次 `cancel_export_cmd`；按钮变「取消中…」 |
| F7 | 取消文案 | 精确匹配 `目标目录未产生成片`，不含「已生成」 |
| F8 | 部分失败 / 全成功 | 琥珀 alert 在前 / 绿色 status |
| F9 | 运行中 | 所有输入与模式禁用，X/Esc 锁定 |

### 4.3 e2e（`09-render-export`）

- 门禁：sidecar 存在且设置已开启（仿 `08-lumen-preset.mjs:54-81`）；缺 sidecar 时 `note` + skip，不判红。
- 素材：**复制** 2 张 JPG 到 `RENDER_SRC`，不要用 `generate.mjs` 的合成 RAW（那是 JPEG 字节，LUMEN 解不了）。
- 断言：产物存在、JPEG 魔数、sha256 ≠ 源、manifest `mode=render`/`result=rendered`、无 tmp、源目录 hash 前后不变。
- 取消用例易 flaky，确定性取消交给 R4。

---

## 5. 实施顺序

| 阶段 | 内容 | 产出 |
|---|---|---|
| 1 | `runtime::export_photo` + 参数构造单测 | R8 |
| 2 | `render_export_items` 纯函数 + 单测 | R1-R7、R9 |
| 3 | `batch_render_export_cmd` + 转发 + 注册 + 清单扩展 | 可联调 |
| 4 | 前端 api + UI + 测试 | F1-F9 |
| 5 | e2e `09-render-export` | E1-E7 |
| 6 | 全量回归（tsc + vitest + cargo test + e2e） | 绿 |

---

## 6. 风险清单

### P0（会导致功能不可用或静默错误）

| # | 风险 | 影响 | 触发条件 | 缓解 |
|---|---|---|---|---|
| 1 | 走 A 通道（常驻 session）做导出 | 单张 RAW 超 120s → `Timeout`、丢 client、`failures+=1`；累计 8 次后编辑通道永久不可用 | 大图 / CPU 后端 / 有空间类编辑 | **按本方案走 B 通道**；A 通道仅用于预览 |
| 2 | 源文件选成 JPG | `.lumen` 挂在 RAW 上，成片**静默丢失全部调色** | JPG+RAW 组且从 JPG 渲染 | 后端固定 `raw ?? jpg`；单测断言传给 renderer 的 src |
| 3 | 未落盘编辑丢失 | 导出的是旧版调色 | 预览级 `apply_recipe` 后未 save | 导出前对 `has_live_client()` 的当前照片 `save_project`；文档写明「以已落盘工程为准」 |
| 4 | 并发导出抢 `export_cancel` | 后启动者复位标志，取消请求丢失；无法区分取消谁 | 同时开两个导出 | 加单飞守卫（`AtomicBool`/`Mutex`），导出进行中直接拒绝第二次 |
| 5 | commit 阶段 `fs::rename` 覆盖 | Windows 上可能替换已存在同名文件（TOCTOU） | 检查与搬迁之间有新文件 | 目标名先用 `create_new` 占位，或 rename 前二次检查；至少加单测锁行为 |

### P1（体验或数据完整性问题）

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 6 | 单张渲染不可取消 | 用户点取消后要等当前张渲染完 | 文案改为「正在完成当前照片…」；只在张间检查 |
| 7 | 取消看门狗 10s | 单张 >10s 时误报「取消请求无响应」 | 渲染期间持续发张级进度；或对该模式延长看门狗 |
| 8 | 进度条长时间不动 | 用户以为卡死 | `current` 显示「正在渲染 xxx」；首张开始即发 0/N |
| 9 | 磁盘峰值翻倍 | 临时目录 + 目标同时存在全尺寸成片 | 文档提示；空间不足时 `fs::rename` 失败要报明确错误 |
| 10 | 跨目录同名文件 | 两个 `IMG_001` 在 tmp 互相覆盖，第二个 rename 失败 | 目标名去重集合（按 baseName 计数，冲突加 `-2`） |
| 11 | LUMEN 未安装/未启用 | 命令直接 Err | 前端模式可用但按钮禁用 + 引导去设置；不要静默回退复制 |
| 12 | 只有 XMP、没有 `.lumen` | 引擎关闭时调的色不进成片 | 导出前检测 `.lumen` 缺失 + XMP 有 tone → 提示「该照片的调色未写入 LUMEN 工程」 |
| 13 | 版本钉死 1.6.0 | 握手拒绝其他版本，导出入口不可用 | 升级 sidecar 时同步 `PINNED_LUMEN_VERSION`（`lumen.rs:56`） |
| 14 | 失败文案英文 | `CommandError` 原样透出 | 映射常见错误：目录不存在 / 已存在 / 格式不支持 / 原片不可覆盖 |

### P2（可接受或后续优化）

| # | 风险 | 说明 |
|---|---|---|
| 15 | 每张冷启动 sidecar | 100 张约多花 1-2 分钟；后续可做「常驻 session + 按命令超时」优化 |
| 16 | MCP 单线程串行 | 导出期间预览请求排队（B 通道不占锁，仅 sidecar 进程各自独立，实际影响小） |
| 17 | DNG `software` 字段写死 1.2.2 | LUMEN 上游问题，不影响可用性 |
| 18 | 成片写入源目录 | 若用户坚持，扫描器可能把成片当原片（`scanner.rs:20-29` 识别 `_edit`/`_Luminar` 后缀）；默认仍禁止目标=源 |
| 19 | 4 亿像素上限 | 超限报错，需先裁切或降长边 |

---

## 7. 验收标准

1. 一张带 `.lumen` 的 RAW 导出成片：文件存在、JPEG 可解析、sha256 ≠ 原片；与 LUMEN GUI 导出同图对比，肉眼一致。
2. 无 `.lumen` 的照片导出成功（相机默认 develop），不报错。
3. 取消后目标目录无成片、无 `.gallery-export-tmp-*`，manifest `status=cancelled`。
4. LUMEN 未启用时，成片模式按钮禁用且有可点击的设置引导。
5. `tsc --noEmit`、vitest 全量、`cargo test --lib`、`e2e` 全绿。

---

## 8. 证据索引

| 主题 | 文件:行 |
|---|---|
| 现有导出命令与契约 | `src-tauri/src/commands/export.rs:36-55`、`:224-260` |
| 暂存/提交/清单 | `export.rs:102-194`、`:197-222`、`:307-310` |
| 进度节流 | `src-tauri/src/commands.rs:104-138` |
| 调色双落点 | `src-tauri/src/commands/tone.rs:24-98` |
| 调色路径 | `src/utils/groupPath.ts:13-15` |
| LUMEN 常驻 session | `src-tauri/src/lumen/runtime.rs:112-156` |
| 读超时 | `src-tauri/src/lumen/transport.rs:16` |
| LUMEN 导出命令 | `lumen-raw/lumen/commands.py:540-600` |
| 导出循环 | `lumen-raw/lumen/batch_export.py:108-160` |
| 命名去重 | `lumen-raw/lumen/batch_export.py:88-97` |
| 编码/原子写 | `lumen-raw/lumen/engine.py:1275-1307` |
| 工程加载 | `lumen-raw/lumen/session.py:62-117` |
| 水印 | `lumen-raw/lumen/watermark.py:105-122` |
| 大图/上限 | `lumen-raw/lumen/large_image.py:8-10`、`:113-129` |
| 前端导出弹窗 | `src/components/BatchExportModal.tsx:73-217` |
| 进度 hook | `src/hooks/useTaskProgress.ts:57-80` |
| e2e 导出套件 | `e2e/suites/05-export.mjs` |
