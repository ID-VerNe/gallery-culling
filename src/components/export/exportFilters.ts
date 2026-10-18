/**
 * 导出范围的**唯一定义**（纯数据 + 纯谓词，无 React 依赖）。
 *
 * 抽出来的理由：范围同时被三处消费 —— 表单 state 的默认值、候选集的过滤、
 * 单选项上的计数徽标。散落定义会让「显示的计数」与「实际导出的集合」有机会分叉，
 * 而导出是最高危的写入路径，这种分叉的代价不可接受。
 */
import type { PhotoGroupInfo } from '../../types';

export type ExportFilterValue =
  | 'pick_or_rated'
  | 'pick_only'
  | 'star3_plus'
  | 'raw_only'
  | 'current_query'
  | 'all';

/**
 * 谓词的上下文。
 *
 * 存在的原因只有一个：`current_query` 档必须复用宫格的 chips 与查询语法，
 * 而不是在导出侧再写一遍。报告 §5.5 第 5 点明确要求合并 —— 导出是最高危的
 * 写入路径，两套筛选逻辑一旦漂移，用户会导出「看到的」之外的照片。
 */
export interface ExportFilterContext {
  /** 当前 chips 档位（`matchesFilter`）。 */
  matchesChips: (g: PhotoGroupInfo) => boolean;
  /** 当前查询语法（`matchesQuery`，**不含**错误放行）。 */
  matchesQuery: (g: PhotoGroupInfo) => boolean;
  /** 查询语法是否有错误 —— 有错时 `current_query` 一律不命中。 */
  queryInvalid: boolean;
}

export interface ExportFilterSpec {
  value: ExportFilterValue;
  label: string;
  /** 命中即进入导出候选集。 */
  test: (g: PhotoGroupInfo, ctx: ExportFilterContext) => boolean;
}

/**
 * 顺序即 UI 顺序。默认选第一项（最保守的非空集合）。
 * `all` 显式排除淘汰（reject）—— 淘汰是用户的删除意图，绝不能因为「全选」被导出。
 *
 * `raw_only` 放在 `all` **之前**：前三档按评级/旗标筛，它是按**文件类型**筛，
 * 语义上都属于「缩小范围」，而 `all` 是兜底全选，必须压轴。
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
    /**
     * 淘汰守卫**不可省**：`rating` 与 `flag` 是两个独立字段，一张被判了淘汰的
     * 照片星级仍然可能 ≥3（先打星、后淘汰）。少了这半句，用户明确判过死刑的
     * 照片就能靠换一个范围档被导出 —— 与 `pick_or_rated` 里的同款守卫必须一致。
     */
    test: (g) => g.flag !== 'reject' && g.rating >= 3,
  },
  {
    value: 'raw_only',
    label: '含 RAW 的组',
    /**
     * 同样排除淘汰：这是按文件类型筛，不该顺手推翻「淘汰永不导出」的语义。
     * 用 `!!g.raw` 而不是 `status === 'COMPLETE'`：状态字段可能因扫描策略变化
     * （例如只扫 JPG 目录），而「有没有 raw 文件」是候选本身的事实。
     *
     * 标签写「含 RAW」而不是「仅含 RAW」：谓词收的是「有 RAW」的组，
     * 混拍组（RAW + JPG 都在）同样命中。写成「仅含」会让用户以为筛掉了
     * 带 JPG 的组，而计数明明把她们算进来了。
     */
    test: (g) => g.flag !== 'reject' && !!g.raw,
  },
  {
    value: 'current_query',
    label: '当前筛选结果',
    /**
     * 与宫格看到的一致：chips 档位 ∧ 查询语法。
     *
     * 两处刻意的收紧：
     * - **语法有错时一律不命中**（候选变 0）。宫格在语法错误时是放行的
     *   （提示而非拒绝），但导出不能沿用这个宽容：用户以为筛了 40 张，
     *   实际导出 500 张，是不可撤销的错误。宁可拦住让他先改语法。
     * - 仍然排除淘汰。`matchesChips` 在 chips 选「已淘汰」时会命中淘汰，
     *   这一档不能因此把淘汰放出去。
     */
    test: (g, ctx) =>
      g.flag !== 'reject' && !ctx.queryInvalid && ctx.matchesChips(g) && ctx.matchesQuery(g),
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
