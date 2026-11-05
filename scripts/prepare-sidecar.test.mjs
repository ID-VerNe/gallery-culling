/**
 * `prepare-sidecar.mjs` 的接线单测（issue #73）。
 *
 * 为什么必须测整段接线：`prepare-sidecar` 是 `tauri build` 的前置，它失败的表现
 * 是「构建到一半才炸」；而它放过的表现更糟——**换了一份产物、构建照常成功、装出来
 * 的包里是另一个引擎**。所以这里全部用真实文件系统（临时目录）跑 `prepare()`，
 * 断言退出码与中文文案，而不是只测几个纯函数。
 *
 * `spawn` 被注入成固定输出，避免单测真的去启动一个 PyInstaller exe。
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from './prepare-sidecar.mjs';
import { collectDirectory, parseVersionOutput, pinnedVersionFromLumenRs } from './sidecar-lock.mjs';

/** 造一个最小仓库骨架：只需 `src-tauri/src/lumen.rs` 与（可选）产物目录。 */
function makeRoot(pinned = '1.6.0') {
  const root = mkdtempSync(join(tmpdir(), 'prepare-sidecar-'));
  mkdirSync(join(root, 'src-tauri', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src-tauri', 'src', 'lumen.rs'),
    `pub const PINNED_LUMEN_VERSION: &str = "${pinned}";\n`,
    'utf8',
  );
  return root;
}

/** 写一份 onedir 产物。`extra` 往 `_internal/` 里加文件，用来造「文件数不一致」。 */
function writeArtifact(dir, { exe = 'exe-bytes', dll = 'dll-bytes', extra = {} } = {}) {
  mkdirSync(join(dir, '_internal'), { recursive: true });
  writeFileSync(join(dir, 'lumen-cli.exe'), exe, 'utf8');
  writeFileSync(join(dir, '_internal', 'python.dll'), dll, 'utf8');
  for (const [name, content] of Object.entries(extra)) {
    writeFileSync(join(dir, '_internal', name), content, 'utf8');
  }
}

const spawnWith = (version) => (_exe, args) => {
  expect(args).toEqual(['--version']);
  return { status: 0, stdout: `LUMEN RAW ${version}\n` };
};

/** 跑一次 `prepare()`，收集两路输出；返回 `{ code, output }`。 */
function run(root, { args = [], env = {}, spawn = spawnWith('1.6.0') } = {}) {
  const output = [];
  const code = prepare({
    root,
    argv: ['node', 'scripts/prepare-sidecar.mjs', ...args],
    env,
    spawn,
    log: (line) => output.push(String(line)),
    errorLog: (line) => output.push(String(line)),
    now: () => '2026-11-05T00:00:00.000Z',
  });
  return { code, output: output.join('\n') };
}

/** 在临时根上先 `--update-lock` 建基线，返回产物目录。 */
function withBaseline(root, artifact = {}) {
  const dir = join(root, 'src-tauri', 'binaries', 'lumen-cli');
  writeArtifact(dir, artifact);
  const result = run(root, { args: ['--update-lock'] });
  expect(result.code, result.output).toBe(0);
  return dir;
}

const lockPath = (root) => join(root, 'src-tauri', 'sidecar.lock.json');

describe('sidecar-lock 口径', () => {
  it('解析 `LUMEN RAW 1.6.0` 里的版本号，垃圾输出返回 null', () => {
    expect(parseVersionOutput('LUMEN RAW 1.6.0\n')).toBe('1.6.0');
    expect(parseVersionOutput('no version here')).toBeNull();
  });

  it('从 lumen.rs 取 PINNED_LUMEN_VERSION，取不到返回 null', () => {
    expect(pinnedVersionFromLumenRs('pub const PINNED_LUMEN_VERSION: &str = "1.6.0";')).toBe('1.6.0');
    expect(pinnedVersionFromLumenRs('pub const OTHER: &str = "1.6.0";')).toBeNull();
  });

  it('目录统计的 contentSha256 对「加一个文件」敏感，且等于自身重复计算的稳定值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'collect-'));
    try {
      writeArtifact(dir);
      const first = collectDirectory(dir);
      expect(first.fileCount).toBe(2);
      expect(first.totalBytes).toBe('exe-bytes'.length + 'dll-bytes'.length);
      expect(first.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      // 重复扫描必须同值：否则锁文件在每台机器上都会红。
      expect(collectDirectory(dir).contentSha256).toBe(first.contentSha256);

      writeFileSync(join(dir, '_internal', 'extra.txt'), 'x', 'utf8');
      const after = collectDirectory(dir);
      expect(after.fileCount).toBe(3);
      expect(after.contentSha256).not.toBe(first.contentSha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('prepare-sidecar —— 默认模式只校验', () => {
  it('锁文件缺失 → fail-closed，并给出建立基线的下一步', () => {
    const root = makeRoot();
    try {
      writeArtifact(join(root, 'src-tauri', 'binaries', 'lumen-cli'));
      const { code, output } = run(root);
      expect(code).toBe(1);
      expect(output).toContain('缺少锁文件');
      expect(output).toContain('--update-lock');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('产物与锁文件一致 → 通过，并打印可核对的文件数与字节数', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      const { code, output } = run(root);
      expect(code).toBe(0);
      expect(output).toContain('与锁文件一致');
      expect(output).toContain('2 个文件');
      expect(output).toContain('字节');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exe 内容变了 → 报 exe sha256 / 字节数不一致（期望 vs 实际）', () => {
    const root = makeRoot();
    try {
      const dir = withBaseline(root);
      // 与 'exe-bytes' 等长（9 字节）：只改内容不改字节数，才锁得住「比的是哈希不是大小」。
      writeFileSync(join(dir, 'lumen-cli.exe'), 'bad-bytes', 'utf8');
      const { code, output } = run(root);
      expect(code).toBe(1);
      expect(output).toContain('exe sha256 不一致');
      expect(output).toContain('锁文件');
      expect(output).toContain('实际');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('多塞一个文件 → 文件数 / 总字节数 / contentSha256 一起报', () => {
    const root = makeRoot();
    try {
      const dir = withBaseline(root);
      writeFileSync(join(dir, '_internal', 'extra.pyc'), 'x', 'utf8');
      const { code, output } = run(root);
      expect(code).toBe(1);
      expect(output).toContain('文件数不一致');
      expect(output).toContain('contentSha256');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('缺 _internal/ → 明确说明只搬 exe 会崩', () => {
    const root = makeRoot();
    try {
      const dir = withBaseline(root);
      rmSync(join(dir, '_internal'), { recursive: true, force: true });
      const { code, output } = run(root);
      expect(code).toBe(1);
      expect(output).toContain('_internal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exe 自报版本与锁文件不一致 → fail-closed', () => {
    const root = makeRoot();
    try {
      const dir = withBaseline(root);
      writeFileSync(join(dir, 'lumen-cli.exe'), 'exe-bytes', 'utf8');
      const { code, output } = run(root, { spawn: spawnWith('1.5.0') });
      expect(code).toBe(1);
      expect(output).toContain('1.5.0');
      expect(output).toContain('1.6.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exe 自报版本与宿主 PINNED 不一致 → 拦住（不让它进安装包）', () => {
    const root = makeRoot('1.5.0');
    try {
      writeArtifact(join(root, 'src-tauri', 'binaries', 'lumen-cli'));
      const { code, output } = run(root, { spawn: spawnWith('1.6.0') });
      expect(code).toBe(1);
      expect(output).toContain('PINNED_LUMEN_VERSION');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('默认模式绝不重写锁文件', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      // 手工改一个 generatedAt：只要默认模式顺手调了 --update-lock 的写盘路径，
      // 它就会被 now() 换成 2026-11-05，用例随之变红。
      const lock = JSON.parse(readFileSync(lockPath(root), 'utf8'));
      lock.generatedAt = '2000-01-01T00:00:00.000Z';
      const before = JSON.stringify(lock);
      writeFileSync(lockPath(root), before, 'utf8');
      expect(run(root).code).toBe(0);
      expect(readFileSync(lockPath(root), 'utf8')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('prepare-sidecar —— --update-lock 才重写', () => {
  it('从产物重建锁文件：版本来自 exe 自报，不是手写', () => {
    const root = makeRoot();
    try {
      const dir = join(root, 'src-tauri', 'binaries', 'lumen-cli');
      writeArtifact(dir);
      const { code } = run(root, { args: ['--update-lock'], spawn: spawnWith('1.6.0') });
      expect(code).toBe(0);
      const lock = JSON.parse(readFileSync(lockPath(root), 'utf8'));
      expect(lock.version).toBe('1.6.0');
      expect(lock.exe.bytes).toBe(statSync(join(dir, 'lumen-cli.exe')).size);
      expect(lock.directory.fileCount).toBe(2);
      expect(lock.generatedAt).toBe('2026-11-05T00:00:00.000Z');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exe 自报版本取不到 → 不写锁文件', () => {
    const root = makeRoot();
    try {
      writeArtifact(join(root, 'src-tauri', 'binaries', 'lumen-cli'));
      const { code, output } = run(root, {
        args: ['--update-lock'],
        spawn: () => ({ status: 0, stdout: 'no version' }),
      });
      expect(code).toBe(1);
      expect(output).toContain('没有 x.y.z 版本号');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('重写时保留原有 source 说明（不把来源洗成默认文案）', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      const lock = JSON.parse(readFileSync(lockPath(root), 'utf8'));
      lock.source = { type: 'local-path', upstream: 'someone-else', note: '手工来源说明' };
      writeFileSync(lockPath(root), JSON.stringify(lock, null, 2), 'utf8');
      expect(run(root, { args: ['--update-lock'] }).code).toBe(0);
      expect(JSON.parse(readFileSync(lockPath(root), 'utf8')).source.upstream).toBe('someone-else');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('prepare-sidecar —— LUMEN_SIDECAR_SRC 复制', () => {
  it('干净检出（目标不存在）→ 复制 + 校验通过', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      rmSync(join(root, 'src-tauri', 'binaries'), { recursive: true, force: true });
      const srcDir = join(root, 'build-output', 'lumen-cli');
      writeArtifact(srcDir);
      const { code, output } = run(root, { env: { LUMEN_SIDECAR_SRC: srcDir } });
      expect(code).toBe(0);
      expect(output).toContain('复制并校验通过');
      expect(readFileSync(join(root, 'src-tauri', 'binaries', 'lumen-cli', 'lumen-cli.exe'), 'utf8')).toBe(
        'exe-bytes',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('源产物与锁文件不符 → 失败且目标目录原封不动（不留半截）', () => {
    const root = makeRoot();
    try {
      const dir = withBaseline(root);
      const srcDir = join(root, 'build-output', 'lumen-cli');
      writeArtifact(srcDir, { exe: 'other-exe' });
      const { code, output } = run(root, { env: { LUMEN_SIDECAR_SRC: srcDir } });
      expect(code).toBe(1);
      expect(output).toContain('exe sha256 不一致');
      expect(output).toContain('目标目录未改动');
      expect(readFileSync(join(dir, 'lumen-cli.exe'), 'utf8')).toBe('exe-bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('源目录缺 _internal/ → 失败且目标目录原封不动', () => {
    const root = makeRoot();
    try {
      const dir = withBaseline(root);
      const srcDir = join(root, 'build-output', 'lumen-cli');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'lumen-cli.exe'), 'exe-bytes', 'utf8');
      const { code, output } = run(root, { env: { LUMEN_SIDECAR_SRC: srcDir } });
      expect(code).toBe(1);
      expect(output).toContain('_internal');
      expect(output).toContain('目标目录未改动');
      expect(readFileSync(join(dir, 'lumen-cli.exe'), 'utf8')).toBe('exe-bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('锁文件缺失时复制不校验 → fail-closed，要求显式 --update-lock', () => {
    const root = makeRoot();
    try {
      const srcDir = join(root, 'build-output', 'lumen-cli');
      writeArtifact(srcDir);
      const { code, output } = run(root, { env: { LUMEN_SIDECAR_SRC: srcDir } });
      expect(code).toBe(1);
      expect(output).toContain('缺少锁文件');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('LUMEN_SIDECAR_SRC 可以直接指向 exe（取父目录）', () => {
    const root = makeRoot();
    try {
      withBaseline(root);
      rmSync(join(root, 'src-tauri', 'binaries'), { recursive: true, force: true });
      const srcDir = join(root, 'build-output', 'lumen-cli');
      writeArtifact(srcDir);
      const { code } = run(root, { env: { LUMEN_SIDECAR_SRC: join(srcDir, 'lumen-cli.exe') } });
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('prepare-sidecar —— --fetch', () => {
  it('无匹配公开来源时明确失败，并给出两条恢复路径', () => {
    const root = makeRoot();
    try {
      const { code, output } = run(root, { args: ['--fetch'] });
      expect(code).toBe(1);
      expect(output).toContain('没有可稳定取回的公开来源');
      expect(output).toContain('LUMEN_SIDECAR_SRC');
      expect(output).toContain('--update-lock');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('未知参数直接拒绝（不静默忽略）', () => {
    const root = makeRoot();
    try {
      const { code, output } = run(root, { args: ['--fetc'] });
      expect(code).toBe(1);
      expect(output).toContain('未知参数');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
