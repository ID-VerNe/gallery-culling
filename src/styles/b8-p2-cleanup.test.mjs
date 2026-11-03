/**
 * B8 P2 收敛的结构契约（issue #18）。
 *
 * jsdom 钉不了视觉（tracking 字距、ring vs 底色的悬停观感、crash 页配色）——
 * 这些进 needs-live-verify。这里钉的是**语义结构**：审计点名的违规位迁移、
 * 死令牌删除、死代码删除、reduced-motion 白名单不再漏。
 *
 * 覆盖 finding：PC-5 / PC-9 / PC-10 / PC-11 / PC-12 / PD-5 / PD-10 / PD-11 / PB-11 / PA-8。
 * PB-2 / PB-5（P1 缓动）与 PC-8 / PA-7 / PB-11 presence / PB-12（需真机或 feature）
 * 不在本批，分别走 B9 与 follow-up。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readSrc(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('B8 P2 收敛（issue #18）', () => {
  describe('PC-5 / PC-9 / PC-10 字距与等宽数字', () => {
    it('index.css @layer base 给 h1/h2 兜底负字距（大字不散）', () => {
      const css = readSrc('src/index.css');
      // 兜底规则须落在 @layer base 里，且 letter-spacing 为负值。
      expect(css).toMatch(/@layer base[^]*?h1,?\s*h2\s*\{[^]*?letter-spacing:\s*-0\.0\d+em[^]*?\}/s);
    });

    it('LrcatDialog 三处统计数字带 tabular-nums + 负字距（切换目录不横向跳）', () => {
      const lrcat = readSrc('src/components/LrcatDialog.tsx');
      // 三个统计 div 都是 text-lg font-medium，应统一带 tabular-nums 与 tracking。
      const matches = lrcat.match(/text-lg font-medium[^'"]*/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(3);
      for (const m of matches) {
        expect(m).toContain('tabular-nums');
        expect(m).toMatch(/tracking-\[-0\.0\d+em\]/);
      }
    });

    it('ThumbnailGrid 「已选 N」span 带 tabular-nums（实时随 Ctrl+点击变化，比命中数更需要等宽）', () => {
      const grid = readSrc('src/components/ThumbnailGrid.tsx');
      expect(grid).toContain('已选 {activeIds.size}');
      // 「已选」所在 span 应含 tabular-nums。
      const sel = grid.match(/[^]*已选 \{activeIds\.size\}/s);
      expect(sel).not.toBeNull();
      // 取「已选」前 80 字符内的 span 开标签，看是否带 tabular-nums。
      const before = sel[0].slice(-80);
      expect(before).toContain('tabular-nums');
    });

    it('BottomBar 文件名容器带 tabular-nums（切换照片整行不横向抖动）', () => {
      const bb = readSrc('src/components/BottomBar.tsx');
      // 文件名容器是 `flex items-center gap-1.5 font-mono ... min-w-0`，审计原
      // 证据缺 tabular-nums。取该 className 串断言含 tabular-nums。
      const fileRow = bb.match(/flex items-center gap-1\.5 font-mono[^'"]*/);
      expect(fileRow).not.toBeNull();
      expect(fileRow[0]).toContain('tabular-nums');
    });
  });

  describe('PC-11 星标符号去掉误用的 tracking-tight', () => {
    it('XmpConflictDialog 的星标 span 不再挂 tracking-tight', () => {
      const xmp = readSrc('src/components/XmpConflictDialog.tsx');
      const starsSpan = xmp.match(/<span[^>]*>\{stars\([^}]*\)\}<\/span>/);
      expect(starsSpan).not.toBeNull();
      expect(starsSpan[0]).not.toContain('tracking-tight');
    });
  });

  describe('PC-12 视口导航箭头悬停用环而非更实的底', () => {
    // 导航箭头是 rounded-full 的左右按钮。取完整双引号 className 串逐个核。
    function navArrowClassNames(source) {
      return [...source.matchAll(/"([^"]*rounded-full[^"]*)"/g)].map((m) => m[1]);
    }

    it('PreviewViewport 左右导航箭头 hover 走 ring，不再 hover:bg-background-base/90', () => {
      const arrows = navArrowClassNames(readSrc('src/components/PreviewViewport.tsx'));
      expect(arrows.length).toBeGreaterThanOrEqual(2);
      for (const a of arrows) {
        expect(a).not.toContain('hover:bg-background-base/90');
        expect(a).toContain('hover:ring');
      }
    });

    it('SplitCompareViewport 左右导航箭头 hover 走 ring，不再 hover:bg-background-base/90', () => {
      const arrows = navArrowClassNames(readSrc('src/components/SplitCompareViewport.tsx'));
      expect(arrows.length).toBeGreaterThanOrEqual(2);
      for (const a of arrows) {
        expect(a).not.toContain('hover:bg-background-base/90');
        expect(a).toContain('hover:ring');
      }
    });
  });

  describe('PD-5 删除零使用的死令牌', () => {
    it('design-tokens.css 不再定义 --color-bg-button / --color-bg-button-hover / --color-border-strong', () => {
      const tokens = readSrc('src/styles/design-tokens.css');
      expect(tokens).not.toContain('--color-bg-button:');
      expect(tokens).not.toContain('--color-bg-button-hover:');
      expect(tokens).not.toContain('--color-border-strong:');
    });

    it('tailwind.config.js 不再映射 button 命名空间与 border.strong', () => {
      const cfg = readSrc('tailwind.config.js');
      // 删的是映射值：`strong: 'var(--color-border-strong)'` 与 `button: {...}`。
      // 用带引号的 var 引用断言，避开注释里的中文「strong/button」字样。
      expect(cfg).not.toContain('var(--color-border-strong)');
      expect(cfg).not.toContain('var(--color-bg-button)');
      expect(cfg).not.toContain('var(--color-bg-button-hover)');
    });

    it('index.css prefers-contrast 段不再覆盖已删的 --color-border-strong', () => {
      const css = readSrc('src/index.css');
      expect(css).not.toContain('--color-border-strong:');
    });
  });

  describe('PD-10 ErrorBoundary 改用设计令牌', () => {
    it('ErrorBoundary 不再用 neutral-* 调色板，改走令牌', () => {
      const eb = readSrc('src/components/ErrorBoundary.tsx');
      expect(eb).not.toContain('bg-neutral-');
      expect(eb).not.toContain('text-neutral-');
      expect(eb).toContain('bg-background-base');
    });
  });

  describe('PD-11 reduced-motion 白名单改通配，不再漏 active:scale-[0.99]', () => {
    it('index.css reduced-motion 段用通配 [class*=active:scale-] 而非逐个列举', () => {
      const css = readSrc('src/index.css');
      // 通配规则：[class*="active:scale-"]:active
      expect(css).toContain('[class*="active:scale-"]:active');
      // PD-11 关切点是「列举式必然漏」——通配兜住后，旧的逐个列举可以保留作
      // 历史对照（且补了 active:scale-[0.99] 这条原先漏的）。本断言只验通配
      // 已落盘，不强删旧列举（删了反而让旧变体在通配之外失去显式记录）。
    });

    it('reduced-motion 列举版补上了原先漏的 active:scale-[0.99]', () => {
      const css = readSrc('src/index.css');
      // AlbumDialog 用 active:scale-[0.99]（PD-11 证据），降级段应显式覆盖它。
      expect(css).toContain('active\\:scale-\\[0\\.99\\]:active');
    });
  });

  describe('PB-11 删 ToastRow 上的死 transition-opacity', () => {
    it('ToastViewport 的 ToastRow 容器不再挂 transition-opacity（该 div 无 opacity 变体，是死代码）', () => {
      const tv = readSrc('src/components/ToastViewport.tsx');
      // ToastRow 的根 div className 模板串里不应再有 transition-opacity。
      // 关闭按钮自身仍用 transition-opacity（那是活的），只验根 div。
      const rowDiv = tv.match(/<div\s+key=\{toast\.id\}\s+className=\{`([^`]*)`/);
      expect(rowDiv).not.toBeNull();
      expect(rowDiv[1]).not.toContain('transition-opacity');
    });
  });

  describe('PA-8 BAR_HIT_AREA 去掉圆角（透明命中层不该有形）', () => {
    it('viewportBarStyles 的 BAR_HIT_AREA 不再含 rounded-xl', () => {
      const vbs = readSrc('src/components/viewportBarStyles.ts');
      const hit = vbs.match(/BAR_HIT_AREA\s*=\s*['"]([^'"]*)/);
      expect(hit).not.toBeNull();
      expect(hit[1]).not.toContain('rounded-xl');
      expect(hit[1]).not.toMatch(/\brounded\b/);
    });
  });
});
