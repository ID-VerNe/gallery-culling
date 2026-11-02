import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkVersions, collectVersions, judgeVersions } from './check-version-sync.mjs';

const pkgAt = (version) => JSON.stringify({ name: 'gallery-culling', version });
const lockAt = (version) => JSON.stringify({ name: 'gallery-culling', version, packages: { '': { version } } });
const tauriAt = (version) => JSON.stringify({ productName: 'gallery-culling', version });

describe('collectVersions —— 四处版本都得取到', () => {
  it('三份文件里的四个位置全部进比对', () => {
    const { versions, problems } = collectVersions({
      pkg: pkgAt('2.0.4'),
      lock: lockAt('2.0.4'),
      tauri: tauriAt('2.0.4'),
    });
    expect(problems).toEqual([]);
    expect(versions.map((item) => item.version)).toEqual(['2.0.4', '2.0.4', '2.0.4', '2.0.4']);
  });

  it('lock 只改顶层 version、packages[""] 仍落后时，落后那处照样被看见', () => {
    // 只查一处会让「只改了一半」的 lock 绿过去，而这正是 issue #23 的形态。
    const lock = JSON.stringify({ version: '2.0.4', packages: { '': { version: '2.0.0' } } });
    const { versions } = collectVersions({ pkg: pkgAt('2.0.4'), lock, tauri: tauriAt('2.0.4') });
    expect(judgeVersions({ versions, problems: [] }).ok).toBe(false);
  });

  it('文件不是合法 JSON 时收进 problems，而不是抛出去', () => {
    const { problems } = collectVersions({ pkg: '{', lock: lockAt('2.0.4'), tauri: tauriAt('2.0.4') });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('package.json');
  });

  it('版本字段不是字符串（例如被写成数字）时也算取不到', () => {
    const { problems } = collectVersions({
      pkg: JSON.stringify({ version: 204 }),
      lock: lockAt('2.0.4'),
      tauri: tauriAt('2.0.4'),
    });
    expect(problems[0]).toContain('package.json');
  });
});

describe('judgeVersions —— 不一致要点名是哪一份', () => {
  it('全部一致 → 绿', () => {
    const result = judgeVersions({
      versions: [
        { label: 'package.json', version: '2.0.4' },
        { label: 'src-tauri/tauri.conf.json', version: '2.0.4' },
      ],
      problems: [],
    });
    expect(result.ok).toBe(true);
  });

  it('不一致 → 红，且每条来源都列出来（只说「不一致」读者还得自己找）', () => {
    const result = judgeVersions({
      versions: [
        { label: 'package.json', version: '2.0.4' },
        { label: 'package-lock.json 的 version', version: '2.0.0' },
      ],
      problems: [],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('2.0.4');
    expect(result.message).toContain('2.0.0');
    expect(result.message).toContain('package-lock.json 的 version');
  });

  it('取不到版本时直接红，不拿半份数据判一致', () => {
    const result = judgeVersions({
      versions: [{ label: 'package.json', version: '2.0.4' }],
      problems: ['src-tauri/tauri.conf.json 里取不到字符串型版本号'],
    });
    expect(result.ok).toBe(false);
  });
});

describe('checkVersions —— 读盘这一层', () => {
  const setup = ({ pkg, lock, tauri }) => {
    const root = mkdtempSync(join(tmpdir(), 'gallery-version-'));
    mkdirSync(join(root, 'src-tauri'));
    if (pkg !== undefined) writeFileSync(join(root, 'package.json'), pkg);
    if (lock !== undefined) writeFileSync(join(root, 'package-lock.json'), lock);
    if (tauri !== undefined) writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), tauri);
    return root;
  };

  it('三份一致 → 绿', () => {
    const root = setup({ pkg: pkgAt('2.0.4'), lock: lockAt('2.0.4'), tauri: tauriAt('2.0.4') });
    try {
      expect(checkVersions({ root }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('缺 tauri.conf.json 时判红并点名——文件消失也要被看见', () => {
    const root = setup({ pkg: pkgAt('2.0.4'), lock: lockAt('2.0.4') });
    try {
      const result = checkVersions({ root });
      expect(result.ok).toBe(false);
      expect(result.message).toContain('tauri.conf.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
