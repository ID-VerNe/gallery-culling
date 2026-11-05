/**
 * sidecar 产物的「锁文件」读写与校验（issue #73）。
 *
 * ## 为什么需要它
 *
 * `src-tauri/binaries/lumen-cli/` 是外部 PyInstaller onedir 产物，被 `.gitignore`
 * 忽略，不进版本库。于是有两条互相咬住的隐患：
 *
 * 1. **干净检出构建不了**——clone / 清空 binaries 后 `tauri build` 会在
 *    `prepare-sidecar` 处 fail-closed（这是对的，但恢复路径要一条命令）；
 * 2. **换了产物没人报警**——`lumen-cli.exe` 的 PE 里 FileVersion / ProductName 是空的，
 *    静态上无法自证版本；随包换一份别的构建，构建链和门禁都不会红。
 *
 * 本模块把「这份产物是什么」写进入库的 `src-tauri/sidecar.lock.json`：
 * 版本、来源、exe 哈希、目录文件数与总字节、目录内容哈希。`prepare-sidecar`
 * 与 `check-sidecar-lock` 都只读这一个定义，避免两边各写一套哈希口径。
 *
 * ## `contentSha256` 的口径（改口径 = 让所有人的锁文件一起失效，别随手改）
 *
 * 对目录内每个**文件**生成一行 `<相对路径>\t<字节数>\t<文件 sha256>`；相对路径用
 * `/` 分隔并**统一转小写**（Windows 路径大小写不敏感，避免同一目录因大小写写法
 * 不同的机器算出不同哈希）；所有行按路径字典序排序后以 `\n` 连接、末尾补一个
 * `\n`，对这段文本求 sha256。
 *
 * 它盯的是「文件数、总字节都一样，但内容被换掉」这一类——只比 exe 哈希抓不到
 * `_internal/` 里被替换的 Python 扩展。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const LOCK_FILE_NAME = 'sidecar.lock.json';
export const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** 首次生成锁文件时的来源说明。已有锁文件时 `--update-lock` 会原样保留 `source`。 */
export const DEFAULT_SOURCE = {
  type: 'local-path',
  upstream: 'hety0211/lumen-raw v1.6.0',
  note:
    '上游 Release 只发 GUI 安装包，其中 lumen-cli.exe 是 15,920,050 字节的另一构建；' +
    '随包精简 onedir（exe 6,702,168 字节 + _internal/，1150 个文件）没有可稳定取回的公开来源。',
};

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 目录统计：`{ fileCount, totalBytes, contentSha256 }`。口径见文件头注释。
 *
 * 刻意不跳过任何文件：`_internal/` 里的 `__pycache__`、`.dist-info` 也属于产物，
 * 少一个就说明产物不是打包时那一份。
 */
export function collectDirectory(dir) {
  const lines = [];
  let totalBytes = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const size = statSync(full).size;
      const relPath = relative(dir, full).split(sep).join('/').toLowerCase();
      lines.push(`${relPath}\t${size}\t${sha256File(full)}`);
      totalBytes += size;
    }
  };
  walk(dir);
  lines.sort();
  const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  return {
    fileCount: lines.length,
    totalBytes,
    contentSha256: createHash('sha256').update(content).digest('hex'),
  };
}

/** 锁文件的静态形状（不碰磁盘）。返回问题列表，空数组 = 合格。 */
export function lockShapeProblems(lock) {
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
    return ['锁文件不是 JSON 对象'];
  }
  const problems = [];
  const needString = (value, label) => {
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`${label} 必须是非空字符串`);
    }
  };
  const needBytes = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      problems.push(`${label} 必须是非负整数`);
    }
  };

  if (typeof lock.version !== 'string' || !SEMVER.test(lock.version)) {
    problems.push(`version 必须是 x.y.z 形式的语义版本（实际 ${JSON.stringify(lock.version)}）`);
  }

  const source = lock.source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    problems.push('source 必须是对象');
  } else {
    if (source.type !== 'url' && source.type !== 'local-path') {
      problems.push(`source.type 只能是 "url" 或 "local-path"（实际 ${JSON.stringify(source.type)}）`);
    }
    if (source.type === 'url') {
      needString(source.url, 'source.url');
    } else {
      // local-path 必须写清「为什么没有公开来源」，否则后人不知道能否换成 --fetch。
      needString(source.note, 'source.note（local-path 必须说明为什么没有公开来源）');
    }
  }

  if (lock.exe === null || typeof lock.exe !== 'object' || Array.isArray(lock.exe)) {
    problems.push('exe 必须是对象');
  } else {
    if (typeof lock.exe.sha256 !== 'string' || !SHA256.test(lock.exe.sha256)) {
      problems.push(`exe.sha256 必须是 64 位小写十六进制（实际 ${JSON.stringify(lock.exe.sha256)}）`);
    }
    needBytes(lock.exe.bytes, 'exe.bytes');
  }

  if (lock.directory === null || typeof lock.directory !== 'object' || Array.isArray(lock.directory)) {
    problems.push('directory 必须是对象');
  } else {
    needBytes(lock.directory.fileCount, 'directory.fileCount');
    needBytes(lock.directory.totalBytes, 'directory.totalBytes');
    if (
      typeof lock.directory.contentSha256 !== 'string' ||
      !SHA256.test(lock.directory.contentSha256)
    ) {
      problems.push(
        `directory.contentSha256 必须是 64 位小写十六进制（实际 ${JSON.stringify(
          lock.directory.contentSha256,
        )}）`,
      );
    }
  }

  if (typeof lock.generatedAt !== 'string' || Number.isNaN(Date.parse(lock.generatedAt))) {
    problems.push('generatedAt 必须是可解析的 ISO 时间字符串');
  }
  return problems;
}

/**
 * 锁文件与磁盘实际值逐项比对。返回「期望 vs 实际」的问题列表（空数组 = 一致）。
 *
 * `actual = { version, exeSha256, exeBytes, directory: { fileCount, totalBytes, contentSha256 } }`
 */
export function lockMismatchProblems(lock, actual) {
  const problems = [];
  const compare = (label, expected, got) => {
    if (expected !== got) problems.push(`${label}不一致：锁文件 ${expected}，实际 ${got}`);
  };
  compare('版本', lock.version, actual.version);
  compare('exe sha256 ', lock.exe.sha256, actual.exeSha256);
  compare('exe 字节数', lock.exe.bytes, actual.exeBytes);
  compare('文件数', lock.directory.fileCount, actual.directory.fileCount);
  compare('总字节数', lock.directory.totalBytes, actual.directory.totalBytes);
  compare('contentSha256 ', lock.directory.contentSha256, actual.directory.contentSha256);
  return problems;
}

/** 从 `src-tauri/src/lumen.rs` 里取 `PINNED_LUMEN_VERSION`。取不到返回 null。 */
export function pinnedVersionFromLumenRs(text) {
  const matched = text.match(/pub\s+const\s+PINNED_LUMEN_VERSION\s*:\s*&str\s*=\s*"([^"]+)"/);
  return matched ? matched[1] : null;
}

/** 从 `lumen-cli --version` 的输出里取首个 `x.y.z`。取不到返回 null。 */
export function parseVersionOutput(stdout) {
  const matched = String(stdout ?? '').match(/\d+\.\d+\.\d+/);
  return matched ? matched[0] : null;
}

export function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} 字节（${(bytes / 1024 / 1024).toFixed(1)} MB）`;
}

/** 读锁文件；`{ ok: true, lock }` 或 `{ ok: false, problem }`。 */
export function readLock(lockPath) {
  if (!existsSync(lockPath)) {
    return { ok: false, problem: `缺少锁文件 ${lockPath}` };
  }
  try {
    return { ok: true, lock: JSON.parse(readFileSync(lockPath, 'utf8')) };
  } catch (error) {
    return { ok: false, problem: `锁文件不是合法 JSON：${error.message}` };
  }
}
