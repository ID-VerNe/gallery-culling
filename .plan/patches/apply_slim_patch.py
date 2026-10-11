#!/usr/bin/env python3
"""lumen-slim patch applier — 把 lumen-raw 改造成无 Qt 的 headless sidecar 友好形态。

背景（glue-engineer 深模式分析结论）：
  `lumen/session.py:108` 无头路径 import `lens_panel.auto_enable`，而 `lens_panel.py`
  顶层 import PySide6；`lumen/commands.py:549/583`（photo_export / photo_export_batch）
  无头路径 import `batch_export`，而 `batch_export.py` 顶层 import PySide6。
  → 只要不装 PySide6（省 120–180MB），sidecar 就必须打这 4 处补丁。

变更（幂等；可重复执行）：
  1. `lumen/lens.py`      追加 `AUTO_KEY` + `auto_enable()`（Qt-free，惰性 import i18n）
  2. `lumen/lens_panel.py` 删除本地定义，改为从 `.lens` 再导出（GUI API 不变）
  3. `lumen/session.py`   `from .lens_panel import auto_enable` → `from .lens import auto_enable`
  4. `lumen/batch_export.py` 把 `BatchExportDialog` 拆到新模块 `batch_export_dialog.py`
  5. `lumen/library.py`   对话框改从新模块导入

用法：python apply_slim_patch.py <lumen-sidecar 路径>
对应计划：.plan/lumen_raw_integration_steps.md §8 阶段 5
"""

import re
import sys
from pathlib import Path

MARK = "# --- lumen-slim: "


def patch_lens(root: Path) -> str:
    p = root / "lumen" / "lens.py"
    src = p.read_text(encoding="utf-8")
    if "def auto_enable(" in src:
        return "lens.py: 已含 auto_enable，跳过"
    addition = (
        "\n\n"
        f"{MARK}Qt-free home for the auto-enable setting (moved out of lens_panel.py)\n"
        "AUTO_KEY = 'lens_auto_enable'\n\n\n"
        "def auto_enable():\n"
        '    """Whether profile corrections auto-enable for newly opened photos."""\n'
        "    from . import i18n\n\n"
        "    return i18n.setting(AUTO_KEY, '0') == '1'\n"
    )
    p.write_text(src.rstrip("\n") + "\n" + addition, encoding="utf-8")
    return "lens.py: 已追加 AUTO_KEY/auto_enable"


def patch_lens_panel(root: Path) -> str:
    p = root / "lumen" / "lens_panel.py"
    src = p.read_text(encoding="utf-8")
    if "from .lens import AUTO_KEY, auto_enable" in src:
        return "lens_panel.py: 已再导出，跳过"
    # 删除本地 AUTO_KEY / auto_enable 定义块
    src = src.replace(
        "#: settings.ini key: enable profile corrections for photos opened the first time.\n"
        "AUTO_KEY = 'lens_auto_enable'\n",
        "",
    )
    src = re.sub(
        r"\n\ndef auto_enable\(\):\n    return i18n\.setting\(AUTO_KEY, '0'\) == '1'\n",
        "",
        src,
    )
    # 在 `from . import i18n, lens` 后插入再导出
    src = src.replace(
        "from . import i18n, lens\n",
        "from . import i18n, lens\n"
        f"{MARK}Qt-free home (see lens.py); re-exported so the GUI keeps its API\n"
        "from .lens import AUTO_KEY, auto_enable\n",
        1,
    )
    p.write_text(src, encoding="utf-8")
    return "lens_panel.py: 已改为再导出"


def patch_session(root: Path) -> str:
    p = root / "lumen" / "session.py"
    src = p.read_text(encoding="utf-8")
    if "from .lens import auto_enable" in src:
        return "session.py: 已是 Qt-free 导入，跳过"
    src = src.replace(
        "        from .lens_panel import auto_enable\n",
        "        from .lens import auto_enable\n",
    )
    p.write_text(src, encoding="utf-8")
    return "session.py: auto_enable 改从 .lens 导入"


def patch_batch_export(root: Path) -> str:
    be = root / "lumen" / "batch_export.py"
    src = be.read_text(encoding="utf-8")
    if "class BatchExportDialog" not in src:
        return "batch_export.py: 对话框已拆出，跳过"

    start = src.index("class BatchExportDialog(QDialog):")
    end = src.index("def target_path(")
    dialog_src = src[start:end].rstrip() + "\n"

    # batch_export.py：删除对话框与 PySide6 导入
    src = src[:start] + src[end:]
    src = re.sub(
        r"from PySide6\.QtWidgets import \([^)]*\)\n",
        "",
        src,
    )
    be.write_text(src, encoding="utf-8")

    # 新模块：对话框（GUI 侧使用，sidecar 永不 import）
    header = (
        '"""Batch export dialog (GUI only).\n\n'
        f"{MARK}split out of batch_export.py so the headless sidecar can import\n"
        '``batch_export`` (run/target_path/fit_long_edge) without PySide6.\n'
        '"""\n'
        "from pathlib import Path\n\n"
        "from PySide6.QtWidgets import (QComboBox, QDialog, QDialogButtonBox, QFileDialog, QFormLayout,\n"
        "                               QHBoxLayout, QLabel, QLineEdit, QPushButton, QSpinBox, VBoxLayout as _VBox,\n"
        "                               QVBoxLayout)\n\n"
        "from .batch_export import FORMATS, SIZES\n"
        "from .i18n import tr\n\n\n"
    )
    # 原类内使用的是 QVBoxLayout（不是 VBoxLayout），去掉误加的别名行
    header = header.replace("                               QHBoxLayout, QLabel, QLineEdit, QPushButton, QSpinBox, VBoxLayout as _VBox,\n", "                               QHBoxLayout, QLabel, QLineEdit, QPushButton, QSpinBox,\n")
    (root / "lumen" / "batch_export_dialog.py").write_text(header + dialog_src, encoding="utf-8")
    return "batch_export.py: 对话框拆到 batch_export_dialog.py"


def patch_library(root: Path) -> str:
    p = root / "lumen" / "library.py"
    src = p.read_text(encoding="utf-8")
    if "from .batch_export_dialog import BatchExportDialog" in src:
        return "library.py: 已改新模块，跳过"
    src = src.replace(
        "        from .batch_export import BatchExportDialog,run\n",
        "        from .batch_export import run\n"
        "        from .batch_export_dialog import BatchExportDialog\n",
    )
    p.write_text(src, encoding="utf-8")
    return "library.py: 对话框改从 batch_export_dialog 导入"


def patch_control(root: Path) -> str:
    """control.py 模块级 `QObject, Qt, Signal = _qt()` 让无 Qt 构建 import 失败，
    而 cli._context() 无条件 import control → 整条 B 通道（run/mcp）被阻断。
    客户端（前 120 行）本就 Qt-free；GUI 类降级为惰性桩即可。"""
    p = root / "lumen" / "control.py"
    src = p.read_text(encoding="utf-8")
    if "_QtMissing" in src:
        return "control.py: 已打桩，跳过"
    old = "QObject, Qt, Signal = _qt()\n"
    new = (
        "try:\n"
        "    QObject, Qt, Signal = _qt()\n"
        f"except ImportError:  {MARK}sidecar 无 PySide6：GUI 类永不实例化\n"
        "    class _QtMissing:\n"
        "        def __getattr__(self, name):\n"
        "            raise RuntimeError('PySide6 is not available in this build')\n\n"
        "    QObject = object\n"
        "    Qt = _QtMissing()\n"
        "    Signal = lambda *_a, **_k: None\n"
    )
    if old not in src:
        return "control.py: 未找到预期模式（请人工检查）"
    p.write_text(src.replace(old, new, 1), encoding="utf-8")
    return "control.py: GUI 类降级为惰性桩"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not (root / "lumen").is_dir():
        print(f"✗ 不是 lumen 工作副本: {root}")
        return 1
    for fn in (
        patch_lens,
        patch_lens_panel,
        patch_session,
        patch_batch_export,
        patch_library,
        patch_control,
    ):
        print(f"  {fn(root)}")
    print("✓ lumen-slim 补丁应用完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())