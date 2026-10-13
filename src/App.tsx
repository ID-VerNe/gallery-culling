import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
import { useToneEditing } from './hooks/useToneEditing';
import { useSessionDebounce } from './hooks/useSessionDebounce';
import { useRatingUndo } from './hooks/useRatingUndo';
import { useLumenStatus } from './hooks/useLumenStatus';
import type { ViewportEmptyState } from './components/PreviewViewport';
import {
  CullFlag,
  LumenCapabilities,
  PhotoFileInfo,
  PhotoGroupInfo,
  SortOrder,
  ViewMode,
  ToneAdjustments,
} from './types';
import { api } from './services/api';
import { DEFAULT_TONE } from './utils/autoTone';
import { groupPath } from './utils/groupPath';


/** L-11 撤销提示里用到的旗标文案（与宫格/底栏的叫法保持一致）。 */
const FLAG_LABELS: Record<CullFlag, string> = {
  pick: '保留',
  reject: '淘汰',
  none: '未标记',
};

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

  // B1：批量打分/标记的进度。前端逐张写盘、自行推进度条（无后端进度事件），
// 与扫描互不干扰。
  const [batchProgress, setBatchProgress] = useState<{
    processed: number;
    total: number;
  } | null>(null);
  /** 批量执行中"跳过剩余"的协作标志（读取走 ref，避免闭包陈旧）。 */
  const batchCancelRef = useRef(false);
  const [batchCancelling, setBatchCancelling] = useState(false);

  // L-11：星级/旗标的单步撤销。`1..5/p/x/0` 按下即写 .xmp 且原先无路可退，
  // 一次误触只能手改侧边栏或回 Lightroom。这里保留一步回退（Ctrl/Cmd+Z，
  // 或底栏的「撤销」按钮）。
  const {
    canUndo,
    remember: rememberRating,
    take: takeRatingSnapshot,
    clear: clearRatingUndo,
  } = useRatingUndo();

  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMetadataOpen, setIsMetadataOpen] = useState(false);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  /** XMP 与 LUMEN RAW 工程两侧调色是否不一致（统一管线的分歧标记） */
  /** 工程里现有的 AI 蒙版 */
  const [lumenMasks, setLumenMasks] = useState<
    Array<{ index?: number; name?: string; kind?: string }>
  >([]);

  /**
   * B1：宫格多选集合（受控）。空集 = 沿用单选取值。
   * 有 ≥2 张时按 `1..5 / P / X` 走批量写盘（带确认与进度）。
   */
  /**
   * B6：写盘失败、尚未同步到 XMP 的照片 id。用于格子上的持久"未同步"角标
   * （toast 会消失，角标不会），并提供点击重试。
   */
  const [unsyncedIds, setUnsyncedIds] = useState<Set<string>>(new Set());
  /** B1：待确认的批量操作（确认后才真正逐张写盘）。 */
  const [pendingBatch, setPendingBatch] = useState<
    | { kind: 'rate'; value: number }
    | { kind: 'flag'; value: CullFlag }
    | { kind: 'clear' }
    | null
  >(null);
  /** A1：更新下载/安装进行中（弹窗保持可见并显示进度）。 */

  // Grid search (progressive disclosure; owned here so the TopBar toggle and
  // the grid can share it across the tonal-panel swap).

  // Tonal & Luminar state

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
   * 扫描成功后的集合/对比状态更新。
   *
   * 独立成 useCallback：它是 useFolderScan 的入参，每次渲染新建函数会让
   * handleScan 的 identity 抖动，进而触发重扫 effect。
   */
  const handleScanned = useCallback(
    (
      scanned: PhotoGroupInfo[],
      initialTones: Record<string, ToneAdjustments>,
      historyIndex: number | null,
    ) => {
      setGroups(scanned);
      toneSeed(initialTones);
      if (historyIndex !== null && historyIndex < scanned.length) {
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
    dismissScanError,
  } = scan;
  /** 调色保存进行中：禁用保存按钮并挡住重入，避免连点写两次 XMP/工程。 */
  /** UX-12：auto-tone 计算中。RAW-only 要等 LUMEN 预览渲染，采样也是异步的，
      全程数秒无任何反馈，按钮看起来像没生效。 */
  const [isLuminarRunning, setIsLuminarRunning] = useState(false);
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
  // sidecar 真实能力（命令表/预设/AI）。只在握手成功时探测一次。
  const [lumenCaps, setLumenCaps] = useState<LumenCapabilities | null>(null);
  useEffect(() => {
    if (!lumenAvailable) {
      setLumenCaps(null);
      return;
    }
    let active = true;
    api
      .getLumenCapabilities()
      .then((c) => active && setLumenCaps(c))
      .catch((e) => console.warn('LUMEN 能力探测失败:', e));
    return () => {
      active = false;
    };
  }, [lumenAvailable]);
  // 宫格引擎开关：仅在设置开启且引擎握手成功时才切到 lumen 渲染
  const lumenGridThumbs =
    (settings?.lumenGridThumbnails ?? false) && lumenAvailable;




  const tone = useToneEditing({
    currentGroup,
    viewMode,
    lumenAvailable,
    lumenCapsAiMasks: lumenCaps?.aiMasks,
    onGroupsPatched: useCallback(
      (id: string, patch: Partial<PhotoGroupInfo>) => {
        setGroups((prev) =>
          prev.map((g) => (g.id === id ? { ...g, ...patch } : g)),
        );
      },
      [],
    ),
    onMasksLoaded: setLumenMasks,
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
  const isCompareNav = viewMode === 'split' && !!pinnedId && isPinnedOnLeft;
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

  /**
   * M-10：调色面板的**单一真值**。
   *
   * `showTonalPanel` 是「用户意图」，`currentGroup` 是「当前是否有可调对象」，
   * 可见性 = 二者与。此前显示层只读 `showTonalPanel`，于是筛选变空时会出现
   * 「按钮说开着、屏幕显示着宫格」，且再按 E 看似失灵。所有显示与传参统一用
   * 这个派生值；`showTonalPanel` 保持为意图（筛选恢复后面板自动回来）。
   */

  // Compute compare groups based on pinned reference.

  /** B6：把某张照片标记为"已同步到 XMP"（写盘成功时调用）。 */
  const markSynced = useCallback((id: string) => {
    setUnsyncedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /** B6：把某张照片标记为"未同步"（写盘失败时调用，形成持久角标）。 */
  const markUnsynced = useCallback((id: string) => {
    setUnsyncedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const reportRatingFlagError = useCallback(
    (err: unknown, groupId?: string) => {
      console.error('XMP update error:', err);
      // B6：toast 会消失，格子上的"未同步"角标不会 —— 两者都要给。
      if (groupId) markUnsynced(groupId);
      toast.error(
        `照片标记未写入 XMP 侧边栏：${String(err)}\n界面上的星级和保留/淘汰仍然有效，但不会同步到 Lightroom。`,
      );
    },
    [toast, markUnsynced],
  );

  // Update Rating & Flag (syncs to XMP)
  const handleRate = useCallback(
    async (rating: number, targetGroup: PhotoGroupInfo = currentGroup!) => {
      if (!targetGroup) return;
      const targetPath = groupPath(targetGroup);
      if (!targetPath) return;

      // L-11：快照必须在乐观更新**之前**取，否则拿到的已是新值。
      // 同照片连续改动会被 hook 合并，撤销回到这轮操作的起点。
      rememberRating({
        id: targetGroup.id,
        path: targetPath,
        rating: targetGroup.rating,
        flag: targetGroup.flag,
      });

      // 评分必须与淘汰态互斥：给「已淘汰」的照片打星 = 解除淘汰。
      //
      // 否则 handleRate 原样透传 flag=reject，后端按 reject 写 Rating=-1 ——
      // 界面显示「4 星」、磁盘仍是 -1，用户打多少星都摆脱不掉淘汰标记。
      // pick 语义与评分正交（打了星仍是 pick），故只有 reject 被清掉。
      const nextFlag: CullFlag =
        targetGroup.flag === 'reject' && rating > 0 ? 'none' : targetGroup.flag;

      // Update in local state
      setGroups((prev) =>
        prev.map((g) => (g.id === targetGroup.id ? { ...g, rating, flag: nextFlag } : g)),
      );

      // Sync to XMP in background
      try {
        await api.updateRatingFlag(targetPath, rating, nextFlag, true);
        markSynced(targetGroup.id);
      } catch (err) {
        reportRatingFlagError(err, targetGroup.id);
      }
    },
    [currentGroup, reportRatingFlagError, rememberRating, markSynced],
  );

  const handleFlag = useCallback(
    async (
      flag: 'pick' | 'reject' | 'none',
      targetGroup: PhotoGroupInfo = currentGroup!,
    ) => {
      if (!targetGroup) return;
      const targetPath = groupPath(targetGroup);
      if (!targetPath) return;

      rememberRating({
        id: targetGroup.id,
        path: targetPath,
        rating: targetGroup.rating,
        flag: targetGroup.flag,
      });

      setGroups((prev) =>
        prev.map((g) => (g.id === targetGroup.id ? { ...g, flag } : g)),
      );

      try {
        await api.updateRatingFlag(targetPath, targetGroup.rating, flag, true);
        markSynced(targetGroup.id);
      } catch (err) {
        reportRatingFlagError(err, targetGroup.id);
      }
    },
    [currentGroup, reportRatingFlagError, rememberRating, markSynced],
  );

  /**
   * B1：把"打分"入口按选区状态分流。多选 ≥2 张时先弹确认（批量写盘不可轻率），
   * 否则保持原有的单张即时写入。
   */
  const applyRating = useCallback(
    (rating: number) => {
      if (selectedIds.size > 1) setPendingBatch({ kind: 'rate', value: rating });
      else void handleRate(rating);
    },
    [selectedIds.size, handleRate],
  );

  /** B1：旗标入口同样的分流。 */
  const applyFlag = useCallback(
    (flag: CullFlag) => {
      if (selectedIds.size > 1) setPendingBatch({ kind: 'flag', value: flag });
      else void handleFlag(flag);
    },
    [selectedIds.size, handleFlag],
  );

  /** B6：点击格子上"未同步"角标时，用该张当前值重写 XMP。 */
  const handleRetrySync = useCallback(
    async (group: PhotoGroupInfo) => {
      const targetPath = groupPath(group);
      if (!targetPath) return;
      try {
        await api.updateRatingFlag(targetPath, group.rating, group.flag, true);
        markSynced(group.id);
        toast.success('已重新同步到 XMP 侧边栏。');
      } catch (err) {
        reportRatingFlagError(err, group.id);
      }
    },
    [markSynced, reportRatingFlagError, toast],
  );

  /**
   * B2：`0` / `U` 一次性清除评级与旗标 —— **单次写盘**。
   *
   * 原先拆成 `onRate(0)` + `onFlag('none')` 两条调用，各自发一条 IPC、各写一遍
   * 同一个 .xmp：两条并发写盘存在竞态，磁盘上可能残留旧星级或旧 pick。这里合并
   * 成一条 `updateRatingFlag(0, 'none')`，一次落盘、结果确定。
   */
  const handleClearRatingFlag = useCallback(async () => {
    if (selectedIds.size > 1) {
      setPendingBatch({ kind: 'clear' });
      return;
    }
    const targetGroup = currentGroup;
    if (!targetGroup) return;
    const targetPath = groupPath(targetGroup);
    if (!targetPath) return;

    rememberRating({
      id: targetGroup.id,
      path: targetPath,
      rating: targetGroup.rating,
      flag: targetGroup.flag,
    });
    setGroups((prev) =>
      prev.map((g) =>
        g.id === targetGroup.id ? { ...g, rating: 0, flag: 'none' } : g,
      ),
    );
    try {
      await api.updateRatingFlag(targetPath, 0, 'none', true);
      markSynced(targetGroup.id);
    } catch (err) {
      reportRatingFlagError(err, targetGroup.id);
    }
  }, [
    currentGroup,
    rememberRating,
    reportRatingFlagError,
    markSynced,
    selectedIds.size,
  ]);

  /**
   * B1：执行批量写盘。逐张乐观更新 + 写 XMP，进度条实时推进；单张失败不中断
   * 整批（失败的那张打持久"未同步"角标），结束时如实汇报成功/失败张数。
   */
  const runBatch = useCallback(
    async (action: NonNullable<typeof pendingBatch>) => {
      const targets = filteredGroups.filter((g) => selectedIds.has(g.id));
      if (targets.length === 0) return;

      batchCancelRef.current = false;
      setBatchCancelling(false);
      setBatchProgress({ processed: 0, total: targets.length });

      let ok = 0;
      let failed = 0;
      for (let i = 0; i < targets.length; i++) {
        if (batchCancelRef.current) break;
        const g = targets[i];
        const targetPath = groupPath(g);
        if (!targetPath) {
          failed++;
          setBatchProgress({ processed: i + 1, total: targets.length });
          continue;
        }
        const nextRating =
          action.kind === 'rate'
            ? action.value
            : action.kind === 'clear'
              ? 0
              : g.rating;
        const nextFlag =
          action.kind === 'flag'
            ? action.value
            : action.kind === 'clear'
              ? 'none'
              : g.flag;

        rememberRating({
          id: g.id,
          path: targetPath,
          rating: g.rating,
          flag: g.flag,
        });
        setGroups((prev) =>
          prev.map((x) =>
            x.id === g.id
              ? { ...x, rating: nextRating, flag: nextFlag }
              : x,
          ),
        );

        try {
          await api.updateRatingFlag(targetPath, nextRating, nextFlag, true);
          markSynced(g.id);
          ok++;
        } catch (err) {
          console.error('Batch XMP update error:', err);
          markUnsynced(g.id);
          failed++;
        }
        setBatchProgress({ processed: i + 1, total: targets.length });
      }

      const cancelled = batchCancelRef.current;
      setBatchProgress(null);
      setBatchCancelling(false);
      if (failed > 0) {
        toast.error(
          `批量写入完成：${ok} 张成功，${failed} 张未同步到 XMP（格子上有红色角标，可点击重试）。`,
        );
      } else if (cancelled) {
        toast.info(`已停止：${ok} 张已写入 XMP。`);
      } else {
        toast.success(`已批量写入 ${ok} 张的星级/标记到 XMP 侧边栏。`);
      }
    },
    [
      filteredGroups,
      selectedIds,
      rememberRating,
      markSynced,
      markUnsynced,
      toast,
    ],
  );

  /**
   * L-11 撤销：回填本地状态 + 用**同一套错误语义**重写 XMP。
   *
   * 注意「上次写盘失败」的情形：此时 UI = 新值、磁盘 = 旧值。撤销把 UI 恢复成
   * 快照（= 当时的旧值）并照常发起写入 —— 内容与磁盘现值相同，收敛一致，
   * 只是多一次无害写入。刻意**不**因上次失败而跳过，也刻意不引入第二种错误
   * 文案（仍走 `reportRatingFlagError`，保持"界面有效、未同步 XMP"的既有承诺）。
   */
  const handleUndo = useCallback(async () => {
    const snapshot = takeRatingSnapshot();
    if (!snapshot) {
      toast.info('没有可撤销的操作。');
      return;
    }

    setGroups((prev) =>
      prev.map((g) =>
        g.id === snapshot.id
          ? { ...g, rating: snapshot.rating, flag: snapshot.flag }
          : g,
      ),
    );

    try {
      await api.updateRatingFlag(
        snapshot.path,
        snapshot.rating,
        snapshot.flag,
        true,
      );
      toast.success(
        `已撤销上一处改动：星级恢复为 ${snapshot.rating} 星，标记恢复为 ${FLAG_LABELS[snapshot.flag]}。`,
      );
    } catch (err) {
      reportRatingFlagError(err);
    }
  }, [takeRatingSnapshot, toast, reportRatingFlagError]);

  // Open in Photoshop / External app
  const handleOpenExternal = useCallback(async () => {
    if (!currentGroup) return;
    const targetPath = groupPath(currentGroup);
    if (!targetPath) return;

    try {
      await api.openInPhotoshop(targetPath, settings?.photoshopPath);
    } catch (e) {
      console.warn('Photoshop failed, falling back to default:', e);
      try {
        await api.openInDefaultApp(targetPath);
      } catch (fallbackErr) {
        toast.error(
          `无法打开该照片：${String(fallbackErr)}\n请在「设置」中确认 Photoshop 路径，或安装一个能打开此格式的程序。`,
        );
      }
    }
  }, [currentGroup, settings?.photoshopPath, toast]);

  // View mode toggles
  const handleToggleCompare = useCallback(() => {
    setViewMode((m) => (m === 'split' ? 'single' : 'split'));
  }, []);

  const handleToggleBeforeAfter = useCallback(() => {
    setViewMode((m) => (m === 'before_after' ? 'single' : 'before_after'));
  }, []);


  const handleHoldOriginalStart = useCallback(() => {
    setIsHoldOriginal(true);
  }, []);

  const handleHoldOriginalEnd = useCallback(() => {
    setIsHoldOriginal(false);
  }, []);

  const handleSyncLumenRatings = useCallback(
    async (folder: string): Promise<number> => {
      const target =
        folder ||
        settings?.defaultRawFolder ||
        groupPath(currentGroup) ||
        '';
      if (!target) {
        toast.error('没有可同步的路径，请先设置默认 RAW 目录。');
        return 0;
      }
      // 取所在目录（同时兼容 / 与 \ 分隔符）
      const lastSlash = Math.max(
        target.lastIndexOf('/'),
        target.lastIndexOf(String.fromCharCode(92)),
      );
      const folderPath = lastSlash > 0 ? target.slice(0, lastSlash) : '';
      if (!folderPath) {
        toast.error('无法确定所在目录，请先设置默认 RAW 目录。');
        return 0;
      }
      const result = await api.syncLumenRatings(folderPath);
      if (result.updated.length > 0) {
        toast.success(`已从 LUMEN RAW 同步 ${result.updated.length} 张的评级。`);
        // 评级变了 → 星级排序与边框都要跟着变，重新扫描当前目录
        if (jpgFolder) await handleScan();
      }
      if (result.conflicts.length > 0) {
        const first = result.conflicts[0];
        toast.error(
          `${result.conflicts.length} 张照片在两边都被改过，已保持本机值不覆盖。\n` +
            `例如 ${first.path}：本机 ${first.hostRating}★/${first.hostFlag}，` +
            `LUMEN RAW ${first.lumenRating}★/${first.lumenFlag}。`,
        );
      }
      return result.updated.length;
    },
    // `handleScan` 依赖 jpgFolder/rawFolder/sortOrder
    [settings, currentGroup, toast, jpgFolder, handleScan],
  );

  // Luminar AI Roundtrip Handler
  const handleOpenLuminar = useCallback(async () => {
    if (!currentGroup) return;
    const targetPath = groupPath(currentGroup);
    if (!targetPath) return;

    setIsLuminarRunning(true);
    try {
      const editedPath = await api.openInLuminarRoundtrip(targetPath);
      const ext = editedPath.split('.').pop() || 'tif';
      const editedInfo: PhotoFileInfo = {
        path: editedPath,
        name: editedPath.split(/[/\\]/).pop() || 'edited.tif',
        extension: ext,
        size: 0,
        mtime: Date.now() / 1000,
      };

      setGroups((prev) =>
        prev.map((g) =>
          g.id === currentGroup.id ? { ...g, edited: editedInfo } : g,
        ),
      );

      // Automatically switch to Before/After comparison view to review result!
      setViewMode('before_after');
      toast.success(
        'Luminar AI 精修完成，已切换到前后对照视图查看效果。',
      );
    } catch (err) {
      console.error('Luminar roundtrip failed:', err);
      toast.error(
        `调用 Luminar AI 失败或未完成：${String(err)}\n请确认 Luminar AI 已安装，并已在「设置」中允许作为 Photoshop 插件运行。`,
      );
    } finally {
      setIsLuminarRunning(false);
    }
  }, [currentGroup, toast]);

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
    // B2：`0`/`U` 走合并后的单次写盘（清除评级 + 旗标）。
    onClear: () => void handleClearRatingFlag(),
    onOpenExternal: handleOpenExternal,
    onToggleCompare: handleToggleCompare,
    onSwapCompare: handleSwapCompare,
    onTogglePinReference: handleTogglePinBenchmark,
    onPinLeft: handleTogglePinLeft,
    onPinRight: handleTogglePinRight,
    onTogglePinCurrent: handleTogglePinCurrent,
    onOpenMetadataModal: () => setIsMetadataOpen(true),
    onToggleBeforeAfter: handleToggleBeforeAfter,
    onToggleTonalPanel: handleToggleTonalPanel,
    onHoldOriginalStart: handleHoldOriginalStart,
    onHoldOriginalEnd: handleHoldOriginalEnd,
    onFocusSearch: handleFocusSearch,
    onOpenShortcutHelp: () => setIsShortcutHelpOpen(true),
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

  // B1：批量确认框里的一句话说明。放在 JSX 外，避免在属性里做类型收窄。
  const pendingBatchSummary = useMemo(() => {
    if (!pendingBatch) return '';
    const count = selectedIds.size;
    if (pendingBatch.kind === 'rate') {
      return `将 ${count} 张照片的星级设为 ${pendingBatch.value} 星`;
    }
    if (pendingBatch.kind === 'flag') {
      return `将 ${count} 张照片标记为「${FLAG_LABELS[pendingBatch.value]}」`;
    }
    return `清除 ${count} 张照片的星级与旗标`;
  }, [pendingBatch, selectedIds]);

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
        onSortChange={setSortOrder}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onOpenExportModal={() => setIsExportOpen(true)}
        onOpenSettingsModal={() => setIsSettingsOpen(true)}
        onToggleTonalAdjuster={handleToggleTonalPanel}
        tonalPanelVisible={tonalPanelVisible}
        tonalToggleDisabled={!currentGroup}
        onOpenLuminar={handleOpenLuminar}
        isLuminarRunning={isLuminarRunning}
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
        onCancel={() => {
          batchCancelRef.current = true;
          setBatchCancelling(true);
        }}
        cancelRequested={batchCancelling}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Center Viewport */}
        {viewMode === 'single' && (
          <PreviewViewport
            group={currentGroup}
            tone={currentTone}
            isHoldOriginal={isHoldOriginal}
            lumenStatus={lumenStatus}
            onPrev={guardedPrev}
            onNext={guardedNext}
            onRate={applyRating}
            onFlag={applyFlag}
            onOpenExternal={handleOpenExternal}
            onOpenLuminar={handleOpenLuminar}
            onToggleTonalAdjuster={handleToggleTonalPanel}
            isTonalPanelOpen={tonalPanelVisible}
            isLuminarRunning={isLuminarRunning}
            emptyState={viewportEmptyState}
            onImageElement={setPreviewImage}
          />
        )}

        {viewMode === 'before_after' && (
          <BeforeAfterViewport
            group={currentGroup}
            tone={currentTone}
            isHoldOriginal={isHoldOriginal}
            onRate={applyRating}
            onFlag={applyFlag}
            onOpenLuminar={handleOpenLuminar}
            onToggleTonalAdjuster={handleToggleTonalPanel}
            isTonalPanelOpen={tonalPanelVisible}
            isLuminarRunning={isLuminarRunning}
            emptyState={viewportEmptyState}
            lumenStatus={lumenStatus}
          />
        )}

        {viewMode === 'split' && (
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
              masks={lumenMasks}
              onApplyMask={
                lumenCaps?.aiMasks && lumenAvailable
                  ? handleApplyLumenMask
                  : undefined
              }
              lumenPresets={lumenCaps?.presets ?? []}
              aiAvailable={lumenCaps?.aiMasks ?? false}
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
              lumenThumbnails={lumenGridThumbs}
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
        onOpenExternal={handleOpenExternal}
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
        onError={(m) => toast.error(m)}
        onSuccess={(m) => toast.success(m)}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSettingsSaved={applySettings}
        onError={(m) => toast.error(m)}
        lumenStatus={lumenStatus}
        capabilities={lumenCaps}
        onSyncRatings={lumenStatus?.available ? handleSyncLumenRatings : undefined}
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
