/**
 * tauri build 前置：确保随包 lumen-cli sidecar 完整。
 *
 * 背景（issue #68）：lumen-cli 是外部 PyInstaller **onedir** 产物，
 * `lumen-cli.exe` 必须与同目录 `_internal/` 一起分发；仓库不构建它，只消费
 * 既有产物。历史问题正是「产物不在 → Tauri resources glob 命中空 → 装出来的
 * 包缺引擎」，而且报错晦涩。
 *
 * 用法：
 *   node scripts/prepare-sidecar.mjs
 *   $env:LUMEN_SIDECAR_SRC="D:\build\lumen-cli"; node scripts/prepare-sidecar.mjs
 *
 * `LUMEN_SIDECAR_SRC` 指向 onedir 目录（或直接指向 lumen-cli.exe）时，先复制
 * 到 `src-tauri/binaries/lumen-cli/`；未设置时只校验现有产物。
 * 校验失败必须 exit 1 —— 不允许「构建成功但装出来没有引擎」。
 *
 * 注意：文件名刻意不叫 `check-*`，避免被 `check-gates-manifest.mjs` 当成门禁
 * 收进 `scripts/gates.json`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destDir = path.join(root, 'src-tauri', 'binaries', 'lumen-cli');
const destExe = path.join(destDir, 'lumen-cli.exe');

function fail(message) {
  console.error(`\n[prepare-sidecar] ${message}\n`);
  process.exit(1);
}

const srcEnv = process.env.LUMEN_SIDECAR_SRC?.trim();
if (srcEnv) {
  // 允许直接给 exe（取其父目录），也允许给 onedir 目录。
  const srcDir = fs.statSync(srcEnv, { throwIfNoEntry: false })?.isFile()
    ? path.dirname(srcEnv)
    : srcEnv;
  const srcExe = path.join(srcDir, 'lumen-cli.exe');
  if (!fs.existsSync(srcExe)) {
    fail(
      `LUMEN_SIDECAR_SRC 指向的目录里没有 lumen-cli.exe：${srcDir}\n` +
        `请指向 PyInstaller onedir 输出目录（应包含 lumen-cli.exe 与 _internal/）。`,
    );
  }
  console.log(`[prepare-sidecar] 从 ${srcDir} 复制 sidecar → ${destDir}`);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
}

const internalDir = path.join(destDir, '_internal');
if (!fs.existsSync(destExe) || !fs.statSync(destExe).isFile()) {
  fail(
    '缺少 src-tauri/binaries/lumen-cli/lumen-cli.exe。\n' +
      '下一步（任选其一）：\n' +
      '  1) 先构建 lumen-raw 的 PyInstaller onedir 产物，再执行：\n' +
      '     $env:LUMEN_SIDECAR_SRC="<产物目录>"; node scripts/prepare-sidecar.mjs\n' +
      '  2) 从已有构建机复制整个 lumen-cli/ 目录到 src-tauri/binaries/lumen-cli/。',
  );
}
if (!fs.existsSync(internalDir) || !fs.statSync(internalDir).isDirectory()) {
  fail(
    '缺少 src-tauri/binaries/lumen-cli/_internal/。\n' +
      'lumen-cli 是 PyInstaller onedir 产物，只复制 exe 会得到一个一启动就崩的坏包。\n' +
      '下一步：复制/重建整个 onedir 目录（exe + _internal/），不要只搬 exe。',
  );
}

let fileCount = 0;
let total = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      fileCount += 1;
      total += fs.statSync(full).size;
    }
  }
}
walk(destDir);
console.log(
  `[prepare-sidecar] OK：${fileCount} 个文件 / ${(total / 1024 / 1024).toFixed(1)} MB`,
);
