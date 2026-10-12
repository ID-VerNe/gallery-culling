import React from 'react';
import {
  FolderOpen,
  RefreshCw,
  SlidersHorizontal,
  Download,
  Columns2,
  Maximize2,
  Settings,
  Sliders,
  Split,
  Sparkles,
  Search,
} from 'lucide-react';
import { FilterMode, SortOrder, ViewMode } from '../types';

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
  sortOrder: SortOrder;
  onSortChange: (val: SortOrder) => void;
  viewMode: ViewMode;
  onViewModeChange: (val: ViewMode) => void;
  onOpenExportModal: () => void;
  onOpenSettingsModal: () => void;
  onOpenMetadataModal?: () => void;
  onToggleTonalAdjuster?: () => void;
  showTonalPanel?: boolean;
  onOpenLuminar?: () => void;
  isLuminarRunning?: boolean;
  /** True while the grid search field is open. */
  isGridSearchOpen?: boolean;
  onToggleGridSearch?: () => void;
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
  sortOrder,
  onSortChange,
  viewMode,
  onViewModeChange,
  onOpenExportModal,
  onOpenSettingsModal,
  onOpenMetadataModal,
  onToggleTonalAdjuster,
  showTonalPanel,
  onOpenLuminar,
  isLuminarRunning,
  isGridSearchOpen,
  onToggleGridSearch,
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

  return (
    <header className="bg-background-base/80 backdrop-blur-md border-b border-white/10 flex flex-col gap-1 px-3 py-1.5 shrink-0 text-xs">
      {/* -----------------------------------------------------------
          Row 1 — where the photos come from.
          Two independent rows instead of one 56px bar: the previous
          single row needed ~1272px of content, so on a 1180px window
          the path fields collapsed to their labels and the scan button
          stacked its text vertically (F-01).
          ----------------------------------------------------------- */}
      <div className="flex items-center gap-2 min-w-0">
        {/* JPG Folder */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-white/5 rounded-md px-2.5 py-1 focus-within:bg-white/10 transition-colors">
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
        <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-white/5 rounded-md px-2.5 py-1 focus-within:bg-white/10 transition-colors">
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
          className="focus-ring p-1.5 text-white/60 hover:text-white hover:bg-white/5 rounded-md active:scale-[0.96] transition-transform shrink-0"
          title="首选项与工具设置"
          aria-label="首选项与工具设置"
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
        <div className="flex items-center gap-1.5 bg-background-base border border-white/10 rounded-md px-2 py-1 text-white/80">
          <SlidersHorizontal
            className="w-3.5 h-3.5 text-white/60"
            aria-hidden="true"
          />
          <select
            value={filterMode}
            onChange={(e) => onFilterChange(e.target.value as FilterMode)}
            aria-label="照片筛选过滤"
            className="focus-ring bg-transparent border-none outline-none text-white cursor-pointer text-xs max-w-[8.5rem]"
          >
            <option value="all" className="bg-background-base">
              全部照片
            </option>
            <option value="pick" className="bg-background-base">
              仅已保留 (Pick)
            </option>
            <option value="reject" className="bg-background-base">
              已淘汰 (Reject)
            </option>
            <option value="unmarked" className="bg-background-base">
              未标记
            </option>
            <option value="star3" className="bg-background-base">
              ★3 星以上
            </option>
            <option value="star5" className="bg-background-base">
              ★5 星精选
            </option>
          </select>
        </div>

        {/* Sort */}
        <div className="bg-background-base border border-white/10 rounded-md px-2 py-1 text-white/80">
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

        {/* Search (progressive disclosure — the grid keeps its full width) */}
        {onToggleGridSearch && (
          <button
            onClick={onToggleGridSearch}
            className={`focus-ring flex items-center gap-1.5 px-2.5 py-1 rounded-md active:scale-[0.96] transition-colors font-medium ${
              isGridSearchOpen
                ? 'bg-white text-black shadow-sm'
                : 'bg-white/5 hover:bg-white/10 text-white'
            }`}
            title="在宫格列表中按文件名搜索 (快捷键 /)"
            aria-label="在宫格列表中按文件名搜索"
            aria-pressed={isGridSearchOpen}
          >
            <Search className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="pb-[1px]">搜索</span>
          </button>
        )}

        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {/* View mode segmented control — text labels, not mystery meat */}
          <div
            className="flex items-center bg-white/5 rounded-md p-0.5"
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
              className={`focus-ring flex items-center gap-1.5 px-3 py-1 rounded-md active:scale-[0.96] transition-colors font-medium whitespace-nowrap ${
                showTonalPanel
                  ? 'bg-white text-black shadow-sm'
                  : 'bg-white/5 hover:bg-white/10 text-white'
              }`}
              title="调色 (快捷键 E)"
              aria-label="轻量调色预检面板"
              aria-pressed={showTonalPanel}
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
              className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md active:scale-[0.96] transition-colors font-medium whitespace-nowrap"
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

          {/* Manual Lens / Metadata Editor */}
          <button
            onClick={onOpenMetadataModal}
            className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-white/5 hover:bg-white/10 text-white rounded-md active:scale-[0.96] transition-colors font-medium whitespace-nowrap"
            title="编辑镜头元数据 (快捷键 M)"
            aria-label="手动镜头与元数据批量编辑"
          >
            <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="pb-[1px]">镜头信息</span>
          </button>

          {/* Batch Export */}
          <button
            onClick={onOpenExportModal}
            className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-white/5 hover:bg-white/10 text-white rounded-md active:scale-[0.96] transition-colors font-medium whitespace-nowrap"
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
