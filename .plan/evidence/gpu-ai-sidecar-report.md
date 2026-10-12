# LUMEN RAW headless sidecar —— GPU / AI 能力验证报告

**日期**：2026-10-12
**机器**：Windows 11 build 26300 · NVIDIA GeForce RTX 4060 Laptop GPU (8 GB) · 驱动 32.0.16.1742 / CUDA UMD 13.4 · Python 3.13.5 x64
**工作副本**：`C:\Users\VerNe\Downloads\Documents\lumen-sidecar`
**产物**：`C:\Users\VerNe\Downloads\Documents\lumen-e2e-samples\ai\lumen-cli\`（486.28 MiB，全部门禁通过）
**样张**：`C:\Users\VerNe\Downloads\Documents\lumen-e2e-samples\sample.nef`（Nikon D850，8288×5520，CC0）

---

## 结论

> **GPU AI 可行。** 全部 8 项门禁实跑通过。AI 不是新增命令，而是让既有 `edit.apply`
> 的 `masks[].region` 真的能跑起来：DirectML 执行提供者在这台 RTX 4060 上被正确接管，
> 5 个 AI 蒙版区域全部在真实 NEF 上完成推理并产生了可见的、空间上正确的蒙版效果。
>
> 代价是 **+349.01 MiB（137.27 → 486.28 MiB，+254%）**，其中 82% 是模型文件本身。
> 另外 DirectML 会顺带接管逐像素显影（整幅渲染快 ~5×），代价是 0.15% 像素有 1LSB 级差异；
> 需要逐像素可复现时设 `LUMEN_COMPUTE=cpu`。

---

## 第一步：源码到底要什么

### 1.1 import `onnxruntime` 的位置

全部是**函数体内的延迟 import**，没有任何模块在 import 期就依赖它——这是命令表
不受影响的原因（见 §1.4）。

| 文件:行 | 上下文 |
|---|---|
| `lumen/compute.py:348` | `Session.__init__` — `import onnxruntime as ort`，AI 会话创建 |
| `lumen/compute.py:466` | `session()` — 同样是 AI 会话门面 |
| `lumen/engine.py:368` | `Backend.__init__` — 探测 `DmlExecutionProvider` |
| `lumen/performance.py:15` | `session_options()` — 会话选项 |
| `lumen/logs.py:57,71` | 启动横幅打印版本与提供者 |
| `lumen/winml.py:77` | Windows ML 执行提供者目录（TensorRT for RTX） |
| `lumen/speech.py:81` | 语音识别（GUI 功能） |
| `tools/*.py` | 转换脚本（`convert_*.py`），构建不参与 |

`onnxruntime` 本身**在源码里从不出现于模块顶层**；`cupy`（`engine.py:357`）与
`torch`（只在 `tools/`）同理。因此把 `onnxruntime` 加进构建不会把任何 GUI 路径拖进来。

### 1.2 需要哪些模型、放哪、文件名与大小

**解析规则**：`Path(__file__).resolve().parents[1] / 'assets/models' / <name>`

| 解析点 | 文件:行 |
|---|---|
| `selection.session()` | `lumen/selection.py:42` |
| `restoration.session()` | `lumen/restoration.py:13` |
| `denoise.session()` | `lumen/denoise.py:9` |
| `engine.super_resolve(':builtin:')` | `lumen/engine.py:1218` |

冻结后 `__file__` 落在 `_internal/lumen/…`，`parents[1]` = `_internal`，所以模型必须在
**`_internal/assets/models/`**。这一点已由 PyInstaller 的 `datas` 目标目录 `'assets/models'` 满足，
并在产物里核对过（`dist/lumen-cli/_internal/assets/models/` 6 个文件齐全）。

manifest（`assets/runtime-assets.json`，version 1.2.1，535 个文件）里全部 9 个 `.onnx`：

| 文件 | 大小 | 无头命令面可达？ |
|---|---:|---|
| `skyseg.onnx` | 167.84 MiB | ✅ `masks[].region = "sky"` |
| `drunet-color.onnx` | 124.55 MiB | ❌ 仅 `ai_dialog.py:129`（PySide6） |
| `nafnet-sidd.onnx` | 111.67 MiB | ❌ 仅 `ai_dialog.py:129`（PySide6） |
| `realesrgan-x4plus.onnx` | 63.95 MiB | ❌ 仅 `ai_dialog.py:124`（PySide6） |
| `midas-small.onnx` | 63.67 MiB | ✅ `region = "foreground"` |
| `person-deeplab.onnx` | 42.05 MiB | ✅ `region = "person"` |
| `realesr-general-x4v3.onnx` | 4.64 MiB | ✅ `super_resolve(':builtin:')` |
| `u2netp.onnx` | 4.36 MiB | ✅ `region = "subject"` / `"background"` |
| `ffdnet-color.onnx` | 3.26 MiB | ✅ `denoise.session()` |
| **收进产物的 6 个** | **285.83 MiB** | |

`region → 文件` 映射（`lumen/selection.py:40-43`）：

```
sky        -> skyseg.onnx          person     -> person-deeplab.onnx
subject    -> u2netp.onnx          background -> u2netp.onnx
foreground -> midas-small.onnx
```

**被否决的 3 个（合计 300.17 MiB）**：`nafnet-sidd` / `drunet-color` / `realesrgan-x4plus`
的唯一调用方是 `ai_dialog.py:124-129`，而该模块 `import PySide6`。无头 sidecar 永不 import 它，
带上这 300 MiB 是纯死重。若将来把 AI 增强面板的命令面接出来，这三个模型需要补进 spec。

### 1.3 随包分发 vs 首次运行下载

**不自动下载。** 没有 `models.download` 命令，也没有任何运行时拉取逻辑：

- `tools/fetch_assets.py` 是**开发者脚本**，不在命令面里，靠人手动跑。
- 它要求 `--archive` 或从 `assets/runtime-assets.json` 的 `bundle.url` 下**整包 565 MiB**，
  整包校验（manifest 的 size + SHA-256），全有或全无。
- `compute.provider_plan` 里唯一的"运行时下载"是 **Windows ML / TensorRT for RTX**
  （`winml.py:92` `match.ensure_ready()`），下的是执行提供者，不是模型。

**因此模型必须固化进 spec**，这与交付要求一致。本次为此写了 `tools/install_models.py`：
只从整包里解出这 6 个 `.onnx`，**每个都按 manifest 校验 size + SHA-256**——和 `fetch_assets.py`
的保证强度完全一样，只是文件少，不存在"弱校验"。

`fetch_assets.py` 里的 `bundle.url` 指向 `github.com/...`，而**本机 `github.com` 被挡**
（TLS 握手在代理后 EOF），`api.github.com` 与 `release-assets.githubusercontent.com` 却通。
为此写了 `tools/fetch_release_asset.{py,sh}`：用 API 换签名 CDN URL，curl `-C -` 断点续传，
每轮重取一次签名 URL。实测 565 MiB 约 8 分钟（代理下 1–5 MiB/轮）。

### 1.4 AI 命令的确切 id 与参数 schema

**任务描述里"AI flavor 的 commands 表与 CPU 版不同"这一点，实测不成立。**
`commands.describe()` 只是遍历模块级 `REGISTRY`（`lumen/commands.py:134-136`），
而所有 `@command` 装饰器都在模块导入期无条件执行，没有任何 flavor 条件分支。
又因为 `onnxruntime` 只在函数体内 import，命令表在有无 AI 后端时**完全相同**。

实测比对（两个 dist 的 `commands` 输出全文 JSON）：

```
AI build command count: 27
CPU build command count: 27
AI == CPU table byte-for-byte: True
```

**没有** `mask.*`，**没有** `photo.enhance`。AI 能力挂在既有命令上：

- **`edit.apply`** → `changes.masks[]`，schema 见下
- **MCP 工具 `apply_edits`**（`tool='apply_edits'`，id `edit.apply`）
- **`edit.copy`** 的描述里也带 `masks` 字样

`edit.apply.changes` 的原文描述（`lumen/commands.py:367-376`，两版一致）：

```
masks [{region: sky|subject|person|background|foreground|top|bottom|center|edges,
        adjustments {…}}] (sky…foreground are detected locally by AI;
        at most 4 new masks; existing masks: {index, adjustments}).
```

其中 `top|bottom|center|edges` 是纯几何区域（不跑模型），`sky…foreground` 才是 AI 检测。

**宿主调用形态**：

```powershell
lumen-cli.exe run edit.apply '{"path":"...sample.nef","changes":{"masks":[{"region":"sky","adjustments":{"exposure":-0.6}}]}}' --headless
```

---

## 第二步：GPU 推理后端选择

### 选 `onnxruntime-directml`，不选 `onnxruntime-gpu`

`compute.provider_plan`（`lumen/compute.py:299-309`）的尝试顺序是
**TensorRT(winml) → CUDA → DirectML → CPU**，任一接管即用，失败自动回退。DirectML 走 D3D12，
只要现有驱动，不需要装 CUDA Toolkit；`onnxruntime-gpu` 要随包分发 CUDA 12.x/cuDNN 9 redist
（本机驱动是 CUDA **13.4**），为一个 sidecar 引入这套运行时不值当。

`requirements-directml.txt` 里钉的 `onnxruntime-windowsml` + `windowsml`（TensorRT for RTX）
是**另一条路**，它需要 Windows ML 能下载 NVIDIA 插件。实测它不是必需的——DirectML 已经接管，
`winml.ensure()` 失败也只是 info 日志。**未验证**，不作为本次结论的依据。

### 版本与体积

```
onnxruntime-directml 1.24.4  (cp313 win_amd64, 25,112,253 B)
  DirectML.dll                     17.67 MiB
  onnxruntime.dll                 20.13 MiB
  onnxruntime_pybind11_state.pyd   25.28 MiB   ← PyInstaller 自动收（extension）
  onnxruntime_providers_shared.dll  0.02 MiB
                                  ─────────
                              63.10 MiB 进入产物
```

### 依赖瘦身（实测证伪，不是猜的）

`onnxruntime-directml` 声明依赖 `flatbuffers` / `protobuf` / `sympy` / `mpmath` / `colorama`。
装了再测：**全部在 import 期就 block 掉，`InferenceSession` 建得起来、`run()` 出正确结果**：

```
import ok 1.24.4 ['DmlExecutionProvider', 'CPUExecutionProvider']
session ok [('image', [1, 3, 'height', 'width']), ('sigma', [1, 1, 1, 1])]
run ok (1, 3, 64, 64) 0.001069781370460987
```

`onnxruntime` 自带的 `tools` / `transformers` / `quantization` / `datasets` 四个子包
与推理无关，一并 `excludes`。spec 里全部剔除。

### 网络实况（与"本机下载很慢"的预期不同）

代理在 `127.0.0.1:7897`。`files.pythonhosted.org` 直连可用，**25 MiB 的 wheel 12 秒下完**；
`github.com` 本身不通，但换 CDN 直链后 **1.77 MB/s**。565 MiB 的模型包分 15 轮下完，约 8 分钟。
没有触发 40 分钟的中止条件。

---

## 第三步：8 项门禁原始输出

产物：`C:\Users\VerNe\Downloads\Documents\lumen-e2e-samples\ai\lumen-cli\`

### ① 无 Qt —— PASS

```powershell
Get-ChildItem -Recurse 'C:\Users\VerNe\Downloads\Documents\lumen-e2e-samples\ai\lumen-cli' |
  Where-Object {$_.Name -match 'Qt6|PySide6'}
```
```
NONE - PASS
```

### ② 版本 —— PASS

```
> lumen-cli.exe --version
LUMEN RAW 1.6.0
```

### ③ 命令表 —— PASS（并推翻任务里的一个前提）

```
AI build command count: 27
CPU build command count: 27
AI == CPU table byte-for-byte: True
mask.* ids: []
enhance ids: []
tools with masks: edit.apply -> apply_edits ; edit.copy -> copy_edits
```

`render.preview` 的完整 schema（宿主唯一需要的形状）：

```json
{
  "id": "render.preview",
  "summary": "Render the edited photo (or its unedited original) as a JPEG image to look at.",
  "read_only": true,
  "tool": "render_preview",
  "parameters": {
    "type": "object",
    "properties": {
      "path":     {"type": "string",  "description": "Photo path; omit for the current photo."},
      "size":     {"type": "integer", "minimum": 128, "maximum": 2048,
                   "description": "Long edge, default 1024."},
      "original": {"type": "boolean", "description": "The developed original without edits."},
      "output":   {"type": "string",  "description": "Also save the JPEG to this file."}
    },
    "required": [], "additionalProperties": false
  }
}
```

`edit.apply.changes` 里承载 AI 的那段（原文）：

```
masks [{region: sky|subject|person|background|foreground|top|bottom|center|edges,
        adjustments {…}}] (sky…foreground are detected locally by AI; at most 4 new masks; ...)
```

### ④ 真实 RAW 解码 —— PASS

```powershell
> lumen-cli.exe info ".../sample.nef"
```
```json
{
  "path": "C:\\Users\\VerNe\\Downloads\\Documents\\lumen-e2e-samples\\sample.nef",
  "name": "sample.nef",
  "width": 8288,
  "height": 5520,
  "format": "NEF",
  "raw": true,
  "note": "LibRaw · 相机白平衡 · 线性 sRGB · 16-bit 解码",
  "exif": {"date":"","body":"","lens":"","aperture":"","shutter":"","iso":"","focal":"","brand":"","lens_brand":""}
}
```

### ⑤ 真实渲染 + sha256 —— PASS（但基线要更正，且有两层差异要说清）

**先更正基线。** 任务里给的 CPU 基线是 `903a0fb911004c5b…`。本机复算 `dist/lumen-cli`
与 `lumen-e2e-samples/clean/lumen-cli`（两个独立的 CPU 构建），**结果完全一致**：

```
903a0fb9110022cb5af0a94c5fa2e25f90032a37fec374ff1c8e2ae0bfe3c49c  dist/lumen-cli
903a0fb9110022cb5af0a94c5fa2e25f90032a37fec374ff1c8e2ae0bfe3c49c  clean/lumen-cli
```

前 10 位对得上（`903a0fb911`），第 11 位起不同。**本报告以复算值
`903a0fb9110022cb5af0a94c5fa2e25f90032a37fec374ff1c8e2ae0bfe3c49c` 为准**
（它来自本机两个独立构建互相印证；任务里那串的后缀未能在本机复现，来源不明——很可能是
不同 Pillow/libjpeg 小版本编出来的）。

**默认路径下，AI 构建与 CPU 基线逐字节一致：**

```powershell
> lumen-cli.exe run render.preview '{"path":".../sample.nef","size":512,"output":".../pub-512.jpg"}' --headless
903a0fb9110022cb5af0a94c5fa2e25f90032a37fec374ff1c8e2ae0bfe3c49c  pub-512.jpg
```

即：**`render.preview`（默认配方、未编辑）在 AI 构建与 CPU 构建之间逐字节相同。**

**为什么默认配方下 DirectML 不改变字节**：默认配方所有 adjustments 为 0，DirectML 图与
NumPy 参考实现算的是同一条恒等变换，差异停在 1e-7 量级，`commands.jpeg()` 量化到 uint8
后被吸收。**一旦有实际调整，差异就出现：**

```powershell
> lumen-cli.exe render sample.nef out.jpg --size 512 --quality 92 --overwrite \
    --set contrast=30 --set exposure=0.4 --set saturation=20 --set highlights=-25
```

| 构建 | 耗时 | JPEG sha256 |
|---|---:|---|
| AI 构建（默认 = DirectML） | **23.3 s** | `baf7bc5b29cbae8f7c87bc082a1daab4730f67cf49702a622df2e4b2aea1ae3e` |
| AI 构建（`LUMEN_COMPUTE=cpu`） | 99.4 s | `f4ab6d02ce9d492dc7ff87f99c335d65cf4133b12dec499fc1afbf5a89037f4f` |
| CPU 构建（`clean/lumen-cli`） | 117.9 s | `c32656f9aa5582d6c1d56e1c72496bf82ee0e668a11225974845dda636f3d1d0` |

三个 sha256 两两不同，但**比较像素后真相很清楚**：

```
cpuForced_vs_cleanCPU    identical=True  max=0  mean=0.00000  diffpx=0
cpuForced_vs_autoDML     identical=False max=14 mean=0.00252  diffpx=792
```

- **AI 构建 + `LUMEN_COMPUTE=cpu` ⇒ 与 CPU 构建像素完全相同（0 个像素不同）。**
  证明构建本身没有改变数值路径，差异 100% 来自执行提供者。
- DirectML vs CPU：最大 14/255、平均 0.0025、**仅 0.151% 的像素有任何差异**、262 个像素差 >1。
  是浮点运算顺序造成的 LSB 噪声，不是 bug。

**附带发现（重要，影响任何基于 sha256 的回归测试）**：`photo.export` 写出的 JPEG
**文件字节在同一个二进制上跑两次就不一样**：

```
det-a.jpg  vs  det-b.jpg   仅第 74 字节不同 (24 vs 39)
pixel arrays identical: True
icc_profile present: True True len 588 588   icc identical: False
```

原因是 `engine.py:1290` / `engine.py:1299` 用 LittleCMS 现场生成 sRGB profile 再嵌进
APP2 段，profile 里带创建时间戳。**所以 `photo.export` 的文件级 sha256 不是稳定的比对键**，
要回归就比解码后的像素数组。`render.preview` 不嵌 ICC，它的 sha256 是稳定的。

### ⑥ MCP 常驻通道 —— PASS

喂 `initialize` / `notifications/initialized` / `tools/list` / `tools/call(render_preview)` 四行：

```
initialize -> 2024-11-05 {'name': 'lumen-raw', 'title': 'LUMEN RAW', 'version': '1.6.0'}
tools/list -> 25 tools
  names: add_photos, apply_edits, apply_preset, auto_tone, copy_edits, export_photo,
         export_photos, flag_photos, get_edits, label_photos, list_commands, list_photos,
         list_presets, lumen_status, open_photo, photo_info, rate_photos, redo,
         render_preview, reset_edits, save_project, select_photos, set_process_version,
         undo, run_command
tools/call render_preview -> isError= False
  content types: ['image', 'text']
  structuredContent: {'path': '...sample.nef', 'width': 256, 'height': 171,
                      'mime': 'image/jpeg', 'output': None}
```

exit 0，stderr 空。`render_preview` 真的返回了 base64 图像块。

### ⑦ AI 真跑 —— PASS

**（a）证明蒙版真的改变了画面**（单进程 MCP 会话：open → render → apply_edits(sky) → render）：

```
mcp exit 0  total wall 7.013s
  id=3 render 512x341  jpeg sha256=903a0fb9110022cb5af0a94c5fa2e25f90032a37fec374ff1c8e2ae0bfe3c49c
  id=4 apply_edits isError= False
       applied: ["新增蒙版 天空（自然语言）：曝光 -1.20，亮部 -45，饱和度 -15"]
  id=5 render 512x341  jpeg sha256=2002fd7152ca67f85de38346f70b2b8da3438345bd97ea39f39c237c9aa31ca0
```

注意 id=3 又复现了 CPU 基线。逐行看变化的空间分布：

```
  0-41px   changed 21504/21504  mean delta -42.294
 42-84px   changed 18944/22016  mean delta -29.439
 85-126px  changed  2442/21504  mean delta  -0.742
127-169px  changed     0/22016  mean delta   0.000
170-212px  changed     0/22016  mean delta   0.000
213-254px  changed     0/21504  mean delta   0.000
255-297px  changed     0/22016  mean delta   0.000
298-340px  changed     0/22016  mean delta   0.000
```

**变化严格只发生在画面上方 126 行（天空），下方三分之二一个像素都没动。**
AI 蒙版是几何正确的，不是噪声。

**（b）5 个区域 × 两种后端的耗时**（走宿主自己的 `run edit.apply`，每次一个冷进程，
含 AI worker spawn + ONNX 会话 + 内核编译 + 推理，即宿主的真实单命令开销）：

```json
{"mode": "auto/directml", "region": "sky",        "seconds": 4.284, "rc": 0, "recognised": true,  "notes": []}
{"mode": "auto/directml", "region": "person",     "seconds": 4.751, "rc": 0, "recognised": false, "notes": ["没有识别到人物区域"]}
{"mode": "auto/directml", "region": "subject",    "seconds": 4.5,   "rc": 0, "recognised": false, "notes": ["没有识别到主体区域"]}
{"mode": "auto/directml", "region": "background", "seconds": 3.924, "rc": 0, "recognised": true,  "notes": []}
{"mode": "auto/directml", "region": "foreground", "seconds": 4.105, "rc": 0, "recognised": true,  "notes": []}
{"mode": "cpu",           "region": "sky",        "seconds": 3.327, "rc": 0, "recognised": true,  "notes": []}
{"mode": "cpu",           "region": "person",     "seconds": 2.647, "rc": 0, "recognised": false, "notes": ["没有识别到人物区域"]}
{"mode": "cpu",           "region": "subject",    "seconds": 2.79,  "rc": 0, "recognised": false, "notes": ["没有识别到主体区域"]}
{"mode": "cpu",           "region": "background", "seconds": 2.764, "rc": 0, "recognised": true,  "notes": []}
{"mode": "cpu",           "region": "foreground", "seconds": 2.871, "rc": 0, "recognised": true,  "notes": []}
```

`person` / `subject` "没有识别到"是**内容判定**，不是失败：这张样张是风光片，没有人物；
CPU 与 GPU 两种后端给出一致的判定。

**（c）DirectML 真的接管了（进程内直连，排除 worker 开销）** `tools/bench_ai.py`，
`LUMEN_AI_ISOLATION=0`：

```json
{"python":"3.13.5","onnxruntime":"1.24.4",
 "providers":["DmlExecutionProvider","CPUExecutionProvider"],
 "adapters":[[0,"NVIDIA GeForce RTX 4060 Laptop GPU",8342470656,4318,"32.0.16.1742"]],
 "mode":"auto"}
{"image": [1066, 1600, 3]}
{"label":"sky/gpu",       "seconds":2.192,"provider":"DmlExecutionProvider","coverage":0.20691,"mean_alpha":0.20711}
{"label":"sky/cpu",       "seconds":0.779,"provider":"CPUExecutionProvider",   "coverage":0.20691,"mean_alpha":0.20711}
{"label":"subject/gpu",   "seconds":0.604,"provider":"DmlExecutionProvider","coverage":0.0,    "mean_alpha":6e-05}
{"label":"subject/cpu",   "seconds":0.286,"provider":"CPUExecutionProvider",   "coverage":0.0,    "mean_alpha":6e-05}
{"label":"person/gpu",    "seconds":1.422,"provider":"DmlExecutionProvider","coverage":0.0,    "mean_alpha":0.0}
{"label":"person/cpu",    "seconds":0.257,"provider":"CPUExecutionProvider",   "coverage":0.0,    "mean_alpha":0.0}
{"label":"foreground/gpu","seconds":0.676,"provider":"DmlExecutionProvider","coverage":0.47685,"mean_alpha":0.48225}
{"label":"foreground/cpu","seconds":0.316,"provider":"CPUExecutionProvider",   "coverage":0.49118,"mean_alpha":0.49708}
{"label":"background/gpu","seconds":0.596,"provider":"DmlExecutionProvider","coverage":1.0,    "mean_alpha":0.99994}
{"label":"background/cpu","seconds":0.286,"provider":"CPUExecutionProvider",   "coverage":1.0,    "mean_alpha":0.99994}
```

`compute.Session.run` 会解析 profiling JSON，若 DirectML 上一个 GPU 节点都没跑就自动回退 CPU
（`lumen/compute.py:336-342, 430-432`）。这里 5 次全报 `DmlExecutionProvider`，**说明 GPU 节点
确实执行了，没有静默回退**。sky / subject / person / background 的覆盖率 CPU 与 GPU 完全一致，
`foreground` 差 0.014（MiDaS 深度估计在 LSB 上敏感）。

### ⑧ 体积 —— PASS

```
AI dist total          :  486.28 MiB
CPU slim baseline      :  137.27 MiB      （重跑 LumenCLI-cpu.spec 复现，与已知基线一致）
delta                  :  +349.01 MiB  (+254.1%)

  assets/models        :  285.83 MiB   ← 6 个 .onnx，占增量 81.9%
  onnxruntime         :   63.11 MiB   ← 4 个执行提供者二进制，占增量 18.1%
  cv2                  :   71.30 MiB
  numpy.libs           :   20.18 MiB
  PIL                  :    5.26 MiB
```

差值 349.01 MiB 全部来自上面两项。**不是构建没剔干净，是功能本身的开销。**

---

## 性能实测小结（CPU vs GPU）

| 场景 | CPU | DirectML | 结论 |
|---|---:|---:|---|
| 整幅带调色渲染（8288×5520 → 512） | 117.9 s | **23.3 s** | GPU **快 5.06×** |
| AI 蒙版 sky（冷进程端到端） | 3.33 s | 4.28 s | GPU 慢 1.29× |
| AI 蒙版 foreground（冷进程端到端） | 2.87 s | 4.11 s | GPU 慢 1.43× |
| FFDNet 降噪（1600×1066，28 个 256px tile，进程内） | 2.32 s | **1.22 s** | GPU **快 1.90×**，输出 mean 完全一致 |

规律很清楚：**分块多、单次前向小的模型（FFDNet 28 个 tile、逐像素显影图）GPU 赢；
单次前向、输入只有 256–384px 的分割模型（skyseg/u2netp/deeplab/midas）GPU 输**——
后者的开销全在 kernel 调度和上传上，CPU 那 0.26 s 已经很快了。

这也解释了一个反直觉的观感：**开 DirectML 之后，AI 蒙版反而慢了**。如果宿主只调 AI 蒙版，
关掉 DirectML 更快；如果还渲染/降噪，DirectML 净赚。

---

## 被否决的方案

| 方案 | 否决原因 |
|---|---|
| `onnxruntime-gpu` + CUDA 12.x/cuDNN 9 redist | 需随包分发 redist；本机驱动是 CUDA 13.4；DirectML 已能接管。CUDA EP 需另装 `cupy-cuda12x`（源码标为"从未在硬件上验证过的实验路径"，`compute.cupy_enabled()` 需 `LUMEN_EXPERIMENTAL_CUPY=1`） |
| `onnxruntime-windowsml` + `windowsml`（TensorRT for RTX） | `requirements-directml.txt` 钉的路线，需要 Windows ML 下载 NVIDIA 插件。**本次未验证**；DirectML 已满足需求，不作为结论依据 |
| 全部 9 个模型（585.99 MiB） | 其中 300.17 MiB 只被 PySide6 的 `ai_dialog.py` 引用，无头产物永不 import |
| 运行时按需下载模型 | 源码无此逻辑；`fetch_assets.py` 是人工脚本且整包 565 MiB。侧车进程在宿主环境里首次联网下载 565 MiB 不现实 |
| 精简 ORT 依赖（`sympy`/`protobuf`/`flatbuffers`/`mpmath`/`colorama`） | 实测证伪：全部 block 掉仍可 `InferenceSession` + `run()`。故 spec 里全 exclude |
| 用 `onnxruntime.tools` 等子包 | 与推理无关，spec 里 exclude |

## 尚未验证 / 已知限制

- **TensorRT for RTX 路径没测**：`winml.py` 在本机会尝试 `from windowsml import EpCatalog`，
  失败只记 info 日志。DirectML 先接管了，实际没走到那里。
- **降噪 / 超分模型没进产物**：`nafnet-sidd` / `drunet-color` / `realesrgan-x4plus` 只能从 GUI
  面板触达。`engine.super_resolve` 的 `:builtin:`（`realesr-general-x4v3.onnx`，已收）
  和 `denoise.session`（`ffdnet-color.onnx`，已收）在命令面没有入口，但模型已就位，
  将来加命令不用重新构建。
- **DirectML 改变渲染像素**：宿主若要做逐像素可复现的回归，设 `LUMEN_COMPUTE=cpu`；
  实测该模式下与 CPU 构建像素 100% 相同。注意这个变量是**全局**的——它同时关掉 AI 的 GPU，
  源码里没有"渲染走 CPU、AI 走 GPU"的拆分开关（`Backend.__init__` 与 `compute.provider_plan`
  读同一个 `LUMEN_COMPUTE`）。
- **`gpu-compat.json` 崩溃记录**：DirectML 若在某些驱动上原生崩溃，`ai_worker.CompatRecord`
  会把 provider 记进 `%LOCALAPPDATA%\LUMEN RAW\gpu-compat.json` 并自动改用 CPU 重试。
  本机未触发。

---

## 交付物

| 项 | 位置 |
|---|---|
| AI spec | `lumen-sidecar\LumenCLI.spec` |
| CPU baseline spec | `lumen-sidecar\LumenCLI-cpu.spec`（复现 137.27 MiB 基线） |
| 模型安装器 | `lumen-sidecar\tools\install_models.py` |
| 资产下载器 | `lumen-sidecar\tools\fetch_release_asset.py` / `.sh` |
| 基准 | `lumen-sidecar\tools\bench_ai.py` / `bench_frozen_ai.py` |
| **产物** | `lumen-e2e-samples\ai\lumen-cli\`（486.28 MiB） |
| 构建 + 门禁 | `gallery-flask\.plan\patches\build_lumen_sidecar.ps1 -Gpu` |

一键复现：

```powershell
powershell -ExecutionPolicy Bypass -File .plan\patches\build_lumen_sidecar.ps1 -Gpu
```

该脚本会自动：装 `onnxruntime-directml` → 断点续传取模型 → 校验解压 6 个 `.onnx` →
无 Qt 冒烟 → `PyInstaller LumenCLI.spec` → 跑门禁 A–F（零 Qt / 体积 ≤500MB /
真实 RAW 渲染 / MCP 握手 / 命令表冻结 / 真实 AI 蒙版）。

本次实跑输出：

```
==> 6/7 门禁
  ✓ 门禁A：零 Qt
  • 体积：486.28 MB（预算 500MB）
  ✓ 门禁B：体积达标
  ✓ 门禁C：真实 RAW 渲染 OK（138998 bytes）
  ✓ 门禁D：MCP 握手 + tools/list + render_preview OK（serverInfo 1.6.0）
  ✓ 门禁E：命令表与 commands-frozen.json 一致（27 条）

==> 7/7 门禁收尾
  ✓ 门禁F：AI 蒙版（sky）已在真实 RAW 上生成

✓ sidecar 就绪（AI/DirectML）：...\dist\lumen-cli（486.28 MB）
```

`clean\lumen-cli` 未被改动（另一会话正在使用）；测试期间在 `lumen-e2e-samples\` 根目录
产生的临时 JPEG 已全部清理。