/**
 * 禁用态 hover 全局复位 + opacity 收敛（issue #18 · B5 · PD-2）。
 *
 * ## 防的是什么
 *
 * 70 处 `disabled` 按钮里只有 3 处带 `disabled:hover:` 复位。典型
 * `BottomBar.tsx:199` 写的是 `hover:bg-white/15 ... disabled:bg-background-surface-hover`——
 * `disabled` 时 `hover` 仍生效并覆盖 `disabled:bg`，禁用按钮被悬停时**变亮**。
 *
 * 修法是在 `src/index.css` 的 `@layer components` 加一条全局
 * `button:disabled { pointer-events: none; }`：禁用按钮完全不接收指针事件，
 * hover 永不触发。前置确认：本仓库禁用按钮的说明已按 AGENTS.md 要求常驻
 * footer（`BatchExportModal.tsx:170` 明文「footer 左侧是唯一的状态说明位」），
 * 不依赖 hover tooltip，所以 `pointer-events: none` 安全。
 *
 * ## 为什么用 CSS 文本断言而不是 computed style
 *
 * jsdom 不解析 `@layer` + 全局选择器的级联，`getComputedStyle(btn).pointerEvents`
 * 在 jsdom 下拿不到 `none`（实测）。把规则挪出 `@layer` 只为凑 computed-style
 * 断言会改变级联优先级，是实质性改动，不做。退回「CSS 文本断言」——门禁能钉
 * 「规则落盘了」，钉不了「按下禁用按钮时视觉确实不变亮」，后者进 needs-live-verify。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '..', 'index.css');
const css = readFileSync(cssPath, 'utf8');

function walkTsx(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkTsx(p));
    else if (e.endsWith('.tsx') || e.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('B5 · 禁用态 hover 全局复位（issue #18 · PD-2）', () => {
  it('src/index.css 的 @layer components 内含 button:disabled { pointer-events: none }', () => {
    // 规则必须落在 @layer components 里——挪出去会改变级联优先级。
    // 注意 String.search 不接受 start 参数，用 slice(1).search 再 +1 还原位置。
    const firstLayer = css.indexOf('@layer components');
    expect(firstLayer).toBeGreaterThan(-1);

    const afterFirstLayer = css.slice(firstLayer);
    const nextBoundary = afterFirstLayer.slice(1).search(/@(?:layer|media)\b/);
    const layerBody =
      nextBoundary === -1 ? afterFirstLayer : afterFirstLayer.slice(0, nextBoundary + 1);

    expect(layerBody).toMatch(/button:disabled\s*\{/);
    expect(layerBody).toMatch(/pointer-events:\s*none/);
  });

  it('button:disabled 规则内 pointer-events 值为 none（同一规则块里）', () => {
    // 更强的断言：在 button:disabled { ... } 这一个规则块里就含 pointer-events: none，
    // 不只是「同 layer 内某处有 pointer-events: none」。变异把 none 改成 auto 会红。
    expect(css).toMatch(/button:disabled\s*\{[^}]*pointer-events:\s*none[^}]*\}/);
  });

  it('禁用按钮的说明不依赖 hover tooltip：扫描全仓无 Tooltip 组件（排除测试自身）', () => {
    // 这是 B5 安全性的前置：本仓库禁用按钮的关键说明都已常驻 footer 或
    // aria-label，pointer-events:none 不会让任何「只在 hover 时才显示的关键
    // 说明」消失。这条断言钉住「扫描结论」——以后若有人引入 <Tooltip> 组件
    // 并把它绑给禁用按钮，这里转红，强制回到 footer 常驻说明的约定。
    const files = walkTsx(resolve(here, '..')).filter((f) => !/\.test\./.test(f));
    const tooltipComponent = files.some((f) => /<Tooltip[\s>]/.test(readFileSync(f, 'utf8')));
    expect(tooltipComponent).toBe(false);
  });
});

describe('B5 · opacity 收敛两档（issue #18 · PD-2）', () => {
  it('src 下不再出现 disabled:opacity-50（收敛到 40 / 60 两档）', () => {
    const files = walkTsx(resolve(here, '..'));
    const offenders = [];
    for (const f of files) {
      if (/\.test\./.test(f)) continue;
      const src = readFileSync(f, 'utf8');
      if (/disabled:opacity-50/.test(src)) {
        offenders.push(f.replace(/\\/g, '/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
