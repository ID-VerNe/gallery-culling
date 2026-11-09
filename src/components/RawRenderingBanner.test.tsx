/**
 * 「正在渲染 RAW…」横幅的单一真值（issue #121）。
 *
 * Preview 为大档（top-4 px-3.5 py-1.5 text-xs），Split / BeforeAfter 为小档
 * （top-3 px-3 py-1 text-[11px]），三处 div class 各自漂移。本文件钉死收敛
 * 后的大档：渲染文案逐字 + class 关键档位 + 源码不回潮小档。
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RawRenderingBanner } from './RawRenderingBanner';
import bannerSource from './RawRenderingBanner.tsx?raw';

describe('RawRenderingBanner —— 大档横幅（issue #121）', () => {
  it('文案逐字「正在渲染 RAW…」且 role=status', () => {
    render(<RawRenderingBanner />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('正在渲染 RAW…');
  });

  it('class 为 Preview 大档（top-4 / px-3.5 / py-1.5 / text-xs）', () => {
    const { container } = render(<RawRenderingBanner />);
    const el = container.querySelector('[role="status"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.className).toContain('absolute top-4 left-1/2 -translate-x-1/2');
    expect(el.className).toContain('px-3.5 py-1.5');
    expect(el.className).toContain('text-xs');
    // 小档特征不得回潮。
    expect(el.className).not.toContain('text-[11px]');
    expect(el.className).not.toContain(' px-3 py-1 ');
  });

  it('源码钉大档字面量（防有人把小档搬回横幅组件）', () => {
    // 以「定位 + 底色 + 虚化 + 内边距 + 圆角 + 字号」锁定横幅那一行。
    expect(bannerSource).toContain(
      'bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs',
    );
    expect(bannerSource).not.toContain('px-3 py-1 rounded-md text-[11px]');
    expect(bannerSource).toContain('正在渲染 RAW…');
  });
});
