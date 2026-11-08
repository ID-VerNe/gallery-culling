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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { PreviewViewport } from './PreviewViewport';
import { SplitCompareViewport } from './SplitCompareViewport';
import { BeforeAfterViewport } from './BeforeAfterViewport';
import { GESTURE, SETTLE } from '../utils/viewportMotion';
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

  it('滚轮触底后夹在 MIN_SCALE，缩放面报告已达下限（状态栏据此禁用「缩小」）', () => {
    const onZoomApi = vi.fn();
    const { host, img } = renderPreview({ onZoomApi });

    // 1 / 1.25^8 < 0.2，第 8 格起被夹住；多打几格证明不会继续掉
    for (let i = 0; i < 12; i++) {
      fireEvent.wheel(host, { clientX: 600, clientY: 400, deltaY: 100 });
    }
    expect(readTransform(img).scale).toBe(0.2);
    // 缩放按钮已搬到窗口底栏（issue #62）：视口只负责把 scale 交出去，
    // 底栏用 `scale <= ZOOM_MIN` 判 `disabled`（见 BottomBar 的缩放组）。
    const calls = onZoomApi.mock.calls;
    const api = calls[calls.length - 1]?.[0];
    expect(api?.scale).toBe(0.2);

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
      <BeforeAfterViewport group={GROUP} {...props} />,
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

// ---------------------------------------------------------------------------
// issue #22 · 拖拽收尾：速度继承（PB-6）+ 越界阻尼（PB-8）
//
// 背景：`handlePointerUp` 原先只把 `isDragging` 置假，快速甩动后画面立刻停住；
// 越界拖拽又被 `clampTo` 硬夹在边界上，手指贴着边推、画面纹丝不动。
//
// 为什么必须用假定时器：惯性是 rAF 逐帧写 `transform`，jsdom 的 rAF 由
// `vi.useFakeTimers()` 接管后可以精确推进（实测 `advanceTimersByTime(32)` 会
// 触发一帧），因此这里断言的是**逐帧位移**，不是「设了什么属性」。
// 真窗口的手感（跟手程度 / 长甩是否发飘）无法在 jsdom 里判定，属人工验收项。
//
// 边界口径（setup 的桩）：pane clientWidth/Height = 0，img offset = 1200×800，
// 所以 scale=1 时最大平移 ±600 / ±400，scale=2.5 时 ±1500 / ±1000。
// ---------------------------------------------------------------------------
describe('issue #22 · 拖拽收尾（速度继承 + 回弹）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderPreview() {
    render(<PreviewViewport group={GROUP} onPrev={vi.fn()} onNext={vi.fn()} />);
    const img = screen.getByAltText(GROUP.baseName) as HTMLImageElement;
    return { img, host: img.parentElement as HTMLElement };
  }

  /**
   * 一次甩动：按下 → 每个采样点间隔 16ms 的移动（两次移动 = 速度可观）→ 抬手。
   * 返回抬手时（还没跑惯性）的 transform。
   */
  function flick(host: HTMLElement, startX: number, xs: number[], gap = 16) {
    fireEvent.pointerDown(host, { button: 0, clientX: startX, clientY: 400, pointerId: 1 });
    for (const x of xs) {
      vi.advanceTimersByTime(gap);
      fireEvent.pointerMove(host, { clientX: x, clientY: 400, pointerId: 1 });
    }
    const last = xs[xs.length - 1];
    fireEvent.pointerUp(host, { clientX: last, clientY: 400, pointerId: 1 });
  }

  it('甩动松手后继续滑行，落点被夹在边界上（PB-6）', () => {
    const { img, host } = renderPreview();
    // +200px / 32ms = 6.25px/ms，被速度上限夹到 6 —— 投影 1500px，越界后夹到 600。
    flick(host, 100, [200, 300]);

    expect(readTransform(img)).toMatchObject({ x: 200, y: 0 });
    expect(img.style.transition).toBe(GESTURE);

    // 第一帧只是把起点写回去（elapsed=0），不能一抬手就跳到落点。
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(readTransform(img).x).toBeCloseTo(200, 5);

    // 96ms 后已滑出一段，但仍在边界内 —— 惯性是渐进位移，不是瞬移。
    act(() => {
      vi.advanceTimersByTime(96);
    });
    const mid = readTransform(img).x;
    expect(mid).toBeGreaterThan(200);
    expect(mid).toBeLessThan(600);

    // 收尾有明确上界：投影再远也只落在 clamp 边界上，2s 内落定。
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(readTransform(img).x).toBe(600);
    expect(img.style.transition).toBe(SETTLE);
  });

  it('停下来再松手不启动惯性：速度只认最近 100ms（PB-6）', () => {
    const { img, host } = renderPreview();

    fireEvent.pointerDown(host, { button: 0, clientX: 100, clientY: 400, pointerId: 1 });
    vi.advanceTimersByTime(16);
    fireEvent.pointerMove(host, { clientX: 200, clientY: 400, pointerId: 1 });
    vi.advanceTimersByTime(16);
    fireEvent.pointerMove(host, { clientX: 300, clientY: 400, pointerId: 1 });
    // 停手 400ms：采样窗口（100ms）里只剩松手点自己，速度必须归零。
    // 注意这里刻意留了两个移动采样：只留一个的话「窗口失效」也会因样本不足
    // 而算出 0 速度，用例就成了假绿。
    vi.advanceTimersByTime(400);
    fireEvent.pointerUp(host, { clientX: 300, clientY: 400, pointerId: 1 });

    expect(img.style.transition).toBe(SETTLE);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(readTransform(img).x).toBe(200);
  });

  it('越界拖拽走阻尼、松手逐帧回弹到边界（PB-8）', () => {
    const { img, host } = renderPreview();
    fireEvent.doubleClick(host); // scale 2.5 → 最大平移 ±1500

    fireEvent.pointerDown(host, { button: 0, clientX: 100, clientY: 400, pointerId: 1 });
    vi.advanceTimersByTime(16);
    // 目标 +2900，越界 1400，阻尼系数 0.4 → 1500 + 560。
    fireEvent.pointerMove(host, { clientX: 3000, clientY: 400, pointerId: 1 });
    expect(readTransform(img).x).toBeCloseTo(1500 + 1400 * 0.4, 5);

    // 只动过一次 → 抬手速度 0，但位置越界，必须弹回边界内。
    fireEvent.pointerUp(host, { clientX: 3000, clientY: 400, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(16);
    });
    // 第一帧把起点写回去，此时还在越界位置 —— 不能一抬手就瞬跳到边界。
    expect(readTransform(img).x).toBeCloseTo(2060, 5);

    act(() => {
      vi.advanceTimersByTime(96);
    });
    const mid = readTransform(img).x;
    expect(mid).toBeGreaterThan(1500);
    expect(mid).toBeLessThan(2060);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(readTransform(img).x).toBe(1500);
    // 收尾只动平移：倍率仍停在双击落点。
    expect(readTransform(img).scale).toBe(2.5);
  });

  it('收尾途中边界收紧（窗口变窄）也不留在界外', () => {
    const { img, host } = renderPreview();
    flick(host, 100, [200, 300]); // 投影落点会被夹到 ±600
    act(() => {
      vi.advanceTimersByTime(96);
    });

    // 收尾还在飞的时候照片被重新布局成 600 宽：最大平移从 ±600 收到 ±300。
    Object.defineProperty(img, 'offsetWidth', { configurable: true, get: () => 600 });

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // 说明每帧写入都还过一遍夹紧，而不是只在抬手时算一次落点。
    expect(readTransform(img).x).toBe(300);
  });

  it('滚轮打断在飞的收尾（新输入优先，PB-6）', () => {
    const { img, host } = renderPreview();
    flick(host, 100, [200, 300]);

    fireEvent.wheel(host, { clientX: 600, clientY: 400, deltaY: -100 });
    const afterWheel = readTransform(img);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(readTransform(img)).toEqual(afterWheel);
    expect(img.style.transition).toBe(GESTURE);
  });
});
