import type { FilterMode, PhotoGroupInfo } from '../types';

/**
 * 筛选谓词唯一真值（M-14）。
 *
 * `App.tsx` 的 `filteredGroups` 原先用一段 switch 内联定义，而顶部筛选下拉一旦
 * 也要显示「每档数量」，就会沉淀出**第二份**同样的判断逻辑。两处一旦漂移，
 * 用户看到的 `(N)` 与实际切档后宫格里的张数就会不一致 —— 这正是本函数要
 * 消除的风险：计数、过滤共用同一份谓词，不可能再分叉。
 *
 * 判定口径严格对齐 `App.tsx:156-174` 的原 switch（一字不改），尤其：
 * - `unmarked` = 既没有旗标、也没有星级；
 * - `star3` = `rating >= 3`（「星以上」）、`star5` = `rating === 5`（「精选」）。
 */
export function matchesFilter(group: PhotoGroupInfo, mode: FilterMode): boolean {
  switch (mode) {
    case 'pick':
      return group.flag === 'pick';
    case 'reject':
      return group.flag === 'reject';
    case 'unmarked':
      return group.flag === 'none' && group.rating === 0;
    case 'star1':
      return group.rating >= 1;
    case 'star2':
      return group.rating >= 2;
    case 'star3':
      return group.rating >= 3;
    case 'star4':
      return group.rating >= 4;
    case 'star5':
      return group.rating === 5;
    case 'all':
    default:
      return true;
  }
}

/** 全部档位（含暂未在 UI 暴露的 star1/2/4），计数需要全量覆盖。 */
export const ALL_FILTER_MODES: readonly FilterMode[] = [
  'all',
  'pick',
  'reject',
  'unmarked',
  'star1',
  'star2',
  'star3',
  'star4',
  'star5',
];

/**
 * 顶部筛选下拉实际提供的档位与文案（顺序即展示顺序）。
 * 原生 `<select>` 不支持富文本，计数只能拼进 option 文本，故文案在此统一。
 */
export const FILTER_OPTIONS: ReadonlyArray<{ mode: FilterMode; label: string }> = [
  { mode: 'all', label: '全部照片' },
  { mode: 'pick', label: '仅已保留 (Pick)' },
  { mode: 'reject', label: '已淘汰 (Reject)' },
  { mode: 'unmarked', label: '未标记' },
  { mode: 'star3', label: '★3 星以上' },
  { mode: 'star5', label: '★5 星精选' },
];

/**
 * 单次 O(n) 遍历出各档计数（零中间数组）。
 *
 * 相比「每档各 filter 一次」的朴素写法（O(6n) + 6 个临时数组），这里对
 * `groups` 只走一遍；档位循环在内层，仍复用 `matchesFilter`，不重复谓词。
 * 1 万张规模下为亚毫秒级，可安全地放进 `App` 的 useMemo。
 */
export function countByFilter(
  groups: readonly PhotoGroupInfo[],
): Record<FilterMode, number> {
  const counts = {} as Record<FilterMode, number>;
  for (const mode of ALL_FILTER_MODES) counts[mode] = 0;

  for (const group of groups) {
    for (const mode of ALL_FILTER_MODES) {
      if (matchesFilter(group, mode)) counts[mode]++;
    }
  }
  return counts;
}
