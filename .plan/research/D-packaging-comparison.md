# ④ 打包 / 构建 / 发布链 — 逐文件比对报告

对象: 宿主 `gallery-flask` (Tauri 2.0 + Rust + React) vs 客体 `lumen-raw` (Python RAW 编辑器)。
集成决策: 把 lumen-raw 裁成 **headless sidecar** `lumen-cli`, 随宿主 NSIS installer 出货, ExifTool 二进制与 AI 权重不进安装包 (按需下载)。

比对完成时间: 2026-10-11。所有结论均有代码行号证据。

---

## 0. 证据速查表

### 0.1 客体当前是 **两种 Windows 打包** 并存, 必须合并

| 入口脚本 | 依赖清单 | onnxruntime flavor | 产物定位 | 关键行 |
|---|---|---|---|---|
| `build.ps1` | `requirements-lock.txt` (含 `PySide6==6.11.2`, `onnxruntime==1.30.0` CPU, `pyinstaller` 在 venv 内另装) | **CPU** | `dist\LumenRAW\LumenRAW.exe` (`onedir+onefile-in-COLLECT`) | `build.ps1:7-9` |
| `build-directml.ps1` | 要求现有 `.venv` 已切到 `onnxruntime-windowsml`+`windowsml` | **DirectML** | 同上 | `build-directml.ps1:9-15` |
| `tools/build_release.ps1` | **auto-probe**: 若无 DmlExecutionProvider → pip uninstall 所有 ort 变体 → 装 `requirements-directml.txt` | **DirectML (自动)** | 完整流水线: pytest → GPU check → PyInstaller → Inno Setup → 解包校验 → 冒烟 → SHA256SUMS | `build_release.ps1:44-69` |
| `tools/build_macos.sh` | `requirements-macos.txt` (`onnxruntime==1.30.0` 含 CoreML) | **CoreML** | `.app`+DMG (arm64) | `build_macos.sh:57-58` |

**关键结论 (回答问题 2)**: Windows x64 应选 `requirements-directml.txt` 的 **`onnxruntime-windowsml==1.30.0.202609102321` + `windowsml==2.4.89`**。理由:
- `LumenRAW.spec:8-12` 用 `collect_all('onnxruntime')`+`collect_all('windowsml')` — 这就是 windowsml flavor 的收集方式。
- `build_release.ps1:45` 明确 `assert 'DmlExecutionProvider' in ort.get_available_providers()`。
- `requirements.txt:7` 的 `onnxruntime>=1.21,<2` 只是 CPU fallback, 只用于 `run-source.cmd` 开发环境和 `build.ps1` 的 CPU-only 对照构建; 生产 sidecar **不** 用它。
- `requirements-lock.txt` 同样只被 `build.ps1` (CPU 构建) 使用; `build_release.ps1` 会自动改写环境, 最终产物是 DirectML。
- sidecar 只需要 `onnxruntime` + `windowsml`, 不需要 `cupy-cuda12x` (`requirements-gpu.txt`); TensorRT for RTX 由 `windowsml` provider 在 Win11 24H2+ RTX30+ 上按需下载, 见 `requirements-directml.txt:4-6` 与 `compute.py:134-135` (`PluginDevices`)。

### 0.2 lumen 运行期资源查找 — **全部相对 `__file__`, 无环境变量兜底**

`Path(__file__).resolve().parents[1]` 即冻结产物根 (`onedir` 下 = `_internal`)。证据:

| 资源 | 查找代码 | frozen 路径 |
|---|---|---|
| ExifTool | `white_balance.py:17-20` `folder = parents[1]/'assets'/'exiftool'`; nt 下 `exe = folder/'exiftool.exe'`, 存在才用, 否则返回 `None` 优雅降级 | `_internal/assets/exiftool/exiftool.exe` |
| lensfun DB | `lens.py:47` `DB_FOLDER = parents[1]/'assets'/'lensfun'/'db'`; `lens.py:5-7` 纯 NumPy/OpenCV 解析 XML, **不链接 lensfun 库** | `_internal/assets/lensfun/db/*.xml` |
| AI 权重 | `engine.py:1218` / `restoration.py:13` / `selection.py:42` / `denoise.py:9` / `speech.py:18` 均 `parents[1]/'assets/models'/...` | `_internal/assets/models/*.onnx` |
| 语言包 | `i18n.py:28` `LOCALES = parents[0]/'locales'` (= `lumen/locales/*.json`, **JSON 非 .qm**) | `_internal/lumen/locales/*.json` |
| 图标/字体 | `app.py:236,240` / `watermark.py:81` `parents[1]/'assets'/NotoSansSC.ttf`、`lumen.ico` — 仅 GUI 用 | headless 不需要 |

**没有任何 `os.environ` 可作为资源根覆盖** (搜遍 `lumen/` 只有 `LUMEN_COMPUTE`/`LUMEN_DML_DEVICE`/`LUMEN_LANGUAGE` 等运行时行为开关, 无资源路径开关)。**对宿主的含义**: 按需下载的模型/ExifTool 必须落到 sidecar 安装目录内的 `_internal/assets/...` 硬编码位置 (写死), 不能改 lumen 源码。这要求 sidecar 装在**可写目录** (Tauri 装在 `%LOCALAPPDATA%\<id>` 时可写; 若装 Program Files 则需 UAC, 应优先把可下载资源放 `%APPDATA%\gallery-culling\lumen-assets\` 并由宿主软链/复制进 `_internal/assets/models`)。

---

## 1. 逐文件比对表 (file-by-file)

### 1.1 客体打包文件

| 文件 | 作用 | headless sidecar 处置 | 证据 |
|---|---|---|---|
| `LumenRAW.spec` | GUI EXE + `lumen-cli` EXE 双入口, 同一 `PYZ`/`COLLECT` | **改写为新 `LumenCLI.spec`**, 只保留 CLI 入口 | 现 `LumenRAW.spec:27-33` 两个 EXE (`console=False`GUI + `console=True`CLI) |
| `LumenRAW-macOS.spec` | macOS `.app` | 无需移植 (宿主只发 Windows x64) | — |
| `installer.iss` | Inno Setup 安装器 (GUI app) | **不用**; 改用宿主 Tauri NSIS 一次安装 | — |
| `build.ps1` | CPU onedir 构建 | 不用 (CPU flavor 非生产) | `build.ps1:7` |
| `build-directml.ps1` | DirectML 构建 (需预切 venv) | 参考其 `check_gpu.py` 步; 换成 requirements-directml | `build-directml.ps1:9-13` |
| `build-release.cmd` → `tools/build_release.ps1` | 完整 Windows 发布流水线 | **作为 `build_lumen.ps1` 蓝本**, 删 pytest/Inno/DMG 段 | `build_release.ps1` 全篇 |
| `build-macos.command` | macOS | 不用 | — |
| `run-source.cmd` | venv 引导 (py3.12 → requirements.txt) | 参考其 venv 引导; 换 headless 清单 | `run-source.cmd:4-16` |
| `requirements.txt` | 主清单含 `PySide6` + CPU `onnxruntime` | 派生 `requirements-cli.txt`: 去掉 PySide6 | `requirements.txt:5-7` |
| `requirements-gpu.txt` | cupy-cuda12x + onnxruntime-gpu | 不用 (锁定 DirectML) | `requirements-gpu.txt:4-5` |
| `requirements-directml.txt` | onnxruntime-windowsml + windowsml | **采用 (基础)** + 追加 numpy/cv2/Pillow/rawpy/tifffile/pyinstaller | `requirements-directml.txt:7-8` |
| `requirements-macos.txt` | macOS arm64 全锁定 | 不用 (Win x64 另锁) | — |
| `requirements-lock.txt` | Win CPU 全锁定 (含 PySide6) | 派生 Win-DirectML 全锁定 `requirements-cli-lock.txt` (去 PySide6, 换 windowsml) | `requirements-lock.txt:13,22` |
| `requirements-dev.txt` | dev (pytest+pyinstaller) | 仅构建机参考 | — |
| `tools/fetch_assets.py` | 拉 runtime-assets.zip (含 ExifTool+模型 manifests) + speech-assets | **改**: sidecar 构建跳过 ExifTool/src 权重, 保留 lensfun/locales; 见 §3 | `fetch_assets.py:76-78,112-115` |
| `tools/fetch_exiftool.py` | 仅 macOS Perl ExifTool | 不用 (Win 用 exiftool.exe) | `fetch_exiftool.py:1-8` |
| `tools/build_release.ps1` / `build_macos.sh` | 编排 | 蓝本 (见 §6) | — |
| `tools/package_windows.py` / `verify_installer.py` / `publish_release.ps1` | ZIP/校验/发布 | 不用 (宿主接管发布) | — |

### 1.2 客体数据 (现仓库已含)

| 路径 | 体积量级 | sidecar 处置 | 证据 |
|---|---|---|---|
| `assets/lensfun/db/*.xml` (~60 文件) | ~2-4MB | **保留** (核心 `lens.py` 依赖, 纯数据) | `lens.py:47` |
| `assets/lensfun/COPYING.CC_BY-SA_3.0` | <1KB | 保留 (license) | — |
| `lumen/locales/*.json` (8 文件: en/de/es/fr/ja/ko/ru/zh_TW; zh_CN 为源码串) | 各几 KB | **保留** (i18n 核心 `tr()` 非独 GUI; `white_balance.py:8` 等 core 模块调用) | `i18n.py:20-28` |
| `assets/models/*.json` (manifests: selection/v11/v12/model-info) | 小 | **保留** (宿主按需下载的 URL+sha256 清单源) | `selection-models.json`, `model-info.json` |
| `assets/*-LICENSE.txt` (NAFNet/BasicSR/…~11 个) | 各 KB | 保留 (合规) | glob |
| `assets/lumen.ico` | ~10KB | 剔 (GUI 图标; CLI 无窗口) — 保留亦可, 体积可忽略 | `LumenRAW.spec:29,33` |
| `assets/exiftool/` (仓库内**不存在**, 构建时 fetch 进来) | win exe+perl lib | **不入包** (按需下载) | `fetch_assets.py:20-24` |
| `assets/NotoSansSC.ttf` (仓库内**不存在**, runtime zip 才有) | ~10MB | **剔除** (源码 `app.py:236` 引用了但该文件未入库; CLI 不需要字体) | `app.py:236` |

> **注意**: 任务简报假设的 "字体目录 / 9 语言 .qm" 与实际仓库不符 — locales 是 **8 个 JSON** (非 9 个、非 .qm), 且**不存在 assets/fonts 目录**。i18n 的 `i18n.py:104` 的 `QLocale` 是懒导入 (仅 GUI 菜单), 不影响 headless `tr()`。故 locales 保留。

### 1.3 宿主打包文件 (需改动)

| 文件 | 现状 | 需要的改动 | 证据 |
|---|---|---|---|
| `src-tauri/tauri.conf.json` | `bundle` 段 **无** `externalBin`/`resources` | 加 sidecar 落地 (见 §4) | `tauri.conf.json:40-51` |
| `scripts/release.mjs` | 只跑 `pnpm tauri build` + 生成 updater.json | 前置 sidecar 构建 + 体积门禁 (见 §4 行号) | `release.mjs:26-38,40-69` |
| `package.json` | `scripts` 无 python sidecar 步 | 加 `build:lumen`/`tauri` 链 (见 §6) | `package.json:6-12` |
| `src-tauri/Cargo.toml` | 无 shell 插件 | 按 §4 定: 若走 std::process 则**无需**加 `tauri-plugin-shell` | `Cargo.toml:22-43` |
| `src-tauri/src/*.rs` | 无调用 lumen 的模块 | 新增 `src-tauri/src/lumen_cli.rs` (spawn sidecar) | `main.rs`/`lib.rs` |
| `.gitignore` | 有 `.venv/` | 加 sidecar 构建产物 (略, 属任务 ①/② 领域) | `.gitignore:17` |
| `src-tauri/capabilities/*.json` | 无 `shell` 权限 | 若用 `tauri-plugin-shell` 则加 `shell:allow-spawn`+scope (本方案用 std::process, **不需要**) | `default.json:8-13` |

> 现有 `luminar.rs` 已示范 **std::process::Command 直调外部 exe** (调 Skylum Luminar AI), 说明宿主 spawn sidecar 走同款原生调用即可, **不必引入 tauri-plugin-shell**。这决定了 §4 推荐 **方案一** (随主 NSIS 包) 的落地方式。

---

## 2. 客体瘦身可行性 + `LumenCLI.spec` 保留/剔除清单

### 2.1 GUI→core 泄露点 (三处懒导入, 非简报说的两处)

| 位置 | 现状 | 修法 |
|---|---|---|
| `session.py:108` | `from .lens_panel import auto_enable` → `lens_panel` 模块级 `from PySide6.QtWidgets import ...` (`lens_panel.py:10`) + `from .widgets import AdjustSlider` (`lens_panel.py:15`, GUI 模块) | **方案**: 把 `lens_panel.auto_enable()`+`AUTO_KEY` 移到 `lens.py`; `session.py:108` 改为 `from .lens import auto_enable` |
| `commands.py:549` | `from . import batch_export` (内部 `batch_export.py:15` 模块级 `from PySide6.QtWidgets import ...`; 且 `batch_export.py:23-26` 顶层 `FORMATS`/`SIZES` 调 `tr()` — 任何 `import batch_export` 都会触发) | 见下 |
| `commands.py:583` | **同一 `from . import batch_export`** (`photo_export_batch`) — 简报未列, 也必须一起修 | 见下 |

**`batch_export` 的修法 (推荐)**: `commands.py` 只用 `batch_export.run()`, 从不实例化 `BatchExportDialog`。取最小改法: 在 `batch_export.py:15` 把 `PySide6...` import 用 try/except 包住, 并把 `from . import ... watermark` 中依赖 Qt 的部分下沉; 更干净是把 `run()`/`BatchExportDialog` 拆成 `batch_export_core.py`(纯)+`batch_export.py`(GUI 壳)。**两种都必须保证 `import batch_export` 不 import PySide6。**
**隐患**: PyInstaller 仍会把 `batch_export.py` 等 core 链上**未 import** 的 GUI 模块 (app.py/library.py/rating.py…) 因属于 `lumen` 包而被扫入; 真正决定 "无 Qt6*.dll" 的是 **spec `excludes=['PySide6', ...]` + 仅 CLI 入口 (onefile spec, Analysis 不引 main.py 的 GUI 路径)**。验收项 (见 §5/步2) 会兜底。

### 2.2 `LumenCLI.spec` — 保留/剔除清单

```python
# LumenCLI.spec (onefile, Windows x64 DirectML headless) — 关键 diff
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_data_files
root = Path(SPECPATH)
raw_data, raw_b, raw_h = collect_all('rawpy')
ort_data, ort_b, ort_h = collect_all('onnxruntime')      # = onnxruntime-windowsml
try:
    winml_data, winml_b, winml_h = collect_all('windowsml')
except Exception:
    winml_data = winml_b = winml_h = []
a = Analysis(
    [str(root / 'main.py')],               # main.py:52 → sys.executable name == 'lumen-cli' → 走 lumen.cli
    pathex=[str(root)],
    binaries=raw_b + ort_b + winml_b,      # 保留 rawpy LibRaw, ORT+DirectML, windowsml
    datas=[                                   # 只留 4 样
        (str(root / 'assets' / 'lensfun'), 'assets/lensfun'),   # 镜头数据 (2-4MB, core lens.py)
        (str(root / 'lumen' / 'locales'), 'lumen/locales'),     # i18n JSON (8 个小文件)
        (str(root / 'assets' / 'models'), 'assets/models'),     # 只含 *.json manifests, 无 .onnx
    ] + [(str(p), 'assets') for p in (root/'assets').glob('*-LICENSE.txt')]
      + raw_data + ort_data + winml_data + collect_data_files('tifffile'),
    hiddenimports=raw_h + ort_h + winml_h + ['PIL.ImageCms'],   # 去掉 QtMultimedia/QtNetwork
    excludes=['PySide6','PySide6.Essentials','PySide6.Addons','shiboken6',
              'onnx','sympy','torch','torchvision','cupy','tkinter'],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], name='lumen-cli', console=True, ...)   # onefile 单 exe
```

逐项标注 (对比现 `LumenRAW.spec`):

| spec 元素 | 现 `LumenRAW.spec` | sidecar 处置 |
|---|---|---|
| `collect_all('rawpy')` | 有 (`:7`) | **保留** (LibRaw .dll ~8-12MB) |
| `collect_all('onnxruntime')` | 有 (`:8`) | **保留**, 但 venv 须是 `onnxruntime-windowsml` (DirectML) |
| `collect_all('windowsml')` | try (`:9-12`) | **保留** (TRT provider 目录) |
| datas `(assets,'assets')` 全量 | `:16` | **改为只用 `assets/lensfun` + `assets/models`(仅 json)** |
| datas `lumen/locales` | `:16` | **保留** |
| `collect_data_files('tifffile')` | `:16` | **保留** (DNG 16-bit TIFF 导出) |
| hiddenimports `PySide6.QtMultimedia/.QtNetwork` | `:17` | **剔除** (语音/网络 GUI 依赖) |
| hiddenimports `PIL.ImageCms` | `:17` | **保留** (白平衡 ICC) |
| `excludes` | `:18` `cupy/torch/torchvision/onnx/sympy` | **追加** `PySide6/shiboken6/PySide6_*/tkinter` |
| nt 特判删 `icuuc.dll`/`icudt*` | `:20-25` | **保留并加强**: headless 无 Qt 但 onnxruntime/windowsml 也可能带 ICU; 该过滤防 System32 遮蔽, 应予保留 |
| GUI `EXE(console=False)` | `:27-29` | **删除** |
| CLI `EXE(console=True, name='lumen-cli')` | `:31-33` | **保留为唯一 EXE** |
| `COLLECT` | `:34` | onefile 则无 COLLECT |

> **onefile vs onedir 取舍 (deprioritize, 记录在案)**: onefile (单个 `lumen-cli.exe`, `~150-250MB`) 启动时自解压到 `%TEMP%`, 首次启动慢 (~5-15s), 但宿主 NSIS 集成最简单 (单文件, 无 `_internal` 顶层暴露)。onedir (`_internal\` 同级) 启动快, 但宿主需把目录树塞进 `bundle.resources` 且 Rust spawn 时要定位 `_internal`。**推荐 onefile**: NSIS 单文件、无共享目录更新问题、体积预算达标见 §5。(若实测 onefile 启动超时可退回 onedir。)

### 2.3 不需要进 sidecar 的客体 GUI 模块 (仅供核对)

`app.py, library.py, rating.py, viewport.py, widgets.py, palette.py, studio.py, lens_panel.py, batch_export.py, auto_masks.py, ai_dialog.py, agent_dialog.py, enhance_dialog.py, merge_dialog.py, merge_diagnostics.py, workflow.py, workflow_diagnostics.py, release_diagnostics.py, watermark_dialog.py, nl_panel.py, speech.py(依赖 models), scheduler.py, control.py(QtNetwork/QProcess), diagnostics.py(QtTest), exposure_curve.py, revision.py, resolution.py, dng?`。其中 `speech.py` 因语音模型不下载, 到点自然 `MODEL.is_file()==False` 走不到 onnx。
真正会被 core 链 import 的非 GUI 但需注意: `nl_edit.py` (远程 LLM, CLI 的 nl 功能走它; 无 Qt, 保留)、`photo_metadata.py`, `catalog.py`(懒引 exiftool, 保留)。

---

## 3. 资源拉取与按需下载 (问题 3)

### 3.1 客体现状: 三套独立机制, 一个共同校验 (sha256)

| 工具/清单 | 拉什么 | URL | 校验 | 何时跑 | 证据 |
|---|---|---|---|---|---|
| `tools/fetch_assets.py` + `assets/runtime-assets.json` | runtime ZIP: **ExifTool (exiftool.exe + Strawberry Perl lib) + Noto 字体 + AI 权重 .onnx manifests** | **GitHub Releases** (`runtime-assets.json:5`, `must start https://github.com/` `:129`) | ZIP 整包 `bundle.sha256` + 每文件 `bytes`+`sha256`, staging 解压逐成员验, 防 zip-slip | **build-time** (一次性全装) | `fetch_assets.py:112-139` |
| `assets/speech-assets.json` (DIRECT_MANIFESTS) | SenseVoice 语音模型 `model.int8.onnx`(231MB)+`tokens.txt` | **HuggingFace** 固定 revision (`DIRECT_HOSTS` `:78`, url `speech-assets.json:7`) | 逐文件 `bytes`+`sha256` | build-time (随 fetch_assets) | `fetch_assets.py:81-104` |
| `assets/models/*.json` (selection/v11/v12/model-info) | .onnx 的 `source` + `sha256`/`weights_sha256` | HuggingFace/pytorch.org/GitHub releases **仅元数据, 无下载逻辑** | 只有 sha256 记录 | 人工/离线核对 | `selection-models.json`, `model-info.json:4,8` |
| `tools/fetch_exiftool.py` | **仅 macOS** Perl ExifTool | exiftool.org/sourceforge tarball | **官方 checksums.txt 的 sha256 硬编码在脚本** (`VERSION='13.59'`, `SHA256='668e…'`) | macOS build-time | `fetch_exiftool.py:22-25` |

**Windows runtime zip (v1.2.1) 大小 592,599,134 B ≈ 565MB**, 含 ExifTool+AI 权重 → 就是"为何必须剔"的直接证据 (`runtime-assets.json:6`)。

### 3.2 sidecar 构建期降级 (直接复用 fetch_assets.py, 加 `--skip-exiftool`/`--skip-models`)

`fetch_assets.py` 结构友好, 加两条开关即可:
- `--skip-exiftool`: 在 `verify()/install_archive()` 里把 `assets/exiftool/**` 记录剔除 (白名单 `for record in manifest['files'] if not record['path'].startswith('assets/exiftool/')`)。
- `--skip-models`: 剔除 `assets/models/**` 里的大 `.onnx` 记录, 只保留 `*.json` manifests (本身已在仓库, 不依赖 zip)。
- 不执行 `install_direct` (`speech-assets.json`)。
- **净效果**: sidecar 构建只需 lensfun/locales/licenses (全在仓库内 ~5MB), 甚至可不下载 zip; spec datas 直接指向仓库现有文件。

### 3.3 宿主侧运行期按需下载 — 新设计 (slice, runtime-assets 已在 §3.1)

lumen 硬编码 `_internal/assets/...`, 宿主必须在**安装后可写的位置**提供资源。建议:

```
%LOCALAPPDATA%\gallery-culling\           (Tauri 应用数据; Tauri v2 默认 currentUserLocal)
├─ resources\lumen\lumen-cli.exe           (sidecar, 随 NSIS)
└─ lumen-assets\                            (宿主按需写入)
   ├─ exiftool\exiftool.exe+exiftool_files\  (~15MB)
   └─ models\*.onnx                           (按需 feature)
```

宿主 Rust (`lumen_cli.rs`):
1. 启动时 resolve sidecar 安装根 (Tauri `app.path().resource_dir()` 或推导 `%LOCALAPPDATA%\gallery-culling`), 记 `_internal_root = <sidecar_exe_dir>` (onefile 自解压后 `sys._MEIPASS`)。
2. spawn 前检查 `_internal/assets/models/<needed>.onnx` 是否在; 不在则从宿主自带 manifest (从 §3.1 制品复制来的 url+sha256) 下载到 `lumen-assets\models\`, 验 sha256 后 **copy 进 `_internal/assets/models/`** (onefile 会解压到 `%TEMP%\_MEIxxxx`, 可写; 缓存命中则跳过)。
3. ExifTool 同理 (下载 exe+perl_files 到 `lumen-assets\exiftool\`, 拷进 `_internal/assets/exiftool\`)。
4. `LUMEN_COMPUTE`/`LUMEN_DML_DEVICE` 可作为 env 传入控制 GPU (`compute.py:108,140`)。`LUMEN_LANGUAGE` 若宿主 UI 语言与 lumen 不一致也可传 (`i18n.py:128`)。

> **onefile 的副作用**: 每次冷启动都可能重新解压到新 `_MEI` 目录 → 资源需每进程重新 copy (或先写回 bundle 同级的固定目录)。**onedir 无此问题** (资源 copy 一次, 重启常驻)。这是 onedir 相对 onefile 的一个实质优势, 需在落地 benchmark 时权衡 (见"待验证项")。

### 3.4 版本校验契约 (宿主侧 manifest)

`assets/models/*.json` 已有 sha256, 但 URL 与 bundle 元数据格式不一。**建议宿主自制一份 `lumen-assets.manifest.json`** (从 §3.1 三条清单聚合归一化), 字段:
```json
{ "schema": 1,
  "files": [
    {"path": "assets/exiftool/exiftool.exe", "bytes": 58368, "sha256": "68c0…",
     "url": "https://github.com/…", "required": false},
    {"path": "assets/models/realesrgan-x4plus.onnx", "bytes": …, "sha256": …,
     "url": "https://huggingface.co/…", "required": false, "feature": "superres"}
  ] }
```
下载逻辑照抄 `fetch_assets.py:95-100` (HuggingFace UA + temp + sha256 校验 + `os.replace` 原子落盘), 复用其健壮性。

---

## 4. 宿主打包链改造 (问题 4)

### 4.0 目标 sidecar 布局

```
src-tauri/
├─ tauri.conf.json              # 加 resources 指向
├─ binaries/
│  └─ lumen-cli.exe             # (onefile 推荐则仅此 1 文件; onedir 则 + _internal/)
└─ ...
```
构建管线产出 `src-tauri/binaries/lumen-cli.exe`, `resources: ["binaries/lumen-cli.exe"]`, Tauri 装到 `…\gallery-culling\resources\lumen-cli.exe`。Rust spawn 从那里起。

### 4.1 `tauri.conf.json` — 精确 diff

现状 `bundle` (`tauri.conf.json:40-51`):
```json
  "bundle": {
    "active": true,
    "targets": "all",
    "createUpdaterArtifacts": true,
    "icon": [ ... :44-50 ]
  }
```
改为 (新增 `resources`, **不加 `externalBin`** 以免触发 triple-suffix 更名):
```json
  "bundle": {
    "active": true,
    "targets": "all",
    "createUpdaterArtifacts": true,
    "icon": [ ... ],
    "resources": ["binaries/lumen-cli.exe", "binaries/lumen-cli.exe.sig"]
  }
```
**Tauri v2 说明**: `bundle.resources` 在 NSIS 里会铺到 install-dir `resources\`; `bundle.externalBin` 走 sidecar-rename (`-x86_64-pc-windows-msvc.exe`) 且需 `tauri-plugin-shell` 的 scope 才能 spawn。宿主已有 `std::process::Command` 现成范式 (`luminar.rs:10-13`), **用 `resources` 更贴合现状**, 无需 shell 插件/权限。`binaries/lumen-cli.exe.sig` 是给 updater 校验副产物签名用的可选文件, 不加也能跑。
> 若未来切 `externalBin` (官方"正途"), 需把 exe 拷成 `lumen-cli-x86_64-pc-windows-msvc.exe` 并加 `tauri-plugin-shell` + `capabilities` 的 `shell:allow-spawn`+`shell:allow-execute` scope, 见 §4.4 方案二说明。

### 4.2 `scripts/release.mjs` — 行号级改动

现流程 (`release.mjs`): 读版本 (`:14-18`) → 查 key (`:20-24`) → `pnpm tauri build` (`:30`) → 找 NSIS sig (`:42-53`) → 写 updater.json (`:56-69`)。

**改动点 A — 插入 sidecar 前置构建 (在 `:30` 的 `execSync('pnpm tauri build')` 之前)**:
```js
// :29 之后, execSync('pnpm tauri build') 之前:
//   step 0a: 从 sidecar 工作区拷贝/校验 lumen-cli.exe 到 src-tauri/binaries/
const binExe = path.join(rootDir, 'src-tauri', 'binaries', 'lumen-cli.exe');
const srcLumen = process.env.LUMEN_BUILD_DIR || path.join(rootDir, '..', 'lumen-raw-sidecar', 'dist');
if (!fs.existsSync(binExe)) {                        // 本地未预置才报错; CI 用前一 job 产出
  throw new Error(`❌ sidecar 缺失: ${binExe}\n先运行 pnpm build:lumen 或设置 LUMEN_BUILD_DIR`);
}
// 步骤 0b (可选门禁, 见 §5): exe 体积上限
const sizeMB = fs.statSync(binExe).size / 1024 / 1024;
if (sizeMB > 130) throw new Error(`❌ lumen-cli.exe ${sizeMB.toFixed(1)}MB 超过 120MB 目标+10%余量`);
console.log(`📎 sidecar: lumen-cli.exe ${sizeMB.toFixed(1)}MB`);
```
**改动点 B — NSIS sig 校验通过之后、生成 updater.json 之前 (`:52-53` 之间), 追加装载后体积报告**:
```js
// :52 (const signature = ...) 之后:
//   记录最终 NSIS 体积, 供发布说明引用
const setupPath = path.join(nsisDir, setupExeName);
console.log(`📦 NSIS setup (含 sidecar): ${(fs.statSync(setupPath).size/1024/1024).toFixed(1)}MB`);
```
**改动点 C — updater.json 已是单 URL 全量包 (`:63`)**:
```js
url: `.../releases/download/v${version}/${setupExeName}`   // 已包含 sidecar, 无需改
```
→ **方案一 (随主包) 对 release.mjs 只加 step0a/0b, updater 机制零改**。这正是推荐它的理由。

### 4.3 现有 updater 机制核对

- endpoint `raw.githubusercontent.com/ID-VerNe/gallery-culling/master/updater.json` (`tauri.conf.json:35`)
- pubkey 固定 (`:37`)
- `createUpdaterArtifacts: true` (`:43`) + `TAURI_SIGNING_PRIVATE_KEY` 环境注入 (`release.mjs:35`)
- 产物名 `${productName}_${version}_x64-setup.exe` + `.sig` (`release.mjs:43-44`)
- **全量重下**: updater.json 直接指向整个 setup.exe (~200MB), 客户端下载整个 NSIS 重装 — sidecar 自然随动。**没有增量/delta**。可接受 (Tauri v2 默认)。
- sidecar 若独立更新 (方案二) 则需在 updater.json 之外另建 `updater-lumen.json` (宿主自管), 涉及一个新的 release 源与公钥; 若只更新模型则 §3.3 的运行时下载已覆盖, 无需更新器。**结论: 不上 sidecar 独立更新通道。**

### 4.4 方案一 vs 方案二 (结论 + 各自的 release.mjs 级差异)

| | 方案一: 随主 NSIS | 方案二: sidecar 独立更新器 |
|---|---|---|
| tauri.conf | `resources:["binaries/lumen-cli.exe"]` | 主 app 不含 sidecar; 需额外静态服务器/GitHub release tag 托管 |
| release.mjs | 加 §4.2-A/B (仅 step0a+0b), updater.json 不动 | 需再造 `lumen_cli.exe` 的 `.sig` + 独立 `updater-lumen.json`; Rust 侧需第二套下载安装逻辑 |
| 更新成本 | 每次 lumen 或宿主改动 → 全量 200MB | lumen 单独更新 → 只下 ~150-250MB (onefile 无优势) |
| 复杂度/风险 | 低 | 高 (sidecar 需要自我覆盖, 与主 exe 版本协同) |
| **结论** | **采用** | 不采用 (onefile 下无收益; 模型按需下载已满足轻量更新诉求) |

---

## 5. 体积预算与验收 (问题 5)

### 5.1 组件体积估算 (Windows x64, PyInstaller **解压态**)

| 组件 | 估算 (解压) | 备注 |
|---|---|---|
| CPython runtime + stdlib (PyInstaller) | ~25-35MB | py3.12 base_library.zip + `*.pyd` + `libcrypto`/`libssl`/`vcruntime` |
| `lumen` 纯 Python 包 | ~3-6MB | 剔 GUI 后仍 ~80 个文件; MANIFEST pyc |
| `numpy` 2.5 | ~35-45MB | 含 `_core` `.pyd` + OpenBLAS |
| `opencv-python-headless` 5.x | ~35-50MB | `.pyd` 大块 (无 Qt GUI 依赖, 已适合 headless) |
| `rawpy` + LibRaw | ~8-12MB | `rawpy._rawpy.pyd` + `rawpy.libs` |
| `Pillow` + ImageCms | ~4-6MB | 含 littlecms |
| `tifffile` | ~1MB | 纯 Python |
| `onnxruntime-windowsml` + `windowsml` | **~60-90MB** ⚠️ | DirectML.dll (~15-20MB) + windowsml eps/catalog + ORT (~15MB) + TRT-catalog; **主要不确定项** |
| lensfun db (XML) + locales(json) + licenses | ~4-6MB | 数据 |
| manifest json | <1MB | |
| **合计 (解压)** | **~175-250MB** | |
| **PyInstaller onefile bootloader 压缩后** | **~90-160MB** | UPX 关 (`spec upx=False`); zlib 压缩比 ~0.45-0.55 |
| **NSIS lzma2 再压缩** (sidecar 作为资源) | 边际递减 (已压缩) | 主 setup ≈ 侧身 exe + Tauri 框架 ~30MB |
| **最终 NSIS setup.exe** | **≈ 130-200MB** | 取决于 ORT |
| **目标 <120MB** | ⚠️ **临界** | 见下 |

### 5.2 结论: <120MB 现实吗?

**现实但有风险 — onnxruntime-windowsml 是唯一变量。**
- 剔除 PySide6 (省 ~120-180MB 解压) 是最大杠杆, 已经吃掉最肥部分 (`white_balance` 也已确认无 Qt)。
- DirectML+windowsml 把 ORT 从 CPU 版 ~15MB 顶到 ~60-90MB 解压; 这是 "GPU 默认" 策略的代价。
- **若 onefile exe 实测 > 120MB**: 缓解手段优先级 — (a) onedir (消除 bootloader 重复 + 让 NSIS lzma2 压缩 `_internal` 里未压缩 `.pyd`, 常可再降 15-25%); (b) 若仍超, 降级 onnxruntime 到 CPU flavor (省 ~50-70MB) 但需 GUI 侧确认 fallback 体验; (c) 评估 `onnxruntime-directml` 单 provider 版 (无 TRT catalog)。
- **若允许 onedir**: <120MB 基本稳, 且资源复制体验更好 (§3.3)。**故"推荐 onefile"需让位给 size 实测**, 见 §6 步2 门禁触发条件。

### 5.3 验收清单 (每步 = 可验证动作 + 标准)

构建后核心验收命令 (在 build 工作站, PowerShell):
```powershell
# A. onefile exe 体积
(Get-Item src-tauri\binaries\lumen-cli.exe).Length/1MB   # 期望 < 120; >130 触发 onedir 回退

# B. 无 Qt 泄漏 (最关键)
Get-ChildItem -Recurse src-tauri\binaries\ -Include Qt6*.dll,PySide6*,shiboken* -ErrorAction SilentlyContinue
#   → 期望: 0 行输出

# C. onefile exe 解压态 du (需先跑一次让 exe 自解压, 或在 onedir 上直接测)
#    onefile: 转而校验启动后 %TEMP%\_MEI*; onedir:
$d='src-tauri\binaries\_internal'; "{0:N0} MB" -f ((Get-ChildItem $d -Recurse -File | Measure-Object Length -Sum).Sum/1MB)
#   → 期望 < 120MB

# D. 无大文件泄漏 (人工)
Get-ChildItem -Recurse src-tauri\binaries\ -File | Sort-Object Length -Desc | Select -First 20
#   → 期望 Top20 里无 .onnx (>10MB)、exiftool_files、DirectML.dll 单独 >40MB

# E. 干净目录冒烟 (onefile 从 NSIS 里解出来跑; onedir 拷整目录到 %TEMP%\clean-room 后跑)
& src-tauri\binaries\lumen-cli.exe --help            # 期望 exit 0, 打印用法
& src-tauri\binaries\lumen-cli.exe info <某个.jpg>   # 期望 exit 0, stdout JSON 含 width/height
& src-tauri\binaries\lumen-cli.exe render <某个.jpg> out.jpg   # 期望落盘, size>0
#   期望: 3 条都 exit 0; 见 §6 步5
```

---

## 6. CI / 本地构建落地步骤 (问题 6)

### 6.0 前置: 客体工作副本 (两仓库只读)

`gallery-flask/` 和 `lumen-raw/` 都只读, 不能在原目录打补丁。做法: CI/本地先 clone 客体到工作副本并在其上做**全部 lumen 侧改动** (补丁 + 新 spec + 新 requirements), 产物 copy 进宿主。

```powershell
# 引出干净工作副本 (宿主仓库外)
git clone <lumen-raw-remote> ..\lumen-sidecar      # 或 copy -Recurse lumen-raw ..\lumen-sidecar
cd ..\lumen-sidecar
git apply ..\gallery-flask\.plan\research\lumen-slim.patch   # 三处懒导入补丁 + build_lumen.py + fetch_assets 开关
```

`.plan/research/lumen-slim.patch` (交付物之一, 补丁内容见 §2.1) 三处改动:
1. `lumen/lens_panel.py`: 删 `auto_enable`/`AUTO_KEY`, 迁至 `lumen/lens.py`。
2. `lumen/session.py:108`: `from .lens import auto_enable`。
3. `lumen/batch_export.py`: `PySide6` import try/except 化 + `FORMATS/SIZES` 内联 (或拆 `batch_export_core.py`), 使 `commands.py:549,583` 的 `import batch_export` 无 Qt。

> **验证补丁最小自洽 (步 1 前先跑)**:
> ```powershell
> ...\lumen-sidecar\.venv\Scripts\python.exe -c "import sys; sys.path.insert(0,'.'); import lumen.cli, lumen.commands, lumen.session, lumen.engine, lumen.lens; import importlib.util as u; print('pyside6:', u.find_spec('PySide6') is not None)"
> ```
> 期望: import 全通过, 且能在**未安装 PySide6** 的 venv 里成功 (见步1 venv 无 PySide6)。

### 6.1 step-by-step (每步 = 可验证动作 + 验收)

**步 0 — 冻结依赖, 生成 `requirements-cli.txt` + `requirements-cli-lock.txt`**
- 动作 (`..\lumen-sidecar`): 基于 `requirements-directml.txt` 追加 `numpy>=2.2,<3`、`opencv-python-headless>=4.10,<6`、`Pillow>=11,<13`、`rawpy>=0.25,<0.28`、`tifffile>=2025.1`、`pyinstaller>=6.12,<7` (`requirements.txt` 去 PySide6 行 + `requirements-dev.txt` 的 pyinstaller)。
- 落锁: `pip install -r requirements-cli.txt; pip freeze > requirements-cli-lock.txt`; 断言 `onnxruntime` 不出现在 freeze (应只有 `onnxruntime-windowsml` + `windowsml`)。
- 验收: `python -c "import onnxruntime as o; assert 'DmlExecutionProvider' in o.get_available_providers()"`; `python -c "import PySide6"` **必须 ImportError**。

**步 1 — 建 headless venv + 打补丁 + import 冒烟**
- 动作: `py -3.12 -m venv .venv` → `pip install --no-cache-dir -r requirements-cli-lock.txt` → `git apply` 补丁 (§6.0)。
- 验收 (§6.0 的 verify 命令): `lumen.cli/commands/session/engine/lens` import OK; **PySide6 未安装仍 OK**。

**步 2 — `LumenCLI.spec` 构建 + 三连验收 (本报告核心)**
- 动作: `.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean LumenCLI.spec` (spec 见 §2.2)。
- 验收 (3 项必须全过):
  1. **无 Qt**: `Get-ChildItem -Recurse .\dist -Include Qt6*.dll,PySide6*,shiboken6*` → **0 行**。
  2. **体积**: onefile `dist\lumen-cli.exe` < 120MB (预测 ~90-160MB; **若 >130 → 触发 onedir 回退**, spec 改 `COLLECT` 且重测 `_internal` 合计 < 120MB; 若 onedir 仍超 → 上报 onnxruntime flavor 决策, 见 §5.2)。
  3. **数据完整性**: `_internal`(或 `%TEMP%\_MEI*`) 下存在 `assets/lensfun/db/slr-canon.xml`、`assets/models/selection-models.json`、`lumen/locales/zh_TW.json`; **不存在** `assets/models/*.onnx`、`assets/exiftool/*`。
- 产物: `..\gallery-flask\src-tauri\binaries\lumen-cli.exe` (onedir 则连 `_internal\` 一起 copy)。

**步 3 — Tauri 装配 + Rust spawn (`lumen_cli.rs`)**
- 动作: 改 `tauri.conf.json` (`resources`, §4.1); 新增 `src-tauri/src/lumen_cli.rs` (仿 `luminar.rs:62-74` 用 `std::process::Command` + `app.path()` 定位 `resources\lumen-cli.exe`); `capabilities` 无需改 (无 shell 插件)。
- 验收: `cargo check` / `pnpm tauri dev` 能起, 宿主能 spawn `lumen-cli --help` 并读到 stdout JSON。

**步 4 — `package.json` / release 链整合**
- 动作: `package.json` `scripts` 加:
  ```json
  "build:lumen": "powershell -NoProfile -ExecutionPolicy Bypass -File ..\\lumen-sidecar\\build_lumen.ps1",
  "tauri": "tauri",
  "release": "node scripts/release.mjs"
  ```
  `build_lumen.ps1` (仿 `build_release.ps1` 精简): venv→步0 依赖→PyInstaller→copy `dist\lumen-cli*` → `src-tauri\binaries\`。
- `release.mjs` 改 `:30` 前加 sidecar 门禁 (§4.2-A/B)。
- 验收: `pnpm release` 一次通过, stdout 含 `📎 sidecar: lumen-cli.exe xx.xMB` 和 `📦 NSIS setup (含 sidecar): xxxMB`。

**步 5 — 冒烟: 干净目录 (具体命令)**
- 动作: 从 `src-tauri\target\release\bundle\nsis\` 解出 setup, 拷 `resources\lumen-cli.exe`(onefile) 到 `$env:TEMP\clean-room\` (与宿主机 exe 无关的净目录); onedir 则拷整 `resources\lumen-cli\`。
- 验收 (全 exit 0):
  ```powershell
  cd $env:TEMP\clean-room
  .\lumen-cli.exe --help
  .\lumen-cli.exe info C:\path\to\sample.jpg     # 或先用 tools/bench_pipeline.sample() 造 synthetic PNG
  .\lumen-cli.exe render C:\path\to\sample.jpg out.jpg   # out.jpg size>0
  ```
- **注意**: 客体 `LumenRAW.spec --smoke-test` (`main.py:76-78`) 需要**完整 AI 模型**, 因权重不下发会失败 (`diagnostics.py` 会找 model); **sidecar 冒烟禁用 `--smoke-test`, 改用 `lumen-cli` 三连**。`tools/check_cli.py` (客体已存在于 `tools/`, `build_release.ps1:114` 用它) 可复用到宿主 CI。

**步 6 — 按需下载冒烟 (§3.3 的 Rust 逻辑)**
- 动作: 干净环境首次触发一个需 exiftool 的功能 (如 `info <raw>`), 观察宿主下载 `lumen-assets\exiftool\...` 并 copy 进 sidecar `_internal`/`_MEIPASS`。
- 验收: 二次调用同一功能不再下载; `lumen-cli info <raw>` 输出含 `-ColorTemperature#` 相关字段 (证明 exiftool 生效); 断网时功能优雅降级 (白平衡走 rawpy 相机值, `white_balance.py:17-20` 已内置该 fallback)。

### 6.2 待验证项 / 需与其他任务协作

- **ORT flavor 实测体积** (唯一 <120MB 风险): 需在 build 机实测 onedir vs onefile × onnxruntime(CPU/windowsml/directml) 三者组合; 落到 §5.3 门禁即可自动化。
- **onefile 资源落点与回收路径**: onefile 每次解压到新 `_MEI*`, 需评估 copy 成本 / 是否改为 onedir; `%LOCALAPPDATA%` 可写已在 Tauri 默认 (需在 `commands.rs`/`lumen_cli.rs` 里确认 install mode = currentUser; NSIS `PrivilegesRequired=lowest` 等价)。
- **Windows ML TRT 自动下载** (`requirements-directml.txt:4-6`): 首次在 Win11 24H2+RTX30 上跑会下 TensorRT — 与"权重不进安装包"策略叠加, 需确认用户无感 (大概率走 Microsoft CDN, 短暂等待), 归任务 ②/⑤ 评估。
- **`fetch_assets.py` 的 `--skip-exiftool/--skip-models` 开关** 是新增补丁, 需要在 `lumen-slim.patch` 里一并给。
- 字体/图标 (`lumen.ico`/`NotoSansSC.ttf`) 已判定不入 sidecar, 若上游后续引用需回溯 §1.2。

---

## 7. 结论摘要 (交付其他任务的接口)

1. **客体瘦身可行**: GUI→core 只 **3 处懒导入** (`session.py:108`, `commands.py:549`, `commands.py:583` — 比简报多 1 处), 补丁集中在 `lens_panel.auto_enable` 迁位 + `batch_export` 去 Qt。excludes PySide6 后 Qt6*.dll 应归零, §5.3-B 是硬门禁。
2. **依赖**: Windows x64 选 `requirements-directml.txt` (`onnxruntime-windowsml`+`windowsml`), 追加 numpy/cv2/Pillow/rawpy/tifffile/pyinstaller → `requirements-cli.txt`。**不用** `-gpu`(cupy)/`requirements.txt`(CPU+PySide6)。
3. **资源**: ExifTool + AI 权重按需下载到 `%LOCALAPPDATA%\gallery-culling\lumen-assets\`, 因 lumen **硬编码 `_internal/assets` 无 env 覆盖**, 需宿主 copy 进 bundle 解压目录; 校验照抄 `fetch_assets.py` 的 sha256 原子落盘, manifest 复用 `assets/models/*.json`。
4. **宿主打包**: `tauri.conf.json` bundle 加 `resources:["binaries/lumen-cli.exe"]` (用 std::process spawn, 不引入 shell 插件); `release.mjs:30` 前插 sidecar 门禁, updater 机制零改 (**方案一: 随主 NSIS 包**)。
5. **体积**: 剔除 PySide6 是最大杠杆; onnxruntime-windowsml 是唯一风险项 (60-90MB 解压)。目标 <120MB 临界可行, 以"无 Qt 泄漏 + 实测体积"双门禁兜底, 超标优先回退 onedir。端点到端点 §5.3。
6. **产物交付**: `lumen-slim.patch` (补丁, 给任务 ①/②)、`LumenCLI.spec` (§2.2, 给任务 ⑤)、`build_lumen.ps1` 骨架 (§6.1 步4)、`lumen_cli.rs` 契约 (§4.0, 给任务 ③)、`release.mjs`/`tauri.conf.json` diff (§4.1/4.2, 本任务自留)。
