# E — AI 增强 / 智能蒙版 / 镜头校正 ↔ 宿主 比对报告

- **日期**: 2026-10-11
- **客体钉死**: lumen-raw commit `43b4ebe2a84284098523219d597873a52197a1b7` (v1.6.0, tag `v1.6.0`)
- **宿主**: gallery-flask (Tauri 2.0 + Rust + React 19 + TS)
- **范围**: 7 个课题（GUI-only 缺口 / 智能蒙版链路 / 降噪量化 / GPU 栈 / 模型权重 / 镜头校正 / 宿主空白确认）
- **配套文档**: `.plan/lumen_raw_integration_plan.md`（总计划）、`.plan/research/`（A–E 系列）

---

## 0. 结论速查

| # | 课题 | 结论 |
|---|---|---|
| 1 | `ai_dialog.py:124-129` GUI-only 缺口 | 缺口 = **对话窗 + job 调度 + 进度/取消 + preview 局部区域**；纯算法 `restoration.super_resolution/denoise/drunet_denoise` 与 `denoise.process` 本身零 Qt 依赖，可直接在命令层复用 |
| 2 | 新增 `photo.enhance` 补丁 | ~55 行新代码（含 4 个 helper），全部落在 `commands.py` 末尾 + `palette.py:28` 一行 + `cli.py:3` 处 docstring 一行；**`cli.py` 逻辑零改动** |
| 3 | 智能蒙版（P1 可用） | `edit.apply` 的 `masks[{region:"sky"}]` 已经在 CLI/MCP 全链路跑通（`commands._regions`），worker 隔离由 `compute.session()` 自动兜住；P1 只需补**模型文件落位 + u2netp/skyseg 两个小模型** |
| 4 | 降噪是两套东西 | recipe `denoise` = Lab 双边滤波（`engine.reduce_noise`），AI 降噪 = `denoise.process`/`restoration.*`；**前端文案必须分开，且 AI 版产 DNG 副本、不进 recipe** |
| 5 | GPU 栈 | 3 条路径：DirectML（Win）/ TensorRT-RTX（WinML 插件）/ CUDA / Metal（macOS）+ CPU 兜底；sidecar 默认 flavor 决策见 §5.3 |
| 6 | 模型清单+体积 | 蒙版 4 个共 **277.93 MiB**，增强 5 个共 **308.06 MiB**，合计 585.99 MiB；onnx 全部 gitignore → **必须按需下载** |
| 7 | 镜头校正 | `lens.py` 100% 数学自实现（无 lensfun C 库链接），DB 被 git 跟踪（58 文件 / 5.15 MiB）→ **直接随 sidecar 打包，零下载成本** |
| 8 | 宿主空白 | 逐项 grep 确认：`src-tauri/` 无 ORT / candle / tract / rawloader / 任何推理框架 → **100% 依赖 sidecar** |

---

## 1. file-by-file 比对表

### 1.1 lumen-raw 侧（客体）

| 文件 | 行数 | 职责 | Qt 依赖 | 宿主复用方式 |
|---|---:|---|---|---|
| `lumen/ai_dialog.py` | 186 | AI 增强对话窗（参数面板 + 预览 + 副本保存） | **是**（PySide6 全量） | 仅作**参数集与调用契约参考**；不打包 |
| `lumen/restoration.py` | 109 | NAFNet / Real-ESRGAN-x4plus 分块推理 | 否 | **命令层直接 import**（P2） |
| `lumen/denoise.py` | 54 | FFDNet 离线降噪 + Haar 噪声估计 | 否 | **命令层直接 import**（P2） |
| `lumen/selection.py` | 110 | SkySeg / DeepLabV3 / U2NetP / MiDaS 蒙版 | 否 | **已被 `commands._regions` 调用**（P1） |
| `lumen/auto_masks.py` | 134 | GUI 的"自动选择 / AI MASKS"面板 | **是** | 仅参考按钮与 kind 映射 |
| `lumen/lens.py` | 34k 字节 | lensfun 数据库解析 + 畸变/暗角/CA 数学 | 否 | **已随 recipe 生效**（P1/P2 零成本） |
| `lumen/lens_panel.py` | 269 | 镜头校正 GUI 面板 | **是** | 仅参考 |
| `lumen/ai_worker.py` | 315 | ONNX 推理独立进程 + GPU 崩溃兼容记录 | 否（_serve 内部 import logs/winml） | **自动生效**（`compute.session()` 门控） |
| `lumen/compute.py` | 480 | provider 选择 / Session 门面 / CPU 回退 | 否 | 自动生效；宿主只设 flavor |
| `lumen/onnx_graph.py` | 117 | 无依赖 ONNX protobuf writer | 否 | 自动生效（gpu_graphs 用） |
| `lumen/gpu_graphs.py` | 21k 字节 | 逐像素显影 GPU 图（tonal/color/fused/2代） | 否 | 自动生效（`engine.Backend` 调） |
| `lumen/resolution.py` | 248 | 原分辨率细节分块渲染 | **是** | GUI 专属，宿主不需要（宿主一次一图） |

### 1.2 宿主侧（宿主）

| 文件 | 行数 | 与本课题的关系 |
|---|---:|---|
| `src-tauri/Cargo.toml` | 47 | 依赖清单：tauri/image/kamadak-exif/rusqlite/trash/rayon/sha2/walkdir/tokio —— **无 ort / candle / tract / rawloader / opencv-rust** |
| `src-tauri/src/commands.rs` | 285 | 12 个命令，最接近的模板 = `batch_export_cmd`（`:162-219`）与 `open_in_luminar_roundtrip_cmd`（`:279-284`，Option B 单发先例） |
| `src-tauri/src/lib.rs` | 41 | `generate_handler!` 注册表（`:23-38`） |
| `src-tauri/src/luminar.rs` | 160 | **Option B 单发先例**：`Command::new(exe)` + `spawn_blocking` + 超时/退出码判错（`:129-159`） |
| `src-tauri/src/scanner.rs` | 526 | `find_edited_version`（`:16-52`）只认 `_Luminar.*`/`_edit.*` → **DNG 副本不会被识别为"已编辑"**（P2 必须补一行） |
| `src/components/TonalAdjuster.tsx` | ~200 | 7 个滑块写 XMP；**无 denoise / 无 AI 入口** |
| `src/components/PreviewViewport.tsx` | — | RAW 预览，`luminance/mask/enhance` 三词在全文 0 命中 |
| `src/services/api.ts` | — | invoke 唯一出口（P2 加 `lumenEnhance()`） |

**宿主 grep 实证**（对 `src-tauri/src/*.rs` + `src/components/*.tsx` 大小写不敏感）：

```
onnx|ort|candle|tract|denoise|noise|lens|mask|segment|upscale|superres|enhance|esrgan|dml|directml|coreml|metal
```
命中仅 2 类：① `models.rs`/`scanner.rs`/`commands.rs` 里的 **EXIF `LensModel` 字段读写**（元数据，与镜头校正无关）；
② `TonalAdjuster.tsx` / `MetadataEditorModal.tsx` / `TopBar.tsx` 的 **`enhance` 子串**（实为"增强对比度"等 CSS filter 词，非 AI）。**结论：宿主在 AI/降噪/镜头校正三个方向都是空白。**

---

## 2. GUI-only 缺口精确定位（课题 1）

### 2.1 缺口到底缺什么

`ai_dialog.py` 的算法调用点 **L123–133** 是纯函数调用，无任何 Qt 对象参与：

```python
# lumen/ai_dialog.py:123-133（原文摘录）
if self.kind=='super':
    if r['method']==0:
        output,backend=restoration.super_resolution(rgb,r['scale'],r['cuda'],progress,self.cancel_event,region=region)
    else:
        source=before if region else rgb
        output,backend=engine.super_resolve(source,r['scale'],':builtin:',r['cuda'],progress,self.cancel_event)
else:
    algorithm=(restoration.drunet_denoise,restoration.denoise,denoise.process)[r['method']]
    options={'noise_reference':noise_reference}
    if r['method']<2:options['region']=region
    source=before if region and r['method']==2 else rgb
    output,backend=algorithm(source,r['amount'],r['cuda'],progress,self.cancel_event,**options)
```

GUI-only 的只是**外围六件**：
1. 参数面板（`L52-58`：method 下拉 / scale 或 amount 输入）
2. `self._request` dict 组装（`L94-96`）
3. `w.job(work, ready, fail, priority=10)` 线程池投递（`L170`）
4. `progressed` Signal 进度回调（`L81-82, 121-122`）
5. `cancel_event` 取消事件（`L39, 100, 134`）
6. `ai_worker.set_status_listener`（`L121`，把 TensorRT 下载状态转成进度文本）+ `reserve_copy` 副本命名（`L18-29`）+ `engine.export_image` 落盘（`L142`）

**核心加载链路（可 1:1 搬到命令层）**：
```python
source,_ = engine.load_image(r['path'], None)                                    # ai_dialog.py:110  ← 注意 None = 不限尺寸
rgb = engine.process(source, r['edits'], engine.Backend('auto' if r['cuda'] else 'cpu'))  # :113
large_image.validate_size((rgb.shape[0]*scale, rgb.shape[1]*scale))            # :114
noise_reference = denoise.noise_level(rgb) if kind=='denoise' else None        # :115
```

> ⚠️ **`load_image(path, None)` 的 `None` 是 preview_limit**。宿主传给 sidecar 的若是低分辨预览图（`render.preview` size=1024），AI 增强会变成"对 1024px 图超分"。命令层必须自己按需加载全尺寸，不能复用 `context.source()` 的预览缓存（`initialized` 分支处理见 §2.6 与补丁内 `develop_reference=not initialized`）。

### 2.2 现有函数签名（补丁设计的硬契约）

| 函数 | 签名 | 备注 |
|---|---|---|
| `restoration.super_resolution` | `(rgb, scale=2, cuda=True, progress=None, cancel=None, region=None)` | `scale not in (2,4)` 抛错；超分**没有 strength 参数** |
| `restoration.denoise` | `(rgb, amount=70, cuda=True, progress=None, cancel=None, noise_reference=None, region=None)` | NAFNet；`amount=0` 直接返回原图 copy |
| `restoration.drunet_denoise` | `(rgb, amount=35, cuda=True, progress=None, cancel=None, noise_reference=None, region=None)` | 同上签名 |
| `denoise.process` | `(rgb, amount=35, cuda=True, progress=None, cancel=None, noise_reference=None)` | FFDNet；**无 `region` 参数**（所以 `ai_dialog.py:131` 才对 method<2 才注 region） |
| `engine.super_resolve` | `(rgb, scale=2, model_path=None, use_cuda=True, progress=None, cancel=None)` | `:builtin:` = Real-ESRGAN compact，`None` = Lanczos+反投影（非 AI） |
| `engine.load_image` | `(path, preview_limit=1600, develop_reference=False, clip=False)` | `preview_limit=None` = 全尺寸 |
| `engine.export_image` | `(path, rgb, quality=95, photo=None, provenance=None)` | 原子写（`.lumen-tmp` + `os.replace`），支持 dng/tif/jpg/png |
| `large_image.validate_size` | `(shape)` | 上限 4 亿像素（`large_image.MAX_PIXELS`） |
| `performance.THREADS` | int | 32 上限 × `os.cpu_count()` |

### 2.3 参数集确认（对照 `ai_dialog.py:52-59`）

| kind | GUI 下拉项 | method idx | 落到的函数 | scale | amount 默认 |
|---|---|---|---|---|---|
| `super` | 高画质 · Real-ESRGAN x4plus / RRDB | 0 | `restoration.super_resolution` | 2 或 4（`L55` 两项） | — |
| `super` | 快速 · Real-ESRGAN compact | 1 | `engine.super_resolve(..., ':builtin:')` | 2 或 4 | — |
| `denoise` | 高画质 · DRUNet 细节保留 | 0 | `restoration.drunet_denoise` | — | 35（`L56` `setValue(35)`） |
| `denoise` | 真实噪声 · NAFNet SIDD | 1 | `restoration.denoise` | — | 70（`L57` 切到 idx=1 时 `setValue(70)`） |
| `denoise` | 快速 · FFDNet 自适应降噪 | 2 | `denoise.process` | — | 35 |

- **无 tiling 参数**：tile/overlap 在 `restoration.tiled`（L40：super `128/32/32`，其余 `256/64/32`）与 `denoise.process`（L36：`tile,pad=256,32`）里写死。宿主侧不应暴露 tiling。
- **无 strength 混合参数**：只有 `amount`（0–100），语义由各函数内部定义（DRUNet `noise=min(50/255, ref*amount/35)`、FFDNet `strength=min(75/255, ref*amount/35)`、NAFNet `blen

- **无 strength 混合参数**：只有 `amount`（0–100），语义由各函数内部定义（DRUNet `noise=min(50/255, ref*amount/35)`、FFDNet `strength=min(75/255, ref*amount/35)`、NAFNet `blend=amount/100*clip(ref*255/2,.1,1)`）。
- `cuda` 在 GUI 里 = `backend_combo.currentIndex()==0`（"自动加速"档），CPU 档 → False。

### 2.4 `photo.enhance` 补丁设计（~55 行）

**插入位置（精确到行）**：`lumen/commands.py` **末尾追加**（现有 608 行，`project.save` 结束于 `:608`；`_Never` 类在 `:572-574` 可直接复用，无需前移）。

```python
# ============ lumen/commands.py 追加（第 609 行起） ============

#: AI 增强任务状态（宿主轮询/调试用；一次一个任务，对齐 scheduler.A.AI 语义）
_ENHANCE_STATE = dict(busy=False, stage='', progress=0, backend='', error='')

_ENHANCE_ALGORITHMS = {
    # kind -> ((method, 显示名), ...)
    'super': ((0, 'Real-ESRGAN x4plus / RRDB'), (1, 'Real-ESRGAN compact')),
    'denoise': ((0, 'DRUNet 细节保留'), (1, 'NAFNet SIDD'), (2, 'FFDNet 自适应降噪')),
}


def _enhance_progress(value, text):
    _ENHANCE_STATE.update(progress=int(value), stage=str(text))


@command('photo.enhance', 'AI enhancement: super-resolution (2x/4x) or denoising of the edited '
                          'photo. Writes a 16-bit linear DNG copy; the original is never modified.',
         dict(path=PATH,
              kind=dict(type='string', enum=['super', 'denoise'],
                        description='super = upscale, denoise = AI noise reduction.'),
              method=dict(type='integer', minimum=0, maximum=2,
                          description='super: 0 Real-ESRGAN x4plus / 1 Real-ESRGAN compact. '
                                      'denoise: 0 DRUNet / 1 NAFNet SIDD / 2 FFDNet.'),
              scale=dict(type='integer', enum=[2, 4], description='Upscale factor; kind=super only.'),
              amount=dict(type='integer', minimum=0, maximum=100,
                         description='Denoise strength; kind=denoise only. DRUNet/FFDNet base 35, NAFNet mix 70.'),
              folder=dict(type='string', description='Folder of the DNG copy; default: beside the photo.'),
              gpu=dict(type='boolean', description='Allow GPU execution providers (default true).')),
         required=('kind', 'method'), tool='enhance_photo')
def photo_enhance(context, kind, method, scale=2, amount=35, path=None, folder=None, gpu=True):
    from . import restoration, denoise as denoise_module, large_image
    if method >= len(_ENHANCE_ALGORITHMS[kind]):
        raise CommandError(f'unknown method {method} for kind {kind}')
    path = _target(context, path)
    if _ENHANCE_STATE['busy']:
        raise CommandError('another AI enhancement is already running')
    _ENHANCE_STATE.update(busy=True, stage='', progress=0, error='', backend='')
    try:
        context.notify(f'{kind}.{method} {Path(path).name}')
        edits = context.edits(path)
        initialized = context.initialized(path)
        _ENHANCE_STATE.update(stage='reading the full-resolution original…', progress=5)
        # preview_limit=None: AI models need the full-resolution frame, not the 1600px preview.
        source, info = engine.load_image(path, None, develop_reference=not initialized)
        if not initialized:
            # As MainWindow.open_path / batch_export.run does for a photo opened the first time.
            edits['white_balance'] = copy.deepcopy(info.get('white_balance', edits['white_balance']))
            edits['develop'] = copy.deepcopy(info.get('develop', edits['develop']))
        edits = model.validate(edits)
        _ENHANCE_STATE.update(stage='applying the current edits…', progress=15)
        rgb = engine.process(source, edits, engine.Backend('auto' if gpu else 'cpu'))
        del source
        if kind == 'super':
            large_image.validate_size((rgb.shape[0] * scale, rgb.shape[1] * scale))
            noise_reference = None
        else:
            large_image.validate_size(rgb.shape)
            noise_reference = denoise_module.noise_level(rgb)
        _ENHANCE_STATE.update(stage='running the AI model…', progress=25)
        ai_worker.set_status_listener(lambda text: _ENHANCE_STATE.update(stage=text))
        if kind == 'super':
            if method == 0:
                output, backend = restoration.super_resolution(rgb, scale, gpu, _enhance_progress, _Never())
            else:
                output, backend = engine.super_resolve(rgb, scale, ':builtin:', gpu, _enhance_progress, _Never())
        else:
            functions = (restoration.drunet_denoise, restoration.denoise, denoise_module.process)
            options = dict(noise_reference=noise_reference)
            if method != 2:
                options['region'] = None
            output, backend = functions[method](rgb, amount, gpu, _enhance_progress, _Never(), **options)
        ai_worker.set_status_listener(None)
        _ENHANCE_STATE.update(stage='saving the DNG copy…', progress=92)
        target = _reserve_enhance_copy(context, path, folder, kind)
        engine.export_image(target, output, photo=info.get('photo', {}),
                            provenance=dict(operation=f'{kind}.{method}', source=Path(path).name,
                                            backend=backend, scale=scale if kind == 'super' else 1,
                                            amount=amount if kind == 'denoise' else 0))
        _ENHANCE_STATE.update(progress=100, backend=backend)
        return dict(path=path, output=str(target), backend=backend,
                    width=output.shape[1], height=output.shape[0])
    except BaseException as exc:
        _ENHANCE_STATE.update(error=str(exc) or type(exc).__name__, progress=0)
        raise
    finally:
        ai_worker.set_status_listener(None)
        _ENHANCE_STATE['busy'] = False
```

配套 helper（同文件追加）：

```python
def _reserve_enhance_copy(context, path, folder, kind):
    """Unique DNG copy path, O_EXCL style, never the original (ai_dialog.reserve_copy analogue)."""
    folder = Path(folder).expanduser().resolve() if folder else Path(path).parent
    if not folder.is_dir():
        raise CommandError(f'folder not found: {folder}')
    kind_label = 'enhanced' if kind == 'super' else 'denoised'
    for index in range(1, 10000):
        target = folder / f'{Path(path).stem}-{kind_label}{"" if index == 1 else "-" + str(index)}.dng'
        try:
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            return target
        except FileExistsError:
            continue
    raise CommandError('too many copies with the same name; choose another folder')
```

**另外 2 处必改**（否则 `tests/test_v160.py:560` 的 `set(TITLES) == set(commands.REGISTRY)` 断言失败）：

```python
# lumen/palette.py:27（project.save 那行后追加）
    'photo.enhance': N_('AI 增强副本'),
```
```python
# lumen/cli.py:11（docstring 用法行，纯文档）
    lumen-cli run photo.enhance '{"kind":"denoise","method":1}'
```

**顶层 import 需补 1 行**：`commands.py:15-20` 现有 `base64/copy/io/math/Path/typing` —— 已含 `copy` 与 `Path`，需补 `import os`（`_reserve_enhance_copy` 用）。`large_image` **不在顶层 import 里**（`:25` 只到 `nl_edit`），所以补丁内用函数级 `from . import restoration, denoise as denoise_module, large_image`（与 `:383` 的懒加载风格一致，也避免把 GUI 侧模块拖进命令层）。`ai_worker` **不导入顶层**，保持 `:383` 那种 `from . import ...` 懒加载风格，避免命令层把 GUI 侧模块拖进来。

> ⚠️ **不要在本补丁里用 `tr()`**：`commands.py` **没有** `from .i18n import tr`，且该文件全部 39 处错误消息都是英文字面量（如 `:155` `f'file not found: {path}'`）——命令层是给 agent 读的，保持英文是上游既有风格。因此副本目录名用 `enhanced`/`denoised`，落盘形态 `<stem>-enhanced1.dng` / `<stem>-denoised1.dng`（若要与宿主 `find_edited_version` 的 `_edit.*` 约定对齐，宿主在下发 `folder` 时自行控制命名，或按 §8.2 给 scanner 加候选）。

### 2.5 参数 JSON（宿主下发给 sidecar 的实例）

```json
{ "kind": "denoise", "method": 1, "amount": 70, "gpu": true, "folder": "D:/exports" }
{ "kind": "super",   "method": 0, "scale": 4, "gpu": true }
```
必需项 `kind` + `method`；`scale` 仅 super 用，`amount` 仅 denoise 用。多余键会被 `arguments()`（`:111-122`）判为 `unknown argument` 报错——所以宿主必须按 kind 裁剪字段。

### 2.6 为何不能复用 `render.preview` 的 `context.source()`

`preview_image`（`commands.py:507-514`）读 `context.source(path)` 的已加载帧。GUI 上下文里那是全尺寸；但 `session.Session._load`（`session.py:92-105`）里 `document['source']` 是 **`engine.load_image(path)` 默认 `preview_limit=1600` 的解**。`batch_export.run`（`batch_export.py:118`）因此每次重新 `load_image(path, None, develop_reference=not initialized)`。`photo.enhance` 必须照抄，否则 headless/MCP 模式下会对 1600px 预览图做 AI 增强。

---

## 3. 智能蒙版链路（课题 2，P1 即可用）

### 3.1 完整链路（CLI/MCP → ONNX → recipe）

```
agent/宿主 JSON
  → commands.run(session, 'edit.apply', {...})                    commands.py:403
  → nl_edit.plan(before, dict(changes, reset=...))                nl_edit.py:881-994
      · 解析 masks[*].region ∈ REGIONS(13 种)                      nl_edit.py:373-380
      · AI 类 (sky/subject/person/background/foreground) → plan.regions.append((kind, mask))
      · 渐变类 (top/bottom/center/edges) → 直接进 target['masks']（无推理）
  → commands._regions(context, path, plan)                        commands.py:379-395
      · rgb = engine.develop_view(lens.correct(source, edits), edits)   ← 基于镜头校正后的画面！
      · alpha, _ = selection.automatic(rgb, kind, True)           selection.py:60
          └─ session(kind, cuda=False)  [lru_cache maxsize=4]     selection.py:37-43
                 └─ compute.session(path, True)                   compute.py:464-473
                      ├─ isolation_enabled() and not in_worker()  → ai_worker.RemoteSession
                      └─ 否则 → compute.Session（进程内）
      · 覆盖率 <0.0003 → None（丢该区域）                          commands.py:391
  → nl_edit.attach_regions(plan, alphas)                          nl_edit.py:997-1007
      · mask['raster'] = selection.encode(alpha)  (base64 PNG)    selection.py:10-14
  → nl_edit.blend + model.validate + context.apply(...)           commands.py:411-414
```

### 3.2 可工作调用示例（直接可复制）

**（a）CLI 单发（Option B）**：
```bash
lumen-cli run edit.apply "{\"path\":\"D:/p/100EOS5D/IMG_2841.CR2\",\"changes\":{\"masks\":[{\"region\":\"sky\",\"adjustments\":{\"exposure\":-0.55,\"saturation\":14,\"highlights\":-22}}]}}" --headless
```

**（b）MCP stdio（Option A，宿主主力通道）**：
```json
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"apply_edits","arguments":{"changes":{"masks":[{"region":"sky","adjustments":{"exposure":-0.55,"saturation":14,"highlights":-22}}]}}}}
```

**（c）一次多区域 + 渐变（示范参数全集）**：
```json
{"region":"sky",      "adjustments":{"exposure":-0.5,"saturation":12}}
{"region":"person",   "adjustments":{"exposure":0.2,"clarity":10}}
{"region":"foreground","adjustments":{"exposure":0.15}}
{"region":"bottom",   "adjustments":{"exposure":-0.2}}
```

**（d）`render.preview` 验证蒙版是否真的生效**：
```bash
lumen-cli run render.preview "{\"path\":\"D:/p/IMG_2841.CR2\",\"size\":1024}" --headless
```
返回 `{path,width,height,mime,image(base64 JPEG),statistics,output}`。宿主解码 base64 写 `app_cache/lumen/` 后 `convertFileSrc` 即可。

### 3.3 依赖 worker 进程的证据与影响

`selection.session()`（`selection.py:37-43`）默认 `cuda=False`，但 `commands._regions`（`:390`）**硬编码传 `True`**：
```python
alpha, _ = selection.automatic(rgb, kind, True)
```
→ `compute.session(path, True)` → `isolation_enabled()`（`compute.py:459-461`：`LUMEN_AI_ISOLATION != '0'` 且 `requested_mode() != 'cpu'`）→ **`ai_worker.RemoteSession`**。

RemoteSession 链路：
- `_open()`（`ai_worker.py:259-268`）读 `%LOCALAPPDATA%\LUMEN RAW\gpu-compat.json`（`host.py:35-40`）拿 excluded provider 列表 → `('open', key, path, excluded)`
- `Worker.start()`（`:163-172`）用 **`multiprocessing.get_context('spawn')`** 拉起子进程
- 子进程 `_serve()`（`:41-56`）：`compute._IN_WORKER=True` → `winml.preload_system_runtime()` → `logs.configure(filename='lumen-worker.log')` → `compute.coreml_housekeeping()`
- provider 顺序（`compute.provider_plan:283-310`）：CoreML(macOS) → **NvTensorRtRtx(WinML 插件, RTX30+/Win11 24H2+)** → CUDA → DirectML → CPU

**对宿主的 3 个实操影响**：
1. **必须 spawn 模式安全**：PyInstaller 冻结产物里 `multiprocessing` spawn 需要 `multiprocessing.freeze_support()`。lumen 的 `main.py` 入口已含（`main.py` 是 GUI 入口，`cli.py` 经 `main.py --cli` 进入）。宿主若自建 `LumenCLI.spec` 只留 `cli.py` 入口，**必须在 spec 的入口脚本里调 `freeze_support()`**，否则 spawn 子进程会二次执行入口 → 直接挂。
2. **模型文件缺失 = 静默降级**：`selection.session` 抛的异常被 `_regions` 的 `try/except`（`:392-394`）捕获，只往 `plan.notes` 追加一条 `'{kind}: {exc}'`，**该蒙版不建、其余编辑照常生效**。宿主要把 `notes` 透传到前端，否则用户以为 AI 生效了。
3. **GPU 崩溃隔离自动兜底**：`_call()`（`ai_worker.py:270-287`）最多重试 4 次，崩溃 provider 写入 `gpu-compat.json`（同型号 ≥2 个模型崩溃 → `info['all']=True` 永久排除）。宿主无需自己实现。

### 3.4 region → kind → 模型文件映射表

| region（JSON） | kind（内部） | 模型文件 | 输入尺寸 | 说明 |
|---|---|---|---|---|
| `sky` | `sky` | `skyseg.onnx` | 320² | SkySeg，MIT |
| `person` | `person` | `person-deeplab.onnx` | 384² | DeepLabV3-MobileNetV3，21 类 softmax 取 person(15) |
| `background` | `background` | `u2netp.onnx` | 320² | U²-Net 前景概率**取反** |
| `subject` | `subject` → 映射 `background` | `u2netp.onnx` | 320² | 复用同一 session（`selection.py:61`） |
| `foreground` | `foreground` | `midas-small.onnx` | 256² | MiDaS 相对逆深度 → 分位数归一 → 阈值 |
| `top`/`bottom` | `linear` | — | — | 纯几何渐变，**零推理** |
| `center`/`edges` | `radial` | — | — | 纯几何渐变，**零推理** |

> P1 最小可用集 = `u2netp.onnx`(4.36 MiB) + `skyseg.onnx`(167.84 MiB) = **172.21 MiB**，即可覆盖 sky/subject/person/background 四类中三类（person 需再 +42.05 MiB）。

### 3.5 资源查找逻辑（证据）

所有模型路径都是**编译期常量，无环境变量覆盖**：
```python
# selection.py:42 / restoration.py:13 / denoise.py:9 / engine.py:1218 完全同构
path = Path(__file__).resolve().parents[1] / 'assets/models' / filename
# lens.py:47
DB_FOLDER = Path(__file__).resolve().parents[1] / 'assets' / 'lensfun' / 'db'
```
`grep "environ.get('LUMEN"` 全仓 13 处，**无一个指向 assets 目录**（只有 `LUMEN_COMPUTE` / `LUMEN_DML_DEVICE` / `LUMEN_AI_ISOLATION` / `LUMEN_WINML` / `LUMEN_CATALOG` / `LUMEN_CONTROL_NAME` / `LUMEN_COREML_UNITS` / `LUMEN_LANGUAGE` / `LUMEN_LOG_LEVEL` / `LUMEN_EXPERIMENTAL_CUPY` / `LUMEN_TEST_WORKER_CRASH`）。
→ **宿主无法用环境变量把模型重定向到 `app_cache`**；只能把文件写进 sidecar 的 `assets/models/`（详见 §6.3）。

---

## 4. 降噪量化差异（课题 3 —— 前端文案防误导重点）

### 4.1 两套完全不同的东西

| 维度 | recipe 降噪滑块（宿主 XMP 互通目标） | AI 降噪（`photo.enhance`，P2） |
|---|---|---|
| 代码位置 | `engine.reduce_noise`，`engine.py:560-571` | `denoise.process` / `restoration.drunet_denoise` / `restoration.denoise` |
| 算法 | **Lab 空间双边滤波** | ONNX 神经网络（FFDNet / DRUNet / NAFNet） |
| 输入 | 显影后的 Lab | 显影后的 RGB (0-1 float32) |
| 作用域 | **非破坏性 recipe 字段**，`adjustments.denoise` + `adjustments.color_noise` | **一次性**，产出独立 DNG 副本 |
| 可撤销 | 是（recipe 一条 undo） | 否（删副本文件） |
| 修改原片 | 否 | 否 |
| 计算成本 | 每帧预览都算（有 mask 局部重算） | 秒级～分钟级，分块推理 |
| GPU | 走 `engine.Backend` 逐像素图（其实是 OpenCV CPU） | 走 `compute.Session`（DirectML/TRT/CUDA/CoreML/CPU） |
| 宿主侧位置 | `TonalAdjuster.tsx` 目前**只有** 7 个 tonal 滑块，**没有 denoise** | 无 |

### 4.2 recipe 降噪的精确量化（`engine.py:560-571`）

```python
def reduce_noise(x, a):
    """Luminance and color noise reduction (Lab bilateral filters)."""
    if a.get('denoise', 0) > 0 or a.get('color_noise', 0) > 0:
        lab = cv2.cvtColor(x, cv2.COLOR_RGB2Lab)
        if a.get('denoise', 0) > 0:
            smooth = cv2.bilateralFilter(lab[..., 0], 7, max(1., a.get('denoise', 0) / 4), 3)
            mix = a.get('denoise', 0) / 100
            lab[..., 0] = lab[..., 0] * (1 - mix) + smooth * mix
        if a.get('color_noise', 0) > 0:
            mix = a.get('color_noise', 0) / 100
            for c in (1, 2):
                smooth = cv2.bilateralFilter(lab[..., c], 9, max(1., a.get('color_noise', 0) / 3), 4)
                lab[..., c] = lab[..., c] * (1 - mix) + smooth * mix
        x = np.clip(cv2.cvtColor(lab, cv2.COLOR_Lab2RGB), 0, 1)
    return x
```
- `denoise`：亮度通道 L，核 7，sigmaColor = `denoise/4`（0→内核禁用），sigmaSpace=3，混合比 `denoise/100`
- `color_noise`：a/b 两通道，核 9，sigmaColor = `color_noise/3`，sigmaSpace=4，混合比 `color_noise/100`
- 二者都是 **SPATIAL_KEYS**（`engine.py:322`）成员 → 一旦非零就关掉 fused GPU 图（`has_spatial`，`engine.py:329-330`），走 `spatial_details` 分支（`engine.py:938`）
- 参数范围（`nl_edit.PARAMS`，`nl_edit.py:356`）：`denoise` 描述 "减少亮度噪点；高 ISO 照片可用 20–50"

### 4.3 AI 降噪的精确量化

| 算法 | amount 语义 | 噪声参考来源 | 硬上限 |
|---|---|---|---|
| DRUNet | `noise = min(50/255, reference * amount/35)` → 作为 `sigma` 输入 | `denoise.noise_level`（`denoise.py:13-24`，9 区 Haar MAD，clip 到 `[0.5/255, 60/255]`） | sigma ≤ 50/255 |
| FFDNet | `strength = min(75/255, reference * amount/35)` | 同上 | sigma ≤ 75/255 |
| NAFNet | `blend = amount/100 * clip(reference*255/2, .1, 1)`，输出与原图线性混合 | 同上 | blend ∈ [0,1] |

`amount=0` 时三者都**直接返回原图 copy**（`restoration.py:87-89, 104-106`、`denoise.py:30`），backend 标签会写 "强度 0"。

### 4.4 前端文案红线（写进验收）

1. 宿主要做 AI 降噪 UI，入口必须叫 **"AI 去杂色（生成副本）"** 之类，**禁止**叫"降噪滑块加强档"；
2. recipe 的 `denoise`/`color_noise` 若未来接到宿主面板，tooltip 必须写 "经典双边滤波（双向边保留平滑）"，**不得出现 "AI"**；
3. `edit.apply changes.adjustments.denoise` 走的是**经典滤波**，不触发任何 ONNX 模型 → 宿主把它归类到 P1 调色互通，不占 AI 体积预算；
4. AI 降噪结果**不应**回写 recipe（lumen 的设计就是产副本 `reserve_copy`，`ai_dialog.py:18-29`）。宿主若要"看起来连续"，做法是：新副本加入选片列表 + `find_edited_version` 识别（见 §7.3 的 scanner 一行补丁）。

---

## 5. GPU 栈（课题 4）

### 5.1 三条路径全景

```
                    ┌─ engine.Backend('auto') ──┐
                    │  (逐像素显影图，gpu_graphs)  │
   engine.process ──┤                            ├─ DirectML / CuPy(实验) / Metal / CPU
                    └─ compute.Session(path) ────┘
                       (ONNX 模型：AI 超分/降噪/蒙版)
                           provider_plan(): CoreML → NvTensorRtRtx → CUDA → DirectML → CPU
```

**路径 A：逐像素显影图（`engine.Backend`，`engine.py:333-395`）**
- Windows：先试 CuPy（`compute.cupy_enabled()` 默认 False，需 `LUMEN_EXPERIMENTAL_CUPY=1`），再试 DirectML（`'DmlExecutionProvider' in ort.get_available_providers()`）
- macOS：`_init_metal()` → `metal.pipeline()`（MSL 着色器，与 gpu_graphs 同公式）
- `compute.session(gpu_graphs.model(kind), True)`（`engine.py:414-416`）：传的是 **bytes**（内存图），`compute.Session.models = not isinstance(path, bytes)` → **False → 不走 TensorRT-RTX 插件路径**，只走 CUDA/DirectML
- 失败即 `_disable_gpu` + CPU（`engine.py:401-410`）

**路径 B：AI 模型（`compute.Session`，`compute.py:345-456`）**
- `provider_plan`（`:283-310`）顺序：CoreML(macOS) → NvTensorRtRtx(仅 NVIDIA RTX30+ & Win11 24H2+ & `LUMEN_WINML!=0`) → CUDA → DirectML → **CPU 兜底**（`:399-405`）
- 首次推理**验证 GPU kernel 真的跑了**（`_gpu_kernels_in_profile`，`:336-342`，读 ORT profiling JSON），没跑就 `_cpu_fallback`（`:407-418`）
- DirectML 分支特调：`enable_mem_pattern=False` + `ORT_SEQUENTIAL`（`:380-382`）

**路径 C：worker 隔离（`ai_worker`）**
- 进程内 Session 只用于 `compute.in_worker()`（即 worker 子进程里）；宿主侧 `compute.session()` 一律返回 `RemoteSession`
- 原生崩了 → `record()` 写 `gpu-compat.json` → 重启 worker → 换 provider 重试（最多 `MAX_RETRIES=4`）

### 5.2 flavor 对比（宿主 sidecar 选型用）

| ONNX Runtime wheel | 覆盖 provider | 体积量级 | 对中端 Windows x64 机的意义 |
|---|---|---|---|
| `onnxruntime`（CPU，requirements.txt 默认） | CPU | 最小 | 能跑但 AI 秒级→分钟级，不可接受 |
| `onnxruntime-directml` | CPU + DirectML | 中 | **AMD/Intel/NVIDIA 通吃**，Win10+ |
| `onnxruntime-gpu`（`requirements-gpu.txt`，1.23.2） | CPU + CUDA | 大（需 CUDA 12 + cuDNN 9 运行时） | 只惠及 NVIDIA；中端机多为 Intel/AMD 集显 → 白背体积 |
| **`onnxruntime-windowsml`（`requirements-directml.txt`，1.30.0.202609102321）** | CPU + DirectML + **WinML 插件目录（可下 TensorRT-RTX）** | 中 | **lumen 自己 Windows 发版用的就是这个**（`build-directml.ps1:8` 断言 `DmlExecutionProvider` 在册） |

### 5.3 sidecar 默认 flavor 决策（依据：宿主用户面 = Windows x64 中端机）

**结论：`onnxruntime-windowsml==1.30.0.202609102321`**（照抄 `requirements-directml.txt`），理由：

1. **覆盖最广**：DirectML 是 DXGI 层抽象，Intel UHD/Iris、AMD RDNA、NVIDIA 全系都能用；`onnxruntime-gpu` 的 CUDA 在中端机上大概率不可用（无独显或驱动不带 cuDNN）。
2. **与上游实测一致**：lumen 1.6.0 Windows 便携版就是 DirectML 构建（`build-directml.ps1` + `LumenRAW.spec:1` 注释 "collects the active ONNX Runtime (Windows ML build with DirectML)"），COMMIT 43b4ebe 的 GPU 行为已被这条路径覆盖；换 CUDA wheel 等于进入未实测领域。
3. **RTX 用户白拿 TensorRT for RTX**：WinML 目录按需下载（`winml.ensure`，`winml.py:64+`），不需要宿主预先打包 EP。
4. **一个 wheel 同时满足路径 A（逐像素图）与路径 B（AI 模型）**，不需要双 ORT 安装（requirements 注释明确警告两个 wheel 提供同一个 `onnxruntime` 包，不能共存）。

**CPU 兜底路径（必须保住）**：
- `onnxruntime` 包本身就是"CPU 一定能跑"的基线（`requirements.txt` 就装它）；DirectML 不可用时 `Session.__init__` 的 `for...else` 落到 `providers=['CPUExecutionProvider']`，并设 `self.warning = tr('当前 ONNX 环境没有可用的 GPU 执行设备。')`（`:405`）
- 宿主侧可**显式强制 CPU**：给 sidecar 进程设 `LUMEN_COMPUTE=cpu`（`compute.requested_mode()`，`:138-141`）。这同时关掉 worker 隔离（`isolation_enabled()` 里 `requested_mode() != 'cpu'` 条件）→ 变成进程内推理，**崩溃不再被隔离**。所以：只在用户显卡明确有问题时用，并同时接受崩溃风险。
- 另一个有用的强制项：`LUMEN_DML_DEVICE=<DXGI index>`（`compute.py:99-114`），多显卡（独显+核显）时手动选适配器，`preferred_adapter()` 默认按 dedicated VRAM 最大者选。

### 5.4 宿主必须做的 4 件 GPU 相关事

1. sidecar venv 装 `requirements-directml.txt`（**不是** `requirements-gpu.txt`）；
2. 不设 `LUMEN_COMPUTE`（保持 auto）→ 让 DirectML/TRT/CUDA 自动协商，CPU 兜底；
3. `LumenCLI.spec` 排除 `cupy`、`torch`、`onnx`（照抄 `LumenRAW.spec:28` 的 excludes）；
4. 侧信道的 `gpu-compat.json` 写在 `%LOCALAPPDATA%\LUMEN RAW\`——宿主做"重置 GPU 兼容记录"按钮时删这个文件即可（`ai_worker.CompatRecord`，`:110-146`）。

---

## 6. 模型权重（课题 5）

### 6.1 清单与体积（数据源：`assets/runtime-assets.json` + 各 `assets/models/*.json` manifest）

**智能蒙版（4 个）**

| 文件 | 字节 | MiB | 许可 | manifest | 来源 URL |
|---|---:|---:|---|---|---|
| `skyseg.onnx` | 175,997,079 | 167.84 | MIT (Sky-Segmentation-and-Post-processing) | `selection-models.json` | huggingface.co/JianyuanWang/skyseg |
| `person-deeplab.onnx` | 44,094,917 | 42.05 | BSD-3-Clause (TorchVision) | `selection-models.json` | download.pytorch.org/.../deeplabv3_mobilenet_v3_large-fc3c493d.pth |
| `u2netp.onnx` | 4,574,861 | 4.36 | Apache-2.0 (U-2-Net) | `selection-models.json` | github.com/danielgatis/rembg/releases/tag/v0.0.0 |
| `midas-small.onnx` | 66,764,249 | 63.67 | MIT (Intel ISL MiDaS) | `v11-models.json` | github.com/isl-org/MiDaS/releases/download/v2_1/model-small.onnx |
| **小计** | **291,431,106** | **277.93** | | | |

**AI 增强（5 个）**

| 文件 | 字节 | MiB | 许可 | manifest | 来源 URL |
|---|---:|---:|---|---|---|
| `realesrgan-x4plus.onnx` | 67,051,648 | 63.95 | BSD-3-Clause / Apache-2.0 | `v12-models.json` | github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth |
| `realesr-general-x4v3.onnx` | 4,866,387 | 4.64 | BSD-3-Clause | `model-info.json` | github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0 |
| `nafnet-sidd.onnx` | 117,090,863 | 111.67 | MIT (Megvii) | `v12-models.json` | Google Drive ID `1lsByk21Xw-6aW7epCwOQxvm6HYCQZPHZ` |
| `drunet-color.onnx` | 130,596,443 | 124.55 | MIT (Kai Zhang) | `v12-models.json` | github.com/cszn/KAIR/releases/download/v1.0/drunet_color.pth |
| `ffdnet-color.onnx` | 3,414,804 | 3.26 | MIT (KAIR / Kai Zhang) | `v11-models.json` | github.com/cszn/KAIR/releases/download/v1.0/ffdnet_color.pth |
| **小计** | **323,020,145** | **308.06** | | | |

**合计 9 个 = 614,451,251 B = 585.99 MiB**（与 `runtime-assets.json` 的 models 合计 586.0 MiB 一致）。

**排除项**：`sensevoice`（`model.int8.onnx` 239,233,841 B ≈ 228 MiB + `tokens.txt`，FunASR Model License 1.1）—— 语音输入，选片场景用不到；且 `assets/models/sensevoice/` 在 `.gitignore` 中被单独忽略并通过 `install_direct()` 单独拉取（`fetch_assets.py:77-100`）。

### 6.2 分发模式证据（决定"必须按需下载"）

```gitignore
# lumen-raw/.gitignore
*.onnx          ← 所有权重都不进 git
*.pth
assets/NotoSansSC.ttf
assets/exiftool/
```
- `git ls-files assets/models` 只返回 **4 个 .json manifest**，0 个 .onnx
- `git ls-files assets | wc -l` = 76（lensfun 58 + 4 manifest + license/ico/字体等）
- `tools/fetch_assets.py` 是**构建期**工具：从 GitHub release 下整包 zip（`assets/runtime-assets.json` 的 `bundle.url` = `v1.2.1/LumenARW-1.2.1-RuntimeAssets.zip`，592,599,134 B ≈ 565 MiB）→ 校验 bundle sha256 → 逐成员校验 → `os.replace` 落位 → 再全量 verify
- **运行期零下载代码**：`grep -rn "urllib\|requests" lumen/*.py` 只有 `nl_edit.py` 的 LLM HTTP 客户端（自然语言修图，与本课题无关）。`white_balance.py` 调 ExifTool 子进程（非下载）。

→ **宿主必须自己实现按需下载器**，lumen 不会帮你下。

### 6.3 按需下载方案 —— 目录结构设计

**关键约束（已在 §3.5 证明）**：模型路径是编译期常量 `Path(__file__).resolve().parents[1] / 'assets/models'`，**无环境变量可改**。所以下载目标只有两个候选：

| 候选 | 优点 | 缺点 |
|---|---|---|
| **① sidecar 自带 `assets/models/`** | 与上游路径完全一致，零改动 | ① 装进安装包就违反"AI 权重不进安装包"决策；② Program Files 只读，普通用户无权写 |
| **② 宿主 `app_cache/lumen-models/`** | 可写、可清理、和现有缩略图缓存一致（`thumbnail.rs:11-24` 已有 `app_cache` 优先逻辑） | lumen 找不到 → **必须额外机制** |

**推荐：② + 启动时把 sidecar 的 `assets/models` 做成目录联接（junction）指向 `app_cache/lumen-models`。**

```
%LOCALAPPDATA%\GalleryCulling\            ← 或 <安装目录>\app_cache\lumen-models\（与 thumbnail 保持一致）
├─ lumen-models\
│  ├─ skyseg.onnx                  (167.84 MiB)
│  ├─ u2netp.onnx                  (  4.36 MiB)
│  ├─ person-deeplab.onnx          ( 42.05 MiB)
│  ├─ midas-small.onnx             ( 63.67 MiB)
│  ├─ realesrgan-x4plus.onnx       ( 63.95 MiB)
│  ├─ realesr-general-x4v3.onnx    (  4.64 MiB)
│  ├─ nafnet-sidd.onnx             (111.67 MiB)
│  ├─ drunet-color.onnx            (124.55 MiB)
│  ├─ ffdnet-color.onnx            (  3.26 MiB)
│  └─ .manifest.json               (每个文件的 bytes + sha256 + 来源，复制自 lumen manifest)
└─ lumen-gpu-compat.json           (可选副本；lumen 自己写 %LOCALAPPDATA%\LUMEN RAW\)

<sidecar>/_internal/assets/models   ──junction──►  app_cache/lumen-models
```

宿主启动时（`lumen_bridge.ensure_started()` 内）一次性执行：
```rust
// 伪代码
fn ensure_model_dir(sidecar: &Path, cache: &Path) -> io::Result<()> {
    let target = sidecar.join("_internal/assets/models");
    let source = cache.join("lumen-models");
    fs::create_dir_all(&source)?;
    if !target.exists() { fs::create_dir_all(&target)?; }
    // 若 target 为空目录 → 删掉，建 junction（Windows: junction 不需要管理员权限）
    if is_dir_empty(&target)? {
        fs::remove_dir(&target)?;
        junction(&source, &target)?;          // winapi 的 DeviceIoDevice FSCTL_SET_REPARSE_POINT
    }
    Ok(())
}
```

**下载器规格（照抄 `fetch_assets.py` 的安全模型）**：
1. 从宿主内置 manifest（把 `assets/models/*.json` 的 9 项 + bytes + sha256 抄进 Rust/TS 常量表）读目标；
2. 下载到 `lumen-models/.tmp-<name>` → **校验 bytes + sha256 通过才 `os.replace`**（`fetch_assets.py:97-100` 同款）；失败即删临时文件，**绝不留半成品**；
3. 只下**当次任务需要的**：`edit.apply masks[region]` 只需要该 region 的模型；`photo.enhance kind=super method=0` 只需要 `realesrgan-x4plus.onnx`；
4. 展示进度/取消（宿主 UI），失败给"重试/换源/改用 CPU 算法"三选一；
5. 已存在且 sha256 匹配 → 跳过（`fetch_assets.py:87` 同款幂等）。

**分级下发建议**：

| 阶段 | 下载内容 | 追加体积 |
|---|---|---|
| P1 最小组 | `u2netp` + `skyseg` | +172.21 MiB |
| P1 完整组 | + `person-deeplab` + `midas-small` | +105.72 MiB（累计 277.93） |
| P2 轻量增强 | `realesr-general-x4v3` + `ffdnet-color` | +7.90 MiB |
| P2 高画质增强 | `realesrgan-x4plus` / `nafnet-sidd` / `drunet-color` | 用户点哪个下哪个（+63.95 / +111.67 / +124.55） |

### 6.4 lensfun 数据库（镜头校正附带）

- **git 跟踪**：`git ls-files assets/lensfun` = 58 文件（56 个 xml + `COPYING.CC_BY-SA_3.0` + `README.txt`），合计 **5,270,149 B ≈ 5.02 MiB**（其中 `db/*.xml` 5,246,786 B）
- **不在 runtime-assets.json 里**（`grep lensfun assets/runtime-assets.json` 命中 0）→ 说明它**不随资源包分发，而是随源码/构建目录走**
- 许可 CC BY-SA 3.0，仅数据；lumen **未链接 lensfun C 库**（`THIRD_PARTY.md` + `lens.py:1-9` docstring 明示 "no lensfun library is linked"）
- → **直接打进 sidecar（+5 MiB），零下载成本**，只需在宿主 notices 里署名

---

## 7. 镜头校正（课题 6）

### 7.1 lumen 侧现状：已全自动生效，宿主零代码

`lens.py` 的调用点在渲染主链路上，不是可选插件：
```python
# engine.py:917-919（process 内，1.5.1 起"校正优先"）
lens_key = lens.key(edits.get('lens'))
corrected = cache.get('lens', _key(lens_key, version), lambda: lens.correct(source, edits)) if lens_key else source
```
→ 只要 recipe 里 `edits['lens']['enabled'] = True` 且 `profile` 已解出，`engine.process` 输出的就是校正后的画面。宿主 P0 已经在调 `render.preview` / `photo.export` → **镜头校正自动跟着来**。

### 7.2 recipe 字段结构（`lens.defaults()`，`lens.py:56-61`）

```python
dict(enabled=False, distortion=100., vignetting=100., chromatic=True, manual=None, profile=None)
```
- `enabled` / `distortion`(0–200%) / `vignetting`(0–200%) / `chromatic`(bool)：**用户意图**，可手写
- `manual`：`dict(maker, model)`，手动指定镜头
- `profile`：`solve()` 解出的分辨率无关系数（`dict(distortion[tca/vignetting/center/focal/crop/aperture/distance...])`），由 `lens.identify`/`lens.prepare` 从 EXIF 自动匹配数据库生成
- 校验：`lens.validate`（`lens.py:710-760`），数值越界/类型错 → `ValueError`，被 `model.validate` 兜住

### 7.3 宿主接入点（P2，3 行级改动）

| 接入方式 | 宿主动作 | 说明 |
|---|---|---|
| **① 只读跟随（推荐 P2 首选）** | **零代码** | 宿主不做镜头 UI；用户在 LUMEN RAW 里开的校正，宿主 `render.preview`/`photo.export` 自动带上 |
| ② `edit.apply` 开 lens | `changes` 里**没有** lens 键（`CHANGES` 白名单只列 adjustments/hsl/grading/effects/monochrome/curve/masks，`commands.py:367-376`）→ 需要另开命令或扩 `CHANGES` | 若宿主想在自己的 UI 里"一键启用镜头校正"，最小改法是加 `lumen_apply_lens_cmd` → sidecar `edit.apply` + 直接改 recipe 的 `lens.enabled`（lumen 内部命令做不到，需走 `edit.apply` 的 changes 扩展或新增命令） |
| ③ recipe 直通 | 宿主 `edit.get full=true` 拿整份 recipe → 改 `lens` → `edit.apply` | `edit.apply` 的 `changes` 会被 `nl_edit.plan` 过滤，**未知键忽略** → lens 改动会被静默丢弃。**所以②③都需要 lumen 侧小补丁** |

**明确建议**：P2 只做 ①（零成本、零风险、无补丁）。宿主 UI 上的"镜头校正"开关若要出现，排在 P2 末尾或 P3，且需要上游补丁支持（把 `lens` 加进 `edit.apply` 的 changes 词表 ≈ 10 行，另立报告）。

### 7.4 `lens_panel.py` 的 GUI 参数（参考映射）

| GUI 控件 | recipe 字段 | 范围 |
|---|---|---|
| 启用配置文件校正 (checkbox) | `lens.enabled` | bool |
| 畸变校正 % | `lens.distortion` | 0–200（默认 100） |
| 暗角校正 % | `lens.vignetting` | 0–200（默认 100） |
| 去除横向色差 (checkbox) | `lens.chromatic` | bool |
| 选择镜头… / 按照片自动识别 | `lens.manual` | `{maker, model}` |
| 新打开的照片自动启用 | **settings.ini `lens_auto_e
nable`（`lens_panel.py:18-22`，**不在 recipe 里**） | '0'/'1' |

⚠️ 最后一项是 `i18n.setting(AUTO_KEY)` 持久化的**编辑器级**偏好 → **headless session 默认不启用 lens**（`session.py:107-111`：只有 `new and auto_enable()` 才自动开）。宿主若想默认开，要么让用户在 LUMEN RAW 里勾一次（settings.ini 全局生效），要么打补丁。**这也强化了"P2 只做只读跟随"的建议**：宿主用户自己在编辑器里开好，宿主渲染自然带上。

### 7.5 数学自实现的范围（合规口径）

`lens.py` 自实现：PT 多项式畸变（`_radial`，`:565-568`）、横向色差（`effective()` 的 tca 系数，`:547-558`）、暗角（v1/v2/v3 六次项 + `fill_zoom` 自动放大填满，`:602-623`）、`cv2.remap` 采样（`apply`，`:624+`，`SUBPIXEL=32` 亚像素栅格对齐）、Hermite 插值标定（`_hermite`/`_along_focal`，`:408-438`）、EXIF→镜头匹配（`identify`/`_match_lens`/`_score`，`:343-394`）。
→ **无 LGPL 链接**，只借 CC BY-SA 3.0 数据。宿主 notices 收录 `assets/lensfun/COPYING.CC_BY-SA_3.0` + 署名即可。

---

## 8. 宿主侧空白确认（课题 7）

### 8.1 `src-tauri/Cargo.toml` 逐项 grep 实证

对 `Cargo.toml`（47 行）与 `src-tauri/src/*.rs`（1841 行）做大小写不敏感检索：

| 检索词 | 命中 | 说明 |
|---|---|---|
| `ort` / `onnxruntime` | **0** | 无 ONNX Runtime 绑定 |
| `candle` | 0 | 无 HuggingFace candle |
| `tract` | 0 | 无 tract 推理 |
| `rawloader` / `rawler` / `libraw` / `rawpy` | **0** | 宿主自己**不解码 RAW**（这是 P0 依赖 sidecar 的根因） |
| `opencv` / `imageproc` | 0（`image` crate 有，仅 jpeg/png/webp） | 无 CV 能力 |
| `dml` / `directml` / `coreml` / `metal` / `cuda` / `wgpu` | **0** | 无 GPU 计算 |
| `denoise` / `noise` / `esrgan` / `upscale` / `superres` / `segment` | **0** | 无 AI 语义代码 |
| `mask` | **0** | 蒙版概念在宿主不存在 |
| `lens` | 12 处，**全部是** `models.rs:23` 的 `pub lens_model: Option<String>` 及其 scanner/xmp/commands 读写链 | **EXIF 元数据字段，非镜头校正** |

**结论：宿主侧 AI/降噪/镜头校正方向 100% 空白，且不具备自建能力（无 RAW 解码 + 无推理框架 + 无 GPU）→ 100% 依赖 sidecar。** 这条结论同时否掉"在 Rust 侧用 candle 复刻 AI 降噪"的念头：宿主连 RAW→RGB 都要靠 sidecar。

### 8.2 宿主新增文件清单

#### P1（智能蒙版，仅需模型 + 前端，无宿主新文件）

| 文件 | 性质 | 内容 |
|---|---|---|
| `src-tauri/src/lumen_bridge.rs` | 新增（P0 已建） | 复用；不改 |
| `src/services/api.ts` | 改 | 加 `lumenApplyEdits(changes)` 包装（若 P0 未建） |
| `src/components/*` | 改 | AI 蒙版入口（天空/人物/背景/近景四按钮 + 说明） |
| `app_cache/lumen-models/*.onnx` | 运行时下载 | 见 §6.3 |

#### P2（AI 增强）

| 文件 | 新增/改 | 职责 | 预估行数 |
|---|---|---|---|
| `src-tauri/src/lumen_enhance_cmd.rs` | **新增** | `lumen_enhance_cmd` 命令：参数校验 → `LumenBridge::one_shot("photo.enhance", json)` → 返回 DNG 路径 | ~90 |
| `src-tauri/src/lumen_models.rs` | **新增** | 模型 manifest 常量表（9 项 bytes+sha256+url）+ `ensure_model()` 下载/校验/落位 + junction | ~180 |
| `src-tauri/src/commands.rs` | 改 | 加 `lumen_enhance_cmd` + `lumen_enhance_status_cmd`（进度轮询） | +40 |
| `src-tauri/src/lib.rs` | 改 | `generate_handler!` 注册 2 条（`:23-38` 数组内追加） | +2 |
| `src-tauri/src/scanner.rs` | 改 | `find_edited_version` 候选加 `{stem}_Lumen.dng` / `{stem}_enhance.dng`（`:17-26` 数组加项） | +2 |
| `src-tauri/tauri.conf.json` | 改 | `bundle.externalBin` 指 `lumen-cli`（P0 已做）；不改 | 0 |
| `src/services/api.ts` | 改 | `lumenEnhance(kind, method, scale?, amount?)` / `lumenEnhanceStatus()` | +25 |
| `src/components/AiEnhanceModal.tsx` | **新增** | AI 增强面板（仿 `ai_dialog.py` 参数集：kind / method / scale / amount） | ~200 |
| `src/components/TonalAdjuster.tsx` | 改（**仅文案**） | 若加 denoise 滑块，tooltip 标"经典双边滤波（非 AI）"；"AI 去杂色"按钮跳到 AiEnhanceModal | +15 |
| `.plan/patches/photo_enhance.patch` | 新增 | 对钉死 commit 的 quilt 补丁（§2.4 全部改动） | — |
| `THIRD-PARTY-NOTICES.txt` | 新增 | 9 模型许可 + lensfun CC BY-SA 3.0 + BasicSR/KAIR/Apache 结构许可 | — |

**lumen-raw 侧 P2 补丁清单**（全部落在 `.plan/patches/`，宿主构建 sidecar 时应用）：

| 文件 | 改动 | 行数 |
|---|---|---|
| `lumen/commands.py` | 追加 `photo.enhance` + `_ENHANCE_STATE` + `_ENHANCE_ALGORITHMS` + `_enhance_progress` + `_reserve_enhance_copy`；补 `import os` | +70 |
| `lumen/palette.py:27` | `'photo.enhance': N_('AI 增强副本'),` | +1 |
| `lumen/cli.py:11` | docstring 用法示例行 | +1 |
| `lumen/session.py:108` | `from .lens_panel import auto_enable` → 函数内懒导入（**P0 补丁，Qt 剥离必需**） | 改 1 |
| `lumen/commands.py:549` | `from . import batch_export` → 函数内懒导入（**P0 补丁**） | 改 1 |

> `palette.py` 那 1 行**不是可选项**：`tests/test_v160.py:560` 断言 `set(TITLES) == set(commands.REGISTRY)`，漏了直接红。

---

## 9. Step-by-step 实施步骤（每步 = 可验证动作 + 验收标准）

> 前置约定：步 1–3 属 P0/P1 共用；步 4–6 是 P1 智能蒙版闭环；步 7–8 是 P2 AI 增强；步 9 是 P2 镜头校正；步 10 是回归。所有命令均在**只读**两个仓库的前提下可执行（除步 7 需在 lumen 的**副本**上打补丁）。

### 步 1 · sidecar 无 Qt 冒烟（P0 收尾，P1 阻塞项）

**动作**：建 venv 只装 `rawpy/numpy/opencv-python-headless/tifffile/onnxruntime-windowsml`（**不装 PySide6**），打上 §8.2 的两个懒导入补丁，然后：
```bash
python main.py --cli commands > cmds.json
python main.py --cli info D:/p/IMG_2841.CR2
python main.py --cli render D:/p/IMG_2841.CR2 D:/out/x.jpg --size 1600
```
**验收**：
- [ ] 三条命令退出码 0，stdout 为合法 JSON；`cmds.json` 里**不含**任何 GUI 报错栈；
- [ ] `python -c "import PySide6"` 确认**未安装**；
- [ ] `x.jpg` 尺寸长边 1600，非内嵌 JPEG 直出（对比 Host `getThumbnail` 的 200px 图可辨）。

### 步 2 · GPU flavor 落定（P2 前置，但 P1 蒙版也要 GPU）

**动作**：在 sidecar venv 装 `requirements-directml.txt`（前置先 `pip uninstall -y onnxruntime`），然后跑上游自检：
```bash
python tools/check_gpu.py
python -c "import onnxruntime as o; print(o.get_available_providers())"
```
**验收**：
- [ ] 输出含 `DmlExecutionProvider`；
- [ ] `check_gpu.py` 通过（它会实际跑一个小模型验证 GPU kernel）；
- [ ] 记录本机 `python -c "from lumen import compute; print(compute.preferred_adapter())"` 的适配器元组 → 作为后续 backends 字段的期望值。

### 步 3 · 模型按需下载器（P1 的最小集）

**动作**：宿主实现 `lumen_models.rs` 的 `ensure_model()`；首批只下 2 个：
```
u2netp.onnx      4,574,861 B   sha256 309c8469...f4ddd8
skyseg.onnx  175,997,079 B   sha256 ab9c34c6...9aa1d39
```
下载到 `app_cache/lumen-models/`，校验通过后建 junction → `<sidecar>/_internal/assets/models`。
**验收**：
- [ ] `app_cache/lumen-models/` 出现 2 个文件，字节数与 manifest 完全一致；
- [ ] junction 建成后 `<sidecar>/_internal/assets/models/skyseg.onnx` 可读且 `Get-Item` 显示 `LinkType: Junction`；
- [ ] 故意把 `skyseg.onnx` 改 1 字节 → `ensure_model()` 重下并还原；
- [ ] 断网再调 → 返回明确错误（不崩溃、不留 `.tmp` 半成品）。

### 步 4 · CLI 触发 AI 蒙版 ★核心验收

**动作**（对 CC0/自有样张，取一张有明显天空的风景 RAW）：
```bash
python main.py --cli run edit.apply "{\"path\":\"D:/p/sky.CR2\",\"changes\":{\"masks\":[{\"region\":\"sky\",\"adjustments\":{\"exposure\":-0.6,\"saturation\":15}}]}}" --headless
```
**验收**：
- [ ] 退出码 0；返回 JSON 的 `applied` 里出现 `masks[0]` 类似描述，`state.masks` 长度为 1，`notes` 为**空数组**（若 notes 含 `sky: ...` → 模型缺失或 provider 失败，按 §3.3 排查）；
- [ ] 紧接 `edit.get full=true` 返回的 `recipe.masks[0]` 含 `kind:"sky"`、`raster`（base64 PNG，长度 > 1000）、`feather:10.0`；
- [ ] **视觉验收**：`render.preview` 出的图天空区域明显压暗、饱和度升高，地面不变 → 截图对比 `original=true` 版本；
- [ ] `%LOCALAPPDATA%\LUMEN RAW\gpu-compat.json`：**不存在或为空**（存在且非空 = 发生了 GPU 原生崩溃，需按 §5.1 路径 B 追查）。

### 步 5 · 多 region + 渐变 + MCP 通道

**动作**：
```bash
python main.py --cli run edit.apply "{\"path\":\"D:/p/sky.CR2\",\"changes\":{\"masks\":[{\"region\":\"sky\",\"adjustments\":{\"exposure\":-0.5}},{\"region\":\"bottom\",\"adjustments\":{\"exposure\":-0.25}}]}}" --headless
```
再用 MCP（宿主 Option A 通道）发 `apply_edits`，`render_preview` 取图。
**验收**：
- [ ] 两次调用都 ok；`state.masks` 长度 2，且 `kind` 分别为 `sky` 与 `linear`；
- [ ] MCP `tools/list` 里能见到 `apply_edits` / `render_preview`（宿主握手断言用）；
- [ ] `render_preview` 返回 `content[0].type == "image"`（对齐 `tools/check_cli.py:61` 的判据）；
- [ ] 超上限：一次请求 5 个新 region → `notes` 含"一次最多新增 4 个蒙版"（`nl_edit.py:973-975`），且**不报错中断**。

### 步 6 · worker 隔离与崩溃降级

**动作**：
```bash
# a) 关隔离对比
LUMEN_AI_ISOLATION=0 python main.py --cli run edit.apply "{...sky...}" --headless
# b) 模拟 GPU provider 崩溃（上游测试钩子）
LUMEN_TEST_WORKER_CRASH=skyseg.onnx python main.py --cli run edit.apply "{...sky...}" --headless
```
**验收**：
- [ ] (a) 正常出图，`backend` 字符串里带 `CPUExecutionProvider` 或 GPU 名（证明隔离只是进程边界）；
- [ ] (b) 命令**不整体失败**：返回 JSON 带 warning/notes，`%LOCALAPPDATA%\LUMEN RAW\gpu-compat.json` 生成且含 `skyseg.onnx`；
- [ ] (b) 之后再跑一次正常 sky → 自动跳过崩溃 provider，仍出图；
- [ ] 删掉 `gpu-compat.json` → 行为回到首次。

### 步 7 · `photo.enhance` 补丁（P2）

**动作**：在 lumen 的**工作副本**上按 §2.4 打 `.plan/patches/photo_enhance.patch`，然后：
```bash
python -m pytest tests/test_v160.py -q                 # 上游回归
python main.py --cli run photo.enhance "{\"kind\":\"denoise\",\"method\":2,\"amount\":35,\"path\":\"D:/p/noisy.ARW\"}" --headless
python main.py --cli run photo.enhance "{\"kind\":\"super\",\"method\":1,\"scale\":2,\"path\":\"D:/p/small.ARW\"}" --headless
python main.py --cli run commands > c2.json && grep -c photo.enhance c2.json
```
**验收**：
- [ ] `test_v160.py` 全绿（尤其 `:560` 的 palette 断言）；
- [ ] `c2.json` 里 `photo.enhance` 存在且 `parameters.properties` 含 `kind/method/scale/amount/folder/gpu`；
- [ ] 两次 enhance 退出码 0，返回 `{path, output, backend, width, height}`；`output` 指向 `<stem>-去杂色1.dng` / `<stem>-增强1.dng`，**原文件 mtime 与 sha256 不变**；
- [ ] DNG 副本尺寸：denoise 与原图一致；super 2× 面积 ×4；
- [ ] `method=1` 的 denoise 只需 `nafnet-sidd.onnx`；缺该文件时错误信息里**明确点名缺失文件**（不是泛泛 "AI 推理进程异常"）；
- [ ] `kind=super, method=0` 缺 `realesrgan-x4plus.onnx` 时同理；
- [ ] `kind` 与 `method` 不匹配（如 `kind=denoise, method=1` 对 super 语义越界 / `kind=super, method=2`）→ `unknown method 2 for kind super`，退出码 1；
- [ ] `scale=3` → `_check` 拒绝（enum 只有 2/4）。

### 步 8 · 宿主端到端（Option B 单发）

**动作**：宿主加 `lumen_enhance_cmd`（仿 `luminar.rs:129-159` 的 `spawn_blocking` + 退出码判错），前端 `AiEnhanceModal` 调 `api.lumenEnhance(...)`。
**验收**：
- [ ] 点击"AI 去杂色（NAFNet 70）"→ 进度可观测、可取消（宿主侧 kill 子进程，`_ENHANCE_STATE` 不复位也不影响下次）；完成后选片列表出现新 DNG；
- [ ] `scanner.rs` 的 `find_edited_version` 能认出该副本 → 卡片显示"已编辑"角标（**需先加 `{stem}_Lumen.dng` 候选**，见 §8.2）；
- [ ] 侧信道进程被杀 → 下次点击自动拉起，UI 不白屏、不弹原生错误框；
- [ ] 超时：`photo.enhance` 在 61MP RAW 上跑 super 4× 可能 > 5 min → 宿主 `one_shot` 超时必须 ≥ 600 s（对齐 `ai_worker.RUN_TIMEOUT=600`），超时后给"重试/降低倍率/取消"。

### 步 9 · 镜头校正只读跟随（P2）

**动作**：在 LUMEN RAW 编辑器里对样张开"启用配置文件校正"（可先勾"新打开的照片自动启用"），存工程；宿主侧只调 `render.preview` / `photo.export`。
**验收**：
- [ ] 宿主渲染结果与 LUMEN RAW 界面**像素级一致**（同尺寸同参数，允许 < 1e-4 浮点差）；
- [ ] 关掉 lens 再渲染 → 差异集中在画面四角（桶形/枕形 + 暗角），证明真的走的是 `lens.correct` 而非巧合；
- [ ] sidecar 打包体积只增加 ~5 MiB（lensfun db 5.02 MiB）；
- [ ] `THIRD-PARTY-NOTICES.txt` 含 lensfun CC BY-SA 3.0 署名条目。

### 步 10 · 回归与预算

**动作**：跑全套降级场景 + 记账。
**验收**：
- [ ] lumen 关闭/未安装/被杀/版本漂移（`app.status.version` ≠ `1.6.0`）→ 宿主全部 AI/蒙版入口置灰，**选片主流程零影响、零报错弹窗**；
- [ ] `LUMEN_COMPUTE=cpu` 下步 4/步 7 仍能出图（慢但正确）；
- [ ] 体积：sidecar（无 Qt、无模型、含 lensfun）< 120 MB；安装包不含任何 `.onnx`；
- [ ] 性能（中端机，24MP RAW）：sky 蒙版 < 3 s；FFDNet denoise < 20 s；NAFNet < 60 s；Real-ESRGAN x4plus 2× < 120 s；
- [ ] 内存：worker 进程峰值 < 1.5 GB（`RemoteSession` 分块 256/128，`large_image.allocate` 大图走 memmap）；
- [ ] `app_cache/lumen-models/` 提供"清理模型缓存"入口，清理后下次自动重下。

---

## 10. 附录 A · 关键判断的证据索引

| 判断 | 证据位置 |
|---|---|
| AI 算法零 Qt 依赖 | `restoration.py:1-7` imports 仅 cv2/numpy/large_image/compute/i18n；`denoise.py:1-4` 仅 numpy |
| 蒙版已在命令层打通 | `commands.py:379-395` `_regions` + `nl_edit.py:997-1007` `attach_regions` |
| 蒙版走 worker 隔离 | `commands.py:390` 传 `True` → `compute.py:469-472` → `ai_worker.RemoteSession` |
| worker spawn 模式 | `ai_worker.py:164` `get_context('spawn')` |
| 无 assets 环境变量 | `grep -rn "environ.get('LUMEN" lumen/*.py` 13 处，无一指向 assets |
| 模型路径编译期常量 | `selection.py:42` / `restoration.py:13` / `denoise.py:9` / `engine.py:1218` / `lens.py:47` |
| onnx 不进 git | `.gitignore` 的 `*.onnx`；`git ls-files assets/models` 只有 4 个 json |
| lensfun 进 git | `git ls-files assets/lensfun` 58 文件 / 5,270,149 B |
| 运行期无下载代码 | `grep -rn "urllib" lumen/*.py` 仅 `nl_edit.py`（LLM 客户端） |
| DirectML 是上游 Windows 默认 | `build-directml.ps1:8` 断言 `DmlExecutionProvider`；`LumenRAW.spec:1` 注释 |
| GPU 三级回退 | `compute.py:283-310`（plan）/ `:399-405`（CPU 兜底）/ `:407-418`（运行时回退） |
| recipe 降噪是双边滤波 | `engine.py:560-571` `reduce_noise`；`SPATIAL_KEYS` `:322` |
| lens 在渲染主链路 | `engine.py:917-919`（1.5.1 "校正优先"） |
| lensfun 库未链接 | `lens.py:1-9` docstring；`THIRD_PARTY.md` |
| 宿主无推理框架 | `Cargo.toml` 47 行全览 + `src-tauri/src/*.rs` 大小写不敏感 grep |
| 宿主不加 lens 参数的原因 | `edit.apply` 的 `CHANGES` 白名单 `commands.py:367-376` 无 lens；`nl_edit.plan` 忽略未知键 |
| headless 默认不开 lens | `session.py:107-111` 依赖 `auto_enable()`（`lens_panel.py:21-22`，settings.ini） |

## 11. 附录 B · 上游测试钩子（宿主导入前可自建 CI）

| 环境变量 | 效果 | 用途 |
|---|---|---|
| `LUMEN_COMPUTE=cpu\|auto\|dml\|cuda\|trt\|metal` | 强制计算模式（`compute.py:138-141`） | 复现"用户显卡不可用"场景 |
| `LUMEN_DML_DEVICE=<DXGI idx>` | 指定 DirectML 适配器（`compute.py:99-114`） | 多显卡机型的回归 |
| `LUMEN_WINML=0` | 关掉 Windows ML 目录（`winml.py:12-13`） | 避免 CI 触发 TB 级 TensorRT 下载 |
| `LUMEN_AI_ISOLATION=0` | 关 worker 隔离（`compute.py:459-461`） | 对比"隔离内/外"一致性 |
| `LUMEN_TEST_WORKER_CRASH=<model.onnx>` | worker 打开该模型时 `os._exit(9)`（`ai_worker.py:74-76`） | 崩溃降级集成测试 |
| `LUMEN_CATALOG=<path>` / `LUMEN_CONTROL_NAME=<name>` | 隔离 catalog 与控制通道（`catalog.py` / `control.py:34-37`） | CI 不污染用户数据 |
| `LUMEN_LOG_LEVEL=DEBUG` | 日志级别（`logs.py`） | 排障 |

> **给宿主 CI 的直接建议**：改造 `tools/check_cli.py` 为宿主 sidecar 冒烟 —— 它已示范"独立 catalog + 独立 control name + MCP stdio 会话 + 断言 `content[0].type=='image'`"的完整套路，把样例图换成 CC0 RAW 即可复用。

---

## 12. 一页结论（给决策者）

1. **P1 就能拿到 AI 蒙版，且几乎免费**：`edit.apply` 的 `masks[{region}]` 已在 lumen 命令层跑通（`commands._regions` → `selection.automatic` → worker 隔离），宿主只需：① 下载 `u2netp`+`skyseg`（172 MiB）；② 把返回的 `notes` 透传到前端；③ 在 junction 里落位模型。**不需要 lumen 打任何补丁。**
2. **P2 的 AI 增强需要一处上游小补丁**（`photo.enhance` ~70 行 + `palette.py` 1 行），把 `ai_dialog.py:123-133` 的 GUI-only 调用搬到命令层。算法本身零 Qt 依赖，可直接复用；核心坑是 `preview_limit=None`（全尺寸）与 `batch_export` 同款的 `initialized` 分支。
3. **降噪必须讲清楚是两套**：recipe 滑块 = Lab 双边滤波（`engine.reduce_noise`，可撤销、非 AI）；AI 降噪 = ONNX 模型、产 DNG 副本、不可撤销。宿主文案若混为一谈，用户会把"双边滤波没效果"当成 bug 上报。
4. **镜头校正是白送的**：`lens.correct` 已在 `engine.process` 主链路（1.5.1 起），宿主渲染自动带上；数据库 git 跟踪（5 MiB）直接随 sidecar 打包，无 LGPL 链接。**P2 建议只做只读跟随，不做宿主 UI 开关**（那需要扩 `edit.apply` 的 changes 白名单，另立补丁）。
5. **sidecar GPU flavor = `onnxruntime-windowsml`（DirectML）**：中端 Windows 机覆盖最广、与上游实测路径一致、一个 wheel 同时喂逐像素显影图与 AI 模型；CPU 兜底由 ORT 自身 + `compute.Session` 的三级回退保证。
6. **模型权重一律不进安装包**：`*.onnx` 本就被 lumen `.gitignore`，宿主按 §6.3 的"分级下发 + sha256 校验 + junction 落位"实现即可，`app_cache/lumen-models/` 是可写可清理的唯一定点。
