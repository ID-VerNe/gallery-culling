/**
 * 发版前 e2e 闸门的单测（issue #57）。
 *
 * 为什么值得测：这个闸门坏了同样是**静默放行**——它不红，就没有任何东西提醒
 * 「这次发版没跑真窗口 e2e」，而底栏命中 / 静息收起 / 左手别名这类回归
 * （#45 / #46 / #47）只有真窗口能暴露。所以三条判定（通过放行 / 失败中止 /
 * 显式跳过留痕）都要能被单独造数据打红。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertE2eUiPassed,
  E2E_UI_CMD,
  evaluateE2eUiGate,
  main,
  runE2eUiGate,
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
