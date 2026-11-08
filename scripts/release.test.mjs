/**
 * 发版前 e2e 闸门的单测（issue #57）。
 *
 * 为什么值得测：这个闸门坏了同样是**静默放行**——它不红，就没有任何东西提醒
 * 「这次发版没跑真窗口 e2e」，而底栏命中 / 静息收起 / 左手别名这类回归
 * （#45 / #46 / #47）只有真窗口能暴露。所以三条判定（通过放行 / 失败中止 /
 * 显式跳过留痕）都要能被单独造数据打红。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertE2eUiPassed,
  decideAssetUpload,
  decideTag,
  decideUpdaterVersion,
  E2E_UI_CMD,
  evaluateE2eUiGate,
  evaluateLatest,
  main,
  parseArgs,
  runE2eUiGate,
  sha256File,
  summarizePublish,
} from './release.mjs';

/** 造一个 execSync 同形状的桩：记录调用，按需抛带 status 的错误。 */
function stubExec({ status = 0 } = {}) {
  const calls = [];
  const exec = (cmd, opts) => {
    calls.push([cmd, opts]);
    if (status !== 0) {
      const err = new Error('e2e failed');
      err.status = status;
      throw err;
    }
  };
  return { exec, calls };
}

describe('通过放行', () => {
  it('退出码 0 判 pass，不抛错', () => {
    const verdict = assertE2eUiPassed({ exitCode: 0 });
    expect(verdict.ok).toBe(true);
    expect(verdict.kind).toBe('pass');
  });

  it('runE2eUiGate 成功时只执行一次 npm run e2e:ui，并把 cwd / env 透传下去', () => {
    const { exec, calls } = stubExec();
    const env = { PATH: 'x' };
    const verdict = runE2eUiGate({ exec, rootDir: 'C:/repo', env });
    expect(verdict.ok).toBe(true);
    expect(calls).toEqual([
      [E2E_UI_CMD, { stdio: 'inherit', cwd: 'C:/repo', env }],
    ]);
  });
});

describe('失败中止', () => {
  it('退出码 1 判真回归，下一步指向 FAIL 行与重跑，而不是让人去查环境', () => {
    const verdict = evaluateE2eUiGate({ exitCode: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.kind).toBe('regression');
    expect(verdict.message).toContain('真回归');
    expect(verdict.message).toContain('FAIL');
    expect(verdict.message).toContain('npm run e2e:ui');
    expect(() => assertE2eUiPassed({ exitCode: 1 })).toThrow(/真回归/);
  });

  it('退出码 2 判环境问题，下一步指向端口 / WebView2 / 日志', () => {
    const verdict = evaluateE2eUiGate({ exitCode: 2 });
    expect(verdict.ok).toBe(false);
    expect(verdict.kind).toBe('environment');
    expect(verdict.message).toContain('环境问题');
    expect(verdict.message).toContain('1420');
    expect(verdict.message).toContain('WebView2');
    expect(() => assertE2eUiPassed({ exitCode: 2 })).toThrow(/环境问题/);
  });

  it('未知退出码按失败处理，不静默放行', () => {
    const verdict = evaluateE2eUiGate({ exitCode: 7 });
    expect(verdict.ok).toBe(false);
    expect(verdict.kind).toBe('unknown');
    expect(verdict.message).toContain('7');
  });

  it('命令抛错时把 err.status 交给判定并中止（不是吞掉继续打包）', () => {
    const { exec } = stubExec({ status: 1 });
    expect(() => runE2eUiGate({ exec, rootDir: '.', env: {} })).toThrow(/真回归/);
  });
});

describe('显式跳过留痕', () => {
  it('SKIP_E2E=1 不执行命令，但必须打印含 SKIP_E2E 与「跳过」的警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { exec, calls } = stubExec();
    const verdict = runE2eUiGate({ exec, rootDir: '.', env: { SKIP_E2E: '1' } });

    expect(verdict.ok).toBe(true);
    expect(verdict.skipped).toBe(true);
    expect(calls).toEqual([]);

    const text = warn.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(text).toContain('SKIP_E2E');
    expect(text).toContain('跳过');
  });

  it('只有 SKIP_E2E=1 才算跳过，其他值照常执行', () => {
    const { exec, calls } = stubExec();
    runE2eUiGate({ exec, rootDir: '.', env: { SKIP_E2E: '0' } });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(E2E_UI_CMD);
  });
});

describe('main —— e2e 失败即中止，updater.json 不落盘', () => {
  it('只调一次 e2e、不进签名构建、不产出 updater.json', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
    try {
      fs.mkdirSync(path.join(rootDir, 'src-tauri'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, 'src-tauri', 'tauri.conf.json'),
        JSON.stringify({ version: '9.9.9', productName: 'gallery-culling' }),
        'utf8',
      );

      const { exec, calls } = stubExec({ status: 1 });
      await expect(main({ rootDir, exec, env: {} })).rejects.toThrow(/真回归/);

      expect(calls.map((c) => c[0])).toEqual([E2E_UI_CMD]);
      expect(fs.existsSync(path.join(rootDir, 'updater.json'))).toBe(false);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

/**
 * `--publish` 全链模式（issue #83）。
 *
 * 为什么值得测：这条链一旦半途放行，症状是「脚本 exit 0、版本却没发出去」——
 * 正是 issue 里描述的「每次发版都卡住」。所以每个判定都要能被单独造数据打红：
 * tag 冲突 / 资产 digest 不一致 / latest 没指向本版本。
 */

/** 造一次发版的最小磁盘现场：tauri.conf.json + 假 setup.exe + 假 .sig + 假私钥。 */
function makeReleaseFixture({ version = '9.9.9', productName = 'gallery-culling' } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-publish-'));
  fs.mkdirSync(path.join(rootDir, 'src-tauri'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({ version, productName }),
    'utf8',
  );
  fs.writeFileSync(path.join(rootDir, 'updater.key'), 'FAKE-KEY', 'utf8');
  const nsisDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  fs.mkdirSync(nsisDir, { recursive: true });
  const setupExe = path.join(nsisDir, `${productName}_${version}_x64-setup.exe`);
  fs.writeFileSync(setupExe, 'FAKE-BINARY', 'utf8');
  fs.writeFileSync(`${setupExe}.sig`, 'FAKE-SIG', 'utf8');
  return { rootDir, setupExe };
}

/** `--publish` 编排用的 exec 桩：按命令返回预置 stdout，并记录原始命令。 */
function stubPublishExec({ setupExe, tagLookup = 'absent', existingTagSha = null }) {
  const calls = [];
  const digest = sha256File(setupExe);
  const assets = [{ name: path.basename(setupExe), size: fs.statSync(setupExe).size, digest }];
  let lookupCount = 0;
  const exec = (cmd) => {
    calls.push(cmd);
    if (cmd === E2E_UI_CMD || cmd === 'npm run tauri build') return '';
    if (cmd === 'git status --porcelain updater.json') return ' M updater.json';
    if (cmd === 'git add updater.json' || cmd.startsWith('git commit ')) return '';
    if (cmd === 'git push origin master') return '';
    if (cmd === 'git rev-parse HEAD') return 'abc1234567';
    if (cmd.startsWith('git tag --list ')) return existingTagSha ? 'v9.9.9' : '';
    if (cmd.startsWith('git rev-list -n1 ')) return existingTagSha;
    if (cmd.startsWith('git tag -a ') || cmd.startsWith('git push origin v')) return '';
    if (cmd === 'gh repo view --json nameWithOwner --jq .nameWithOwner') {
      return 'ID-VerNe/gallery-culling';
    }
    // 建 Release 前的存在性探测：只有「本就没有 Release」这一档才抛 404。
    if (/\/releases\/tags\/v9\.9\.9$/.test(cmd)) {
      lookupCount += 1;
      if (tagLookup === 'absent' && lookupCount === 1) {
        const err = new Error('HTTP 404: Not Found');
        err.status = 1;
        throw err;
      }
      return JSON.stringify({
        id: 7,
        draft: tagLookup === 'absent',
        html_url: 'https://github.com/ID-VerNe/gallery-culling/releases/tag/v9.9.9',
        assets,
      });
    }
    if (cmd.startsWith('gh api -X POST ') && cmd.includes('/releases ')) {
      return JSON.stringify({ id: 7, draft: true, assets: [] });
    }
    if (cmd.includes('/releases/7/assets')) return '[]';
    if (cmd.startsWith('gh release upload ')) return '';
    if (cmd.startsWith('gh api -X PATCH ')) return JSON.stringify({ id: 7, draft: false });
    if (cmd === 'gh api repos/ID-VerNe/gallery-culling/releases/latest --jq .tag_name') {
      return 'v9.9.9';
    }
    throw new Error(`桩未覆盖的命令: ${cmd}`);
  };
  return { exec, calls };
}

describe('parseArgs —— 只有 --publish 打开全链', () => {
  it('默认不带 --publish', () => {
    expect(parseArgs([])).toEqual({ publish: false });
    expect(parseArgs(['--gates'])).toEqual({ publish: false });
  });

  it('识别 --publish，且不吞掉其他参数', () => {
    expect(parseArgs(['--publish'])).toEqual({ publish: true });
    expect(parseArgs(['--publish', '--verbose'])).toEqual({ publish: true });
  });
});

describe('decideUpdaterVersion —— 拒绝把旧清单发进新 Release', () => {
  it('一致时返回 tag', () => {
    expect(decideUpdaterVersion({ confVersion: '2.0.9', updaterVersion: 'v2.0.9' })).toBe('v2.0.9');
  });

  it('不一致即中止，文案指明下一步', () => {
    expect(() =>
      decideUpdaterVersion({ confVersion: '2.0.10', updaterVersion: 'v2.0.9' }),
    ).toThrow(/不一致/);
  });
});

describe('decideTag —— 已发出的 tag 不被重写', () => {
  it('远端没有 tag → create', () => {
    expect(decideTag({ existingTagSha: null, updaterSha: 'abc' })).toEqual({ action: 'create' });
  });

  it('已存在且指向同一提交 → exists（幂等重跑不重复打 tag）', () => {
    expect(decideTag({ existingTagSha: 'abc', updaterSha: 'abc' })).toEqual({ action: 'exists' });
  });

  it('已存在但指向别的提交 → 中止，不挪 tag', () => {
    expect(() => decideTag({ existingTagSha: 'def', updaterSha: 'abc' })).toThrow(/tag 已存在/);
  });
});

describe('decideAssetUpload —— 同名资产按 digest 判定', () => {
  it('远端没有同名资产 → upload', () => {
    expect(
      decideAssetUpload({ existingAssets: [], assetName: 'x.exe', localDigest: 'sha256:aaa' }),
    ).toEqual({ action: 'upload' });
  });

  it('digest 一致 → skip（重跑不重复上传）', () => {
    expect(
      decideAssetUpload({
        existingAssets: [{ name: 'x.exe', digest: 'sha256:AAA' }],
        assetName: 'x.exe',
        localDigest: 'sha256:aaa',
      }),
    ).toEqual({ action: 'skip' });
  });

  it('digest 不一致 → 中止（同名资产不能覆盖）', () => {
    expect(() =>
      decideAssetUpload({
        existingAssets: [{ name: 'x.exe', digest: 'sha256:bbb' }],
        assetName: 'x.exe',
        localDigest: 'sha256:aaa',
      }),
    ).toThrow(/digest 不一致/);
  });
});

describe('evaluateLatest —— latest 必须指向本版本', () => {
  it('指向本版本 → ok', () => {
    const verdict = evaluateLatest({ latestTag: 'v9.9.9', tag: 'v9.9.9' });
    expect(verdict.ok).toBe(true);
    expect(verdict.match).toBe(true);
  });

  it('指向别的版本 / 不可得 → 不 ok，文案说明 Release 可能仍是 draft', () => {
    const verdict = evaluateLatest({ latestTag: 'v9.9.8', tag: 'v9.9.9' });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('draft');
    expect(evaluateLatest({ latestTag: '', tag: 'v9.9.9' }).ok).toBe(false);
  });
});

describe('summarizePublish —— 结构化终态', () => {
  const base = {
    version: '2.0.10',
    tag: 'v2.0.10',
    commitSha: 'abc1234def',
    releaseUrl: 'https://github.com/ID-VerNe/gallery-culling/releases/tag/v2.0.10',
    assetName: 'gallery-culling_2.0.10_x64-setup.exe',
    assetSize: 100,
    localDigest: 'sha256:AAA',
    remoteDigest: 'sha256:aaa',
    latestTag: 'v2.0.10',
  };

  it('全部对上 → status=PUBLISHED，且每个字段都是一行 key=value', () => {
    const text = summarizePublish(base);
    expect(text).toContain('version=v2.0.10');
    expect(text).toContain('tag=v2.0.10 -> abc1234');
    expect(text).toContain(`release=${base.releaseUrl}`);
    expect(text).toContain('digest=sha256:aaa match=yes');
    expect(text).toContain('latest=v2.0.10 match=yes');
    expect(text).toContain('status=PUBLISHED');
  });

  it('digest 或 latest 任意一项不符 → status=FAILED（不伪装成功）', () => {
    expect(summarizePublish({ ...base, remoteDigest: 'sha256:bbb' })).toContain('status=FAILED');
    expect(summarizePublish({ ...base, latestTag: 'v2.0.9' })).toContain('status=FAILED');
  });

  it('失败路径由调用方显式传 status=FAILED，不被派生值翻绿', () => {
    expect(summarizePublish({ ...base, status: 'FAILED' })).toContain('status=FAILED');
  });
});

describe('main —— 默认模式不碰 git / gh', () => {
  it('只跑 e2e 与签名构建，updater.json 照常落盘', async () => {
    const { rootDir } = makeReleaseFixture();
    try {
      const { exec, calls } = stubExec();
      await main({ rootDir, exec, env: {} });
      expect(calls.map((c) => c[0])).toEqual([E2E_UI_CMD, 'npm run tauri build']);
      expect(fs.existsSync(path.join(rootDir, 'updater.json'))).toBe(true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('main —— --publish 全链', () => {
  it('提交 → push → tag → 建 Release → 传资产 → 发布 → 复核，末尾打印 status=PUBLISHED', async () => {
    const { rootDir, setupExe } = makeReleaseFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { exec, calls } = stubPublishExec({ setupExe, tagLookup: 'absent' });
      await main({ rootDir, exec, env: { RELEASE_NOTES: '本次发版说明' }, argv: ['--publish'] });

      expect(calls).toContain('git add updater.json');
      expect(calls).toContain('git commit -m "chore(release): update updater.json for v9.9.9"');
      expect(calls).toContain('git push origin master');
      expect(calls).toContain('git tag -a v9.9.9 -m "v9.9.9" abc1234567');
      expect(calls).toContain('git push origin v9.9.9');
      expect(calls.some((cmd) => cmd.startsWith('gh api -X POST ') && cmd.includes('/releases '))).toBe(
        true,
      );
      expect(calls.some((cmd) => cmd.startsWith('gh release upload v9.9.9 '))).toBe(true);
      expect(calls).toContain('gh api -X PATCH repos/ID-VerNe/gallery-culling/releases/7 -F draft=false');
      expect(calls).toContain('gh api repos/ID-VerNe/gallery-culling/releases/latest --jq .tag_name');

      const text = log.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(text).toContain('status=PUBLISHED');
      expect(text).toContain('tag=v9.9.9 -> abc1234');
    } finally {
      log.mockRestore();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('tag 已存在却指向别的提交 → 中止，打印 status=FAILED stage=tag，且一个 gh 命令都不发', async () => {
    const { rootDir, setupExe } = makeReleaseFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { exec, calls } = stubPublishExec({
        setupExe,
        tagLookup: 'exists',
        existingTagSha: 'deadbeef00',
      });
      await expect(
        main({ rootDir, exec, env: {}, argv: ['--publish'] }),
      ).rejects.toThrow(/tag 已存在/);

      const text = log.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(text).toContain('status=FAILED');
      expect(text).toContain('stage=tag');
      expect(calls.some((cmd) => cmd.startsWith('gh '))).toBe(false);
    } finally {
      log.mockRestore();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
