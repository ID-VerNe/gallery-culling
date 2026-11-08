/**
 * 视口动效通道护栏（issue #18 · PB-1 + PB-10）。
 *
 * PB-1：三视口各自写死 `<img>` 的 `transition`，且值分叉（Preview 0.08s、
 * 双栏 0.05s），滚轮与拖拽共用同一条缓动 —— 滚轮缩放被 50–80ms 的补间
 * 糊成「慢半拍」，拖拽则要靠 `isDragging` 单独关掉。真正的分界不是
 * 「是否在拖」，而是**手势通道（连续输入）与跳变通道（离散跳变）**。
 *
 * PB-10：双击判定写成 `scale === 1` 精确相等，浮点残差差一点点就永远进不了
 * 250%。判定必须走带容差的 `isFitScale`，与读数 `scaleLabel` 共用同一条容差
 * —— 组件层的可见症状是「读数说适应、双击却当成已放大」。
 *
 * 方法论沿用 FE-08：先写测试 → 变异验证网有效 → 还原 → 才准动实现。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { PreviewViewport } from './PreviewViewport';
import { SplitCompareViewport } from './SplitCompareViewport';
import { BeforeAfterViewport } from './BeforeAfterViewport';
import { act } from 'react';
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

/** 从 `transform: translate(Xpx, Ypx) scale(...)` 读出缩放。 */
function readScale(el: HTMLElement): number {
  const m = /scale\(([\d.]+)\)/.exec(el.style.transform || '');
  return m ? parseFloat(m[1]) : 1;
}

const GROUP = jpgGroup('a');

function renderPreview(extra: Partial<ComponentProps<typeof PreviewViewport>> = {}) {
  const { container } = render(
    <PreviewViewport
      group={GROUP}
      onPrev={vi.fn()}
      onNext={vi.fn()}
      {...extra}
    />,
  );
  const img = screen.getByAltText(GROUP.baseName) as HTMLImageElement;
  // 滚轮/dblclick 打在内层容器上：外层容器是同结构的兄弟包裹，
  // `<img>` 的 parentElement 并不是绑了 querySelector 手势的那个节点。
  const host = img.parentElement as HTMLElement;
  void container;
  return { img, host };
}

function renderSplit() {
  const { container } = render(
    <SplitCompareViewport
      leftGroup={GROUP}
      rightGroup={jpgGroup('b')}
      isLeftPinned={false}
      isRightPinned={false}
      onTogglePinLeft={vi.fn()}
      onTogglePinRight={vi.fn()}
      onSwap={vi.fn()}
    />,
  );
  const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
  return { imgs, host: imgs[0].parentElement as HTMLElement };
}

function renderBeforeAfter(props: Partial<ComponentProps<typeof BeforeAfterViewport>> = {}) {
  const { container } = render(
    <BeforeAfterViewport group={GROUP} {...props} />,
  );
  const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
  return {
    imgs,
    beforeHost: imgs[0].parentElement as HTMLElement,
    afterHost: imgs[1].parentElement as HTMLElement,
  };
}

// ---------------------------------------------------------------------------
// PB-1 · 动效通道
// ---------------------------------------------------------------------------

describe('PB-1 · 手势通道与跳变通道必须分开', () => {
  it('PreviewViewport：静止时是跳变通道（SETTLE）', () => {
    const { img } = renderPreview();
    expect(img.style.transition).toBe(SETTLE);
  });

  it('PreviewViewport：拖拽期间走手势通道（GESTURE）', () => {
    const { img, host } = renderPreview();
    fireEvent.pointerDown(host, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(img.style.transition).toBe(GESTURE);

    fireEvent.pointerUp(host, { clientX: 120, clientY: 110, pointerId: 1 });
    expect(img.style.transition).toBe(SETTLE);
  });

  it('PreviewViewport：滚轮是手势通道，不能补间', () => {
    const { img, host } = renderPreview();
    fireEvent.wheel(host, { clientX: 600, clientY: 400, deltaY: -100 });
    expect(readScale(img)).toBe(1.25);
    expect(img.style.transition).toBe(GESTURE);
  });

  it('PreviewViewport：双击是跳变通道', () => {
    const { img, host } = renderPreview();
    fireEvent.doubleClick(host);
    expect(readScale(img)).toBe(2.5);
    expect(img.style.transition).toBe(SETTLE);

    fireEvent.wheel(host, { clientX: 600, clientY: 400, deltaY: -100 });
    expect(img.style.transition).toBe(GESTURE);
    fireEvent.doubleClick(host);
    expect(readScale(img)).toBe(1);
    expect(img.style.transition).toBe(SETTLE);
  });

  it('SplitCompareViewport：与 Preview 逐字同一条通道串', () => {
    const { imgs, host } = renderSplit();
    expect(imgs[0].style.transition).toBe(SETTLE);

    fireEvent.wheel(host, { clientX: 600, clientY: 400, deltaY: -100 });
    expect(imgs[0].style.transition).toBe(GESTURE);
    expect(imgs[1].style.transition).toBe(GESTURE);

    fireEvent.doubleClick(host);
    expect(imgs[0].style.transition).toBe(SETTLE);
    expect(imgs[1].style.transition).toBe(SETTLE);
  });

  it('BeforeAfterViewport：两栏逐字同一条通道串', () => {
    const { imgs, beforeHost, afterHost } = renderBeforeAfter();
    expect(imgs[0].style.transition).toBe(SETTLE);
    expect(imgs[1].style.transition).toBe(SETTLE);

    fireEvent.wheel(afterHost, { clientX: 600, clientY: 400, deltaY: -100 });
    expect(imgs[0].style.transition).toBe(GESTURE);
    expect(imgs[1].style.transition).toBe(GESTURE);

    // 拖拽覆盖两栏（联动平移），抬手后两栏都回跳变通道。
    fireEvent.pointerDown(beforeHost, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    expect(imgs[0].style.transition).toBe(GESTURE);
    expect(imgs[1].style.transition).toBe(GESTURE);
    fireEvent.pointerUp(beforeHost, { clientX: 120, clientY: 110, pointerId: 1 });
    expect(imgs[0].style.transition).toBe(SETTLE);
    expect(imgs[1].style.transition).toBe(SETTLE);
  });

  it('Split 独立模式下滚轮只改手势通道，不影响同步语义', () => {
    const { imgs, host } = renderSplit();
    fireEvent.click(screen.getByLabelText('切换双图联动同步缩放'));
    fireEvent.wheel(host, { clientX: 600, clientY: 400, deltaY: -100 });

    expect(readScale(imgs[0])).toBe(1.25);
    expect(readScale(imgs[1])).toBe(1);
    expect(imgs[0].style.transition).toBe(GESTURE);
  });
});

// ---------------------------------------------------------------------------
// issue #22 · 收尾动效的通道归属
//
// 惯性是 rAF 逐帧写 `transform`：走 `GESTURE`（无 CSS 补间），否则 CSS 的
// 0.12s 补间会追着每一帧跑，读作双重缓动。落定之后必须回 `SETTLE`，让下一次
// 双击 / 复位仍是跳变通道 —— 通道不能因为「刚甩过」而滞留在手势态。
// ---------------------------------------------------------------------------
describe('issue #22 · 收尾期间保持手势通道，落定回跳变通道', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('PreviewViewport：甩动收尾全程 GESTURE，落定后 SETTLE', () => {
    const { img, host } = renderPreview();

    fireEvent.pointerDown(host, { button: 0, clientX: 100, clientY: 400, pointerId: 1 });
    vi.advanceTimersByTime(16);
    fireEvent.pointerMove(host, { clientX: 200, clientY: 400, pointerId: 1 });
    vi.advanceTimersByTime(16);
    fireEvent.pointerMove(host, { clientX: 300, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(host, { clientX: 300, clientY: 400, pointerId: 1 });

    expect(img.style.transition).toBe(GESTURE);

    act(() => {
      vi.advanceTimersByTime(96);
    });
    expect(img.style.transition).toBe(GESTURE);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(img.style.transition).toBe(SETTLE);
  });

  it('BeforeAfterViewport：联动收尾两栏同一条通道', () => {
    const { imgs, beforeHost } = renderBeforeAfter();

    fireEvent.pointerDown(beforeHost, { button: 0, clientX: 100, clientY: 400, pointerId: 1 });
    vi.advanceTimersByTime(16);
    fireEvent.pointerMove(beforeHost, { clientX: 200, clientY: 400, pointerId: 1 });
    vi.advanceTimersByTime(16);
    fireEvent.pointerMove(beforeHost, { clientX: 300, clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(beforeHost, { clientX: 300, clientY: 400, pointerId: 1 });

    expect(imgs[0].style.transition).toBe(GESTURE);
    expect(imgs[1].style.transition).toBe(GESTURE);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(imgs[0].style.transition).toBe(SETTLE);
    expect(imgs[1].style.transition).toBe(SETTLE);
  });
});

describe('PB-1 · 通道常量本身', () => {
  it('GESTURE 关闭补间、SETTLE 带 transform 补间，两者不相等', () => {
    expect(GESTURE).toBe('none');
    expect(SETTLE.startsWith('transform ')).toBe(true);
    expect(GESTURE).not.toBe(SETTLE);
  });

  // 只判「以 transform 开头」等于放行任何时长与曲线：把 0.12s 改成 1.2s、
  // 或把缓动换成 linear，都不会红 —— 而那正是 PB-1 要修的「慢半拍」本体。
  // 这里钉住解析出来的时长与曲线，改任一项都必须先改这条。
  it('SETTLE 的时长与曲线是定值：0.12s + cubic-bezier(0.32, 0.72, 0, 1)', () => {
    const time = /(\d*\.?\d+)m?s\b/.exec(SETTLE);
    expect(time).not.toBeNull();
    const ms = time![0].endsWith('ms') ? Number(time![1]) : Number(time![1]) * 1000;
    expect(ms).toBeCloseTo(120, 5);
    expect(SETTLE).toContain('cubic-bezier(0.32, 0.72, 0, 1)');
  });
});

// ---------------------------------------------------------------------------
// PB-10 · 「适应」判定的容差
//
// 双击判定写成 `scale === 1` 严格相等，判定本身的容差由纯函数层锁定：
// `src/utils/viewportZoom.test.ts` 的「isFitScale」组用 `isFitScale(1.0004)`
// 逼出 `=== 1` 的实现必红。
//
// 组件层为什么没有对应红灯：`ZOOM_STEP = 1.25` 的一次往返在 IEEE754 下精确
// 回到 1，从滚轮入口造不出「读数说适应、代码不等于 1」的中间态 —— 在这个
// 步长下 `=== 1` 与 `isFitScale` 行为完全相同，写个组件用例只会是 tautology。
// 如实记录这一限制，不假装守住了。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PB-10 的第二处：Z 键的 1:1 往返判定
//
// `PreviewViewport.toggleOneToOne` 原先记下 1:1 的比例，再用
// `Math.abs(scale - known) < 0.02` 判断「现在是不是还在 1:1」—— 固定容差
// 压在**比例**上，而 1:1 的比例本身随图幅与窗口变：24MP 在 1200px 里是
// 5.02×，近似方图贴近窗口尺寸时只有 1.01×。同一个 0.02 窗口在不同图上
// 含义差着量级。
//
// 改成「精确落点」也不自洽（第一版修法，已被下面的用例推翻并留下记录）：
// 从 1.01 的 1:1 滚一格离开落在 1.2625，再按 Z 重算回 1.01 —— 两个数都
// 是同一张图的同一个 1:1，指望「当前值恰好等于它」成立，等于拿一个自己
// 按需算出来的数去跟自己比：它永远成立，也就永远判不出「现在还在不在
// 1:1」，更判不出「用户是不是刚滚走」。
//
// 正确的判据是**模式**：上一次按 Z 落在 1:1 还是适应。模式为真时按 Z 回
// 适应，否则进 1:1。1:1 之外的每个入口（滚轮 / 拖拽 / 双击 / ± / 复位 /
// 换图）都必须把模式打回适应 —— 否则下一次按 Z 会复位到用户早就离开的
// 画面。下面的用例逐条盯住这两半。
// ---------------------------------------------------------------------------

/**
 * 让 `<img>` 报出指定的原图像素尺寸（jsdom 不加载图片，默认 0）。
 *
 * 必须走 prototype 读取器：`naturalWidth` 定义在 `HTMLImageElement.prototype`
 * 上，而 `src/test/setup.ts` 把 `offsetWidth` 桩在 `HTMLElement.prototype`；
 * 实例自有属性会被原型链上的另一处桩规则挡住，读回 0/默认值。
 */
function stubNaturalSize(naturalWidth: number) {
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true,
    get: () => naturalWidth,
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
    configurable: true,
    get: () => Math.round(naturalWidth * 0.75),
  });
}

describe('PB-10 · Z 键的 1:1 往返（判据是模式，不是比例窗口）', () => {
  it('Z 进 1:1 再按 Z 回适应（大幅 1:1：5.02×）', () => {
    const oneToOneRef = { current: () => {} };
    const { img } = renderPreview({ oneToOneRef });
    stubNaturalSize(6024);

    act(() => oneToOneRef.current());
    expect(readScale(img)).toBeCloseTo(5.02, 2);

    act(() => oneToOneRef.current());
    expect(readScale(img)).toBe(1);
  });

  it('1:1 只有 1.01× 时同样成立：再按一次 Z 回适应', () => {
    const oneToOneRef = { current: () => {} };
    const { img } = renderPreview({ oneToOneRef });
    // 1212 / 1200 = 1.01 —— 与适应只差 0.01，正是固定容差最容易出事的比例。
    stubNaturalSize(1212);

    act(() => oneToOneRef.current());
    expect(readScale(img)).toBeCloseTo(1.01, 4);

    act(() => oneToOneRef.current());
    expect(readScale(img)).toBe(1);
  });

  // 下面三组盯的是模式的另一半：离开 1:1 的入口有没有把模式打回适应。
  // 模式若滞留在「在 1:1」，下一次按 Z 不回 1:1 而是复位到适应 —— 用户
  // 按了 Z，画面反而退出来，且没有任何报错。
  const leaves = [
    {
      name: '滚一格',
      leave: (host: HTMLElement) =>
        fireEvent.wheel(host, { clientX: 600, clientY: 400, deltaY: -100 }),
      // 从 1.01 起滚一格：1.01 × 1.25 = 1.2625。
      afterLeave: 1.2625,
    },
    {
      name: '双击',
      leave: (host: HTMLElement) => fireEvent.doubleClick(host),
      // 1.01 已不算适应，双击落在适应（1）。
      afterLeave: 1,
    },
    {
      name: '拖拽',
      leave: (host: HTMLElement) => {
        fireEvent.pointerDown(host, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
        fireEvent.pointerMove(host, { clientX: 140, clientY: 130, pointerId: 1 });
        fireEvent.pointerUp(host, { clientX: 140, clientY: 130, pointerId: 1 });
      },
      // 1:1 时图片正好铺满视口，夹紧后平移锁死为 0 —— 拖拽只换通道、不改比例。
      afterLeave: null,
    },
  ];

  for (const { name, leave, afterLeave } of leaves) {
    it(`离开 1:1（${name}）之后按 Z：重新进 1:1，而不是复位`, () => {
      const oneToOneRef = { current: () => {} };
      const { img, host } = renderPreview({ oneToOneRef });
      stubNaturalSize(1212);

      act(() => oneToOneRef.current());
      expect(readScale(img)).toBeCloseTo(1.01, 4);

      leave(host);
      if (afterLeave !== null) expect(readScale(img)).toBeCloseTo(afterLeave, 4);

      act(() => oneToOneRef.current());
      expect(readScale(img)).toBeCloseTo(1.01, 4);
    });
  }

  // 双击与 Z 同构：落点走同一条 oneToOne 路径。两者分头实现时，双击在
  // RAW-only 组上只会落在「适应 × 2.5」的假放大 —— 那张图根本没有可比的
  // 1:1，用户双击看到的却是一个看似 1:1 的比例。
  it('双击与 Z 落同一个点：都在 1:1 上，双击后按 Z 直接回适应', () => {
    const oneToOneRef = { current: () => {} };
    const { img, host } = renderPreview({ oneToOneRef });
    stubNaturalSize(1212);

    fireEvent.doubleClick(host);
    expect(readScale(img)).toBeCloseTo(1.01, 4);

    act(() => oneToOneRef.current());
    expect(readScale(img)).toBe(1);
  });

  it('双击一次离开 1:1、再双击回 1:1（不是一路放大）', () => {
    const oneToOneRef = { current: () => {} };
    const { img, host } = renderPreview({ oneToOneRef });
    stubNaturalSize(1212);

    act(() => oneToOneRef.current());
    expect(readScale(img)).toBeCloseTo(1.01, 4);

    fireEvent.doubleClick(host);
    expect(readScale(img)).toBe(1);

    fireEvent.doubleClick(host);
    expect(readScale(img)).toBeCloseTo(1.01, 4);
  });

  it('算不出 1:1（没有布局）时双击仍是一个放大：落在 DOUBLE_CLICK_SCALE', () => {
    // setup 把 offsetWidth 桩成 1200，这里把原图尺寸打成 0 —— 元素在、但读不
    // 出原图像素，oneToOneScale 返回 null。双击必须退回 2.5，而不是原地不动。
    const { img, host } = renderPreview();
    stubNaturalSize(0);
    fireEvent.doubleClick(host);
    expect(readScale(img)).toBe(2.5);
  });
});

