/**
 * 构建前置：本地**有** lumen-cli sidecar 时，确保它就是锁文件里那一份。
 *
 * issue #75 起引擎不再随主安装包分发（181.6 MB 从安装包移除），改为应用运行时
 * 从独立 Release 资产下载。因此本脚本的默认语义变成：
 *
 * - 本地没有产物 → **正常状态**，打印提示后 exit 0，不阻断 `tauri build`；
 * - 本地有产物 → 仍按 `src-tauri/sidecar.lock.json` 逐项校验，不一致 fail-closed
 *   （防「换了一份构建、构建照常成功、装进去的是另一个引擎」）。
 *
 * 仓库不构建产物，只消费既有产物；`lumen-cli.exe` 的 PE 版本号为空，静态上
 * 无法自证，所以锁文件钉住版本、exe 哈希、目录文件数与内容哈希。
 *
 * 用法：
 *   node scripts/prepare-sidecar.mjs                    # 有产物则校验，无产物则跳过
 *   node scripts/prepare-sidecar.mjs --update-lock       # 有意更换产物时人工重写锁文件
 *   node scripts/prepare-sidecar.mjs --fetch             # 说明产物从哪来（不代为下载）
 *   $env:LUMEN_SIDECAR_SRC="D:\build\lumen-cli"; node scripts/prepare-sidecar.mjs
 *
 * `LUMEN_SIDECAR_SRC` 指向 onedir 目录（或直接指向 lumen-cli.exe）时，先复制到临时目录、
 * 在临时目录上校验（或重写锁文件），再**原子替换** `src-tauri/binaries/lumen-cli/`。
 * 复制或校验失败时目标目录保持原样，不会留下半截产物。
 *
 * 注意：文件名刻意不叫 `check-*`，避免被 `check-gates-manifest.mjs` 当成门禁
 * 收进 `scripts/gates.json`。门禁入口是 `scripts/check-sidecar-lock.mjs`。
 */
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collectDirectory,
  DEFAULT_SOURCE,
  formatBytes,
  lockMismatchProblems,
  lockShapeProblems,
  parseVersionOutput,
  pinnedVersionFromLumenRs,
  readLock,
  sha256File,
} from './sidecar-lock.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_PUBLIC_SOURCE =
  '脚本不再代为下载引擎（issue #75）：引擎改由应用运行时从独立 Release 资产拉取。\n' +
  '主安装包构建**不需要**本地产物；只有本地测试 / 对照时才需要放一份。\n' +
  '下一步（任选其一）：\n' +
  '  1) 从 release 下载 zip 并解压到 src-tauri/binaries/lumen-cli/（整目录，含 _internal/）：\n' +
  `     ${DEFAULT_SOURCE.url}\n` +
  '  2) $env:LUMEN_SIDECAR_SRC="<产物目录>"; node scripts/prepare-sidecar.mjs\n' +
  '  3) 若确实要有意更换引擎：先核对来源，再 --update-lock\n' +
  '产物只用于本地对照，不得提交进 git（也不引入 LFS）。';

function fail(errorLog, message) {
  errorLog(`\n[prepare-sidecar] ${message}\n`);
  return 1;
}

/** 跑 `lumen-cli --version` 并解析版本号；`spawn` 可注入，便于单测。 */
export function queryVersion(exe, spawn) {
  const result = spawn(exe, ['--version']);
  if (result?.error) {
    return { ok: false, reason: `无法执行 lumen-cli.exe --version：${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `lumen-cli.exe --version 退出码 ${result.status}（预期 0）` };
  }
  const version = parseVersionOutput(result.stdout);
  if (!version) {
    return { ok: false, reason: 'lumen-cli.exe --version 的输出里没有 x.y.z 版本号' };
  }
  return { ok: true, version };
}

/**
 * 检查一个 onedir 目录并汇总实际值。缺 exe / 缺 `_internal/` / 取不到版本都算问题，
 * 此时 `actual` 为 null（没有可写进锁文件的完整基线）。
 */
export function inspectArtifact(dir, spawn) {
  const exe = join(dir, 'lumen-cli.exe');
  const internal = join(dir, '_internal');
  if (!fs.existsSync(exe) || !fs.statSync(exe).isFile()) {
    return {
      problems: [`缺少 ${join(dir, 'lumen-cli.exe')}`],
      actual: null,
    };
  }
  if (!fs.existsSync(internal) || !fs.statSync(internal).isDirectory()) {
    return {
      problems: [
        `缺少 ${join(dir, '_internal')}（PyInstaller onedir 只复制 exe 会得到一个一启动就崩的坏包）`,
      ],
      actual: null,
    };
  }
  const version = queryVersion(exe, spawn);
  if (!version.ok) return { problems: [version.reason], actual: null };

  const directory = collectDirectory(dir);
  return {
    problems: [],
    actual: {
      version: version.version,
      exeSha256: sha256File(exe),
      exeBytes: fs.statSync(exe).size,
      directory,
    },
  };
}

/** 从 `src-tauri/src/lumen.rs` 取宿主钉死的版本；取不到视为仓库结构异常。 */
function readPinnedVersion(root) {
  const file = join(root, 'src-tauri', 'src', 'lumen.rs');
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `找不到 ${file}，无法核对宿主钉死的引擎版本` };
  }
  const pinned = pinnedVersionFromLumenRs(fs.readFileSync(file, 'utf8'));
  if (!pinned) {
    return { ok: false, reason: `${file} 里解析不到 PINNED_LUMEN_VERSION` };
  }
  return { ok: true, pinned };
}

/** 把源目录复制到临时目录；返回临时目录路径，失败抛出带中文说明的错误。 */
function copyToTemp(srcDir, destDir) {
  const tempDir = join(
    dirname(destDir),
    `lumen-cli.tmp-${process.pid}-${Date.now().toString(36)}`,
  );
  fs.mkdirSync(dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, tempDir, { recursive: true });
  return tempDir;
}

/**
 * 原子替换目标目录：先把旧目录改名让位，新目录就位后删掉旧目录。
 * 两步改名都在同一卷上，失败时把旧目录改回来，调用方不会看到半截产物。
 */
function replaceDirectory(tempDir, destDir) {
  const backup = `${destDir}.old-${Date.now().toString(36)}`;
  const hadDest = fs.existsSync(destDir);
  if (hadDest) fs.renameSync(destDir, backup);
  try {
    fs.renameSync(tempDir, destDir);
  } catch (error) {
    if (hadDest && fs.existsSync(backup)) fs.renameSync(backup, destDir);
    throw error;
  }
  if (hadDest) fs.rmSync(backup, { recursive: true, force: true });
}

/** `replaceDirectory` 的中文失败包装：返回是否成功，失败时目标目录保持原样。 */
function swapInPlace(tempDir, destDir, errorLog) {
  try {
    replaceDirectory(tempDir, destDir);
    return true;
  } catch (error) {
    fail(errorLog, `替换 ${destDir} 失败：${error.message}\n目标目录未改动。`);
    return false;
  }
}

function mismatchMessage(problems) {
  return (
    `sidecar 产物与锁文件不一致（${problems.length} 处）：\n` +
    problems.map((problem) => `  - ${problem}`).join('\n') +
    '\n下一步：\n' +
    '  - 如果这是有意更换产物：node scripts/prepare-sidecar.mjs --update-lock\n' +
    '  - 如果是换机器 / 清空了 binaries：$env:LUMEN_SIDECAR_SRC="<产物目录>"; ' +
    'node scripts/prepare-sidecar.mjs\n' +
    '  - 如果产物来源不明：先核对来源，再决定要不要 --update-lock'
  );
}

function writeLock(lockPath, lock) {
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

/**
 * 主流程。返回退出码；不直接 `process.exit`，单测可以复用整段接线。
 */
export function prepare({
  root = ROOT,
  argv = process.argv,
  env = process.env,
  spawn = spawnSync,
  log = console.log,
  errorLog = console.error,
  now = () => new Date().toISOString(),
} = {}) {
  const destDir = join(root, 'src-tauri', 'binaries', 'lumen-cli');
  const lockPath = join(root, 'src-tauri', 'sidecar.lock.json');
  const args = argv.slice(2);
  const updateLock = args.includes('--update-lock');
  const fetchRequested = args.includes('--fetch');
  const unknown = args.filter((arg) => arg !== '--update-lock' && arg !== '--fetch');
  if (unknown.length > 0) return fail(errorLog, `未知参数：${unknown.join(' ')}`);

  if (fetchRequested) return fail(errorLog, NO_PUBLIC_SOURCE);

  const pinned = readPinnedVersion(root);
  if (!pinned.ok) return fail(errorLog, pinned.reason);

  const srcEnv = env.LUMEN_SIDECAR_SRC?.trim();
  if (srcEnv) {
    if (!fs.existsSync(srcEnv)) {
      return fail(errorLog, `LUMEN_SIDECAR_SRC 指向的路径不存在：${srcEnv}`);
    }
    const srcDir = fs.statSync(srcEnv).isFile() ? dirname(srcEnv) : srcEnv;
    if (resolve(srcDir) === resolve(destDir)) {
      return fail(
        errorLog,
        `LUMEN_SIDECAR_SRC 与目标目录相同（${destDir}），无需复制；直接跑校验即可。`,
      );
    }
    if (!fs.existsSync(join(srcDir, 'lumen-cli.exe'))) {
      return fail(
        errorLog,
        `LUMEN_SIDECAR_SRC 指向的目录里没有 lumen-cli.exe：${srcDir}\n` +
          '请指向 PyInstaller onedir 输出目录（应包含 lumen-cli.exe 与 _internal/）。',
      );
    }

    log(`[prepare-sidecar] 从 ${srcDir} 复制 sidecar → ${destDir}`);
    let tempDir;
    try {
      tempDir = copyToTemp(srcDir, destDir);
    } catch (error) {
      return fail(errorLog, `复制 sidecar 失败：${error.message}\n目标目录未改动：${destDir}`);
    }

    try {
      const inspected = inspectArtifact(tempDir, spawn);
      if (inspected.problems.length > 0) {
        return fail(
          errorLog,
          `${inspected.problems.join('\n')}\n目标目录未改动：${destDir}`,
        );
      }
      const actual = inspected.actual;

      if (actual.version !== pinned.pinned) {
        return fail(
          errorLog,
          `复制来的产物版本 ${actual.version} 与宿主钉死的 PINNED_LUMEN_VERSION ` +
            `${pinned.pinned} 不一致。\n先确认是否要升级引擎（需要同步改 src-tauri/src/lumen.rs），` +
            '再决定是否 --update-lock。',
        );
      }

      if (updateLock) {
        const existing = readLock(lockPath);
        const source = resolveSourceForUpdate(existing, pinned.pinned);
        const lock = buildLock(actual, source, now);
        writeLock(lockPath, lock);
        if (!swapInPlace(tempDir, destDir, errorLog)) return 1;
        tempDir = null;
        log(okLine(actual, '已重写 src-tauri/sidecar.lock.json'));
        return 0;
      }

      const existing = readLock(lockPath);
      if (!existing.ok) {
        return fail(errorLog, `${existing.problem}\n${missingLockHint()}`);
      }
      const shape = lockShapeProblems(existing.lock);
      if (shape.length > 0) {
        return fail(
          errorLog,
          `锁文件字段不完整（${shape.length} 处）：\n` +
            shape.map((problem) => `  - ${problem}`).join('\n') +
            '\n修法：node scripts/prepare-sidecar.mjs --update-lock 重新生成基线。',
        );
      }
      const problems = lockMismatchProblems(existing.lock, actual);
      if (problems.length > 0) {
        return fail(
          errorLog,
          `${mismatchMessage(problems)}\n目标目录未改动：${destDir}`,
        );
      }
      if (!swapInPlace(tempDir, destDir, errorLog)) return 1;
      tempDir = null;
      log(okLine(actual, '复制并校验通过'));
      return 0;
    } finally {
      if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const inspected = inspectArtifact(destDir, spawn);
  if (inspected.problems.length > 0) {
    const missing = inspected.problems.join('\n');
    if (!fs.existsSync(destDir)) {
      // issue #75：安装包不再打包引擎，缺产物是**正常构建状态**，不能阻断构建。
      log(
        `[prepare-sidecar] 未找到本地 sidecar 产物：${destDir}\n` +
          '构建继续：引擎不再随安装包分发，应用运行时首次需要 LUMEN 时会从独立 Release ' +
          '资产下载并校验（见 src-tauri/sidecar.lock.json 的 source）。\n' +
          '如需本地直接测试引擎，可任选其一：\n' +
          '  - $env:LUMEN_SIDECAR_SRC="<产物目录>"; node scripts/prepare-sidecar.mjs\n' +
          `  - 手工把 onedir 整目录放到 ${destDir}（必须含 _internal/）`,
      );
      return 0;
    }
    return fail(errorLog, missing);
  }
  const actual = inspected.actual;

  if (actual.version !== pinned.pinned) {
    return fail(
      errorLog,
      `sidecar 产物版本 ${actual.version} 与宿主钉死的 PINNED_LUMEN_VERSION ` +
        `${pinned.pinned} 不一致。\n宿主握手会拒绝这个版本；请换成配套产物，或同步升级 ` +
        'src-tauri/src/lumen.rs 后 --update-lock。',
    );
  }

  if (updateLock) {
    const existing = readLock(lockPath);
    const source = resolveSourceForUpdate(existing, pinned.pinned);
    const lock = buildLock(actual, source, now);
    writeLock(lockPath, lock);
    log(okLine(actual, '已重写 src-tauri/sidecar.lock.json'));
    return 0;
  }

  const existing = readLock(lockPath);
  if (!existing.ok) return fail(errorLog, `${existing.problem}\n${missingLockHint()}`);
  const shape = lockShapeProblems(existing.lock);
  if (shape.length > 0) {
    return fail(
      errorLog,
      `锁文件字段不完整（${shape.length} 处）：\n` +
        shape.map((problem) => `  - ${problem}`).join('\n') +
        '\n修法：node scripts/prepare-sidecar.mjs --update-lock 重新生成基线。',
    );
  }
  const problems = lockMismatchProblems(existing.lock, actual);
  if (problems.length > 0) return fail(errorLog, mismatchMessage(problems));

  log(okLine(actual, '与锁文件一致'));
  return 0;
}

function okLine(actual, prefix) {
  return (
    `[prepare-sidecar] OK：${prefix}；版本 ${actual.version}；` +
    `${actual.directory.fileCount} 个文件 / ${formatBytes(actual.directory.totalBytes)}`
  );
}

function missingLockHint() {
  return (
    '下一步：\n' +
    '  - 若当前产物可信、要在它上面建立基线：node scripts/prepare-sidecar.mjs --update-lock\n' +
    '  - 若是干净检出：先复制产物（$env:LUMEN_SIDECAR_SRC="<产物目录>"; node scripts/prepare-sidecar.mjs），' +
    '锁文件必须在版本库里（src-tauri/sidecar.lock.json）'
  );
}

/** `--update-lock` 时尽量保留原锁文件里的来源说明；没有就退回默认说明。 */
function resolveSourceForUpdate(existing, pinned) {
  if (existing.ok && existing.lock && typeof existing.lock.source === 'object') {
    const source = existing.lock.source;
    if (source.type === 'url' ? typeof source.url === 'string' : typeof source.note === 'string') {
      return source;
    }
  }
  return { ...DEFAULT_SOURCE, upstream: `hety0211/lumen-raw v${pinned}` };
}

function buildLock(actual, source, now) {
  return {
    version: actual.version,
    source,
    exe: { sha256: actual.exeSha256, bytes: actual.exeBytes },
    directory: actual.directory,
    generatedAt: now(),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(prepare({ argv: process.argv }));
}
