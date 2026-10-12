/**
 * 单图视口的滚轮缩放（M-08）。
 *
 * 快捷键说明承诺「滚轮 · 以指针为中心缩放」；本用例把光标放在离画面中心
 * (600, 400) 的偏移处滚一格，断言 `transform` 里的平移量按命中公式反算 ——
 * 修复前只改 scale、translate 恒为 0，本用例会直接失败。
 *
 * 坐标依赖 `src/test/setup.ts` 里给 `getBoundingClientRect` 打的桩：
 * left/top = 0，width 1200 / height 800，故视口中心 O = (600, 400)。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { PreviewViewport } from './PreviewViewport';
import type { PhotoGroupInfo } from '../types';

const group: PhotoGroupInfo = {
  id: 'g1',
  baseName: 'g1',
  jpg: { name: 'g1.jpg', extension: 'jpg', path: 'D:/shoot/g1.jpg', size: 1, mtime: 0 },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  hasXmp: false,
};

function renderViewport() {
  const { container } = render(
    <PreviewViewport
      group={group}
      onPrev={vi.fn()}
      onNext={vi.fn()}
      onRate={vi.fn()}
      onFlag={vi.fn()}
      onOpenExternal={vi.fn()}
    />,
  );
  return { wheelHost: container.firstElementChild as HTMLElement, container };
}

describe('PreviewViewport —— 滚轮以指针为中心缩放（M-08）', () => {
  it('光标不在中心时，按命中公式反算平移量', () => {
    const { wheelHost, container } = renderViewport();
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.style.transform).toContain('translate(0px, 0px)');

    // d = (1200, 800) − (600, 400) = (600, 400)；k = 1.25
    // pos′ = 1.25·0 + (1 − 1.25)·d = (−150, −100)
    fireEvent.wheel(wheelHost, { clientX: 1200, clientY: 800, deltaY: -100 });

    expect(img.style.transform).toContain('translate(-150px, -100px)');
    expect(img.style.transform).toContain('scale(1.25)');
  });

  it('光标在画面正中时退化为「只改缩放」，不产生平移', () => {
    const { wheelHost, container } = renderViewport();
    const img = container.querySelector('img') as HTMLImageElement;

    fireEvent.wheel(wheelHost, { clientX: 600, clientY: 400, deltaY: -100 });

    expect(img.style.transform).toContain('translate(0px, 0px)');
    expect(img.style.transform).toContain('scale(1.25)');
  });
});
