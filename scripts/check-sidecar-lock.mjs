/**
 * 门禁：sidecar 锁文件与磁盘产物一致（issue #73）。
 *
 * 门禁链里最便宜的一档，它只做两件事：
 *
 * 1. **静态校验锁文件本身**——字段齐全、`version` 与宿主 `PINNED_LUMEN_VERSION`
 *    一致。这一步不需要产物，CI 上也能跑，防的是「锁文件被删 / 被手改成跟不上宿主」。
 * 2. **产物在盘时逐个核对**——exe 哈希、exe 字节数、目录文件数、总字节数、
 *    目录内容哈希。换产物、拷错目录、复制中断都会在这里红。
 *
 * 干净检出里 `src-tauri/binaries/` 恒不存在（被 `.gitignore` 忽略），此时**不判红**，
 * 只打印「未取回」与恢复命令。这一点很重要：CI 机器上永远没有产物，如果这里固定红，
 * 整条门禁链在 CI 上就没有意义了（PR_GUIDE 的 parity 同理）。
 *
 *     node scripts/check-sidecar-lock.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectDirectory,
  formatBytes,
  lockMismatchProblems,
  lockShapeProblems,
  pinnedVersionFromLumenRs,
  readLock,
  sha256File,
} from './sidecar-lock.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RECOVER_HINT =
  '取回命令：$env:LUMEN_SIDECAR_SRC="<产物目录>"; node scripts/prepare-sidecar.mjs';

/** 返回退出码；不直接 `process.exit`，单测可以复用整段判定。 */
export function check({ root = ROOT, log = console.log, errorLog = console.error } = {}) {
  const lockPath = path.join(root, 'src-tauri', 'sidecar.lock.json');
  const dir = path.join(root, 'src-tauri', 'binaries', 'lumen-cli');
  const lumenRs = path.join(root, 'src-tauri', 'src', 'lumen.rs');

  const locked = readLock(lockPath);
  if (!locked.ok) {
    errorLog(
      `FAIL: ${locked.problem}\n` +
        '锁文件是 sidecar 产物的唯一基线（入库文件 src-tauri/sidecar.lock.json）。\n' +
        '若产物可信、要在它上面重建基线：node scripts/prepare-sidecar.mjs --update-lock',
    );
    return 1;
  }
  const shape = lockShapeProblems(locked.lock);
  if (shape.length > 0) {
    errorLog(
      `FAIL: 锁文件字段不完整（${shape.length} 处）：\n` +
        shape.map((problem) => `  - ${problem}`).join('\n') +
        '\n修法：node scripts/prepare-sidecar.mjs --update-lock 重新生成基线。',
    );
    return 1;
  }

  if (!fs.existsSync(lumenRs)) {
    errorLog(`FAIL: 找不到 ${lumenRs}，无法核对宿主钉死的引擎版本`);
    return 1;
  }
  const pinned = pinnedVersionFromLumenRs(fs.readFileSync(lumenRs, 'utf8'));
  if (!pinned) {
    errorLog(`FAIL: ${lumenRs} 里解析不到 PINNED_LUMEN_VERSION`);
    return 1;
  }
  if (locked.lock.version !== pinned) {
    errorLog(
      `FAIL: 锁文件的引擎版本 ${locked.lock.version} 与 PINNED_LUMEN_VERSION ${pinned} 不一致。\n` +
        '宿主握手只接受钉死的版本；要么换成配套产物，要么同步升级 lumen.rs 后 --update-lock。',
    );
    return 1;
  }

  if (!fs.existsSync(dir)) {
    log(
      `PASS: 未取回 sidecar 产物（干净检出正常；锁文件字段齐全，版本 ${locked.lock.version} ` +
        `与 PINNED 一致）。\n${RECOVER_HINT}`,
    );
    return 0;
  }

  const exe = path.join(dir, 'lumen-cli.exe');
  if (!fs.existsSync(exe) || !fs.statSync(exe).isFile()) {
    errorLog(
      `FAIL: ${dir} 存在但缺少 lumen-cli.exe，产物不完整。\n` +
        '不要只搬 exe，也不要留下复制到一半的目录；用 LUMEN_SIDECAR_SRC 整目录重新取回。\n' +
        RECOVER_HINT,
    );
    return 1;
  }
  if (!fs.existsSync(path.join(dir, '_internal'))) {
    errorLog(
      `FAIL: ${dir} 存在但缺少 _internal/，PyInstaller onedir 产物不完整（只搬 exe 会一启动就崩）。\n` +
        RECOVER_HINT,
    );
    return 1;
  }

  const actual = {
    version: locked.lock.version,
    exeSha256: sha256File(exe),
    exeBytes: fs.statSync(exe).size,
    directory: collectDirectory(dir),
  };
  const problems = lockMismatchProblems(locked.lock, actual);
  if (problems.length > 0) {
    errorLog(
      `FAIL: sidecar 产物与锁文件不一致（${problems.length} 处）：\n` +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        '\n若这是有意更换产物：node scripts/prepare-sidecar.mjs --update-lock（先核对来源）；\n' +
        '若只是换机器 / 清空 binaries：' +
        RECOVER_HINT,
    );
    return 1;
  }

  log(
    `PASS: sidecar 产物与锁文件一致（版本 ${actual.version}，` +
      `${actual.directory.fileCount} 个文件 / ${formatBytes(actual.directory.totalBytes)}）`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(check());
}
