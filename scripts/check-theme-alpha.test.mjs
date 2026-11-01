/**
 * 主题色透明度门禁的单测（issue #15）。
 *
 * 重点不是「测门禁能跑」，而是造数据把每条判定分支**打红**：
 * 纯函数怎么解析、产物缺规则时怎么报、以及最关键的一条 ——
 * 拿仓库现状跑一遍必须红（在修复前）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCss,
  collectSourceFiles,
  extractThemeAlphaClasses,
  judgeThemeAlpha,
  ROOT,
  scanThemeAlphaUsage,
} from './check-theme-alpha.mjs';

describe('extractThemeAlphaClasses', () => {
  it('抽出主题色的透明度组合', () => {
    const groups = extractThemeAlphaClasses('<div className="bg-background-base/90" />');

    expect(groups).toEqual([{ utility: 'bg', color: 'background-base', alpha: '90' }]);
  });

  it('同一组合在一段源码里出现多次只算一次', () => {
    const groups = extractThemeAlphaClasses('bg-background-base/90 bg-background-base/90 bg-background-panel/85');

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => `${g.color}/${g.alpha}`)).toEqual([
      'background-base/90',
      'background-panel/85',
    ]);
  });

  it('不把内置色（white/black）当成检查对象', () => {
    // 内置色是字面量，天然支持 /NN；收进来只会让门禁对着已知能工作的地方空转。
    expect(extractThemeAlphaClasses('bg-white/10 bg-black/50 text-white/60')).toEqual([]);
  });

  it('认得 border / button 两族（将来开了 alpha 就该被覆盖）', () => {
    // button 的 DEFAULT 键在类名里就是 `bg-button`，不带重复的 `button-` 前缀。
    const groups = extractThemeAlphaClasses('border-border-default/40 bg-button/30 bg-button-hover/20');

    expect(groups.map((g) => g.color)).toEqual(['border-default', 'button', 'button-hover']);
  });

  it('中间带空格的写法也能认', () => {
    const groups = extractThemeAlphaClasses('className="bg-white/10  bg-background-base/70  text-xs"');

    expect(groups.map((g) => `${g.utility}-${g.color}/${g.alpha}`)).toEqual(['bg-background-base/70']);
  });
});

describe('judgeThemeAlpha', () => {
  it('产物里有对应规则即通过', () => {
    const groups = [{ utility: 'bg', color: 'background-base', alpha: '90' }];
    const css = '.bg-background-base\\/90 { background-color: rgb(var(--x) / 0.9) }';

    const verdict = judgeThemeAlpha(groups, css);

    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('1 个');
  });

  it('产物里缺规则即红，并点名是哪一个类', () => {
    const groups = [
      { utility: 'bg', color: 'background-base', alpha: '90' },
      { utility: 'bg', color: 'background-panel', alpha: '85' },
    ];
    const css = '.bg-background-base\\/90 { background-color: red }';

    const verdict = judgeThemeAlpha(groups, css);

    expect(verdict.ok).toBe(false);
    // 报错必须能直接告诉人哪一条坏了，不能只说「有 1 个失败」。
    expect(verdict.message).toContain('bg-background-panel/85');
    expect(verdict.message).not.toContain('bg-background-base/90');
    expect(verdict.message).toContain('var(--color-*)');
  });

  it('没有任何使用处时静止通过（不误伤空项目）', () => {
    expect(judgeThemeAlpha([], '').ok).toBe(true);
  });
});

describe('collectSourceFiles', () => {
  it('收 .ts/.tsx，跳过测试文件', () => {
    const files = collectSourceFiles();
    const rels = files.map((f) => f.replace(/\\/g, '/'));

    expect(rels.some((p) => p.endsWith('.tsx'))).toBe(true);
    expect(rels.every((p) => !/\.(test|spec)\.(ts|tsx)$/.test(p))).toBe(true);
    // App.tsx 一定在，作为「真的扫到了源码」的锚点。
    expect(rels.some((p) => p.endsWith('/App.tsx'))).toBe(true);
  });
});

/**
 * 拿仓库现状跑真编译。
 *
 * 这是本门禁的核心断言：**修复前必须红、修复后必须绿**。
 * 纯函数单测只能证明判定逻辑对，证明不了「真的去编译了 Tailwind」。
 */
describe('仓库现状（真编译 Tailwind）', () => {
  it('源码里所有主题色透明度类都能在产物里找到规则', async () => {
    const groups = scanThemeAlphaUsage();
    expect(groups.length).toBeGreaterThan(0);

    const css = await buildCss();
    const verdict = judgeThemeAlpha(groups, css);

    expect(verdict.ok, verdict.message).toBe(true);
  }, 60000);

  it('对照组：内置色 bg-white/10 本来就能生成（证明编译链路本身是好的）', async () => {
    const css = await buildCss();

    // 如果这条也红，说明是编译环境坏了，不是配色配置问题。
    // 用 String.raw 避免 `\\/` 在源码里被二次转义（Tailwind 产物里是单个反斜杠）。
    expect(css).toContain(String.raw`bg-white\/10`);
  }, 60000);
});

describe('令牌与配置的一致性', () => {
  it('tailwind.config.js 里出现 <alpha-value> 的颜色必须有对应的通道令牌', () => {
    const config = readFileSync(join(ROOT, 'tailwind.config.js'), 'utf8');
    const tokens = readFileSync(join(ROOT, 'src/styles/design-tokens.css'), 'utf8');

    // 抓到所有 `rgb(var(--color-xxx-rgb) / <alpha-value>)` 里的变量名。
    const used = [...config.matchAll(/rgb\(var\((--color-[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);

    for (const token of used) {
      expect(
        tokens.includes(`${token}:`),
        `${token} 被 tailwind.config.js 引用，但 design-tokens.css 里没有定义`,
      ).toBe(true);
    }
  });

  it('通道令牌必须是可解析的通道三元组，不能带 # 或 rgb()', () => {
    const tokens = readFileSync(join(ROOT, 'src/styles/design-tokens.css'), 'utf8');
    const pattern = /(--color-[a-z0-9-]+-rgb)\s*:\s*([^;]+);/g;

    const found = [...tokens.matchAll(pattern)];
    expect(found.length).toBeGreaterThan(0);

    for (const [, name, value] of found) {
      const trimmed = value.trim();
      // `rgb(var(--x) / <alpha-value>)` 要求 x 是「10 10 10」这种裸通道值。
      expect(trimmed, `${name} 必须是通道三元组，实际是 ${trimmed}`).toMatch(/^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/);
    }
  });
});
