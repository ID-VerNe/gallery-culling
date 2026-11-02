/**
 * parity 的收尾顺序（issue #26）。
 *
 * 2026-11-02 实测的故障：干净检出里的 `node_modules` 是**指向调用方**的目录联接，
 * 收尾若先 `git worktree remove --force`（或 `rmSync(recursive)`），删除器会跟进重解析点，
 * 把调用方 `node_modules` 的内容清空、只留下空的联接。之后每次 parity 都在空依赖上跑，
 * 而退出码仍是 0 —— 看不出任何异常。
 *
 * 这条用例锁的是**顺序**，不是「有没有调用 unlinkModules」：把两步对调，
 * 现有全部用例照样绿，故障照样复发。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkModules, probeContents, removeWorktree, unlinkModules } from './check-pr-parity.mjs';

describe('removeWorktree —— 先摘链接，再删目录', () => {
  it('调用顺序是 unlink → remove → prune', () => {
    const calls = [];
    const steps = {
      unlink: (path) => calls.push(['unlink', path]),
      remove: (path) => calls.push(['remove', path]),
      prune: () => calls.push(['prune']),
    };
    removeWorktree('/tmp/pristine', steps);
    expect(calls).toEqual([
      ['unlink', '/tmp/pristine'],
      ['remove', '/tmp/pristine'],
      ['prune'],
    ]);
  });

  it('unlink 抛错时不删目录（宁可留着现场也不掏空目标）', () => {
    const calls = [];
    const steps = {
      unlink: () => {
        throw new Error('lstat 失败');
      },
      remove: () => calls.push('remove'),
      prune: () => calls.push('prune'),
    };
    expect(() => removeWorktree('/tmp/pristine', steps)).toThrow('lstat 失败');
    expect(calls).toEqual([]);
  });
});

describe('unlinkModules —— 只摘重解析点，不碰目标内容', () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'gallery-unlink-'));

  it('链接被摘掉，链接指向的目录内容原封不动', () => {
    const root = scratch();
    try {
      const source = join(root, 'node_modules');
      mkdirSync(source);
      writeFileSync(join(source, 'keep.txt'), 'x');
      const pristine = join(root, 'pristine');
      mkdirSync(pristine);
      // windows 上 linkModules 造的就是 junction，这里直接造同样的结构。
      symlinkSync(source, join(pristine, 'node_modules'), 'junction');

      unlinkModules(pristine);

      expect(existsSync(join(pristine, 'node_modules'))).toBe(false);
      expect(existsSync(join(source, 'keep.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('不是链接的普通目录不碰（那不是我们造的）', () => {
    const root = scratch();
    try {
      const pristine = join(root, 'pristine');
      mkdirSync(join(pristine, 'node_modules'), { recursive: true });
      writeFileSync(join(pristine, 'node_modules', 'real.txt'), 'x');

      unlinkModules(pristine);

      expect(lstatSync(join(pristine, 'node_modules')).isSymbolicLink()).toBe(false);
      expect(existsSync(join(pristine, 'node_modules', 'real.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('node_modules 不存在时静默返回', () => {
    const root = scratch();
    try {
      expect(() => unlinkModules(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('probeContents —— 探针跟清单走，不写死包名', () => {
  it('每条「node 跑 node_modules 入口」的门禁各贡献一个路径，去重且排序', () => {
    expect(
      probeContents({
        ci: [
          { cmd: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'] },
          { cmd: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'] },
          { cmd: ['node', 'node_modules/vitest/vitest.mjs', 'run'] },
          { cmd: ['node', 'scripts/check-theme-alpha.mjs'] },
          { cmd: ['cargo', 'test', '--lib'] },
        ],
      }),
    ).toEqual(['node_modules/typescript/bin/tsc', 'node_modules/vitest/vitest.mjs']);
  });
});

describe('linkModules —— 依赖没装齐时不接进去', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'gallery-link-'));
    const source = join(root, 'source');
    const pristine = join(root, 'pristine');
    mkdirSync(source);
    mkdirSync(pristine);
    return { root, source, pristine };
  };

  it('探针文件都在 → 链接成功（Windows 上走 junction）', () => {
    const { root, source, pristine } = setup();
    try {
      mkdirSync(join(source, 'real'), { recursive: true });
      writeFileSync(join(source, 'real', 'entry.mjs'), '');
      const link = linkModules(pristine, source, 'win32', ['real/entry.mjs']);
      expect(link).toEqual({ linked: true, reason: null });
      expect(lstatSync(join(pristine, 'node_modules')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('探针文件缺一个就判没装齐，并把缺的那个点名', () => {
    // 这条锁的是**按清单探**而不是写死一个包名：写死 postcss 时，
    // 换掉清单里的 tsc 入口这条用例照样绿，而真实缺的是 tsc。
    const { root, source, pristine } = setup();
    try {
      mkdirSync(join(source, 'real'), { recursive: true });
      writeFileSync(join(source, 'real', 'entry.mjs'), '');
      const link = linkModules(pristine, source, 'win32', ['real/entry.mjs', 'gone/tsc']);
      expect(link.linked).toBe(false);
      expect(link.reason).toContain('gone/tsc');
      expect(existsSync(join(pristine, 'node_modules'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('推不出任何探针时不假装验过（空清单也是 fail-closed）', () => {
    const { root, source, pristine } = setup();
    try {
      const link = linkModules(pristine, source, 'win32', []);
      expect(link.linked).toBe(false);
      expect(link.reason).toContain('推不出');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('干净检出里已经躺着 node_modules 时不接（那已经不是 CI 的形态）', () => {
    const { root, source, pristine } = setup();
    try {
      mkdirSync(join(pristine, 'node_modules'));
      const link = linkModules(pristine, source, 'win32', ['whatever']);
      expect(link.linked).toBe(false);
      expect(link.reason).toContain('gitignore');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
