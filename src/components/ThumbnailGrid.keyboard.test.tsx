/**
 * 宫格键盘导航的契约护栏。
 *
 * 为什么单独一个文件：这 48 行逻辑（handleListKeyDown）在拆成 `useGridKeyboard`
 * 之前**完全没有测试覆盖** —— 4 个 ThumbnailGrid 测试文件里没有任何
 * pointer/keyboard 事件断言。坐标系与行列步长改错了没有任何东西会红。
 *
 * 锁住的行为：
 * - 上下键跨行（±columns），与视觉行列一致（不是 ±1）
 * - 右手 Home/End/PageUp/PageDown 已删除（issue #61）：按下不得移动
 * - 边界钳制，不越界
 * - Ctrl/Cmd+A 全选
 * - 键盘移动把选区收拢为单张（roving），保持「当前照片」与高亮一致
 * - issue #79：Shift+↑/↓ 按行、Shift+A/D 逐张从锚点扩展选区；无 Shift 的
 *   ↑/↓ 仍保持 listbox 的单张 roving 契约
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThumbnailGrid } from './ThumbnailGrid';
import { jpgFile, makeGroup } from '../test/factories';

const g = (id: string) => makeGroup(id, { jpg: jpgFile(id, 'D:/shoot') });

/** 12 张，按默认 3 列排布：0..2 / 3..5 / 6..8 / 9..11 */
const GROUPS = Array.from({ length: 12 }, (_, i) => g('abcdefghijkl'[i]));

function renderGrid(props: Partial<React.ComponentProps<typeof ThumbnailGrid>> = {}) {
  const onSelect = vi.fn();
  const onSelectionChange = vi.fn();
  const utils = render(
    <ThumbnailGrid
      groups={GROUPS}
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
  return fireEvent.keyDown(screen.getByRole('listbox'), { key: k, ...init });
}

/** 点击第 index 个宫格格子（建立 Shift 锚点）。 */
function clickCellAt(index: number) {
  fireEvent.click(screen.getAllByRole('option')[index]);
}

/** 一组 id 的集合，按索引区间 [from, to] 取。 */
function idsOfRange(from: number, to: number) {
  return new Set(GROUPS.slice(from, to + 1).map((x) => x.id));
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

  it('右手 Home/End/PageUp/PageDown 已删除，按下不移动', () => {
    const { onSelect, unmount } = renderGrid({ selectedIndex: 5 });

    for (const k of ['Home', 'End', 'PageUp', 'PageDown']) {
      const notPrevented = fireEvent.keyDown(screen.getByRole('listbox'), { key: k });
      expect(onSelect).not.toHaveBeenCalled();
      expect(notPrevented).toBe(true);
    }

    unmount();
  });

  it('边界钳制：底部再往下、顶部再往上都不越界', () => {
    const bottom = renderGrid({ selectedIndex: GROUPS.length - 1 });
    key('ArrowDown');
    expect(bottom.onSelect).toHaveBeenCalledWith(GROUPS.length - 1);
    bottom.unmount();

    const top = renderGrid({ selectedIndex: 0 });
    key('ArrowUp');
    expect(top.onSelect).toHaveBeenCalledWith(0);
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
    const ev = new KeyboardEvent('keydown', { key: 'k', bubbles: true });
    const ok = fireEvent.keyDown(screen.getByRole('listbox'), ev);
    expect(ok).toBe(true); // 未 preventDefault
    expect(onSelect).not.toHaveBeenCalled();
  });
});

/**
 * issue #79：一只手也能多选。
 *
 * 锚点复用 `Shift+点击` 的 `anchorIndexRef`，范围选集语义也保持一致
 * （整段替换）。无 Shift 的 `↑/↓` 必须仍是单张 roving —— 那是 listbox 契约，
 * 连选只加在 Shift 分支上。
 */
describe('issue #79：宫格连选（Shift 扩展）', () => {
  it('Shift+↓ 从点击锚点按行扩展选区，当前照片随焦点移动', () => {
    const { onSelect, onSelectionChange } = renderGrid({ selectedIndex: 0 });
    // 点第 2 格建立锚点：锚点 = 1，而当前照片仍在 0 —— 用来证明扩展起点
    // 取的是锚点而不是 selectedIndex。
    clickCellAt(1);
    onSelectionChange.mockClear();

    key('ArrowDown', { shiftKey: true });

    expect(onSelect).toHaveBeenCalledWith(3);
    expect(onSelectionChange).toHaveBeenCalledWith(idsOfRange(1, 3));
  });

  it('Shift+↑ 反向扩展：锚点 6、目标 0 时选 0..6', () => {
    const { onSelect, onSelectionChange } = renderGrid({ selectedIndex: 0 });
    clickCellAt(6);
    onSelectionChange.mockClear();

    key('ArrowUp', { shiftKey: true });

    expect(onSelect).toHaveBeenCalledWith(0);
    expect(onSelectionChange).toHaveBeenCalledWith(idsOfRange(0, 6));
  });

  it('连续 Shift+↓ 以同一锚点持续增长（锚点不跟随焦点）', () => {
    const { onSelect, onSelectionChange, rerender } = renderGrid({ selectedIndex: 0 });
    clickCellAt(0);
    onSelectionChange.mockClear();

    key('ArrowDown', { shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(idsOfRange(0, 3));

    // 受控宿主把 selectedIndex 推进到 3（组件重渲染，hook 内的锚点保持 0）。
    rerender(
      <ThumbnailGrid
        groups={GROUPS}
        selectedIndex={3}
        onSelect={onSelect}
        selectedIds={new Set()}
        onSelectionChange={onSelectionChange}
        lumenThumbnails={false}
      />,
    );
    key('ArrowDown', { shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(idsOfRange(0, 6));
  });

  it('边界钳制：最后一行再 Shift+↓ 不越界', () => {
    const { onSelect, onSelectionChange } = renderGrid({ selectedIndex: GROUPS.length - 1 });
    key('ArrowDown', { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith(GROUPS.length - 1);
    expect(onSelectionChange).toHaveBeenCalledWith(
      new Set([GROUPS[GROUPS.length - 1].id]),
    );
  });

  it('Shift+D / Shift+A 逐张扩展，并阻断全局上一张/下一张', () => {
    const { onSelect, onSelectionChange } = renderGrid({ selectedIndex: 2 });
    const globalSpy = vi.fn();
    window.addEventListener('keydown', globalSpy);

    const notPrevented = key('D', { shiftKey: true });
    expect(notPrevented).toBe(false); // preventDefault 生效
    expect(onSelect).toHaveBeenCalledWith(3);
    expect(onSelectionChange).toHaveBeenCalledWith(idsOfRange(2, 3));
    // stopPropagation 必须拦住冒泡到 window 的全局 A/D。
    expect(globalSpy).not.toHaveBeenCalled();

    onSelectionChange.mockClear();
    key('A', { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(1);
    expect(onSelectionChange).toHaveBeenCalledWith(idsOfRange(1, 2));
    expect(globalSpy).not.toHaveBeenCalled();

    window.removeEventListener('keydown', globalSpy);
  });

  it('Ctrl+A 把锚点落到当前照片，后续 Shift 扩展从当前照片起算', () => {
    const { onSelect, onSelectionChange, rerender } = renderGrid({ selectedIndex: 0 });
    clickCellAt(0); // 旧锚点 0
    rerender(
      <ThumbnailGrid
        groups={GROUPS}
        selectedIndex={4}
        onSelect={onSelect}
        selectedIds={new Set()}
        onSelectionChange={onSelectionChange}
        lumenThumbnails={false}
      />,
    );

    key('a', { ctrlKey: true });
    onSelectionChange.mockClear();
    key('D', { shiftKey: true });

    expect(onSelect).toHaveBeenLastCalledWith(5);
    expect(onSelectionChange).toHaveBeenCalledWith(idsOfRange(4, 5));
  });

  it('未启用多选时 Shift+A/D 不拦截，保持全局导航语义', () => {
    const onSelect = vi.fn();
    render(
      <ThumbnailGrid
        groups={GROUPS}
        selectedIndex={2}
        onSelect={onSelect}
        lumenThumbnails={false}
      />,
    );

    const notPrevented = key('D', { shiftKey: true });
    expect(notPrevented).toBe(true); // 不吞键，留给全局上一张/下一张
    expect(onSelect).not.toHaveBeenCalled();
  });
});