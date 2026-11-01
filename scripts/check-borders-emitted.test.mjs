/**
 * 描边类门禁的单测（issue #18 · PD-1）。
 *
 * 重点是**每条判定分支都要能被变异打红**：
 *   - 抽取：颜色类收、宽度类/样式类/任意值不收
 *   - 判定：产物缺规则时必须红
 *   - 产物级：`judgeBorderClasses` 吃真实编译产物，写对的名字必须有规则
 *
 * 刻意**不**在这里断言「仓库现状必须红」—— 那会让这个测试文件在 PR 里
 * 表现为「修完反而红」。仓库级的红/绿由门禁脚本自己在 gates 里负责。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCss,
  extractBorderClasses,
  judgeBorderClasses,
  scanBorderUsage,
} from './check-borders-emitted.mjs';

describe('extractBorderClasses', () => {
  it('抽出主题描边颜色类', () => {
    expect(extractBorderClasses('<div className="border border-subtle" />')).toEqual(['subtle']);
  });

  it('抽出带命名空间前缀的完整类名', () => {
    // `border-border-default` 的完整键是 `border-default`（前缀 border + 键名
    // border-default），不是 `default`。这条区分是对本地门禁自身的防错。
    expect(extractBorderClasses('border-border-default border-border-strong')).toEqual([
      'border-default',
      'border-strong',
    ]);
  });

  it('不带出方位前缀后面的颜色键（border-t-subtle → subtle）', () => {
    // 方位前缀被剥掉后，`border-t-subtle` 的键是 `subtle`；而
    // `border-b-border-default` 去掉方位后仍是 `border-default`（不是 `default`）。
    expect(extractBorderClasses('border-t-subtle border-b-border-default')).toEqual([
      'subtle',
      'border-default',
    ]);
  });

  it('排除宽度类', () => {
    // 这三类都不是颜色：纯数字、方位+数字、方位+任意值
    expect(extractBorderClasses('border-2 border-r-0 border-t-[3px]')).toEqual([]);
  });

  it('排除样式类', () => {
    expect(extractBorderClasses('border-solid border-dashed border-none')).toEqual([]);
  });

  it('排除任意值表达式内部的 CSS 属性名', () => {
    // `transition-[border-color,transform]` 里的 border-color 是属性名不是类名
    expect(extractBorderClasses('transition-[border-color,transform]')).toEqual([]);
  });

  it('同一类名出现多次只算一次', () => {
    expect(extractBorderClasses('border-subtle x border-subtle y border-subtle')).toEqual([
      'subtle',
    ]);
  });
});

describe('judgeBorderClasses', () => {
  it('产物里有规则时通过', () => {
    const verdict = judgeBorderClasses(['subtle'], '.border-subtle{border-color:red}');

    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('PASS');
  });

  it('产物里没有规则时判红并指出是哪个类', () => {
    const verdict = judgeBorderClasses(['default'], '.border-subtle{border-color:red}');

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('border-default');
  });

  it('前缀相同的更长类名不算命中（防止 substring 假绿）', () => {
    // `.border-defaults` 是另一个类，不能当成 `.border-default` 存在
    const verdict = judgeBorderClasses(['default'], '.border-defaults{border-color:red}');

    expect(verdict.ok).toBe(false);
  });
});

describe('产物级：写对的名字必须真的有规则', () => {
  it('border-border-default 在编译产物里存在（这是正确写法）', async () => {
    const css = await buildCss();
    const verdict = judgeBorderClasses(['border-default'], css);

    expect(verdict.ok).toBe(true);
  });

  it('border-default（漏了命名空间前缀）在编译产物里不存在（这是缺陷形态）', async () => {
    const css = await buildCss();
    const verdict = judgeBorderClasses(['default'], css);

    expect(verdict.ok).toBe(false);
  });
});

describe('scanBorderUsage', () => {
  it('源码里不再使用漏了前缀的 border-default', () => {
    // 这是本 issue 的验收口径：修复后 src 里不应再有裸的 border-default
    const used = scanBorderUsage();
    const offenders = used.filter((u) => u.key === 'default');

    expect(offenders).toEqual([]);
  });
});
