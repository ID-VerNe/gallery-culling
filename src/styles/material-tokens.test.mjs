/**
 * 材质三档令牌的结构契约（issue #18 · PC-1 + PC-3）。
 *
 * jsdom 钉不了「2% 与 10% 肉眼可辨」「透明静息与白底静息的视觉差」——这些
 * 进 needs-live-verify。这里钉的是**语义结构**：令牌落盘、硬编码色消失、
 * 审计点名的违规位迁移到对应的档位。
 *
 * 三档（审计 PC-1 建议）：
 *  - 结构容器 → bg-background-surface（2% 令牌，与交互层的白底解耦）
 *  - 可交互静息 → bg-transparent + hover:bg-white/NN（跨视口同动词同材质）
 *  - 选中 → 既有语义色（Pick=emerald / Reject=rose）或中性 white/15（徽章），
 *    本批不回填既有 toggle 的选中态（视觉改动留 B8 真机回签）
 *
 * Toast 的 #1c1c1c 是全仓唯一硬编码色值（PC-3 证据），绕过令牌与
 * prefers-contrast: more 的 :root 覆盖——这里钉它改走 bg-background-toast 令牌。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readSrc(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('材质三档令牌（issue #18 · PC-1 + PC-3）', () => {
  it('Toast info 变体的 wrap 用 bg-background-toast 令牌，不再硬编码 hex', () => {
    const toast = readSrc('src/components/Toast.tsx');
    // 取 info 变体的 wrap 行（注释会合法地引用旧值作历史背景，所以只断 wrap 赋值）。
    const infoWrap = toast.match(/info:\s*\{[\s\S]*?wrap:\s*'([^']*)'/);
    expect(infoWrap).not.toBeNull();
    expect(infoWrap[1]).toContain('bg-background-toast/95');
    expect(infoWrap[1]).not.toMatch(/bg-\[#[0-9a-fA-F]+\]/);
  });

  it('design-tokens.css 提供 --color-bg-toast-rgb 通道三元组（/95 需要能解析通道）', () => {
    const tokens = readSrc('src/styles/design-tokens.css');
    expect(tokens).toContain('--color-bg-toast-rgb:');
  });

  it('tailwind.config.js 把 background.toast 映射成通道三元组 + <alpha-value>', () => {
    const cfg = readSrc('tailwind.config.js');
    expect(cfg).toMatch(/toast:\s*['"]rgb\(var\(--color-bg-toast-rgb\)\s*\/\s*<alpha-value>\)['"]/);
  });

  it('prefers-contrast: more 覆盖 --color-bg-toast-rgb（高对比下 Toast 底色受控）', () => {
    // 基线令牌在 design-tokens.css；这条断言钉 index.css 的 prefers-contrast
    // 段里出现同名变量，证明硬编码色改令牌后恢复了 :root 覆盖链（PC-3 关切点）。
    const css = readSrc('src/index.css');
    expect(css).toContain('--color-bg-toast-rgb:');
  });

  it('缩放控件组外壳走结构档 bg-background-surface，不再 bg-white/10（BeforeAfter + SplitCompare）', () => {
    const ba = readSrc('src/components/BeforeAfterViewport.tsx');
    const sc = readSrc('src/components/SplitCompareViewport.tsx');
    // 两视口的缩放按钮组外壳原先都是 `bg-white/10 rounded`（与交互层白底同档），
    // 结构层应走 2% surface 令牌与交互层解耦。
    expect(ba).toContain('gap-0.5 bg-background-surface rounded text-[11px]');
    expect(sc).toContain('gap-0.5 bg-background-surface rounded text-[11px]');
  });

  it('状态栏的 Pick/Reject 静息无底色、选中才叠语义色（三视口同动词同材质）', () => {
    // 审计 PC-1：同一动词在不同视口用了两种材质。issue #62 把三个视口的选片
    // 动作统一收到窗口底栏后，静息只保留 `STATUS_BUTTON` 基底（无 bg → 透明），
    // 选中态才叠 emerald / rose，不再出现 bg-white/10 的静息底色。
    const bb = readSrc('src/components/BottomBar.tsx');
    expect(bb).toMatch(
      /`\$\{STATUS_BUTTON\} \$\{group\.flag === 'pick' \? 'bg-emerald-600\/25 text-emerald-300' : ''\}`/,
    );
    expect(bb).toMatch(
      /`\$\{STATUS_BUTTON\} \$\{group\.flag === 'reject' \? 'bg-rose-600\/25 text-rose-300' : ''\}`/,
    );
  });
});
