/**
 * 高亮真值：`selectedIndex` 与批量选区（`selectedIds`）必须**并集**高亮。
 *
 * 回归背景：多选（B1）落地时把高亮写成「集合非空就完全以集合为准」，而键盘导航
 * （a/d/←/→）只更新 App 的 `selectedIndex`、不碰 `selectedIds`。于是用户点过任意
 * 缩略图后（集合非空），宫格高亮就永久停在旧格 —— 底栏与主视口已经切到下一张，
 * 宫格却还指着上一张，**用户看到的选中格与实际被评级的照片不是同一张**。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThumbnailGrid } from './ThumbnailGrid';
import { mockInvokeCommand } from '../test/setup';
import type { PhotoGroupInfo } from '../types';

function group(id: string, overrides: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    raw: { name: `${id}.CR3`, extension: 'CR3', path: `D:/shoot/${id}.CR3`, size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
    ...overrides,
  };
}

const GROUPS = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => group(id));

function renderGrid(props: {
  selectedIndex: number;
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
}) {
  mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
  return render(
    <ThumbnailGrid
      groups={GROUPS}
      selectedIndex={props.selectedIndex}
      onSelect={() => {}}
      selectedIds={props.selectedIds}
      onSelectionChange={props.onSelectionChange}
      lumenThumbnails={false}
    />,
  );
}

/** 高亮中的格子 id 列表（读 aria-selected，即读屏与测试都依赖的那个契约）。 */
const highlighted = () =>
  screen
    .getAllByRole('option')
    .filter((el) => el.getAttribute('aria-selected') === 'true')
    .map((el) => (el.getAttribute('id') ?? '').replace('grid-opt-', ''));

describe('ThumbnailGrid —— 高亮真值（selectedIndex ∪ selectedIds）', () => {
  it('无批量选区时，高亮跟随 selectedIndex', () => {
    renderGrid({ selectedIndex: 2 });
    expect(highlighted()).toEqual(['c']);
  });

  it('★批量选区非空时，当前照片（selectedIndex）依然高亮', () => {
    // 选区停在 a（用户之前点过），但键盘导航已把 selectedIndex 推到 c：
    // 修复前这里只会高亮 a（宫格与底栏脱钩）。
    renderGrid({ selectedIndex: 2, selectedIds: new Set(['a']), onSelectionChange: () => {} });
    expect(highlighted()).toContain('c');
  });

  it('★选区与当前照片取并集，二者都不丢', () => {
    renderGrid({ selectedIndex: 1, selectedIds: new Set(['d', 'e', 'f']), onSelectionChange: () => {} });
    expect(highlighted().sort()).toEqual(['b', 'd', 'e', 'f']);
  });

  it('Ctrl+A 全选后，selectedIndex 落到最后一格也仍然高亮', () => {
    const all = new Set(GROUPS.map((g) => g.id));
    renderGrid({ selectedIndex: GROUPS.length - 1, selectedIds: all, onSelectionChange: () => {} });
    expect(highlighted().sort()).toEqual(GROUPS.map((g) => g.id).sort());
  });

  it('选区里的照片不在当前渲染窗口时也不会让当前照片丢失高亮', () => {
    // 选区含一个当前不可见的 id（虚拟滚动场景）
    renderGrid({ selectedIndex: 0, selectedIds: new Set(['a', 'zz']), onSelectionChange: () => {} });
    expect(highlighted()).toContain('a');
  });
});