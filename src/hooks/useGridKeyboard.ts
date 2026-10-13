import { useCallback, useMemo, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { PhotoGroupInfo } from '../types';

/**
 * 宫格的键盘导航与多选。
 *
 * 三处原实现互相耦合，必须**放在同一个 hook** 里，否则会出现跨 hook 状态同步：
 * - `handleCellClick`（点击/Ctrl/Shift 选区）
 * - `handleListKeyDown`（上下/Home/End/Page 导航）
 * - `handleSearchKeyDown`（搜索框 Esc）
 * 它们共享 `anchorIndexRef`（Shift 范围选择的起点）与 `activeIds`（当前选区）。
 *
 * 导航语义：上下键按**行**跨（±columns），与视觉行列一致；左右键不在这里处理
 * —— 它们由全局快捷键绑到「上/下一张照片」，避免同一个按键在两个层级各动一次。
 */
export function useGridKeyboard(opts: {
  groups: PhotoGroupInfo[];
  columns: number;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onSelectionChange?: (ids: Set<string>) => void;
  /** 是否启用多选（宿主是否传了 onSelectionChange）。 */
  multiSelectEnabled: boolean;
  /** 当前选区 id 集合。 */
  selectedIds: ReadonlySet<string>;
  onSearchQueryChange?: (q: string) => void;
  onSearchOpenChange?: (open: boolean) => void;
}) {
  const {
    groups,
    columns,
    selectedIndex,
    onSelect,
    onSelectionChange,
    multiSelectEnabled,
    selectedIds,
    onSearchQueryChange,
    onSearchOpenChange,
  } = opts;

  /** Shift 范围选择的锚点。ref 而非 state：点击链路不需要重渲染。 */
  const anchorIndexRef = useRef(-1);

  const activeIds = useMemo(() => {
    if (!multiSelectEnabled || selectedIds.size === 0) return new Set<string>();
    return new Set(selectedIds);
  }, [multiSelectEnabled, selectedIds]);

  const handleSearchKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onSearchQueryChange?.('');
        onSearchOpenChange?.(false);
      }
    },
    [onSearchQueryChange, onSearchOpenChange],
  );

  /**
   * B1：多选点击模型（仅当宿主启用多选时）。
   * - 普通点击：单选，并把"当前照片"移过去（中心视口跟随）。
   * - Ctrl/Cmd 点击：切换该格，不移动当前照片（便于原地组选区）。
   * - Shift 点击：从锚点做范围选择。
   */
  const handleCellClick = useCallback(
    (e: React.MouseEvent, index: number) => {
      if (!multiSelectEnabled || !onSelectionChange) {
        onSelect(index);
        return;
      }
      const clicked = groups[index];
      if (!clicked) return;

      if (e.shiftKey && anchorIndexRef.current >= 0) {
        const a = Math.min(anchorIndexRef.current, index);
        const b = Math.max(anchorIndexRef.current, index);
        const next = new Set<string>();
        for (let i = a; i <= b; i++) next.add(groups[i].id);
        onSelectionChange(next);
        onSelect(index);
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        const next = new Set(activeIds);
        if (next.has(clicked.id)) next.delete(clicked.id);
        else next.add(clicked.id);
        if (next.size === 0) next.add(clicked.id);
        anchorIndexRef.current = index;
        onSelectionChange(next);
        return;
      }

      anchorIndexRef.current = index;
      onSelectionChange(new Set([clicked.id]));
      onSelect(index);
    },
    [multiSelectEnabled, onSelectionChange, onSelect, groups, activeIds],
  );

  const handleListKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (groups.length === 0) return;

      // B1：Ctrl/Cmd+A 全选（仅多选启用时）。
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'a' || e.key === 'A') &&
        onSelectionChange
      ) {
        e.preventDefault();
        onSelectionChange(new Set(groups.map((g) => g.id)));
        return;
      }

      const last = groups.length - 1;
      let next = selectedIndex;

      switch (e.key) {
        // B3：宫格是"按行"排列的，上下键应跨行（±columns），与视觉行列一致；
        // 左右键由全局 handler 绑到上/下一张照片。
        case 'ArrowDown':
          next = Math.min(selectedIndex + columns, last);
          break;
        case 'ArrowUp':
          next = Math.max(selectedIndex - columns, 0);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = last;
          break;
        case 'PageDown':
          next = Math.min(selectedIndex + columns * 3, last);
          break;
        case 'PageUp':
          next = Math.max(selectedIndex - columns * 3, 0);
          break;
        default:
          return;
      }

      e.preventDefault();
      // 键盘移动把选区收拢为单张（roving），保持"当前照片"与高亮一致。
      anchorIndexRef.current = next;
      onSelectionChange?.(new Set([groups[next].id]));
      onSelect(next);
    },
    [groups, columns, selectedIndex, onSelect, onSelectionChange],
  );

  /** 当前高亮的格子；`selectedIndex` 越界时为 undefined。 */
  const activeGroup =
    selectedIndex >= 0 && selectedIndex < groups.length ? groups[selectedIndex] : undefined;

  return {
    anchorIndexRef,
    activeIds,
    activeGroup,
    handleCellClick,
    handleListKeyDown,
    handleSearchKeyDown,
  };
}