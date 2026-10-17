/**
 * 导出范围的**唯一定义**（纯数据 + 纯谓词，无 React 依赖）。
 *
 * 抽出来的理由：范围同时被三处消费 —— 表单 state 的默认值、候选集的过滤、
 * 单选项上的计数徽标。散落定义会让「显示的计数」与「实际导出的集合」有机会分叉，
 * 而导出是最高危的写入路径，这种分叉的代价不可接受。
 */
import type { PhotoGroupInfo } from '../../types';

export type ExportFilterValue = 'pick_or_rated' | 'pick_only' | 'star3_plus' | 'all';

export interface ExportFilterSpec {
  value: ExportFilterValue;
  label: string;
  /** 命中即进入导出候选集。 */
  test: (g: PhotoGroupInfo) => boolean;
}

/**
 * 顺序即 UI 顺序。默认选第一项（最保守的非空集合）。
 * `all` 显式排除淘汰（reject）—— 淘汰是用户的删除意图，绝不能因为「全选」被导出。
 */
export const EXPORT_FILTERS: ReadonlyArray<ExportFilterSpec> = [
  {
    value: 'pick_or_rated',
    label: '已保留或已打星',
    test: (g) => g.flag !== 'reject' && (g.flag === 'pick' || g.rating > 0),
  },
  {
    value: 'pick_only',
    label: '仅标记保留 Pick',
    test: (g) => g.flag === 'pick',
  },
  {
    value: 'star3_plus',
    label: '★ 3 星以上',
    test: (g) => g.rating >= 3,
  },
  {
    value: 'all',
    label: '全部非淘汰照片',
    test: (g) => g.flag !== 'reject',
  },
];

export const DEFAULT_EXPORT_FILTER: ExportFilterValue = 'pick_or_rated';

/** 按值取规格；未知值回落到默认项，保证 UI 永远有可选项。 */
export function resolveExportFilter(value: ExportFilterValue): ExportFilterSpec {
  return EXPORT_FILTERS.find((f) => f.value === value) ?? EXPORT_FILTERS[0];
}
