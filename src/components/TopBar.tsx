import React from 'react';
import { SourceRow, type SourceRowProps } from './SourceRow';
import { ToolbarRow, type ToolbarRowProps } from './ToolbarRow';

/**
 * 顶栏 = 两行语义独立的胶水。
 *
 * Row 1（SourceRow）回答"照片从哪来"，Row 2（ToolbarRow）回答"看什么 / 做什么"。
 * 拆分前本文件是 359 行的单组件，两个 `<div>` 之间不共享任何局部变量，
 * 边界天然，因此直接按语义切分而不引入任何中间抽象。
 *
 * props 刻意**显式转发**而不是 `{...props}` 铺开：两行各自的 prop 面
 * 是这次拆分要澄清的东西，铺开会让边界重新糊回去。
 */
export type TopBarProps = SourceRowProps & ToolbarRowProps;

export const TopBar: React.FC<TopBarProps> = ({
  // Row 1 — SourceRow
  jpgFolder,
  rawFolder,
  onJpgFolderChange,
  onRawFolderChange,
  onBrowseJpg,
  onBrowseRaw,
  onScan,
  isLoading,
  scanProgress,
  scanError,
  onDismissScanError,
  onOpenSettingsModal,
  scanBlockedReason,

  // Row 2 — ToolbarRow
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
  onImportLrcat,
}) => (
  <header
    aria-label="Gallery Culling 应用工具栏"
    className="bg-background-base/80 backdrop-blur-md border-b border-default flex flex-col gap-1 px-3 py-1.5 shrink-0 text-xs"
  >
    {/* -----------------------------------------------------------
        Row 1 — where the photos come from.
        Two independent rows instead of one 56px bar: the previous
        single row needed ~1272px of content, so on a 1180px window
        the path fields collapsed to their labels and the scan button
        stacked its text vertically (F-01).
        ----------------------------------------------------------- */}
    <SourceRow
      jpgFolder={jpgFolder}
      rawFolder={rawFolder}
      onJpgFolderChange={onJpgFolderChange}
      onRawFolderChange={onRawFolderChange}
      onBrowseJpg={onBrowseJpg}
      onBrowseRaw={onBrowseRaw}
      onScan={onScan}
      isLoading={isLoading}
      scanProgress={scanProgress}
      scanError={scanError}
      onDismissScanError={onDismissScanError}
      onOpenSettingsModal={onOpenSettingsModal}
      scanBlockedReason={scanBlockedReason}
    />

    {/* -----------------------------------------------------------
        Row 2 — what to look at and what to do with it.
        Wraps instead of clipping when the window is narrow.
        ----------------------------------------------------------- */}
    <ToolbarRow
      filterMode={filterMode}
      onFilterChange={onFilterChange}
      filterCounts={filterCounts}
      sortOrder={sortOrder}
      onSortChange={onSortChange}
      viewMode={viewMode}
      onViewModeChange={onViewModeChange}
      onOpenExportModal={onOpenExportModal}
      onToggleTonalAdjuster={onToggleTonalAdjuster}
      tonalPanelVisible={tonalPanelVisible}
      tonalToggleDisabled={tonalToggleDisabled}
      onOpenLuminar={onOpenLuminar}
      isLuminarRunning={isLuminarRunning}
      onRefreshXmp={onRefreshXmp}
      isRefreshingXmp={isRefreshingXmp}
      onOpenAlbum={onOpenAlbum}
      albumName={albumName}
      albumCount={albumCount}
      onImportLrcat={onImportLrcat}
    />
  </header>
);