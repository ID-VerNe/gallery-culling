/**
 * 顶部缩放条收敛的墓碑（issue #120）。
 *
 * `BeforeAfterViewport` 与 `SplitCompareViewport` 顶部的缩放条曾是 51 行同构副本，
 * 且 Split 内 effectiveScale 混用（局部 1 处、直读 3 处）。抽 `ViewportZoomBar`
 * 后这里钉住两件事：
 * - 行为：联动合并读数、独立双读数+聚焦、min/max disabled 跟随 `effectiveScale`
 *   而非某栏 scale、重置 aria 带当前值、点击转发 zoomBy/reset。
 * - 源码纯度：组件内 4 处统一 `zoom.effectiveScale`、无局部别名，两调用方已
 *   复用本组件且不再自备重复 markup —— 改回混用立刻变红。
 *
 * 变异靶点：把组件内任一 `zoom.effectiveScale` 改为 `const effectiveScale` 别名
 * 或 `zoom.scaleOf(panes.first)`，本文件至少一条变红（见源码纯度与聚焦栏用例）。
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import barSource from './ViewportZoomBar.tsx?raw';
import beforeSource from './BeforeAfterViewport.tsx?raw';
import splitSource from './SplitCompareViewport.tsx?raw';
import { ViewportZoomBar } from './ViewportZoomBar';
import { ZOOM_MIN, ZOOM_MAX } from '../utils/viewportZoom';
import type { DualZoomPan } from '../hooks/useDualZoomPan';

type P = 'before' | 'after';

type ZoomOverrides = Partial<DualZoomPan<P>> & { __scales?: Record<P, number> };

function makeZoom(overrides: ZoomOverrides = {}): DualZoomPan<P> {
  const scales: Record<P, number> = overrides.__scales ?? { before: 1, after: 1 };
  const { __scales: _ignored, ...rest } = overrides;
  const zoom = {
    scaleOf: (pane: P) => scales[pane],
    posOf: () => ({ x: 0, y: 0 }),
    transformOf: () => 'translate(0px, 0px) scale(1)',
    isDragging: false,
    transition: '',
    sync: true,
    toggleSync: vi.fn(),
    activePane: 'before' as P,
    focusPane: vi.fn(),
    effectiveScale: 1,
    zoomBy: vi.fn(),
    reset: vi.fn(),
    bindPane: () => ({
      ref: () => {},
      onWheel: () => {},
      onPointerDown: () => {},
      onPointerMove: () => {},
      onPointerUp: () => {},
      onDoubleClick: () => {},
    }),
    imgRef: () => () => {},
    ...rest,
  } as unknown as DualZoomPan<P>;
  return zoom;
}

const PANES = {
  first: 'before' as const,
  second: 'after' as const,
  firstShort: '前',
  secondShort: '后',
  firstName: '前',
  secondName: '后',
  dimClass: 'text-white/45',
};

function renderBar(zoom: DualZoomPan<P>) {
  return render(
    <ViewportZoomBar zoom={zoom} panes={PANES} zoomOutLabel="缩小" zoomInLabel="放大" />,
  );
}

describe('ViewportZoomBar —— 联动/独立读数与按钮', () => {
  it('联动时只渲染合并读数（首栏值）', () => {
    const zoom = makeZoom({ sync: true, effectiveScale: 1 });
    renderBar(zoom);
    expect(screen.getByLabelText('当前缩放 适应')).toBeInTheDocument();
  });

  it('独立时渲染双读数并标出聚焦窗格', () => {
    const zoom = makeZoom({
      sync: false,
      activePane: 'after',
      effectiveScale: 1,
      __scales: { before: 1, after: 1 },
    });
    renderBar(zoom);
    expect(
      screen.getByLabelText('当前缩放：前 适应，后 适应（聚焦后图）'),
    ).toBeInTheDocument();
    expect(screen.getByText('前 适应')).toBeInTheDocument();
    expect(screen.getByText('后 适应')).toBeInTheDocument();
  });

  it('点击缩小/放大转发 zoomBy（1/ZOOM_STEP、ZOOM_STEP），重置转发 reset', () => {
    const zoom = makeZoom({ sync: true, effectiveScale: 1 });
    renderBar(zoom);
    fireEvent.click(screen.getByLabelText('缩小'));
    fireEvent.click(screen.getByLabelText('放大'));
    fireEvent.click(screen.getByLabelText(/^重置缩放与平移/));
    expect(zoom.zoomBy).toHaveBeenCalledWith(1 / 1.25);
    expect(zoom.zoomBy).toHaveBeenCalledWith(1.25);
    expect(zoom.reset).toHaveBeenCalledTimes(1);
  });

  it('重置按钮 aria-label 带上当前缩放（适应态与百分比）', () => {
    const zoom = makeZoom({ sync: true, effectiveScale: 1 });
    renderBar(zoom);
    expect(screen.getByLabelText('重置缩放与平移（当前 适应）')).toBeInTheDocument();
  });

  it('effectiveScale 触顶时放大禁用，触底时缩小禁用', () => {
    const { rerender } = renderBar(makeZoom({ sync: true, effectiveScale: ZOOM_MAX }));
    expect(screen.getByLabelText('放大')).toBeDisabled();
    expect(screen.getByLabelText('缩小')).not.toBeDisabled();
    rerender(
      <ViewportZoomBar
        zoom={makeZoom({ sync: true, effectiveScale: ZOOM_MIN })}
        panes={PANES}
        zoomOutLabel="缩小"
        zoomInLabel="放大"
      />,
    );
    expect(screen.getByLabelText('缩小')).toBeDisabled();
    expect(screen.getByLabelText('放大')).not.toBeDisabled();
  });
});

describe('ViewportZoomBar —— disabled 跟随聚焦栏而非首栏（issue #120 变异靶点）', () => {
  it('独立聚焦后栏至上限、首栏不在上限时，放大仍禁用', () => {
    // 若实现误用 scaleOf(first) 判 disabled，这里会变红：首栏 scale=1 不在上限。
    const zoom = makeZoom({
      sync: false,
      activePane: 'after',
      effectiveScale: ZOOM_MAX,
      __scales: { before: 1, after: ZOOM_MAX },
    });
    renderBar(zoom);
    expect(screen.getByLabelText('放大')).toBeDisabled();
  });

  it('独立聚焦后栏至下限、首栏不在下限时，缩小仍禁用', () => {
    const zoom = makeZoom({
      sync: false,
      activePane: 'after',
      effectiveScale: ZOOM_MIN,
      __scales: { before: 1, after: ZOOM_MIN },
    });
    renderBar(zoom);
    expect(screen.getByLabelText('缩小')).toBeDisabled();
  });

  it('未激活窗格用调用方传入的 dimClass，已激活为 text-white', () => {
    const zoom = makeZoom({
      sync: false,
      activePane: 'before',
      effectiveScale: 1,
      __scales: { before: 1, after: 1 },
    });
    renderBar(zoom);
    // 实现细节：活跃侧 text-white，非活跃侧 dimClass。两 span 文案即标识。
    const active = screen.getByText('前 适应');
    const dim = screen.getByText('后 适应');
    expect(active.className).toContain('text-white');
    expect(dim.className).toContain('text-white/45');
  });
});

/** 去掉注释后只剩代码，供源码纯度断言。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('ViewportZoomBar —— 源码纯度（issue #120）', () => {
  it('组件内 effectiveScale 四处统一为 zoom.effectiveScale，无局部别名', () => {
    // 只看代码：剥掉 zoom.effectiveScale 后不应再残留 effectiveScale —— 任何
    // `const effectiveScale = ...` 或裸用都会把这一条冲红。
    const code = stripComments(barSource);
    const stripped = code.replace(/zoom\.effectiveScale/g, '');
    expect(stripped).not.toContain('effectiveScale');
    expect(code.match(/zoom\.effectiveScale/g)).toHaveLength(4);
    expect(code).not.toContain('const effectiveScale');
  });

  it('两调用方复用 ViewportZoomBar，不再自备重复 markup', () => {
    expect(beforeSource).toContain('ViewportZoomBar');
    expect(splitSource).toContain('ViewportZoomBar');
    const dup = 'flex items-center gap-0.5 bg-background-surface rounded text-[11px]';
    expect(beforeSource).not.toContain(dup);
    expect(splitSource).not.toContain(dup);
    expect(barSource).toContain(dup);
  });

  it('两调用方源码不再自建局部 effectiveScale（Split 混用已收敛）', () => {
    expect(beforeSource).not.toContain('const effectiveScale');
    expect(splitSource).not.toContain('const effectiveScale');
  });
});
