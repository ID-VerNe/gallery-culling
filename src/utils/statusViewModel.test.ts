/**
 * 状态栏视图模型纯 selector 单测（issue #112，源自 AppShell 的
 * `statusZoom` / `statusPanes` 内联派生，issue #62 的窗格分流语义不变）。
 */
import { describe, it, expect, vi } from 'vitest';
import { selectStatusPanes, selectStatusZoom } from './statusViewModel';
import { makeGroup } from '../test/factories';
import type { PhotoGroupInfo } from '../types';
import type { PreviewZoomApi } from '../components/PreviewViewport';
import { DEFAULT_TONE } from './autoTone';

const g = (id: string): PhotoGroupInfo =>
  makeGroup(id, { baseName: id.toUpperCase(), tone: { ...DEFAULT_TONE } });

const zoom = (scale: number): PreviewZoomApi => ({
  scale,
  zoomBy: vi.fn(),
  reset: vi.fn(),
});

describe('selectStatusZoom', () => {
  it('split 模式：底栏不展示缩放（顶部已有自己的控制条）', () => {
    expect(
      selectStatusZoom({ viewMode: 'split', currentGroup: g('a'), previewZoom: zoom(1) }),
    ).toBeUndefined();
  });

  it('没有当前照片 → 不展示', () => {
    expect(
      selectStatusZoom({ viewMode: 'single', currentGroup: undefined, previewZoom: zoom(1) }),
    ).toBeUndefined();
  });

  it('视口还没上报 zoom API → 不展示', () => {
    expect(
      selectStatusZoom({ viewMode: 'single', currentGroup: g('a'), previewZoom: null }),
    ).toBeUndefined();
  });

  it('single + 照片 + zoom API → label/边界/回调齐全', () => {
    const z = zoom(1);
    const out = selectStatusZoom({ viewMode: 'single', currentGroup: g('a'), previewZoom: z });
    expect(out).toBeDefined();
    expect(out!.label).toBe('适应');
    expect(out!.atMin).toBe(false);
    expect(out!.atMax).toBe(false);
    out!.onZoomIn();
    expect(z.zoomBy).toHaveBeenCalledWith(1.25);
    out!.onZoomOut();
    expect(z.zoomBy).toHaveBeenCalledWith(1 / 1.25);
    out!.onReset();
    expect(z.reset).toHaveBeenCalledTimes(1);
  });

  it('缩放到最小/最大档 → atMin/atMax 置位', () => {
    expect(
      selectStatusZoom({ viewMode: 'single', currentGroup: g('a'), previewZoom: zoom(0.2) })!.atMin,
    ).toBe(true);
    expect(
      selectStatusZoom({ viewMode: 'single', currentGroup: g('a'), previewZoom: zoom(32) })!.atMax,
    ).toBe(true);
  });
});

describe('selectStatusPanes', () => {
  const handlers = () => ({
    handleRate: vi.fn(),
    handleFlag: vi.fn(),
    setLabel: vi.fn(),
    applyRating: vi.fn(),
    applyFlag: vi.fn(),
    applyLabel: vi.fn(),
  });

  it('single：单窗格带当前照片与调色，动作走 apply* 分流', () => {
    const h = handlers();
    const panes = selectStatusPanes({
      viewMode: 'single',
      leftCompareGroup: undefined,
      rightCompareGroup: undefined,
      toneMap: {},
      currentGroup: g('a'),
      currentTone: { ...DEFAULT_TONE },
      ...h,
    });
    expect(panes).toHaveLength(1);
    expect(panes[0].slot).toBeUndefined();
    expect(panes[0].group?.id).toBe('a');
    expect(panes[0].tone).toBeDefined();
    panes[0].onRate(3);
    expect(h.applyRating).toHaveBeenCalledWith(3);
    expect(h.handleRate).not.toHaveBeenCalled();
  });

  it('split：L/R 两窗格各绑自己的照片，点左图星级不落到右图', () => {
    const h = handlers();
    const left = g('left');
    const right = g('right');
    const panes = selectStatusPanes({
      viewMode: 'split',
      leftCompareGroup: left,
      rightCompareGroup: right,
      toneMap: { left: { ...DEFAULT_TONE, exposure: 0.5 } },
      currentGroup: left,
      currentTone: { ...DEFAULT_TONE },
      ...h,
    });
    expect(panes.map((p) => p.slot)).toEqual(['L', 'R']);
    // 左窗格调色走 toneMap（未保存改动优先），右窗格回退 group.tone。
    expect(panes[0].tone?.exposure).toBe(0.5);
    expect(panes[1].tone).toEqual(right.tone);
    panes[0].onRate(4);
    expect(h.handleRate).toHaveBeenCalledTimes(1);
    expect(h.handleRate).toHaveBeenCalledWith(4, left);
    panes[1].onFlag('pick');
    expect(h.handleFlag).toHaveBeenCalledWith('pick', right);
    panes[1].onLabel!('Red');
    expect(h.setLabel).toHaveBeenCalledWith('Red', right);
  });

  it('split 空窗格：无照片时动作静默不抛', () => {
    const h = handlers();
    const panes = selectStatusPanes({
      viewMode: 'split',
      leftCompareGroup: undefined,
      rightCompareGroup: undefined,
      toneMap: {},
      currentGroup: undefined,
      currentTone: { ...DEFAULT_TONE },
      ...h,
    });
    expect(panes).toHaveLength(2);
    expect(() => panes[0].onRate(3)).not.toThrow();
    expect(h.handleRate).not.toHaveBeenCalled();
  });
});
