import React from 'react';
import {
  Aperture,
  FolderOpen,
  RefreshCw,
  SlidersHorizontal,
  Download,
  Columns2,
  Maximize2,
  Settings,
  Split,
  Sparkles,
} from 'lucide-react';
import { FilterMode, SortOrder, ViewMode } from '../types';
import { FILTER_OPTIONS } from '../utils/filterMatch';

interface TopBarProps {
  jpgFolder: string;
  rawFolder: string;
  onJpgFolderChange: (val: string) => void;
  onRawFolderChange: (val: string) => void;
  onBrowseJpg: () => void;
  onBrowseRaw: () => void;
  onScan: () => void;
  isLoading: boolean;
  filterMode: FilterMode;
  onFilterChange: (val: FilterMode) => void;
  /**
   * 各筛选档的计数（M-14）。缺省时**优雅降级**：只显示档位文案，不显示 `(N)`，
   * 既不显示 0 也不崩溃 —— 让 TopBar 在宿主尚未接线时也可独立编译/测试。
   */
  filterCounts?: Record<FilterMode, number>;
  sortOrder: SortOrder;
  onSortChange: (val: SortOrder) => void;
  viewMode: ViewMode;
  onViewModeChange: (val: ViewMode) => void;
  onOpenExportModal: () => void;
  onOpenSettingsModal: () => void;
  onToggleTonalAdjuster?: () => void;
  /**
   * 调色面板的**派生真值**（= 用户意图 && 当前有可调对象）。
   *
   * 此前本组件同时接受 `showTonalPanel`（裸意图）与 `tonalPanelVisible`
   * （派生真值），缺省时 `tonalPanelVisible ?? !!showTonalPanel` —— 一条
   * 自承为「向后兼容」的双轨。违反 CLAUDE.md「不保留向后兼容，移除过时路径」。
   * 现只保留派生真值一个来源，双轨已删。
   */
  tonalPanelVisible: boolean;
  /** 当前筛选没有照片：按钮置灰并说明这是 no-op，而不是"按了没反应"。 */
  tonalToggleDisabled?: boolean;
  onOpenLuminar?: () => void;
  isLuminarRunning?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  jpgFolder,
  rawFolder,
  onJpgFolderChange,
  onRawFolderChange,
  onBrowseJpg,
  onBrowseRaw,
  onScan,
  isLoading,
  filterMode,
  onFilterChange,
  filterCounts,
  sortOrder,
  onSortChange,
  viewMode,
  onViewModeChange,
  onOpenExportModal,
  onOpenSettingsModal,
  onToggleTonalAdjuster,
  tonalPanelVisible,
  tonalToggleDisabled,
  onOpenLuminar,
  isLuminarRunning,
}) => {
  const viewModes: Array<{
    mode: ViewMode;
    label: string;
    hint: string;
    icon: React.ReactNode;
  }> = [
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

  // M-10：按下态由宿主传入的派生真值决定（用户意图 && 当前有可调对象）。
  const tonalVisible = tonalPanelVisible;
  const tonalDisabled = !!tonalToggleDisabled;

  return (
    <header aria-label="Gallery Culling 应用工具栏" className="bg-background-base/80 backdrop-blur-md border-b border-default flex flex-col gap-1 px-3 py-1.5 shrink-0 text-xs">
      {/* -----------------------------------------------------------
          Row 1 — where the photos come from.
          Two independent rows instead of one 56px bar: the previous
          single row needed ~1272px of content, so on a 1180px window
          the path fields collapsed to their labels and the scan button
          stacked its text vertically (F-01).
          ----------------------------------------------------------- */}
      <div className="flex items-center gap-2 min-w-0">
        {/* 应用标识（A11）：截图 / 切窗时能一眼答出"这是什么应用"。
            图标常显，应用名在窄窗口下让位给路径输入框。 */}
        <div
          role="img"
          aria-label="Gallery Culling — 摄影选片工具"
          className="flex items-center gap-1.5 pl-1 pr-0.5 shrink-0 select-none"
          title="Gallery Culling — 摄影选片工具"
        >
          <Aperture className="w-4 h-4 text-white/80" aria-hidden="true" />
          <span className="text-[11px] font-semibold text-white/90 whitespace-nowrap hidden xl:inline">
            Gallery Culling
          </span>
        </div>

        {/* JPG Folder */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-background-surface-hover rounded-md px-2.5 py-1 focus-within:bg-white/10 transition-colors">
          <label
            htmlFor="topbar-jpg-input"
            className="text-white/60 font-semibold whitespace-nowrap cursor-pointer"
          >
            JPG:
          </label>
          <input
            id="topbar-jpg-input"
            type="text"
            className="bg-transparent border-none outline-none text-white w-full min-w-0 font-mono text-[11px]"
            value={jpgFolder}
            onChange={(e) => onJpgFolderChange(e.target.value)}
            placeholder="选择或输入 JPG 文件夹路径…"
            aria-label="JPG 照片文件夹路径"
          />
          <button
            onClick={onBrowseJpg}
            className="focus-ring text-white/60 hover:text-white p-1 rounded hover:bg-white/10 active:scale-[0.96] transition-transform shrink-0"
            title="浏览 JPG 文件夹"
            aria-label="浏览选择 JPG 文件夹"
          >
            <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* RAW Folder (optional) */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-background-surface-hover rounded-md px-2.5 py-1 focus-within:bg-white/10 transition-colors">
          <label
            htmlFor="topbar-raw-input"
            className="text-white/60 font-semibold whitespace-nowrap cursor-pointer"
          >
            RAW:
          </label>
          <input
            id="topbar-raw-input"
            type="text"
            className="bg-transparent border-none outline-none text-white w-full min-w-0 font-mono text-[11px]"
            value={rawFolder}
            onChange={(e) => onRawFolderChange(e.target.value)}
            placeholder="可选：RAW 文件夹路径…"
            aria-label="RAW 原片文件夹路径（可选）"
          />
          <button
            onClick={onBrowseRaw}
            className="focus-ring text-white/60 hover:text-white p-1 rounded hover:bg-white/10 active:scale-[0.96] transition-transform shrink-0"
            title="浏览 RAW 文件夹"
            aria-label="浏览选择 RAW 文件夹"
          >
            <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* Scan / Refresh */}
        <button
          onClick={onScan}
          disabled={isLoading || !jpgFolder.trim()}
          className="focus-ring flex items-center gap-1.5 px-3.5 py-1 bg-white hover:bg-white/90 text-black active:scale-[0.96] disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium transition-transform shadow-sm shrink-0 whitespace-nowrap"
          aria-label={isLoading ? '正在扫描照片目录' : '扫描照片目录'}
          title={
            isLoading
              ? '正在扫描照片目录…'
              : !jpgFolder.trim()
                ? '请先选择或输入 JPG 文件夹'
                : '扫描照片目录'
          }
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span className="pb-[1px]">{isLoading ? '扫描中…' : '扫描照片'}</span>
        </button>

        <div className="ml-auto" />

        {/* Settings */}
        <button
          onClick={onOpenSettingsModal}
          className="focus-ring p-1.5 text-white/60 hover:text-white hover:bg-background-surface-hover rounded-md active:scale-[0.96] transition-transform shrink-0"
          title="设置"
          aria-label="设置"
        >
          <Settings className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* -----------------------------------------------------------
          Row 2 — what to look at and what to do with it.
          Wraps instead of clipping when the window is narrow.
          ----------------------------------------------------------- */}
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        {/* Filter */}
        <div className="flex items-center gap-1.5 bg-background-base border border-default rounded-md px-2 py-1 text-white/80">
          <SlidersHorizontal
            className="w-3.5 h-3.5 text-white/60"
            aria-hidden="true"
          />
          <select
            value={filterMode}
            onChange={(e) => onFilterChange(e.target.value as FilterMode)}
            aria-label="照片筛选过滤"
            title="按保留 / 淘汰 / 星级筛选照片"
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

        {/* A3：搜索只作用于宫格，入口唯一收敛到宫格表头（+ `/` 快捷键），
            不再在全局顶栏再放一个同名按钮导致"两处同名、作用域错位"。 */}

        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {/* View mode segmented control — text labels, not mystery meat */}
          <div
            className="flex items-center bg-background-surface-hover rounded-md p-0.5"
            role="group"
            aria-label="视图检视模式"
          >
            {viewModes.map((v) => (
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
              <span className="pb-[1px]">
                {isLuminarRunning ? '运行中…' : 'Luminar AI'}
              </span>
            </button>
          )}

          {/* A6：镜头元数据入口唯一收敛到底栏，撤掉顶栏这处第三入口。 */}

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
    </header>
  );
};
