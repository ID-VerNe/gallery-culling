# LUMEN RAW headless sidecar 瘦身报告

- **日期**：2026-10-12
- **工作副本**：`C:\Users\VerNe\Downloads\Documents\lumen-sidecar`（已打 slim 补丁、无 PySide6）
- **产物**：`dist\lumen-cli\`（PyInstaller onedir / COLLECT）
- **结论**：**184 MB → 137.27 MB（-46.7 MB，-25.4%），功能零回归。**
  **目标 <120 MB 未达成**——剩余 137 MB 是当前依赖集的**地板**，详见 §5「为什么 120 MB 不可达」。

---

## 1. 体积轨迹（每一步都跑了完整 7 项验证）

| 阶段 | 动作 | 体积 | 变化 | 7 项验证 |
|---|---|---|---|---|
| baseline | 改动前原始产物 | **181.60 MB** | — | ALL PASS |
| lever A | `excludes=['tkinter', ...]` | **173.91 MB** | **-7.69 MB** | ALL PASS |
| lever B+C | 构建期剔除 ffmpeg DLL + PIL `_avif` | **137.27 MB** | **-36.64 MB** | ALL PASS |
| FINAL | `rm -rf build dist` 后从零重建（可复现性） | **137.27 MB** | 0 | ALL PASS |

> 注：任务书写的 184 MB 是十进制 MB；`Measure-Object` 按 1 MB = 1048576 B 统计得
> 181.60 MB。两者是同一个数的不同单位，报告统一用 MiB 口径。

**净省 44.33 MB（181.60 → 137.27，-24.4%）**，三个杠杆全部固化进
`LumenCLI.spec`（`excludes` + COLLECT 前的条目过滤器），**没有任何手工删文件的步骤**。

---

## 2. 每项杠杆的实际收益

### 杠杆 A — Tcl/Tk（`excludes`）：**-7.69 MB**

| 文件 | MB |
|---|---|
| `_tcl_data\` | 3.02 |
| `tcl86t.dll` | 1.75 |
| `tk86t.dll` | 1.52 |
| `_tk_data\` | 0.81 |
| `_tkinter.pyd` + `pyi_rth__tkinter` | ~0.09 |
| 其余 tkinter .pyc | ~0.50 |
| **合计** | **7.69** |

- **触发源**：`tifffile.py:28156` 的 `from tkinter import Tk, filedialog`——只服务于
  `imshow()`，sidecar 从不 imshow。但 PyInstaller 的 `pre_find_module_path` 钩子
  一看到 `tkinter` 就把整套 Tcl/Tk 资源收进来。
- **做法**：`excludes` 追加 `'tkinter', 'PIL.ImageTk', 'PIL.SpiderImagePlugin',
  'PIL._tkinter_finder'`（后三个是 Pillow 侧同样的间接入口）。
- **验证**：单独跑一轮 7 项，全绿。重建后 `Get-ChildItem` 搜 `tcl|tk86|_tk` 命中 0。

### 杠杆 B — `cv2\opencv_videoio_ffmpeg4140_64.dll`：**-29.10 MB**

- **为什么安全**：OpenCV 的 videoio 插件是**惰性**加载的。`cv2.pyd` 在静态初始化
  阶段只按名字注册后端，真正的 `LoadLibrary` 发生在调用 `cv2.VideoCapture` 时。
  sidecar 只做「解码照片 → 调色 → 缩放 → 存图」，不碰视频 I/O。
- **实测确认**：`import cv2` 正常，`cv2.resize/cvtColor/warpAffine/imdecode/
  bilateralFilter/createCLAHE` 全部照常——7 项验证全绿，且渲染输出 sha256 与
  baseline **逐字节一致**（见 §3）。若它是静态依赖，删掉会直接 ImportError；
  任务书担心的这一点已被实跑排除。
- **代价**：产出的 sidecar 里 `cv2.VideoCapture` 会抛错。headless 路径不可达。

### 杠杆 C — `PIL\_avif.cp313-win_amd64.pyd`：**-7.53 MB**

- Pillow 11+ 自带的可选 AVIF 编解码器。sidecar 读写 jpg/png/tif/dng，AVIF 不在需求内。
- 唯一可观察变化是 `PIL.features.check('avif')` 变成 `False`（即 Pillow 不再宣称
  支持 AVIF），其余格式不受影响。

---

## 3. 七项验证（最终产物的原文输出）

```
==== [1] no Qt6 / PySide6 / shiboken in dist ====
(no output = zero Qt files found)
PASS
==== [2] --version ====
LUMEN RAW 1.6.0
==== [3] info (real NEF decode) ====
{
  "path": "C:\\Users\\VerNe\\Downloads\\Documents\\lumen-e2e-samples\\sample.nef",
  "name": "sample.nef",
  "width": 8288,
  "height": 5520,
  "format": "NEF",
  "raw": true,
  "note": "LibRaw · 相机白平衡 · 线性 sRGB · 16-bit 解码",
  "exif": {
    "date": "", "body": "", "lens": "", "aperture": "",
    "shutter": "", "iso": "", "focal": "", "brand": "", "lens_brand": ""
  }
}
==== [4] run render.preview (host invocation shape) ====
{
  "path": "C:\\Users\\VerNe\\Downloads\\Documents\\lumen-e2e-samples\\sample.nef",
  "width": 1024,
  "height": 682,
  "mime": "image/jpeg",
  "statistics": {
    "亮度分位（0–1）": { "1%": 0.043, "5%": 0.066, "中位": 0.154, "95%": 0.703, "99%": 0.735 },
    "高光溢出比例": 0.0,
    "暗部死黑比例": 0.0,
    "平均饱和度（0–1）": 0.429,
    "平均 RGB": [ 0.224, 0.269, 0.25 ],
    "上/中/下三分之一平均亮度": [ 0.494, 0.169, 0.11 ],
    "色彩倾向": "偏绿"
  },
  "output": "C:/Users/VerNe/Downloads/Documents/lumen-e2e-samples/slim-test.jpg",
  "mode": "headless"
}
output file: 138,998 bytes
output sha256: 4b076558040ad9fe478263de3e22923fba144e65c8a88cc735da118446d271e2
==== [5] MCP stdio: initialize / tools/list / tools/call render_preview ====
  initialize -> protocolVersion=2025-06-18 serverInfo=lumen-raw v1.6.0
  tools/list -> 25 tools: add_photos, apply_edits, apply_preset, auto_tone, copy_edits,
    export_photo, export_photos, flag_photos, get_edits, label_photos, list_commands,
    list_photos, list_presets, lumen_status, open_photo, photo_info, rate_photos, redo,
    render_preview, reset_edits, save_project, select_photos, set_process_version, undo,
    run_command
  render_preview present: True
  tools/call -> isError=False contentType=image mime=image/jpeg b64len=185332
  mcp jpeg sha256: 4b076558040ad9fe478263de3e22923fba144e65c8a88cc735da118446d271e2 (138,998 bytes)
  raw replies: 3
==== [6] commands (frozen command table) ====
  commands -> 18387 chars
  first 300 chars: {
  "commands": [
    {
      "id": "app.status",
      "summary": "Editor state: mode (gui or headless), version, current and selected photos.",
      "read_only": true,
      "tool": "lumen_status",
      "parameters": {
        "type": "object",
        "properties": {},
        "requir
==== [7] size ====
137 MB
==== SUMMARY (FINAL) ====
  1-no-qt        PASS
  2-version      PASS
  3-info         PASS
  4-render       PASS
  5-mcp         PASS
  6-commands     PASS
  7-size         137.27
RESULT: ALL PASS
```

### 额外的「零回归」硬证据

1. **像素级一致**：CLI 渲染产物与 MCP `render_preview` 返回的 base64 解码后，
   sha256 **完全相同**，且与 baseline 一致：
   `4b076558040ad9fe478263de3e22923fba144e65c8a88cc735da118446d271e2`（138,998 B）。
   三轮构建（baseline / lever A / lever B+C）产出的 JPEG 字节数与哈希均未变。
   → 剔除的三样东西**没有触及**解码/调色/缩放/编码任何一个环节。
2. **命令表零漂移**：`lumen-cli.exe commands` 与 `commands-frozen.json` 逐条比对
   （id / summary / tool / parameters）：
   ```
   live commands  : 27
   frozen commands: 27
   only in live   : []
   only in frozen : []
   changed        : []

   PASS: command table identical to commands-frozen.json
   ```
3. **可复现构建**：`rm -rf build dist` 后重跑 `pyinstaller --noconfirm --clean
   LumenCLI.spec`，exit 0、无 ERROR，spec 自报 `[slim] binaries: dropped
   36.63 MB (2/97 entries)`，产物仍为 137.27 MB。

---

## 4. 改动清单

### 4.1 `lumen-sidecar/LumenCLI.spec`（瘦身固化在这里）

```python
excludes=[... 'PySide6', 'PyQt5', 'PyQt6', 'PySide2',
          # --- 瘦身 A: Tk/Tk (tifffile 的 imshow 用，实际不可达)
          'tkinter', 'PIL.ImageTk', 'PIL.SpiderImagePlugin', 'PIL._tkinter_finder'],

DROP_BINARIES = [
    (r'(?i)^cv2$',  r'(?i)^opencv_videoio_ffmpeg.*\.dll$'),   # 瘦身 B
    (r'(?i)^PIL$',  r'(?i)^_avif.*\.pyd$'),                    # 瘦身 C
]
DROP_DATAS = [(r'(?i)^_tcl_data$', r'(?i)'), (r'(?i)^_tk_data$', r'(?i)')]  # 兜底

# 在 COLLECT 之前摘掉条目
def _dropped_bytes(entries, rules, label):
    kept, total = [], 0
    for entry in entries:
        dest = str(entry[0]).replace('\\', '/')
        folder, _, fname = dest.rpartition('/')
        if any(re.search(rfolder, folder) and re.search(rname, fname)
               for rfolder, rname in rules):
            total += Path(entry[1]).stat().st_size
            continue
        kept.append(entry)
    print(f'[slim] {label}: dropped {total/1024/1024:.2f} MB ...')
    return kept

a.binaries = _dropped_bytes(a.binaries, DROP_BINARIES, 'binaries')
a.datas    = _dropped_bytes(a.datas,    DROP_DATAS,    'datas')
```

> **踩坑记录（留给下一个改 spec 的人）**：PyInstaller 6 的
> `Analysis.binaries` / `.datas` 条目是**三元组** `(dest, src, typecode)`，
> 且 `dest` 是**含文件名**的目标相对路径（`'cv2/opencv_videoio_ffmpeg4140_64.dll'`），
> `src` 才是磁盘来源（`entry[1]`）。按二元组 `(src, dest_dir)` 写会静默匹配 0 条
> ——构建照样成功、产物照样 184 MB，只有 `[slim] dropped 0.00 MB` 会暴露它。
> 所以过滤器必须**自报省下的字节数**，让它在构建日志里可审计。

### 4.2 `.plan/patches/build_lumen_sidecar.ps1`

改动（该文件已按 deliverable 2 更新；它是 `.plan/` 下的构建脚本，非应用源码）：

- 门禁阈值 `$MaxSizeMB` `200 → 140`（140 = 实测 137.27 + 约 3 MB 余量）。
  **不再做虚假的 120 承诺**，脚本头部写明了 120 不可达的原因。
- 新增门禁 **D：MCP 常驻通道握手**（`initialize` / `tools/list` / `tools/call
  render_preview`），断言 `serverInfo.version=1.6.0` 且无 Traceback。
- 新增门禁 **E：命令表与 `commands-frozen.json` 逐条比对**。
- 新增 `-SkipInstall` / `-SkipBuild` 开关，便于只重跑门禁。
- **修了两个真 bug**（原脚本里就存在，会让门禁失效）：
  1. **JSON 参数被 PowerShell 5.1 吃掉引号** → 门禁C 必然报
     `lumen: arguments must be a JSON object`。改为自建
     `ProcessStartInfo` + 按 MSVC `list2cmdline` 规则自行拼命令行
     （`Invoke-Sidecar`）。
  2. **`RedirectStandardInput` 没开** → 喂 MCP stdin 会 NPE；且常驻型子进程
     （`mcp`）必须显式关闭 stdin 才会退出。
  3. 附带：门禁③的无头导入冒烟在错误的工作目录下执行（`lumen` 是源码树不是
     site-packages 包），会 `ModuleNotFoundError: No module named 'lumen'`
     ——已改为 `Push-Location $SidecarDir`。
  4. 附带：文件含中文注释，PowerShell 5.1 必须靠 **UTF-8 BOM** 才能正确解析，
     否则报 `表达式或语句中包含意外的标记`。
- 实测输出：
  ```
  ==> 3/6 无 Qt 导入冒烟
    OK headless imports OK, no PySide6
  ==> 5/6 门禁
    ✓ 门禁A：零 Qt
    • 体积：137.27 MB（预算 140MB）
    ✓ 门禁B：体积达标
    ✓ 门禁C：真实 RAW 渲染 OK（138998 bytes）
    ✓ 门禁D：MCP 握手 + tools/list + render_preview OK（serverInfo 1.6.0）
    ✓ 门禁E：命令表与 commands-frozen.json 一致（27 条）

  ✓ sidecar 就绪：...\dist\lumen-cli（137.27 MB）
  ```

---

## 5. 为什么 120 MB 不可达（剩余 137.27 MB 的构成）

把 137.27 MB 里的 217 个文件逐个归类后，**没有任何一块是可剔的冗余**：

| 组成 | MB | 为什么不能动 |
|---|---:|---|
| `cv2\cv2.pyd` | **71.28** | lumen 渲染引擎的核心算子全在这儿：`SIFT_create` / `warpAffine` / `warpPerspective` / `cvtColor` / `resize` / `imdecode` / `erode` / `bilateralFilter` / `createCLAHE` / `createMergeMertens` / `PyRotationWarper` / `findTransformECC`（`engine.py`、`merge.py`、`geometry.py`）。**不可替代**。 |
| `numpy.libs\libscipy_openblas64_*.dll` | **19.64** | `numpy._core` 硬链接 BLAS/LAPACK，`import numpy` 即加载。**不可替代**。 |
| `lumen-cli.exe` | 6.28 | 0.35 MB bootloader + **5.92 MB 的 PYZ overlay**（全部纯 Python 字节码）。PE 结构实测确认，不是异常膨胀。 |
| `libcrypto-3` + `libssl-3` + `_ssl.pyd` | 5.92 | `commands.py:25` 模块级 `from . import ... nl_edit` → `nl_edit.py:23` `import urllib.request` → `http.client` → `ssl`。**在无头导入路径上**。 |
| `python313.dll` | 5.83 | 解释器本体。 |
| `numpy\_core\_multiarray_umath.pyd` | 3.68 | numpy 核心。 |
| `PIL\_imagingft.pyd` | 2.07 | `watermark.py:7` `from PIL import Image, ImageDraw, ImageFont`，第 84 行 `ImageFont.truetype(...)`——水印是真实功能。 |
| `PIL\_imaging.pyd` | 2.51 | Pillow 编解码核心。 |
| `rawpy\raw_r.dll` | 1.84 | LibRaw，RAW 解码本体。 |
| `sqlite3.dll` + `_sqlite3.pyd` | 1.63 | `catalog.py:24` 模块级 `import sqlite3`（Lightroom catalog 导入）。 |
| `assets\lensfun\db\*.xml` | 5.03 | 镜头校正数据库，是**功能**不是膨胀（且 CC BY-SA 3.0 要求随附）。 |
| `base_library.zip` / `ucrtbase` / MSVC runtime / `api-ms-win-*` | ~4.0 | Python 与其链接的 CRT。 |
| `pyexpat.pyd` | 0.20 | `lens.py:38` `import xml.etree.ElementTree` 解析 lensfun XML。 |
| 其余 | ~7.3 | `*.dist-info` 许可证（再分发需要）、`lumen\locales\`、零散扩展模块。 |

**光前两项就是 90.92 MB（占 66%），加上解释器 + PYZ + OpenSSL 共 109.6 MB。**
也就是说：把除「cv2.pyd / openblas / python313 / exe / OpenSSL」之外的**所有东西
归零**，体积也只有 109.6 MB——而那 27.7 MB 里真正可自由支配的不足 7 MB。
**在保持 cv2 + numpy + 当前依赖集的前提下，120 MB 在数学上不可达。**

### PE 层也已压到极限

逐个解析了最大几个二进制的 PE section 表，确认没有可剥的调试数据：

| 文件 | section 构成 | overlay |
|---|---|---|
| `cv2.pyd` | `.text` 55.95 + `IPPCODE` 1.60 + `.rdata` 11.52 + `.data` 0.80 + `.pdata` 1.20 + … | **0 字节** |
| `libscipy_openblas64_*.dll` | `.text` 18.98 + `.rdata` 0.31 + `.edata` 0.28 + … | **0 字节** |
| `raw_r.dll` | `.text` 1.12 + `.rdata` 0.40 + `.data` 0.28 + … | **0 字节** |
| `python313.dll` | `.text` 2.72 + `.rdata` 2.35 + … | 0.01 MB |

无 `.debug*` section、无 COFF 符号表、无证书表、无 overlay。`cv2.pyd` 里的
`IPPCODE`/`IPPDATA`（1.64 MB）是 Intel IPP 真实链接代码，不是调试残留。
`strip=True` 在 Windows 上本来就是 no-op。

---

## 6. 被否决的杠杆（逐条附原因）

| 候选 | 潜在收益 | 否决原因 |
|---|---:|---|
| 剔除 OpenSSL（`excludes=['ssl']`） | -5.92 MB | `commands.py` 模块级导入 `nl_edit` → `urllib.request` → `http.client` → `ssl`。剔了整条 CLI 起不来。 |
| 剔除 `sqlite3` | -1.63 MB | `catalog.py:24` 模块级 `import sqlite3`，`commands.py:25` 导入 `catalog`。同上，会直接 ImportError。 |
| 剔除 `PIL\_imagingft`（FreeType） | -2.07 MB | `watermark.py` 用 `ImageFont.truetype` 画水印文字。剔了水印功能崩。 |
| 剔除 `numpy.random` | -1.09 MB | `engine.py:1144` `np.random.default_rng(17031)` 在**渲染路径**里（颗粒/降噪噪声）。 |
| 剔除 `numpy.fft` | -0.26 MB | `speech.py:66` `np.fft.rfft` 做音频转写频谱；`diagnostics`/`nl_edit` 可达。收益也配不上风险。 |
| 剔除 `PIL\_webp` | -0.40 MB | lumen 源码里无 webp 引用，但 Gallery 侧可能喂 webp 输入。为 0.4 MB 冒输入格式不支持的风险，不划算。 |
| 剔除 `pyexpat` | -0.20 MB | `lens.py` 解析 lensfun XML 必需。 |
| 剔除 numpy 子包（f2py/testing/distutils/polynomial） | ~-0.8 MB | 收益微小、且 lazy import 时机不可控。 |
| 删 `*.dist-info` 许可证文件 | -0.26 MB | LibRaw (LGPL-2.1) / numpy (BSD-3) / OpenCV (Apache-2.0) 再分发**必须**随附许可证。不做。 |
| 裁剪 `assets\lensfun\db\*.xml` | 最多 -4.0 MB | 镜头库是功能本体。裁掉 = 某些机身/镜头查不到校正，等于制造静默的功能回归。 |
| 换更小的 OpenCV 版本 | 可能 -8~10 MB | 偏离任务书锁定的 opencv-headless 4.14，且降版本本身是高风险变更。**建议单独立项评估，不在本次瘦身里做。** |
| UPX 压缩 | 约 -45~60 MB | **本机未安装 upx**（`C:\Program Files\upx` 不存在、PATH 无 `upx`），且计划已明确选 onedir + NSIS lzma2。UPX 会让 DLL 被杀软误报（`Trojan.Win32.Wackelbor` 类），并与 NSIS lzma2 叠加成二次压缩、对最终安装包体积增益有限。**需要显式决策才能引入。** |
| onefile | — | onefile 是自解压包，**磁盘占用比 onedir 更大**。任务书已明确保持 onedir。 |

---

## 7. 建议的下一步（供决策，未执行）

1. **接受 137 MB**，把门禁阈值定在 140 MB（脚本已改）。NSIS lzma2 安装后预计
   落在 60~70 MB，终端用户感知远小于 137 MB。
2. 若安装包体积是硬指标，优先评估 **UPX**（需先装 upx 并做杀软回归），或
   **单独拆分 GPU/AI flavor**（带 onnxruntime 的那个本就是另一个包）。
3. 若磁盘占用是硬指标，唯一干净的路径是**替换 OpenCV**——但 lumen's 引擎用了
   它的 SIFT/ECC/MergeMertens/PyRotationWarper，等于要重写 `merge.py` 与
   `engine.py` 的大半，属于独立项目，不是瘦身。
