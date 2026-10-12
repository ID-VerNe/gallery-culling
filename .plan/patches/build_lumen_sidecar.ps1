# 构建并验证 headless sidecar（lumen-cli），供 Gallery Culling 集成。
#
# 用法（从 gallery-flask 仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File .plan/patches/build_lumen_sidecar.ps1
#   powershell -ExecutionPolicy Bypass -File .plan/patches/build_lumen_sidecar.ps1 -Gpu
#
# 产物：<lumen-sidecar>/dist/lumen-cli/  → 复制到 src-tauri/binaries/
# 门禁：① 无 Qt6/PySide6  ② 体积  ③ 真实 RAW 渲染  ④ MCP 常驻通道  ⑤ 命令表冻结契约
#      ⑥（仅 -Gpu）真实 AI 蒙版
#
# --- 两种 flavor ---------------------------------------------------------------
#   默认（CPU）  LumenCLI-cpu.spec   137.27 MiB   门槛 140MB
#   -Gpu（AI）   LumenCLI.spec       486.28 MiB   门槛 500MB
# AI flavor 多出的 349.01 MiB = 6 个 ONNX 模型 285.83 + onnxruntime 执行提供者 63.11。
# 两者**命令表完全一致**（27 条，byte-for-byte）：AI 不是新命令，而是
# edit.apply 的 masks[].region（sky/person/subject/background/foreground）由本地
# ONNX 模型检测。详见 .plan/evidence/gpu-ai-sidecar-report.md。
#
# 体积基线（2026-10 实测，见 .plan/evidence/sidecar-slimming-report.md）：
#   184MB（未瘦身）→ 137.3MB（LumenCLI-cpu.spec 剔除 tkinter / cv2-ffmpeg / PIL-avif，-44.3MB）
#   目标 120MB **未达成**：剩下 137MB 是这套依赖的地板——cv2.pyd 71.3MB 与 numpy
#   openblas 19.6MB 合计 91MB 都在无头渲染路径上，且已无 PE 层可压（实测无 debug
#   段 / 符号表 / overlay）。再往下只能动 OpenCV 本身或引入 UPX（AV 误报风险）。
#   故门禁阈值取 140MB（留约 3MB 余量），不做虚假的 120 承诺。
#
# -Gpu 的 500MB 门槛同理不做虚假承诺：模型占了 285.83MiB，要压只能砍模型
# （例如去掉 midas-small + person-deeplab 可省 105.72MiB，代价是 foreground /
# person 两个 AI 蒙版失效）。

param(
    [string]$SidecarDir = "$env:USERPROFILE\Downloads\Documents\lumen-sidecar",
    [string]$Sample = "$env:USERPROFILE\Downloads\Documents\lumen-e2e-samples\sample.nef",
    [int]$MaxSizeMB = 0,       # 0 = 按 flavor 取默认（CPU 140 / GPU 500）
    [switch]$Gpu,              # AI flavor：onnxruntime-directml + 6 个 ONNX 模型
    [switch]$SkipInstall,      # 只重跑门禁，不动 venv
    [switch]$SkipBuild,        # 只跑门禁，不重跑 PyInstaller
    [switch]$SkipModels        # 只跑门禁，假定 assets/models/*.onnx 已就位
)

if ($MaxSizeMB -le 0) { $MaxSizeMB = if ($Gpu) { 500 } else { 140 } }
$SpecFile = if ($Gpu) { "LumenCLI.spec" } else { "LumenCLI-cpu.spec" }
$OrtWheel = "onnxruntime_directml-1.24.4-cp313-cp313-win_amd64.whl"
$AssetBundle = "LumenARW-1.2.1-RuntimeAssets.zip"
$AssetUrl = "https://api.github.com/repos/hety0211/lumen-raw/releases/tags/v1.2.1"

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here "..\..")
$patchScript = Join-Path $here "apply_slim_patch.py"

# --- Windows 原生参数引用 ---------------------------------------------------
# PowerShell 5.1 把内含 " 的参数传给原生 exe 时会吃掉引号，JSON 参数会直接变成
# "arguments must be a JSON object"。这里自己按 MSVC list2cmdline 规则拼命令行。
function Invoke-Sidecar {
    param([string]$Exe, [string[]]$CmdArgs, [string]$Stdin = $null)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.Arguments = ($CmdArgs | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '(\\*)"', '$1$1\"') + '"' } else { $_ }
    }) -join ' '
    $proc = [System.Diagnostics.Process]::Start($psi)
    # stdin 必须显式关闭，否则常驻型子进程（mcp）不会退出
    $proc.StandardInput.Write($Stdin)
    $proc.StandardInput.Close()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; Out = $stdout + $stderr }
}

if (-not $SkipInstall) {
    Write-Host "==> 1/6 应用 lumen-slim 补丁（去 Qt 依赖）"
    python $patchScript $SidecarDir
}

$py = Join-Path $SidecarDir ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "==> 创建 venv"
    python -m venv (Join-Path $SidecarDir ".venv")
}

if (-not $SkipInstall) {
    Write-Host "==> 2/7 安装依赖（无 PySide6；大包请用官方源）"
    & $py -m pip install --retries 10 --timeout 180 `
        "numpy>=2.2,<3" "opencv-python-headless>=4.10,<6" "Pillow>=11,<13" `
        "rawpy>=0.25,<0.28" "tifffile>=2025.1" "pyinstaller>=6.12,<7"
    if ($LASTEXITCODE -ne 0) { Write-Error "✗ 依赖安装失败"; exit 1 }

    if ($Gpu) {
        # onnxruntime / onnxruntime-gpu / onnxruntime-directml 提供同一个 `onnxruntime`
        # 模块名，必须先卸掉彼此再装。本脚本只认 directml。
        Write-Host "==> 2b/7 安装 GPU 推理后端 onnxruntime-directml（走 D3D12，不需要 CUDA Toolkit）"
        & $py -m pip uninstall -y onnxruntime onnxruntime-gpu onnxruntime-directml 2>&1 | Out-Null
        & $py -m pip install --retries 10 --timeout 180 onnxruntime-directml==1.24.4
        if ($LASTEXITCODE -ne 0) { Write-Error "✗ onnxruntime-directml 安装失败"; exit 1 }
        # 断言执行提供者真的在，否则 PyInstaller 会打出一个静默退回 CPU 的产物
        & $py -c "import onnxruntime as ort; p=ort.get_available_providers(); assert 'DmlExecutionProvider' in p, p; print('  providers:', p)"
        if ($LASTEXITCODE -ne 0) { Write-Error "✗ DirectML 执行提供者缺失"; exit 1 }
    }
} else { Write-Host "==> 跳过依赖安装" }

# --- AI 模型（仅 -Gpu）------------------------------------------------------
# 565 MiB 的 runtime-asset 包里只有 6 个 .onnx 是无头命令面能打开的（见报告）。
# 整包下载慢且大部分用不上，所以只下整包、只按 manifest 的 size+sha256 校验并解出这 6 个。
# github.com 本身常被挡，tools/fetch_release_asset.sh 走 api.github.com 换签名 CDN URL。
if ($Gpu -and -not $SkipModels) {
    Write-Host "==> 3/7 取 AI 模型（runtime-asset 包 565 MiB，断点续传；网速慢时可能要几分钟）"
    Push-Location $SidecarDir
    $bundle = Join-Path $SidecarDir ".asset-cache\$AssetBundle"
    if (-not (Test-Path $bundle) -or (Get-Item $bundle).Length -lt 592599134) {
        $bash = Get-Command bash -ErrorAction SilentlyContinue
        if ($bash) {
            & bash "tools/fetch_release_asset.sh" "v1.2.1" $AssetBundle ".asset-cache/$AssetBundle" 592599134
        } else {
            Write-Error "✗ 需要 bash（Git for Windows / WSL）来跑断点续传下载`n  手工下载后放到：$bundle`n  来源：$AssetUrl"
            Pop-Location; exit 1
        }
    }
    & $py tools/install_models.py
    if ($LASTEXITCODE -ne 0) { Write-Error "✗ 模型校验/解压失败"; exit 1 }
    Pop-Location
}

Write-Host "==> 4/7 无 Qt 导入冒烟"
# 必须在 $SidecarDir 下跑：lumen 是工作副本里的源码树，不是 site-packages 包
Push-Location $SidecarDir
& $py -c "import lumen.cli, lumen.commands, lumen.session, lumen.engine, lumen.lens, lumen.control; import importlib.util as u; assert u.find_spec('PySide6') is None; print('  OK headless imports OK, no PySide6')"
$importRc = $LASTEXITCODE
Pop-Location
if ($importRc -ne 0) { Write-Error "✗ 无头导入冒烟失败（cwd=$SidecarDir）"; exit 1 }

if (-not $SkipBuild) {
    Write-Host "==> 5/7 PyInstaller 构建（$SpecFile，瘦身/模型规则已固化在 spec 里）"
    Push-Location $SidecarDir
    & $py -m PyInstaller --noconfirm --clean $SpecFile
    Pop-Location
    if ($LASTEXITCODE -ne 0) { Write-Error "✗ PyInstaller 构建失败"; exit 1 }
} else { Write-Host "==> 跳过构建" }

$dist = Join-Path $SidecarDir "dist\lumen-cli"
$exe  = Join-Path $dist "lumen-cli.exe"
if (-not (Test-Path $exe)) { Write-Error "✗ 产物不存在：$exe"; exit 1 }

Write-Host "==> 6/7 门禁"
$qt = Get-ChildItem -Recurse $dist -Include "Qt6*.dll", "PySide6*", "shiboken*" -ErrorAction SilentlyContinue
if ($qt) { Write-Error "✗ 门禁A 失败：发现 Qt 文件 $($qt.Name -join ', ')"; exit 1 }
Write-Host "  ✓ 门禁A：零 Qt"

$sizeMB = [math]::Round(((Get-ChildItem -Recurse $dist -File | Measure-Object Length -Sum).Sum / 1MB), 2)
Write-Host "  • 体积：${sizeMB} MB（预算 ${MaxSizeMB}MB）"
if ($sizeMB -gt $MaxSizeMB) { Write-Error "✗ 门禁B 失败：${sizeMB}MB > ${MaxSizeMB}MB"; exit 1 }
Write-Host "  ✓ 门禁B：体积达标"

# 门禁C：真实 RAW 渲染（宿主调用形态）
if (Test-Path $Sample) {
    $out = Join-Path $env:TEMP "lumen_smoke.jpg"
    if (Test-Path $out) { Remove-Item $out -Force }
    $json = (@{ path = ($Sample -replace '\\','/'); size = 1024; output = ($out -replace '\\','/') } |
             ConvertTo-Json -Compress)
    $r = Invoke-Sidecar -Exe $exe -CmdArgs @('run','render.preview',$json,'--headless')
    if (-not (Test-Path $out)) { Write-Error "✗ 门禁C 失败：真实 RAW 渲染未落盘`n$($r.Out)"; exit 1 }
    Write-Host "  ✓ 门禁C：真实 RAW 渲染 OK（$((Get-Item $out).Length) bytes）"

    # 门禁D：MCP 常驻通道握手（宿主 Step 3/4 的对手方）
    $init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gate","version":"1"}}}'
    $list = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
    $call = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"render_preview","arguments":{"path":"' + ($Sample -replace '\\','/') + '","size":1024,"original":true}}}'
    $m = Invoke-Sidecar -Exe $exe -CmdArgs @('mcp','--headless') -Stdin (@($init,$list,$call) -join "`n")
    if ($m.Out -notmatch '"version":"1\.6\.0"' -or $m.Out -notmatch 'render_preview' -or $m.Out -match 'Traceback') {
        Write-Error "✗ 门禁D 失败：MCP 通道未正常握手`n$($m.Out)"; exit 1
    }
    Write-Host "  ✓ 门禁D：MCP 握手 + tools/list + render_preview OK（serverInfo 1.6.0）"
} else {
    Write-Host "  ! 跳过门禁C/D（未提供样张：$Sample）"
}

# 门禁E：命令表未偏离冻结契约
$frozen = Join-Path $SidecarDir "commands-frozen.json"
if (Test-Path $frozen) {
    $c = Invoke-Sidecar -Exe $exe -CmdArgs @('commands')
    $live = ($c.Out | ConvertFrom-Json).commands | ForEach-Object { $_.id } | Sort-Object
    $want = (Get-Content $frozen -Raw -Encoding UTF8 | ConvertFrom-Json).commands | ForEach-Object { $_.id } | Sort-Object
    $drift = Compare-Object $live $want
    if ($drift) { Write-Error "✗ 门禁E 失败：命令表漂移 $(($drift.InputObject) -join ', ')"; exit 1 }
    Write-Host "  ✓ 门禁E：命令表与 commands-frozen.json 一致（$($live.Count) 条）"
} else {
    Write-Host "  ! 跳过门禁E（无 commands-frozen.json）"
}

Write-Host ""
Write-Host "==> 7/7 门禁收尾"

# 门禁F（仅 -Gpu）：真实 AI 蒙版。必须落到 applied 里的“新增蒙版”，
# 只看 exit code 不够——模型没找到区域时也会 rc=0，只是 notes 里报“没有识别到…”。
if ($Gpu -and (Test-Path $Sample)) {
    $aiJson = (@{ path = ($Sample -replace '\\','/')
                  changes = @{ masks = @(@{ region = "sky"; adjustments = @{ exposure = -0.5 } }) } } |
               ConvertTo-Json -Compress -Depth 6)
    $ai = Invoke-Sidecar -Exe $exe -CmdArgs @('run','edit.apply',$aiJson,'--headless')
    if ($ai.ExitCode -ne 0 -or $ai.Out -notmatch '新增蒙版') {
        Write-Error "✗ 门禁F 失败：AI 天空蒙版未生成`n$($ai.Out)"; exit 1
    }
    Write-Host "  ✓ 门禁F：AI 蒙版（sky）已在真实 RAW 上生成"
} elseif ($Gpu) {
    Write-Host "  ! 跳过门禁F（未提供样张：$Sample）"
}

$flavor = if ($Gpu) { "AI/DirectML" } else { "CPU-only" }
Write-Host ""
Write-Host "✓ sidecar 就绪（$flavor）：$dist（$sizeMB MB）"
Write-Host "  下一步：复制到 $($repoRoot)\src-tauri\binaries\ 并在设置里指定路径或加入 PATH"
if ($Gpu) {
    Write-Host "  注：AI flavor 默认让 ONNX/DirectML 也接管逐像素显影（整幅渲染快约 5 倍），"
    Write-Host "      像素与 CPU 版有 0.15% 的 1LSB 级差异。要与 CPU 版逐像素一致，设 LUMEN_COMPUTE=cpu。"
}
