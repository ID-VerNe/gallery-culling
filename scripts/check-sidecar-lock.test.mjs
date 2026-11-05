/**
 * `check-sidecar-lock.mjs` 的判定单测（issue #73）。
 *
 * 这条门禁有两种合法的「绿」：干净检出里产物未取回（CI 恒为此状态），以及产物在盘
 * 且与锁文件逐项一致。前者**必须**是绿——否则 CI 永远红，门禁形同没有。所以两种绿
 * 与六种红都要各自有用例。
 *
 * 基线一律通过 `prepare --update-lock` 生成，避免测试里再抄一份哈希口径。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from './check-sidecar-lock.mjs';
import { prepare } from './prepare-sidecar.mjs';

function makeRoot(pinned = '1.6.0') {
  const root = mkdtempSync(join(tmpdir(), 'check-sidecar-'));
  mkdirSync(join(root, 'src-tauri', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src-tauri', 'src', 'lumen.rs'),
    `pub const PINNED_LUMEN_VERSION: &str = "${pinned}";\n`,
    'utf8',
  );
  return root;
}

function writeArtifact(dir, { exe = 'exe-bytes', dll = 'dll-bytes' } = {}) {
  mkdirSync(join(dir, '_internal'), { recursive: true });
  writeFileSync(join(dir, 'lumen-cli.exe'), exe, 'utf8');
  writeFileSync(join(dir, '_internal', 'python.dll'), dll, 'utf8');
}

const artifactDir = (root) => join(root, 'src-tauri', 'binaries', 'lumen-cli');
const lockPath = (root) => join(root, 'src-tauri', 'sidecar.lock.json');

/** 用真实 `prepare --update-lock` 建基线，返回产物目录。 */
function withBaseline(root, artifact = {}) {
  const dir = artifactDir(root);
  writeArtifact(dir, artifact);
  const code = prepare({
    root,
    argv: ['node', 'scripts/prepare-sidecar.mjs', '--update-lock'],
    env: {},
    spawn: () => ({ status: 0, stdout: 'LUMEN RAW 1.6.0\n' }),
    log: () => {},
    errorLog: () => {},
    now: () => '2026-11-05T00:00:00.000Z',
  });
  expect(code).toBe(0);
  return dir;
}

function runCheck(root) {
  const output = [];
  const code = check({
    root,
    log: (line) => output.push(String(line)),
    errorLog: (line) => output.push(String(line)),
  });
  return { code, output: output.join('\n') };
}

describe('check-sidecar-lock —— 干净检出不判红', () => {
  it('产物目录不存在 → PASS 并打印「未取回」与取回命令', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      rmSync(join(root, 'src-tauri', 'binaries'), { recursive: true, force: true });
      const { code, output } = runCheck(root);
      expect(code).toBe(0);
      expect(output).toContain('未取回');
      expect(output).toContain('LUMEN_SIDECAR_SRC');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check-sidecar-lock —— 锁文件本身', () => {
  it('锁文件缺失 → 红，并给出重建基线的命令', () => {
    const root = makeRoot();
    try {
      const { code, output } = runCheck(root);
      expect(code).toBe(1);
      expect(output).toContain('缺少锁文件');
      expect(output).toContain('--update-lock');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('字段缺失 → 红，点名缺的那个字段', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      const lock = JSON.parse(readFileSync(lockPath(root), 'utf8'));
      delete lock.generatedAt;
      writeFileSync(lockPath(root), JSON.stringify(lock), 'utf8');
      const { code, output } = runCheck(root);
      expect(code).toBe(1);
      expect(output).toContain('generatedAt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('source.type=url 缺 zipSha256 / zipBytes → 红（无法校验下载内容）', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      const lock = JSON.parse(readFileSync(lockPath(root), 'utf8'));
      delete lock.source.zipSha256;
      delete lock.source.zipBytes;
      writeFileSync(lockPath(root), JSON.stringify(lock), 'utf8');
      const { code, output } = runCheck(root);
      expect(code).toBe(1);
      expect(output).toContain('zipSha256');
      expect(output).toContain('zipBytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('锁文件版本与 PINNED_LUMEN_VERSION 不一致 → 红（不需要产物在盘）', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      // 模拟「宿主降级了、锁文件还停在旧版本」：先在 1.6.0 上建基线，再把 PINNED 改回 1.5.0。
      writeFileSync(
        join(root, 'src-tauri', 'src', 'lumen.rs'),
        'pub const PINNED_LUMEN_VERSION: &str = "1.5.0";\n',
        'utf8',
      );
      rmSync(join(root, 'src-tauri', 'binaries'), { recursive: true, force: true });
      const { code, output } = runCheck(root);
      expect(code).toBe(1);
      expect(output).toContain('PINNED_LUMEN_VERSION');
      expect(output).toContain('1.6.0');
      expect(output).toContain('1.5.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check-sidecar-lock —— 产物在盘时逐项核对', () => {
  it('一致 → PASS，并打印可核对的文件数与字节数', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      const { code, output } = runCheck(root);
      expect(code).toBe(0);
      expect(output).toContain('与锁文件一致');
      expect(output).toContain('2 个文件');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('目录在但缺 exe → 红（半截产物不能当成「未取回」）', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      rmSync(join(artifactDir(root), 'lumen-cli.exe'));
      const { code, output } = runCheck(root);
      expect(code).toBe(1);
      expect(output).toContain('lumen-cli.exe');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('缺 _internal/ → 红，点明 onedir 完整性', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      rmSync(join(artifactDir(root), '_internal'), { recursive: true, force: true });
      const { code, output } = runCheck(root);
      expect(code).toBe(1);
      expect(output).toContain('_internal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exe 内容被换掉 → 红，exe sha256 期望 vs 实际', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      // 与 'exe-bytes' 等长（9 字节）：只改内容不改字节数，才锁得住「比的是哈希不是大小」。
      writeFileSync(join(artifactDir(root), 'lumen-cli.exe'), 'bad-bytes', 'utf8');
      const { code, output } = runCheck(root);
      expect(code).toBe(1);
      expect(output).toContain('exe sha256 不一致');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('多一个文件 → 红，文件数与 contentSha256 不一致', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      writeFileSync(join(artifactDir(root), '_internal', 'extra.pyc'), 'x', 'utf8');
      const { code, output } = runCheck(root);
      expect(code).toBe(1);
      expect(output).toContain('文件数不一致');
      expect(output).toContain('contentSha256');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
