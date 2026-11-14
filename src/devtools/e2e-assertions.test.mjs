/**
 * 期望断言集合校验纯函数单测（issue #188）。
 *
 * 真窗口 e2e 不进 CI（manual 档），本文件在没有桌面会话的阶段把判定逻辑钉住：
 * 缺一条必备断言、条件项静默跳过、互斥分支整组缺失、出现 false、低于下限都必须红。
 * 真机变异（掐 T7 下发 → `e2e:thumb` 红）留待阶段 B 令牌窗口。
 *
 * 判定纯函数在 `e2e/lib/assertions.mjs`（node 侧编排器共用，不在浏览器 bundle 里）。
 */
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_ASSERTIONS,
  evaluateExpectedAssertions,
  parseAssertionLines,
} from '../../e2e/lib/assertions.mjs';

const line = (token, value = 'true') => `001 [1.0s] >>> 断言${token} 占位描述 = ${value}`;
const skipLine = (token, reason) => `002 [1.1s] >>> 断言${token} 跳过（原因：${reason}）`;

/** 按场景必备表拼一份全 true 的齐备日志。 */
function fullLog(scenario) {
  const entry = EXPECTED_ASSERTIONS[scenario];
  const lines = [...entry.required, ...entry.conditional].map((t) => line(t));
  for (const group of entry.anyOf) lines.push(line(group[0]));
  return lines.join('\n');
}

describe('期望断言集合校验（issue #188）', () => {
  it('齐备日志：所有场景都判 ok，无缺失', () => {
    for (const scenario of Object.keys(EXPECTED_ASSERTIONS)) {
      const r = evaluateExpectedAssertions(fullLog(scenario), scenario);
      expect(r.missing, `${scenario} 必备缺失`).toEqual([]);
      expect(r.missingConditional, `${scenario} 条件缺失`).toEqual([]);
      expect(r.falseTokens, `${scenario} 含 false`).toEqual([]);
      expect(r.ok, `${scenario} 应通过`).toBe(true);
    }
  });

  it('掐掉一条必备断言 → missing 命中且 ok=false（变异网必须抓得到）', () => {
    const tokens = EXPECTED_ASSERTIONS['ui-contract'].required;
    const victim = 'G105-8';
    const log = tokens.filter((t) => t !== victim).map((t) => line(t)).join('\n');
    const r = evaluateExpectedAssertions(log, 'ui-contract');
    expect(r.missing).toContain(victim);
    expect(r.ok).toBe(false);
  });

  it('条件项：断言行与显式跳过行二选一；两者皆无 → missingConditional 红', () => {
    const withSkip = evaluateExpectedAssertions(
      [line('T1'), line('T3'), line('T4'), skipLine('T7', '未注入 expectThumb'), line('T5')].join('\n'),
      'thumb-cache',
    );
    expect(withSkip.missingConditional).toEqual([]);
    expect(withSkip.ok).toBe(true);

    const silentSkip = evaluateExpectedAssertions(
      [line('T1'), line('T3'), line('T4'), line('T5')].join('\n'),
      'thumb-cache',
    );
    expect(silentSkip.missingConditional).toEqual(['T7']);
    expect(silentSkip.ok).toBe(false);
  });

  it('互斥分支 anyOf：整组都不命中 → branchMissing 红', () => {
    const entry = EXPECTED_ASSERTIONS['render-export'];
    const base = entry.required.map((t) => line(t)).join('\n');
    const r = evaluateExpectedAssertions(base, 'render-export');
    expect(r.branchMissing.length).toBeGreaterThan(0);
    expect(r.ok).toBe(false);

    const withFirst = evaluateExpectedAssertions(
      `${base}\n${line('R6')}\n${line('R7')}`,
      'render-export',
    );
    expect(withFirst.branchHit).toEqual([true, false]);
    expect(withFirst.ok).toBe(true);
  });

  it('出现一条 false 断言 → falseTokens 命中且 ok=false', () => {
    const tokens = EXPECTED_ASSERTIONS['external-fallback'].required;
    const log = tokens.map((t) => (t === 'F2b' ? line(t, 'false') : line(t))).join('\n');
    const r = evaluateExpectedAssertions(log, 'external-fallback');
    expect(r.falseTokens).toContain('F2b');
    expect(r.ok).toBe(false);
  });

  it('低于下限 → ok=false（兜底「只剩一条也绿」）', () => {
    const r = evaluateExpectedAssertions(line('F1'), 'external-fallback');
    expect(r.parsedCount).toBe(1);
    expect(r.ok).toBe(false);
  });

  it('解析完整性：跳过行不计入 parsed，但计入 rawLines', () => {
    const { asserts, skipped, rawLines } = parseAssertionLines(
      [line('T1'), skipLine('T7', '降级'), line('T5')].join('\n'),
    );
    expect(asserts.map((a) => a.token)).toEqual(['T1', 'T5']);
    expect(skipped).toEqual(['T7']);
    expect(rawLines).toBe(3);
  });

  it('旧口径对照：缺一条时基线「解析数==出现数」仍判真，新校验必须判假', () => {
    // 复刻 run-inapp.mjs 基线逻辑（issue #188 证据：651/653/656）。
    const log = ['F1', 'F2', 'F3'].map((t) => line(t)).join('\n'); // 缺 F2b
    const legacyAsserts = [...log.matchAll(/>>> (断言\S+)[^\n]*?= (true|false)/g)];
    const legacyLines = (log.match(/>>> 断言/g) || []).length;
    const legacyOk = legacyLines > 0 && legacyAsserts.length === legacyLines;
    expect(legacyOk).toBe(true); // 基线漏报：少一条仍绿
    const r = evaluateExpectedAssertions(log, 'external-fallback');
    expect(r.missing).toContain('F2b');
    expect(r.ok).toBe(false); // 新校验钉住
  });
});
