/**
 * 宫格键盘导航的契约护栏。
 *
 * 为什么单独一个文件：这 48 行逻辑（handleListKeyDown）在拆成 `useGridKeyboard`
 * 之前**完全没有测试覆盖** —— 4 个 ThumbnailGrid 测试文件里没有任何
 * pointer/keyboard 事件断言。坐标系与行列步长改错了没有任何东西会红。
 *
 * 锁住的行为：
 * - 上下键跨行（±columns），与视觉行列一致（不是 ±1）
 * - Home/End 跳首尾
 * - PageUp/PageDown 跨 3 行
 * - 边界钳制，不越界
 * - Ctrl/Cmd+A 全选
 * - 键盘移动把选区收拢为单张（roving），保持「当前照片」与高亮一致
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThumbnailGrid } from './ThumbnailGrid';
import type { PhotoGroupInfo } from '../types';

function g(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    jpg: { name: `${id}.jpg`, extension: 'jpg', path: `D:/shoot/${id}.jpg`, size: 1, mtime: 0 },
    status: 'JPG_ONLY',
    rating: 0,
    flag: 'none',
    hasXmp: false,
  };
}

/** 12 张，按默认 3 列排布：0..2 / 3..5 / 6..8 / 9..11 */
const GROUPS = Array.from({ length: 12 }, (_, i) => g('abcdefghijkl'[i]));

function renderGrid(props: Partial<React.ComponentProps<typeof ThumbnailGrid>> = {}) {
  const onSelect = vi.fn();
  const onSelectionChange = vi.fn();
  const utils = render(
    <ThumbnailGrid
      groups={GROUPS}
      columns={3}
      selectedIndex={0}
      onSelect={onSelect}
      selectedIds={new Set()}
      onSelectionChange={onSelectionChange}
      lumenThumbnails={false}
      {...props}
    />,
  );
  return { ...utils, onSelect, onSelectionChange };
}

/** 派一个 keydown 到 listbox 容器（键盘导航的宿主）。 */
function key(k: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(screen.getByRole('listbox'), { key: k, ...init });
}

describe('宫格键盘导航', () => {
  it('ArrowDown 跨一整行（+columns），不是 +1', () => {
    const { onSelect } = renderGrid({ selectedIndex: 0 });
    key('ArrowDown');
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('ArrowUp 跨一整行（-columns）', () => {
    const { onSelect } = renderGrid({ selectedIndex: 6 });
    key('ArrowUp');
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('Home 跳首张，End 跳末张', () => {
    const a = renderGrid({ selectedIndex: 5 });
    key('Home');
    expect(a.onSelect).toHaveBeenCalledWith(0);
    a.unmount();

    const b = renderGrid({ selectedIndex: 2 });
    key('End');
    expect(b.onSelect).toHaveBeenCalledWith(GROUPS.length - 1);
  });

  it('PageDown / PageUp 跨 3 行', () => {
    const a = renderGrid({ selectedIndex: 0 });
    key('PageDown');
    expect(a.onSelect).toHaveBeenCalledWith(9); // 0 + 3*3
    a.unmount();

    const b = renderGrid({ selectedIndex: 11 });
    key('PageUp');
    expect(b.onSelect).toHaveBeenCalledWith(2); // 11 - 3*3
  });

  it('边界钳制：底部再往下、顶部再往上都不越界', () => {
    const bottom = renderGrid({ selectedIndex: GROUPS.length - 1 });
    key('ArrowDown');
    key('PageDown');
    expect(bottom.onSelect).toHaveBeenNthCalledWith(1, GROUPS.length - 1);
    expect(bottom.onSelect).toHaveBeenNthCalledWith(2, GROUPS.length - 1);
    bottom.unmount();

    const top = renderGrid({ selectedIndex: 0 });
    key('ArrowUp');
    key('PageUp');
    expect(top.onSelect).toHaveBeenNthCalledWith(1, 0);
    expect(top.onSelect).toHaveBeenNthCalledWith(2, 0);
  });

  it('Ctrl/Cmd+A 全选所有格子', () => {
    const { onSelectionChange } = renderGrid();
    key('a', { ctrlKey: true });
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(GROUPS.map((x) => x.id)));
  });

  it('键盘移动把多选收拢为单张（roving），高亮与当前照片不脱钩', () => {
    const { onSelectionChange, onSelect } = renderGrid({
      selectedIndex: 0,
      selectedIds: new Set(GROUPS.slice(0, 3).map((x) => x.id)),
    });
    key('ArrowDown');
    expect(onSelect).toHaveBeenCalledWith(3);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set([GROUPS[3].id]));
  });

  it('空集合时不渲染 listbox —— 键盘导航根本没有宿主可挂', () => {
    // 这比「渲染一个空 listbox 但按任何键都不动」更彻底：空集合时整块宫格
    // 走 EmptyGridState 分支，连 role=listbox 都不存在，任何误挂上去的全局
    // 键盘监听都无键可收。
    const { onSelect, onSelectionChange } = renderGrid({ groups: [], selectedIndex: 0 });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('未识别的键不拦截（default 分支直接 return）', () => {
    const { onSelect } = renderGrid({ selectedIndex: 4 });
    const ev = new KeyboardEvent('keydown', { key: 'q', bubbles: true });
    const ok = fireEvent.keyDown(screen.getByRole('listbox'), ev);
    expect(ok).toBe(true); // 未 preventDefault
    expect(onSelect).not.toHaveBeenCalled();
  });
});