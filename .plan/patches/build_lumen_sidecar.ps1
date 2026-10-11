# 构建并验证 headless sidecar（lumen-cli），供 Gallery Culling 集成。
#
# 用法（从 gallery-flask 仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File .plan/patches/build_lumen_sidecar.ps1
#
# 产物：<lumen-sidecar>/dist/lumen-cli/  → 复制到 src-tauri/binaries/
# 门禁：① 无 Qt6/PySide6  ② 体积  ③ 干净目录三连冒烟

param(
    [string]$SidecarDir = "$env:USERPROFILE\Downloads\Documents\lumen-sidecar",
    [string]$Sample = "$env:USERPROFILE\Downloads\Documents\lumen-e2e-samples\sample.nef",
    [int]$MaxSizeMB = 200
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here "..\..")
$patchScript = Join-Path $here "apply_slim_patch.py"

Write-Host "==> 1/5 应用 lumen-slim 补丁（去 Qt 依赖）"
python $patchScript $SidecarDir

$py = Join-Path $SidecarDir ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "==> 创建 venv"
    python -m venv (Join-Path $SidecarDir ".venv")
}

Write-Host "==> 2/5 安装依赖（无 PySide6；大包请用官方源）"
& $py -m pip install --retries 10 --timeout 180 `
    "numpy>=2.2,<3" "opencv-python-headless>=4.10,<6" "Pillow>=11,<13" `
    "rawpy>=0.25,<0.28" "tifffile>=2025.1" "pyinstaller>=6.12,<7"

Write-Host "==> 3/5 无 Qt 导入冒烟"
& $py -c "import lumen.cli, lumen.commands, lumen.session, lumen.engine, lumen.lens, lumen.control; import importlib.util as u; assert u.find_spec('PySide6') is None; print('  ✓ headless imports OK, no PySide6')"

Write-Host "==> 4/5 PyInstaller 构建"
Push-Location $SidecarDir
& $py -m PyInstaller --noconfirm --clean LumenCLI.spec
Pop-Location

$dist = Join-Path $SidecarDir "dist\lumen-cli"
Write-Host "==> 5/5 门禁"
$qt = Get-ChildItem -Recurse $dist -Include "Qt6*.dll", "PySide6*", "shiboken*" -ErrorAction SilentlyContinue
if ($qt) { Write-Error "✗ 门禁A 失败：发现 Qt 文件 $($qt.Name -join ', ')"; exit 1 }
Write-Host "  ✓ 门禁A：零 Qt"

$sizeMB = [math]::Round(((Get-ChildItem -Recurse $dist -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "  • 体积：${sizeMB} MB（预算 ${MaxSizeMB}MB）"
if ($sizeMB -gt $MaxSizeMB) { Write-Error "✗ 门禁B 失败：${sizeMB}MB > ${MaxSizeMB}MB"; exit 1 }

Write-Host "  ✓ 门禁B：体积达标"

& (Join-Path $dist "lumen-cli.exe") --version
if (Test-Path $Sample) {
    $out = Join-Path $env:TEMP "lumen_smoke.jpg"
    & (Join-Path $dist "lumen-cli.exe") run render.preview `
        "{`"path`":`"$Sample`",`"size`":1024,`"output`":`"$out`"}" --headless | Out-Null
    if (-not (Test-Path $out)) { Write-Error "✗ 门禁C 失败：真实 RAW 渲染未落盘"; exit 1 }
    Write-Host "  ✓ 门禁C：真实 RAW 渲染 OK（$out）"
} else {
    Write-Host "  ! 跳过门禁C（未提供样张：$Sample）"
}

Write-Host ""
Write-Host "✓ sidecar 就绪：$dist"
Write-Host "  下一步：复制到 $($repoRoot)\src-tauri\binaries\ 并在设置里指定路径或加入 PATH"