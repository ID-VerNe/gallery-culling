import { useState, useMemo, useCallback, useRef } from 'react';
import { TopBar } from './components/TopBar';
import { ThumbnailGrid } from './components/ThumbnailGrid';
import { PreviewViewport } from './components/PreviewViewport';
import { BeforeAfterViewport } from './components/BeforeAfterViewport';
import { SplitCompareViewport } from './components/SplitCompareViewport';
import { TonalAdjuster } from './components/TonalAdjuster';
import { BottomBar } from './components/BottomBar';
import { BatchExportModal } from './components/BatchExportModal';
import { SettingsModal } from './components/SettingsModal';
import { MetadataEditorModal } from './components/MetadataEditorModal';
import { ShortcutHelpModal } from './components/ShortcutHelpModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ToastProvider, useToast } from './components/Toast';
import { TaskProgressBar } from './components/TaskProgressBar';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAppSettings } from './hooks/useAppSettings';
import { useAutoUpdate } from './hooks/useAutoUpdate';
import { useCollection } from './hooks/useCollection';
import { useComparePin } from './hooks/useComparePin';
import { useFolderScan } from './hooks/useFolderScan';
import { useBatchOps } from './hooks/useBatchOps';
import { useRatingFlagSync } from './hooks/useRatingFlagSync';
import { useToneEditing } from './hooks/useToneEditing';
import { useSessionDebounce } from './hooks/useSessionDebounce';
import { toLumenGateStatus, useLumenStatus } from './hooks/useLumenStatus';
import { useLumenOrchestration } from './hooks/useLumenOrchestration';
import { useExternalApps } from './hooks/useExternalApps';
import type { ViewportEmptyState } from './components/PreviewViewport';
import {
  PhotoGroupInfo,
  SortOrder,
  ToneAdjustments,
} from './types';
import { DEFAULT_TONE } from './utils/autoTone';


function AppShell() {
  const toast = useToast();

  // 读回设置并回填默认目录。必须在 jpgFolder/rawFolder/sortOrder 的 state
  // 声明之后挂载，所以放在它们后面。
  const { settings, applySettings, persistFolders, lumenRefreshToken } =
    useAppSettings((s) => {
      if (s.defaultJpgFolder) setJpgFolder(s.defaultJpgFolder);
      if (s.defaultRawFolder) setRawFolder(s.defaultRawFolder);
      if (s.sortOrder) setSortOrder(s.sortOrder as SortOrder);
    });
  const { dialog: updateDialog } = useAutoUpdate();

  // 模态框开关（导出 / 设置 / 元数据 / 快捷键帮助）。
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMetadataOpen, setIsMetadataOpen] = useState(false);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);

  const collection = useCollection();
  const {
    groups,
    filteredGroups,
    filterCounts,
    visibleGroups,
    selectedVisibleIndex,
    selectedIndex,
    compareIndex,
    currentGroup,
    filterMode,
    selectedIds,
    gridSearch,
    gridSearchOpen,
    gridSearchFocusToken,
    handleFilterChange,
    handlePrev: selectPrev,
    handleNext: selectNext,
    handleSelectPhoto: selectPhoto,
    setGroups,
    setSelectedIndex,
    setCompareIndex,
    setSelectedIds,
    setFilterMode,
    setGridSearch,
    setGridSearchOpen,
    setGridSearchFocusToken,
  } = collection;


  /**
   * 最新选中索引的 ref 镜像：扫描完成的「用户是否动过」判定需要读**当前值**，
   * 而 handleScanned 是空依赖 useCallback（闭包拿不到最新 state）。
   * 渲染期赋值与 useSessionDebounce 的 sessionRef 同一模式。
   */
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  /** 稳定引用：useFolderScan 的 handleScan 依赖它，内联箭头会让 identity 抖动。 */
  const getSelectedIndex = useCallback(() => selectedIndexRef.current, []);

  /** 乐观更新落回集合：评级、调色保存、AI 蒙版三处共用同一入口。 */
  const patchGroup = useCallback(
    (id: string, patch: Partial<PhotoGroupInfo>) => {
      setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
    },
    [],
  );

  /**
   * 扫描成功后的集合/对比状态更新。
   *
   * 独立成 useCallback：它是 useFolderScan 的入参，每次渲染新建函数会让
   * handleScan 的 identity 抖动，进而触发重扫 effect。
   */
  const rating = useRatingFlagSync({
    currentGroup,
    onGroupPatched: patchGroup,
    selectedCount: selectedIds.size,
  });
  const {
    unsyncedIds,
    pendingBatch,
    setPendingBatch,
    canUndo,
    markSynced,
    markUnsynced,
    rate: handleRate,
    setFlag: handleFlag,
    applyRating,
    applyFlag,
    applyLabel,
    rememberRating,
    retrySync: handleRetrySync,
    clearRatingFlag: handleClearRatingFlag,
    undo: handleUndo,
    clearRatingUndo,
  } = rating;

  const batch = useBatchOps({
    filteredGroups,
    selectedIds,
    onGroupPatched: patchGroup,
    markSynced,
    markUnsynced,
    rememberRating,
    pendingBatch,
  });
  const {
    batchProgress,
    batchCancelling,
    pendingBatchSummary,
    runBatch,
    skipRemaining,
  } = batch;

  const handleScanned = useCallback(
    (
      scanned: PhotoGroupInfo[],
      initialTones: Record<string, ToneAdjustments>,
      historyIndex: number | null,
      selectedIndexAtStart: number | null,
    ) => {
      setGroups(scanned);
      toneSeed(initialTones);
      // 扫描是异步的：若用户在扫描窗口内已经改过选中，恢复会话位置会**覆盖
      // 用户操作**（2026-10-15 e2e run5 实锤：点击 IMG_010 被翻回 IMG_011，
      // 随后的 apply 写错了文件）。快照相等（用户没动过）才按会话恢复。
      const userMovedDuringScan =
        selectedIndexAtStart !== null &&
        selectedIndexAtStart !== selectedIndexRef.current;
      if (userMovedDuringScan) {
        // 尊重用户选择：只把旧索引钳制到新集合范围内，不做会话恢复。
        setSelectedIndex((prev) => Math.max(0, Math.min(prev, scanned.length - 1)));
        setCompareIndex((prev) => Math.max(0, Math.min(prev, scanned.length - 1)));
      } else if (historyIndex !== null && historyIndex < scanned.length) {
        setSelectedIndex(historyIndex);
        setCompareIndex(Math.min(historyIndex + 1, scanned.length - 1));
      } else {
        setSelectedIndex(0);
        setCompareIndex(scanned.length > 1 ? 1 : 0);
      }
      // Drop anything pinned to a photo that no longer exists.
      setPinnedId(null);
    },
    [],
  );

  const scan = useFolderScan({
    onScanned: handleScanned,
    // 重新扫描后旧快照指向的照片可能已不在列表里，撤销会写到一个不该碰的文件上。
    beforeScan: clearRatingUndo,
    persistFolders,
    getSelectedIndex,
  });
  const {
    jpgFolder,
    rawFolder,
    sortOrder,
    isLoading,
    scanError,
    scanTask,
    handleScan,
    handleCancelScan,
    handleBrowseJpg,
    handleBrowseRaw,
    setJpgFolder,
    setRawFolder,
    setSortOrder,
    handleSortOrderChange,
    dismissScanError,
  } = scan;
  const [isHoldOriginal, setIsHoldOriginal] = useState(false);

  // LUMEN RAW engine handshake (P0). Zero requests while disabled — the hook
  // itself owns the 1.5s delay and the silent degradation.
  // N-12：主动重探令牌。`useLumenStatus` 依赖 `enabled`/`cliPath`，但用户可能在
  // 弹窗里改了路径又撤销，或引擎在运行中才装好——保存设置后自增这个令牌，让
  // 引擎状态**当场刷新**，而不是停留在启动时的陈旧快照。
  const lumenStatus = useLumenStatus(
    settings?.lumenEnabled ?? false,
    settings?.lumenCliPath ?? '',
    lumenRefreshToken,
  );
  // 只有握手成功（版本 1.6.0 匹配）才出现 LUMEN RAW 专属入口
  const lumenAvailable = lumenStatus.available;
  // LUMEN 前端编排（FE-06）：能力探测、AI 蒙版、宫格开关、评级同步。
  const lumen = useLumenOrchestration({
    available: lumenAvailable,
    gridThumbnails: settings?.lumenGridThumbnails ?? false,
    defaultRawFolder: settings?.defaultRawFolder,
    currentGroup,
    onRescan: handleScan,
    jpgFolder,
  });
  // 外部应用交互与视图模式（FE-06）：Luminar 往返的终点就是切视图，同单元。
  const external = useExternalApps({
    currentGroup,
    photoshopPath: settings?.photoshopPath,
    onGroupPatched: patchGroup,
  });

  const tone = useToneEditing({
    currentGroup,
    viewMode: external.viewMode,
    lumenAvailable,
    lumenCapsAiMasks: lumen.caps?.aiMasks,
    onGroupsPatched: patchGroup,
    onMasksLoaded: lumen.onMasksLoaded,
  });
  const {
    toneMap,
    tonalPanelVisible,
    toneDivergent,
    isSavingTone,
    isAutoToning,
    pendingLeaveTone,
    currentTone,
    setPreviewImage,
    handleToggleTonalPanel,
    handleToneChange,
    handleResetTone,
    guardToneLeave,
    closeTonePanel,
    handleAutoTone,
    handleSaveTone,
    handleApplyLumenPreset,
    handleApplyLumenMask,
    setPendingLeaveTone,
    setShowTonalPanel,
    seedToneMap: toneSeed,
    toneDirty,
  } = tone;

  const swapIndices = useCallback(() => {
    const temp = selectedIndex;
    setSelectedIndex(compareIndex);
    setCompareIndex(temp);
  }, [selectedIndex, compareIndex]);

  const pin = useComparePin({
    filteredGroups,
    selectedIndex,
    compareIndex,
    currentGroup,
    onSwapIndices: swapIndices,
  });
  const {
    pinnedId,
    isPinnedOnLeft,
    isLeftPinned,
    isRightPinned,
    leftCompareGroup,
    rightCompareGroup,
    togglePinLeft: handleTogglePinLeft,
    togglePinRight: handleTogglePinRight,
    togglePinCurrent: handleTogglePinCurrent,
    togglePinBenchmark: handleTogglePinBenchmark,
    swap: handleSwapCompare,
    setPinnedId,
  } = pin;

  // 「有基准且基准在左」的对比模式下，± 与宫格点击作用在**对比候选**而非当前
  // 照片 —— 用户此时盯着右窗格。判定留在 AppShell（它是唯一同时持有
  // viewMode / pinnedId / isPinnedOnLeft 的地方），useCollection 只管改索引。
  const isCompareNav = external.viewMode === 'split' && !!pinnedId && isPinnedOnLeft;
  const handlePrev = useCallback(
    () => selectPrev(isCompareNav),
    [selectPrev, isCompareNav],
  );
  const handleNext = useCallback(
    () => selectNext(isCompareNav, filteredGroups.length),
    [selectNext, isCompareNav, filteredGroups.length],
  );
  const handleSelectPhoto = useCallback(
    (visibleIndex: number) =>
      selectPhoto(visibleIndex, {
        isCompareNav,
        hasPinned: !!pinnedId,
        total: filteredGroups.length,
      }),
    [selectPhoto, isCompareNav, pinnedId, filteredGroups.length],
  );

  const handleHoldOriginalStart = useCallback(() => {
    setIsHoldOriginal(true);
  }, []);

  const handleHoldOriginalEnd = useCallback(() => {
    setIsHoldOriginal(false);
  }, []);

  // Save session when index changes — debounced (M-17).
  //
  // 原先 `selectedIndex` 每变一次就一次 IPC + 一次 SQLite 写：连按方向键约
  // 10 张/秒 = 每秒 10 次磁盘写，而只有最后一次索引有价值。防抖窗口与四个
  // flush 点（目录切换 / 卸载 / 页面隐藏 / Tauri 关闭请求）都在 hook 内部。
  useSessionDebounce({
    jpgFolder,
    rawFolder,
    lastIndex: selectedIndex,
    sortOrder,
  });

  // Metadata batch updated handler
  const handleMetadataUpdated = useCallback(
    (
      targetIds: string[],
      lensModel: string,
      focalLength: string,
      aperture: string,
    ) => {
      setGroups((prev) =>
        prev.map((g) => {
          if (targetIds.includes(g.id)) {
            return {
              ...g,
              hasXmp: true,
              exif: {
                ...g.exif,
                lensModel: lensModel || g.exif?.lensModel,
                focalLength: focalLength || g.exif?.focalLength,
                aperture: aperture || g.exif?.aperture,
              },
            };
          }
          return g;
        }),
      );
    },
    [],
  );

  // C3：切图/选片也走保护 —— 调色有未保存改动时先确认，避免切走即丢失。
  const guardedPrev = useCallback(
    () => guardToneLeave(handlePrev),
    [guardToneLeave, handlePrev],
  );
  const guardedNext = useCallback(
    () => guardToneLeave(handleNext),
    [guardToneLeave, handleNext],
  );
  const guardedSelect = useCallback(
    (i: number) => guardToneLeave(() => handleSelectPhoto(i)),
    [guardToneLeave, handleSelectPhoto],
  );

  const handleFocusSearch = useCallback(() => {
    // The grid has to be mounted for the field to exist.
    setShowTonalPanel(false);
    setGridSearchOpen(true);
    setGridSearchFocusToken((t) => t + 1);
  }, [setShowTonalPanel]);

  // Register single-handed keyboard shortcuts
  useKeyboardShortcuts({
    onPrev: guardedPrev,
    onNext: guardedNext,
    // B1：打分/旗标入口分流 —— 多选 ≥2 时弹批量确认，否则单张即时写入。
    onRate: applyRating,
    onFlag: applyFlag,
    // 6/7/8/9 设红/黄/绿/蓝，Shift+6 设紫；重复按同一个色标 = 取消。
    onLabel: applyLabel,
    // B2：`0`/`U` 走合并后的单次写盘（清除评级 + 旗标）。
    onClear: () => void handleClearRatingFlag(),
    onOpenExternal: external.openExternal,
    onToggleCompare: external.toggleCompare,
    onSwapCompare: handleSwapCompare,
    onTogglePinReference: handleTogglePinBenchmark,
    onPinLeft: handleTogglePinLeft,
    onPinRight: handleTogglePinRight,
    onTogglePinCurrent: handleTogglePinCurrent,
    onOpenMetadataModal: () => setIsMetadataOpen(true),
    onToggleBeforeAfter: external.toggleBeforeAfter,
    onToggleTonalPanel: handleToggleTonalPanel,
    onHoldOriginalStart: handleHoldOriginalStart,
    onHoldOriginalEnd: handleHoldOriginalEnd,
    onFocusSearch: handleFocusSearch,
    onOpenShortcutHelp: () => setIsShortcutHelpOpen(true),
    onOpenExport: () => setIsExportOpen(true),
    onUndo: () => void handleUndo(),
  });

  // Empty-state copy. "No folder loaded" and "filter matched nothing" are
  // different problems and must not share a message.
  const viewportEmptyState = useMemo<ViewportEmptyState>(() => {
    if (groups.length === 0) {
      return {
        title: '未加载照片',
        // A5/A7：说清楚"该选什么"，去掉无操作信息的营销辞令。
        description:
          '请选择存放 JPG 的文件夹用于浏览与选片；RAW 文件夹为可选，选了即可用 LUMEN RAW 引擎预览原片。',
        actionLabel: '选择 JPG 文件夹',
        onAction: handleBrowseJpg,
      };
    }
    if (filteredGroups.length === 0) {
      return {
        title: '当前筛选下没有照片',
        description:
          '还没有照片匹配这个筛选条件。先给照片打星或标记保留，或者切换到「全部照片」。',
        actionLabel: '显示全部照片',
        onAction: () => setFilterMode('all'),
      };
    }
    return {
      title: '未选择照片',
      description: '从右侧宫格列表中选择一张照片。',
    };
  }, [groups.length, filteredGroups.length, handleBrowseJpg]);

  return (
    <div className="flex flex-col h-screen w-screen bg-background-base text-white overflow-hidden antialiased">
      {/* Top Controls Bar */}
      <TopBar
        jpgFolder={jpgFolder}
        rawFolder={rawFolder}
        onJpgFolderChange={setJpgFolder}
        onRawFolderChange={setRawFolder}
        onBrowseJpg={handleBrowseJpg}
        onBrowseRaw={handleBrowseRaw}
        onScan={handleScan}
        isLoading={isLoading || scanTask.isRunning}
        scanProgress={
          scanTask.progress
            ? { processed: scanTask.progress.processed, total: scanTask.progress.total }
            : undefined
        }
        scanError={scanError}
        onDismissScanError={dismissScanError}
        filterMode={filterMode}
        onFilterChange={handleFilterChange}
        filterCounts={filterCounts}
        sortOrder={sortOrder}
        onSortChange={handleSortOrderChange}
        viewMode={external.viewMode}
        onViewModeChange={external.setViewMode}
        onOpenExportModal={() => setIsExportOpen(true)}
        onOpenSettingsModal={() => setIsSettingsOpen(true)}
        onToggleTonalAdjuster={handleToggleTonalPanel}
        tonalPanelVisible={tonalPanelVisible}
        tonalToggleDisabled={!currentGroup}
        onOpenLuminar={external.openLuminar}
        isLuminarRunning={external.isLuminarRunning}
      />

      {/* Scan progress (M-05) — 空闲时不渲染，不留空白条 */}
      <TaskProgressBar
        className="px-4 py-2 border-b border-default bg-background-header shrink-0"
        isRunning={scanTask.isRunning}
        processed={scanTask.progress?.processed ?? 0}
        total={scanTask.progress?.total ?? 0}
        label="正在扫描照片"
        onCancel={handleCancelScan}
        cancelRequested={scanTask.cancelRequested}
        cancelStalled={scanTask.cancelStalled}
        onForceFinish={scanTask.finish}
      />

      {/* B1：批量写盘进度（逐张写 XMP，可跳过剩余） */}
      <TaskProgressBar
        className="px-4 py-2 border-b border-default bg-background-header shrink-0"
        isRunning={batchProgress !== null}
        processed={batchProgress?.processed ?? 0}
        total={batchProgress?.total ?? 0}
        label="正在批量写入 XMP"
        onCancel={skipRemaining}
        cancelRequested={batchCancelling}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Center Viewport */}
        {external.viewMode === 'single' && (
          <PreviewViewport
            group={currentGroup}
            tone={currentTone}
            isHoldOriginal={isHoldOriginal}
            lumenStatus={lumenStatus}
            onPrev={guardedPrev}
            onNext={guardedNext}
            onRate={applyRating}
            onFlag={applyFlag}
            onOpenExternal={external.openExternal}
            onOpenLuminar={external.openLuminar}
            onToggleTonalAdjuster={handleToggleTonalPanel}
            isTonalPanelOpen={tonalPanelVisible}
            isLuminarRunning={external.isLuminarRunning}
            emptyState={viewportEmptyState}
            onImageElement={setPreviewImage}
          />
        )}

        {external.viewMode === 'before_after' && (
          <BeforeAfterViewport
            group={currentGroup}
            tone={currentTone}
            isHoldOriginal={isHoldOriginal}
            onRate={applyRating}
            onFlag={applyFlag}
            onOpenLuminar={external.openLuminar}
            onToggleTonalAdjuster={handleToggleTonalPanel}
            isTonalPanelOpen={tonalPanelVisible}
            isLuminarRunning={external.isLuminarRunning}
            emptyState={viewportEmptyState}
            lumenStatus={lumenStatus}
          />
        )}

        {external.viewMode === 'split' && (
          <SplitCompareViewport
            leftGroup={leftCompareGroup}
            rightGroup={rightCompareGroup}
            isLeftPinned={isLeftPinned}
            isRightPinned={isRightPinned}
            onTogglePinLeft={handleTogglePinLeft}
            onTogglePinRight={handleTogglePinRight}
            onSwap={handleSwapCompare}
            onRate={(g, r) => handleRate(r, g)}
            onFlag={(g, f) => handleFlag(f, g)}
            lumenStatus={lumenStatus}
            getTone={(g) => toneMap[g.id] || g.tone}
            /* C7：对比视图补翻页入口，与单图一致 */
            onPrev={guardedPrev}
            onNext={guardedNext}
          />
        )}        {/* Right Sidebar (Thumbnail Grid OR Tonal Adjuster) */}
        <div className="w-[390px] h-full shrink-0 bg-background-base">
          {tonalPanelVisible ? (
            <TonalAdjuster
              tone={currentTone || DEFAULT_TONE}
              onChange={handleToneChange}
              onReset={handleResetTone}
              onAuto={handleAutoTone}
              autoTonePending={isAutoToning}
              onSave={handleSaveTone}
              isSaving={isSavingTone}
              divergent={toneDivergent}
              masks={lumen.masks}
              onApplyMask={
                lumen.caps?.aiMasks && lumenAvailable
                  ? handleApplyLumenMask
                  : undefined
              }
              lumenPresets={lumen.caps?.presets ?? []}
              aiAvailable={lumen.caps?.aiMasks ?? false}
              /* 换照片（含箭头键切图，面板不卸载）时重置「已套用预设」显示 */
              photoId={currentGroup?.id}
              onApplyPreset={lumenAvailable ? handleApplyLumenPreset : undefined}
              onClose={closeTonePanel}
              dirty={toneDirty}
            />
          ) : (
            <ThumbnailGrid
              groups={visibleGroups}
              selectedIndex={selectedVisibleIndex}
              pinnedId={pinnedId}
              onSelect={guardedSelect}
              searchQuery={gridSearch}
              searchOpen={gridSearchOpen}
              searchFocusToken={gridSearchFocusToken}
              onSearchQueryChange={setGridSearch}
              onFilterReset={() => setFilterMode('all')}
              onSearchOpenChange={(open) => {
                setGridSearchOpen(open);
                if (!open) setGridSearch('');
                else setGridSearchFocusToken((t) => t + 1);
              }}
              totalLoaded={filteredGroups.length}
              lumenThumbnails={lumen.gridThumbs}
              candidateId={rightCompareGroup?.id}
              /* B1：多选（Ctrl/Shift 点选、Ctrl+A、方向键重置为单选） */
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              /* B6：写盘失败的照片显示持久"未同步"角标 + 点击重试 */
              unsyncedIds={unsyncedIds}
              onRetrySync={handleRetrySync}
            />
          )}
        </div>
      </div>

      {/* Bottom Status Bar */}
      <BottomBar
        currentGroup={currentGroup}
        currentIndex={selectedIndex}
        totalCount={filteredGroups.length}
        onOpenExternal={external.openExternal}
        onOpenMetadataModal={() => setIsMetadataOpen(true)}
        onOpenShortcutHelp={() => setIsShortcutHelpOpen(true)}
        searchActive={gridSearch.trim().length > 0}
        searchResultCount={visibleGroups.length}
        onUndo={() => void handleUndo()}
        canUndo={canUndo}
      />

      {/* Batch Export Modal */}
      <BatchExportModal
        isOpen={isExportOpen}
        onClose={() => setIsExportOpen(false)}
        groups={groups}
        lumenStatus={toLumenGateStatus(lumenStatus)}
        lumenDetail={lumenStatus.detail}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onError={(m) => toast.error(m)}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSettingsSaved={applySettings}
        onError={(m) => toast.error(m)}
        lumenStatus={lumenStatus}
        capabilities={lumen.caps}
        onSyncRatings={lumenAvailable ? lumen.syncRatings : undefined}
        savedLumenEnabled={settings?.lumenEnabled ?? false}
      />

      {/* Manual Lens Metadata Editor Modal */}
      <MetadataEditorModal
        isOpen={isMetadataOpen}
        onClose={() => setIsMetadataOpen(false)}
        currentGroup={currentGroup}
        filteredGroups={filteredGroups}
        allGroups={groups}
        onMetadataUpdated={handleMetadataUpdated}
        onError={(m) => toast.error(m)}
      />

      {/* Keyboard & mouse reference */}
      <ShortcutHelpModal
        isOpen={isShortcutHelpOpen}
        onClose={() => setIsShortcutHelpOpen(false)}
      />

      {updateDialog}

      {/* B1：批量写盘前的确认（≥2 张才进入这里，写盘不可轻易回退） */}
      <ConfirmDialog
        isOpen={pendingBatch !== null}
        onClose={() => setPendingBatch(null)}
        onConfirm={() => {
          const action = pendingBatch;
          setPendingBatch(null);
          if (action) void runBatch(action);
        }}
        title="确认批量修改"
        message={`${pendingBatchSummary}\n\n改动会立即写入每张照片的 XMP 侧边栏，无法整批撤销。`}
        confirmLabel="写入 XMP"
        cancelLabel="取消"
        destructive={pendingBatch?.kind === 'clear'}
      />

      {/* C3：调色未保存时离开（翻页/切换照片/关面板）需要二次确认 */}
      <ConfirmDialog
        isOpen={pendingLeaveTone !== null}
        onClose={() => setPendingLeaveTone(null)}
        onConfirm={() => {
          const action = pendingLeaveTone;
          setPendingLeaveTone(null);
          action?.run();
        }}
        title="调色改动尚未保存"
        message={
          '当前照片的调色改动还没有保存到 XMP / 工程，离开后这些改动会丢失。\n\n是否放弃改动并继续？'
        }
        confirmLabel="放弃改动"
        cancelLabel="继续编辑"
        destructive
      />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}
