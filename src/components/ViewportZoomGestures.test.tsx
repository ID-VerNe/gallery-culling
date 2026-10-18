/**
 * 三视口缩放手势护栏（FE-03b 的前置安全网）。
 *
 * 背景：`ViewportPanConsistency.test.tsx` 锁的是拖拽（pointer），
 * `PreviewViewport.test.tsx` / `SplitCompareViewport.test.tsx` 各锁了
 * 两条滚轮命中缩放。但**双击缩放（fit ↔ 250%）在三视口零覆盖**，
 * BeforeAfter 的滚轮也零覆盖，滚轮触顶/触底的钳制同样零覆盖。
 * 抽 `useZoomPan` 共享层之前必须先有这批网，否则搬运时把手势语义
 * 搬丢了没有任何测试会红。
 *
 * 坐标依赖 `src/test/setup.ts` 的桩：getBoundingClientRect 报
 * left/top=0、1200×800（中心 O=(600,400)），offsetWidth/Height = 1200/800。
 *
 * 方法论沿用 FE-08：先写测试 → **故意改坏验证网有效** → 还原 → 才准动代码。
 * 本文件的「改坏验证」记录见 git history（test commit 的 message）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { PreviewViewport } from './PreviewViewport';
import { SplitCompareViewport } from './SplitCompareViewport';
import { BeforeAfterViewport } from './BeforeAfterViewport';
import type { PhotoGroupInfo } from '../types';

/** jsdom 不实现 Pointer Capture，拖拽相关用例依赖它。 */
function stubPointerCapture() {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture = vi.fn();
  proto.releasePointerCapture = vi.fn();
  proto.hasPointerCapture = vi.fn(() => true);
}

beforeEach(() => {
  stubPointerCapture();
});

function jpgGroup(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    jpg: { name: `${id}.jpg`, extension: 'jpg', path: `D:/shoot/${id}.jpg`, size: 1, mtime: 0 },
    status: 'JPG_ONLY',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
  };
}

/** 从 `transform: translate(Xpx, Ypx) scale(...)` 读出缩放与平移。 */
function readTransform(el: HTMLElement): { scale: number; x: number; y: number } {
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(
    el.style.transform || '',
  );
  if (!m) return { scale: 1, x: 0, y: 0 };
  return { x: parseFloat(m[1]), y: parseFloat(m[2]), scale: parseFloat(m[3]) };
}

const GROUP = jpgGroup('a');

describe('PreviewViewport —— 双击缩放与复位', () => {
  function renderPreview(props: Partial<ComponentProps<typeof PreviewViewport>> = {}) {
    const { container } = render(
      <PreviewViewport
        group={GROUP}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onRate={vi.fn()}
        onFlag={vi.fn()}
        onOpenExternal={vi.fn()}
        {...props}
      />,
    );
    const img = screen.getByAltText(GROUP.baseName) as HTMLImageElement;
    const host = img.parentElement as HTMLElement;
    return { host, img, container };
  }

  it('双击在「适应 ↔ 250%」之间切换', () => {
    const { host, img } = renderPreview();
    expect(readTransform(img).scale).toBe(1);

    fireEvent.doubleClick(host);
    expect(readTransform(img).scale).toBe(2.5);

    fireEvent.doubleClick(host);
    expect(readTransform(img).scale).toBe(1);
  });

  it('双击放大时把平移复位到中心（拖偏了再双击应回正）', () => {
    const { host, img } = renderPreview();

    // 先拖偏：(100,100) 按下 → (150,140)，净位移 (+50, +40)
    fireEvent.pointerDown(host, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(host, { clientX: 150, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(host, { clientX: 150, clientY: 140, pointerId: 1 });
    expect(readTransform(img)).toMatchObject({ x: 50, y: 40 });

    fireEvent.doubleClick(host);
    expect(readTransform(img)).toMatchObject({ scale: 2.5, x: 0, y: 0 });
  });

  it('滚轮触底后夹在 MIN_SCALE，「缩小」按钮随之禁用', () => {
    const { host, img } = renderPreview();

    // 1 / 1.25^8 < 0.2，第 8 格起被夹住；多打几格证明不会继续掉
    for (let i = 0; i < 12; i++) {
      fireEvent.wheel(host, { clientX: 600, clientY: 400, deltaY: 100 });
    }
    expect(readTransform(img).scale).toBe(0.2);
    expect(screen.getByLabelText('缩小')).toBeDisabled();

    // 触底后光标在中心滚一格：scale 不变、不产生平移（k===1 恒等）
    fireEvent.wheel(host, { clientX: 900, clientY: 600, deltaY: 100 });
    expect(readTransform(img)).toMatchObject({ scale: 0.2, x: 0, y: 0 });
  });
});

describe('SplitCompareViewport —— 双击缩放与复位', () => {
  function renderSplit(props: Partial<ComponentProps<typeof SplitCompareViewport>> = {}) {
    const { container } = render(
      <SplitCompareViewport
        leftGroup={GROUP}
        rightGroup={jpgGroup('b')}
        isLeftPinned={false}
        isRightPinned={false}
        onTogglePinLeft={vi.fn()}
        onTogglePinRight={vi.fn()}
        onSwap={vi.fn()}
        onRate={vi.fn()}
        onFlag={vi.fn()}
        {...props}
      />,
    );
    const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
    const host = imgs[0].parentElement as HTMLElement;
    return { host, imgs, container };
  }

  it('联动（默认）下双击左栏：两栏同步切到 250% 并回正', () => {
    const { host, imgs } = renderSplit();
    expect(readTransform(imgs[0]).scale).toBe(1);
    expect(readTransform(imgs[1]).scale).toBe(1);

    fireEvent.doubleClick(host);

    expect(readTransform(imgs[0])).toMatchObject({ scale: 2.5, x: 0, y: 0 });
    expect(readTransform(imgs[1])).toMatchObject({ scale: 2.5, x: 0, y: 0 });

    fireEvent.doubleClick(host);
    expect(readTransform(imgs[0]).scale).toBe(1);
    expect(readTransform(imgs[1]).scale).toBe(1);
  });

  it('独立缩放下双击只作用于被点的那一栏', () => {
    const { host, imgs } = renderSplit();
    fireEvent.click(screen.getByLabelText('切换双图联动同步缩放'));

    fireEvent.doubleClick(host);

    expect(readTransform(imgs[0]).scale).toBe(2.5); // 左栏被点
    expect(readTransform(imgs[1]).scale).toBe(1); // 右栏纹丝不动
  });
});

describe('BeforeAfterViewport —— 双击缩放、滚轮与复位', () => {
  function renderBA(props: Partial<ComponentProps<typeof BeforeAfterViewport>> = {}) {
    const { container } = render(
      <BeforeAfterViewport group={GROUP} onRate={vi.fn()} onFlag={vi.fn()} {...props} />,
    );
    const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
    return { imgs, beforeHost: imgs[0].parentElement as HTMLElement, afterHost: imgs[1].parentElement as HTMLElement, container };
  }

  it('联动锁焦（默认）下双击：两栏同步切到 250% 并回正', () => {
    const { afterHost, imgs } = renderBA();
    expect(readTransform(imgs[0]).scale).toBe(1);

    fireEvent.doubleClick(afterHost);
    expect(readTransform(imgs[0])).toMatchObject({ scale: 2.5, x: 0, y: 0 });
    expect(readTransform(imgs[1])).toMatchObject({ scale: 2.5, x: 0, y: 0 });

    fireEvent.doubleClick(afterHost);
    expect(readTransform(imgs[0]).scale).toBe(1);
  });

  it('独立对照下双击只作用于被点的窗格', () => {
    const { beforeHost, imgs } = renderBA();
    fireEvent.click(screen.getByLabelText('切换前后两图联动缩放'));

    fireEvent.doubleClick(beforeHost);
    expect(readTransform(imgs[0]).scale).toBe(2.5); // before 被点
    expect(readTransform(imgs[1]).scale).toBe(1); // after 不变
  });

  it('滚轮以指针为中心缩放，口径与 Preview/Split 一致', () => {
    const { afterHost, imgs } = renderBA();

    // O=(600,400)，光标 (1200,800) → d=(600,400)，k=1.25 ⇒ pos′=(−150,−100)
    fireEvent.wheel(afterHost, { clientX: 1200, clientY: 800, deltaY: -100 });

    expect(readTransform(imgs[0])).toMatchObject({ scale: 1.25, x: -150, y: -100 });
    expect(readTransform(imgs[1])).toMatchObject({ scale: 1.25, x: -150, y: -100 });
  });

  it('独立对照下滚轮只作用于被悬停的窗格', () => {
    const { beforeHost, imgs } = renderBA();
    fireEvent.click(screen.getByLabelText('切换前后两图联动缩放'));

    fireEvent.wheel(beforeHost, { clientX: 1200, clientY: 800, deltaY: -100 });

    expect(readTransform(imgs[0]).scale).toBe(1.25); // before 被悬停
    expect(readTransform(imgs[1]).scale).toBe(1); // after 不动
  });
});
