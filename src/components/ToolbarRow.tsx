import React from 'react';
import {
  SlidersHorizontal,
  Download,
  Columns2,
  Maximize2,
  Split,
  Sparkles,
  RefreshCw,
  Library,
  BookMarked,
} from 'lucide-react';
import type { FilterMode, SortOrder, ViewMode } from '../types';
import { FILTER_OPTIONS } from '../utils/filterMatch';

interface ViewModeOption {
  mode: ViewMode;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

/** 提到模块顶层：原先在组件体内每次渲染都重建一遍同样的 React 元素数组。 */
const VIEW_MODES: ViewModeOption[] = [
  {
    mode: 'single',
    label: '单图',
    hint: '单图大图检视',
    icon: <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />,
  },
  {
    mode: 'split',
    label: '对比',
    hint: '双图对比 (快捷键 C)',
    icon: <Columns2 className="w-3.5 h-3.5" aria-hidden="true" />,
  },
  {
    mode: 'before_after',
    label: '前后',
    hint: '本张照片前后对照 (快捷键 Y)',
    icon: <Split className="w-3.5 h-3.5" aria-hidden="true" />,
  },
];

/**
 * Row 2 — 看什么 + 对它做什么。
 *
 * 与 `SourceRow` 的边界见该文件的说明：按语义切分，两行不共享局部变量。
 */
export interface ToolbarRowProps {
  filterMode: FilterMode;
  onFilterChange: (val: FilterMode) => void;
  /**
   * 各筛选档的计数（M-14）。缺省时**优雅降级**：只显示档位文案，不显示 `(N)`，
   * 既不显示 0 也不崩溃 —— 让本行在宿主尚未接线时也可独立编译/测试。
   */
  filterCounts?: Record<FilterMode, number>;
  sortOrder: SortOrder;
  onSortChange: (val: SortOrder) => void;
  viewMode: ViewMode;
  onViewModeChange: (val: ViewMode) => void;
  onOpenExportModal: () => void;
  onToggleTonalAdjuster?: () => void;
  /**
   * 调色面板的**派生真值**（= 用户意图 && 当前有可调对象）。
   *
   * 此前本行同时接受 `showTonalPanel`（裸意图）与 `tonalPanelVisible`
   * （派生真值），缺省时 `tonalPanelVisible ?? !!showTonalPanel` —— 一条
   * 自承为「向后兼容」的双轨。违反 CLAUDE.md「不保留向后兼容，移除过时路径」。
   * 现只保留派生真值一个来源，双轨已删。
   */
  tonalPanelVisible: boolean;
  /** 当前筛选没有照片：按钮置灰并说明这是 no-op，而不是"按了没反应"。 */
  tonalToggleDisabled?: boolean;
  onOpenLuminar?: () => void;
  isLuminarRunning?: boolean;
  /**
   * FR-08 手动入口：从 XMP 重新读取外部改动。
   *
   * 刻意**不**因互斥而置灰：被扫描/导出挡住时点击会当场弹一句原因。disabled
   * 按钮不可聚焦，原因只能画在屏幕上（FR-09 的规矩），而这一行没有位置常驻
   * 一整句「正在扫描照片，暂时不能读取 XMP」。留一个可点的按钮 + 即时解释，
   * 比留一个灰按钮 + 无处安放的原因更诚实。
   */
  onRefreshXmp?: () => void;
  /** 正在读盘：只防重复点击（互斥另有说明）。 */
  isRefreshingXmp?: boolean;
  /**
   * FR-10 选片集入口。点击打开弹窗（存为 / 打开 / 缺失报告都在里面）。
   *
   * 为什么不是两个顶栏按钮：打开结果的缺失清单需要一块能停住的地方，
   * toast 会自己消失；而两个按钮换两次点击却没多一点信息。
   */
  onOpenAlbum?: () => void;
  /**
   * 当前照片列表来自哪个选片集（`null` = 不是从选片集打开的）。
   *
   * 必须常驻显示：选片集是跨目录的，顶栏那两个目录框在选片集视图里
   * **不再描述这批照片**，不标出来用户会以为照片还是那个目录里的。
   */
  albumName?: string | null;
  /** 选片集里实际载入的张数（缺失的没算进来）。 */
  albumCount?: number;
}

export const ToolbarRow: React.FC<ToolbarRowProps> = ({
  filterMode,
  onFilterChange,
  filterCounts,
  sortOrder,
  onSortChange,
  viewMode,
  onViewModeChange,
  onOpenExportModal,
  onToggleTonalAdjuster,
  tonalPanelVisible,
  tonalToggleDisabled,
  onOpenLuminar,
  isLuminarRunning,
  onRefreshXmp,
  isRefreshingXmp,
  onOpenAlbum,
  albumName,
  albumCount,
}) => {
  // M-10：按下态由宿主传入的派生真值决定（用户意图 && 当前有可调对象）。
  const tonalVisible = tonalPanelVisible;
  const tonalDisabled = !!tonalToggleDisabled;

  return (
    <div className="flex items-center gap-2 flex-wrap min-w-0">
      {/* Filter */}
      <div className="flex items-center gap-1.5 bg-background-base border border-default rounded-md px-2 py-1 text-white/80">
        <SlidersHorizontal className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
        <select
          value={filterMode}
          onChange={(e) => onFilterChange(e.target.value as FilterMode)}
          aria-label="照片筛选过滤"
          title="按保留 / 淘汰 / 星级 / 色标筛选照片"
          className="focus-ring bg-transparent border-none outline-none text-white cursor-pointer text-xs max-w-[12rem]"
        >
          {FILTER_OPTIONS.map(({ mode, label }) => {
            // 计数缺省时不显示 `(N)`（优雅降级）；有计数时即使是 0 也显示，
            // 因为「这一档有 0 张」本身就是用户决策要的信息。
            const count = filterCounts?.[mode];
            return (
              <option key={mode} value={mode} className="bg-background-base">
                {count === undefined ? label : `${label} (${count})`}
              </option>
            );
          })}
        </select>
      </div>

      {/* Sort */}
      <div className="bg-background-base border border-default rounded-md px-2 py-1 text-white/80">
        <select
          value={sortOrder}
          onChange={(e) => onSortChange(e.target.value as SortOrder)}
          aria-label="照片排序方式"
          className="focus-ring bg-transparent border-none outline-none text-white cursor-pointer text-xs max-w-[8rem]"
        >
          <option value="time_filename" className="bg-background-base">
            拍摄时间排序
          </option>
          <option value="filename" className="bg-background-base">
            文件名排序
          </option>
          <option value="rating" className="bg-background-base">
            星级最高优先
          </option>
        </select>
      </div>

      {/* FR-10：当前列表来自选片集时常驻标出来 —— 它跨目录，上面两个目录框
          已经不能描述这批照片了。不标出来用户会以为照片还是那个目录里的。 */}
      {albumName && (
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-400/10 border border-amber-400/30 text-[11px] text-amber-100 min-w-0"
          title={`当前照片列表来自选片集：${albumName}`}
        >
          <BookMarked className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="truncate max-w-[12rem]">选片集 {albumName}</span>
          {typeof albumCount === 'number' && (
            <span className="text-amber-200/70 shrink-0">{albumCount} 张</span>
          )}
        </div>
      )}

      {/* A3：搜索只作用于宫格，入口唯一收敛到宫格表头（+ `/` 快捷键），
          不再在全局顶栏再放一个同名按钮导致"两处同名、作用域错位"。 */}

      <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
        {/* View mode segmented control — text labels, not mystery meat */}
        <div
          className="flex items-center bg-background-surface-hover rounded-md p-0.5"
          role="group"
          aria-label="视图检视模式"
        >
          {VIEW_MODES.map((v) => (
            <button
              key={v.mode}
              onClick={() => onViewModeChange(v.mode)}
              className={`focus-ring flex items-center gap-1 px-2 py-0.5 rounded text-[11px] whitespace-nowrap ${
                viewMode === v.mode
                  ? 'bg-white text-black font-medium shadow-sm'
                  : 'text-white/60 hover:text-white hover:bg-white/10'
              } active:scale-[0.96] transition-transform`}
              title={v.hint}
              aria-label={v.hint}
              aria-pressed={viewMode === v.mode}
            >
              {v.icon}
              <span className="pb-[1px]">{v.label}</span>
            </button>
          ))}
        </div>

        {/* Tonal Adjuster Toggle */}
        {onToggleTonalAdjuster && (
          <button
            onClick={onToggleTonalAdjuster}
            disabled={tonalDisabled}
            className={`focus-ring flex items-center gap-1.5 px-3 py-1 rounded-md active:scale-[0.96] transition-colors font-medium whitespace-nowrap ${
              tonalDisabled
                ? 'bg-background-surface-hover text-white/40 cursor-not-allowed'
                : tonalVisible
                  ? 'bg-white text-black shadow-sm'
                  : 'bg-background-surface-hover hover:bg-white/10 text-white'
            }`}
            title={tonalDisabled ? '当前筛选没有照片' : '调色 (快捷键 E)'}
            aria-label="调色面板"
            aria-pressed={tonalVisible}
            aria-expanded={tonalVisible}
            aria-controls="tonal-adjuster-panel"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="pb-[1px]">调色</span>
          </button>
        )}

        {/* Luminar AI Roundtrip */}
        {onOpenLuminar && (
          <button
            onClick={onOpenLuminar}
            disabled={isLuminarRunning}
            className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-background-surface-hover hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md active:scale-[0.96] transition-colors font-medium whitespace-nowrap"
            title="在 Luminar AI 中精修当前照片"
            aria-label="Luminar AI 精修"
          >
            <Sparkles
              className={`w-3.5 h-3.5 ${isLuminarRunning ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span className="pb-[1px]">{isLuminarRunning ? '运行中…' : 'Luminar AI'}</span>
          </button>
        )}

        {/* A6：镜头元数据入口唯一收敛到底栏，撤掉顶栏这处第三入口。 */}

        {/* FR-08：从 XMP 重新读取（切回窗口时会自动读，这里给手动入口） */}
        {onRefreshXmp && (
          <button
            onClick={onRefreshXmp}
            disabled={isRefreshingXmp}
            className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-background-surface-hover hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md active:scale-[0.96] transition-colors font-medium whitespace-nowrap"
            title="从 XMP 重新读取外部改动（切回窗口时会自动读取）"
            aria-label="从 XMP 重新读取"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isRefreshingXmp ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span className="pb-[1px]">{isRefreshingXmp ? '读取中…' : '读 XMP'}</span>
          </button>
        )}

        {/* FR-10：选片集（存为 / 打开 / 缺失报告） */}
        {onOpenAlbum && (
          <button
            onClick={onOpenAlbum}
            className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-background-surface-hover hover:bg-white/10 text-white rounded-md active:scale-[0.96] transition-colors font-medium whitespace-nowrap"
            title="选片集：把这批照片存成清单，或打开已有的清单"
            aria-label="选片集"
          >
            <Library className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="pb-[1px]">选片集</span>
          </button>
        )}

        {/* Batch Export */}
        <button
          onClick={onOpenExportModal}
          className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-background-surface-hover hover:bg-white/10 text-white rounded-md active:scale-[0.96] transition-colors font-medium whitespace-nowrap"
          title="批量挑选导出"
          aria-label="批量挑选导出照片"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="pb-[1px]">导出</span>
        </button>
      </div>
    </div>
  );
};