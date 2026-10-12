import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
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
import { useSessionDebounce } from './hooks/useSessionDebounce';
import { useTaskProgress } from './hooks/useTaskProgress';
import { isTaskCancelled } from './services/taskApi';
import { useRatingUndo } from './hooks/useRatingUndo';
import { useLumenStatus } from './hooks/useLumenStatus';
import type { ViewportEmptyState } from './components/PreviewViewport';
import {
  AppSettings,
  CullFlag,
  LumenCapabilities,
  FilterMode,
  PhotoFileInfo,
  PhotoGroupInfo,
  SortOrder,
  ViewMode,
  ToneAdjustments,
} from './types';
import { api } from './services/api';
import { computeAutoTone, DEFAULT_TONE } from './utils/autoTone';
import { deriveCompareGroups } from './utils/compareGroups';
import { countByFilter, matchesFilter } from './utils/filterMatch';

function AppShell() {
  const toast = useToast();

  /** L-11 撤销提示里用到的旗标文案（与宫格/底栏的叫法保持一致）。 */
  const FLAG_LABELS: Record<CullFlag, string> = {
    pick: '保留',
    reject: '淘汰',
    none: '未标记',
  };

  // 扫描的进度与取消（M-05）。解构出**稳定引用**的成员：`start/finish/
  // isCancelRequested` 都不随进度变化，因此 `handleScan` 的 identity 不会
  // 因为进度事件每几十毫秒刷新一次而抖动（否则会连带触发 [sortOrder] 那个
  // effect 反复重新扫描）。
  const scanTask = useTaskProgress('scan');
  const { start: scanStart, finish: scanFinish } = scanTask;

  // L-11：星级/旗标的单步撤销。`1..5/p/x/0` 按下即写 .xmp 且原先无路可退，
  // 一次误触只能手改侧边栏或回 Lightroom。这里保留一步回退（Ctrl/Cmd+Z，
  // 或底栏的「撤销」按钮）。
  const {
    canUndo,
    remember: rememberRating,
    take: takeRatingSnapshot,
    clear: clearRatingUndo,
  } = useRatingUndo();

  const [jpgFolder, setJpgFolder] = useState('');
  const [rawFolder, setRawFolder] = useState('');
  const [groups, setGroups] = useState<PhotoGroupInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [compareIndex, setCompareIndex] = useState<number>(1);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [isPinnedOnLeft, setIsPinnedOnLeft] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('time_filename');
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMetadataOpen, setIsMetadataOpen] = useState(false);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  /** XMP 与 LUMEN RAW 工程两侧调色是否不一致（统一管线的分歧标记） */
  const [toneDivergent, setToneDivergent] = useState(false);
  /** 工程里现有的 AI 蒙版 */
  const [lumenMasks, setLumenMasks] = useState<
    Array<{ index?: number; name?: string; kind?: string }>
  >([]);

  // Grid search (progressive disclosure; owned here so the TopBar toggle and
  // the grid can share it across the tonal-panel swap).
  const [gridSearchOpen, setGridSearchOpen] = useState(false);
  const [gridSearch, setGridSearch] = useState('');
  const [gridSearchFocusToken, setGridSearchFocusToken] = useState(0);

  // Tonal & Luminar state
  const [toneMap, setToneMap] = useState<Record<string, ToneAdjustments>>({});
  const [showTonalPanel, setShowTonalPanel] = useState(false);
  /** 调色保存进行中：禁用保存按钮并挡住重入，避免连点写两次 XMP/工程。 */
  const [isSavingTone, setIsSavingTone] = useState(false);
  const [isLuminarRunning, setIsLuminarRunning] = useState(false);
  const [isHoldOriginal, setIsHoldOriginal] = useState(false);

  // Updater prompt
  const [pendingUpdate, setPendingUpdate] = useState<{
    version: string;
    body: string;
    install: () => Promise<void>;
  } | null>(null);

  // The <img> currently rendered in the single-view viewport, so auto-tone can
  // sample the histogram without a fragile DOM query (F-15).
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const setPreviewImage = useCallback((el: HTMLImageElement | null) => {
    previewImageRef.current = el;
  }, []);

  // LUMEN RAW engine handshake (P0). Zero requests while disabled — the hook
  // itself owns the 1.5s delay and the silent degradation.
  // N-12：主动重探令牌。`useLumenStatus` 依赖 `enabled`/`cliPath`，但用户可能在
  // 弹窗里改了路径又撤销，或引擎在运行中才装好——保存设置后自增这个令牌，让
  // 引擎状态**当场刷新**，而不是停留在启动时的陈旧快照。
  const [lumenRefreshToken, setLumenRefreshToken] = useState(0);
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

  // Load initial settings and default paths on startup
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        if (s.defaultJpgFolder) setJpgFolder(s.defaultJpgFolder);
        if (s.defaultRawFolder) setRawFolder(s.defaultRawFolder);
        if (s.sortOrder) setSortOrder(s.sortOrder as SortOrder);
      })
      .catch((err) => {
        // Without this the app looks healthy with settings === null, and the
        // "save folder as default" branch never runs (F-04).
        console.error('Failed to load settings:', err);
        toast.error(
          '无法读取本地设置，将使用默认值。\n如果你的默认文件夹没有自动填充，请到「设置」中重新指定。',
        );
      });

    // Check for updates
    const checkForUpdates = async () => {
      try {
        const update = await check();
        if (!update) return;
        setPendingUpdate({
          version: update.version,
          body: update.body || '修复已知问题，优化体验。',
          install: async () => {
            await update.downloadAndInstall();
            await relaunch();
          },
        });
      } catch (err) {
        // Silent by design: a failed update check is not actionable for the user.
        console.error('Failed to check for updates:', err);
      }
    };
    // small delay to not block initial render
    const timer = window.setTimeout(checkForUpdates, 1500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Filtered list of groups — the app's current working set.
  const filteredGroups = useMemo(
    () => groups.filter((g) => matchesFilter(g, filterMode)),
    [groups, filterMode],
  );

  // M-14：每档计数。与 `filteredGroups` **共用同一个谓词**（`matchesFilter`），
  // 所以下拉里的 `(N)` 与实际切档后的张数不可能漂移——这正是把它们抽成
  // `utils/filterMatch` 的唯一原因。O(n) 单遍，万张规模亚毫秒级。
  const filterCounts = useMemo(() => countByFilter(groups), [groups]);

  // Search narrowing applied inside the filtered set. `filteredIndices` maps a
  // position in the visible list back to its index in `filteredGroups`, so
  // selection, the counter and navigation all keep referring to the stable
  // working set rather than to whatever the search currently matches.
  const filteredIndices = useMemo(() => {
    const q = gridSearch.trim().toLowerCase();
    if (!q) return filteredGroups.map((_, i) => i);
    return filteredGroups
      .map((g, i) => (g.baseName.toLowerCase().includes(q) ? i : -1))
      .filter((i) => i >= 0);
  }, [filteredGroups, gridSearch]);

  const visibleGroups = useMemo(
    () => filteredIndices.map((i) => filteredGroups[i]),
    [filteredIndices, filteredGroups],
  );

  const selectedVisibleIndex = useMemo(
    () => filteredIndices.indexOf(selectedIndex),
    [filteredIndices, selectedIndex],
  );

  // Keep the selection inside the working set. Switching from "全部照片" at
  // photo 500 to "仅已保留" with 3 matches used to leave selectedIndex at 500
  // and render a misleading "未加载照片" empty state.
  useEffect(() => {
    const max = filteredGroups.length;
    setSelectedIndex((prev) => (max === 0 ? 0 : Math.min(prev, max - 1)));
    setCompareIndex((prev) => (max === 0 ? 0 : Math.min(prev, max - 1)));
  }, [filteredGroups.length]);

  // Drop a selection that a new search no longer contains onto the first
  // visible item, so the counter and the highlight never disagree.
  useEffect(() => {
    if (gridSearch.trim() && filteredIndices.length > 0) {
      setSelectedIndex((prev) =>
        filteredIndices.includes(prev) ? prev : filteredIndices[0],
      );
      // N-04: the compare candidate has to be pulled into the visible set too,
      // otherwise the split view keeps rendering a photo the search excluded
      // and stops matching the grid it sits next to.
      setCompareIndex((prev) =>
        filteredIndices.includes(prev) ? prev : filteredIndices[0],
      );
    }
  }, [filteredIndices, gridSearch]);

  const currentGroup = filteredGroups[selectedIndex] || undefined;

  /**
   * M-10：调色面板的**单一真值**。
   *
   * `showTonalPanel` 是「用户意图」，`currentGroup` 是「当前是否有可调对象」，
   * 可见性 = 二者与。此前显示层只读 `showTonalPanel`，于是筛选变空时会出现
   * 「按钮说开着、屏幕显示着宫格」，且再按 E 看似失灵。所有显示与传参统一用
   * 这个派生值；`showTonalPanel` 保持为意图（筛选恢复后面板自动回来）。
   */
  const tonalPanelVisible = showTonalPanel && !!currentGroup;

  // Compute compare groups based on pinned reference.
  // 推导逻辑抽到 `utils/compareGroups`，以便对 filterMode × gridSearch × pinnedId
  // 的四种组合做穷举回归（见该模块的 N-01/N-03 说明）。
  const { leftCompareGroup, rightCompareGroup, isLeftPinned, isRightPinned } =
    useMemo(
      () =>
        deriveCompareGroups(
          filteredGroups,
          selectedIndex,
          compareIndex,
          pinnedId,
          isPinnedOnLeft,
        ),
      [filteredGroups, selectedIndex, compareIndex, pinnedId, isPinnedOnLeft],
    );

  // Pin / Unpin Left as Reference
  const handleTogglePinLeft = useCallback(() => {
    if (isLeftPinned) {
      setPinnedId(null);
    } else if (leftCompareGroup) {
      setPinnedId(leftCompareGroup.id);
      setIsPinnedOnLeft(true);
    }
  }, [isLeftPinned, leftCompareGroup]);

  // Pin / Unpin Right as Reference
  const handleTogglePinRight = useCallback(() => {
    if (isRightPinned) {
      setPinnedId(null);
    } else if (rightCompareGroup) {
      setPinnedId(rightCompareGroup.id);
      setIsPinnedOnLeft(false);
    }
  }, [isRightPinned, rightCompareGroup]);

  // Swap A / B (Candidate becomes new pinned benchmark or swap positions)
  const handleSwapCompare = useCallback(() => {
    if (pinnedId) {
      if (isPinnedOnLeft && rightCompareGroup) {
        setPinnedId(rightCompareGroup.id);
      } else if (!isPinnedOnLeft && leftCompareGroup) {
        setPinnedId(leftCompareGroup.id);
      }
    } else {
      const temp = selectedIndex;
      setSelectedIndex(compareIndex);
      setCompareIndex(temp);
    }
  }, [
    pinnedId,
    isPinnedOnLeft,
    leftCompareGroup,
    rightCompareGroup,
    selectedIndex,
    compareIndex,
  ]);

  // Benchmark toggle shortcut (B)
  const handleTogglePinBenchmark = useCallback(() => {
    if (pinnedId) {
      setPinnedId(null);
    } else if (leftCompareGroup) {
      setPinnedId(leftCompareGroup.id);
      setIsPinnedOnLeft(true);
    }
  }, [pinnedId, leftCompareGroup]);

  // Folder scanning handler
  const handleScan = useCallback(async () => {
    if (!jpgFolder.trim()) return;
    setIsLoading(true);
    scanStart();
    // 重新扫描后旧快照指向的照片可能已不在列表里，撤销会写到一个不该碰的文件上。
    clearRatingUndo();

    try {
      const res = await api.scanFolders(jpgFolder, rawFolder, sortOrder);
      setGroups(res.groups);

      // Populate initial tones from XMP
      const initialTones: Record<string, ToneAdjustments> = {};
      res.groups.forEach((g) => {
        if (g.tone) initialTones[g.id] = g.tone;
      });
      setToneMap(initialTones);

      // Check session history for this folder
      const history = await api.loadSession(jpgFolder);
      if (history && history[0] < res.groups.length) {
        setSelectedIndex(history[0]);
        setCompareIndex(Math.min(history[0] + 1, res.groups.length - 1));
      } else {
        setSelectedIndex(0);
        setCompareIndex(res.groups.length > 1 ? 1 : 0);
      }

      // Drop anything pinned to a photo that no longer exists.
      setPinnedId(null);

      // Save as default in settings
      if (settings) {
        api
          .saveSettings({
            ...settings,
            defaultJpgFolder: jpgFolder,
            defaultRawFolder: rawFolder,
            sortOrder,
          })
          .catch((err) => console.error('Failed to persist settings:', err));
      }

      toast.success(
        `扫描完成，共 ${res.groups.length} 组照片。已按${
          sortOrder === 'time_filename'
            ? '拍摄时间'
            : sortOrder === 'filename'
            ? '文件名'
            : '星级'
        }排序。`,
      );
    } catch (err) {
      // 取消不是失败：后端以哨兵文案 `任务已取消` 返回，必须按「已取消」呈现，
      // 否则用户主动取消会被读成"扫描坏了"。按哨兵而非「点过取消按钮」判断，
      // 这样与取消同时发生的真实错误仍会如实报成失败。
      if (isTaskCancelled(err)) {
        toast.info('已取消扫描：照片列表未更新。');
      } else {
        console.error('Scan failed:', err);
        toast.error(
          `扫描失败：${String(err)}\n请确认文件夹路径存在且有读取权限，然后重试。`,
        );
      }
    } finally {
      scanFinish();
      setIsLoading(false);
    }
  }, [
    jpgFolder,
    rawFolder,
    sortOrder,
    settings,
    toast,
    scanStart,
    scanFinish,
    clearRatingUndo,
  ]);

  // Re-scan when the sort order changes.
  //
  // The previous version called `handleScan()` from the onChange handler,
  // which captured the *previous* `sortOrder` — every sort change re-scanned
  // with the stale order (F-12).
  //
  // The guard skips the value that arrived with the saved settings, so
  // restoring a session does not silently launch a scan.
  const sortOrderInitialised = useRef(false);
  useEffect(() => {
    if (!sortOrderInitialised.current) {
      sortOrderInitialised.current = true;
      return;
    }
    if (!jpgFolder.trim()) return;
    void handleScan();
    // `handleScan` identity covers jpgFolder / rawFolder / sortOrder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortOrder]);

  // Folder picker handlers
  const handleBrowseJpg = useCallback(async () => {
    try {
      const selected = await api.selectFolderDialog(jpgFolder);
      if (selected) setJpgFolder(selected);
    } catch (err) {
      toast.error(`无法打开文件夹选择器：${String(err)}`);
    }
  }, [jpgFolder, toast]);

  const handleBrowseRaw = useCallback(async () => {
    try {
      const selected = await api.selectFolderDialog(rawFolder);
      if (selected) setRawFolder(selected);
    } catch (err) {
      toast.error(`无法打开文件夹选择器：${String(err)}`);
    }
  }, [rawFolder, toast]);

  // Selection navigation (aware of pinned compare mode)
  const handlePrev = useCallback(() => {
    if (viewMode === 'split' && pinnedId && isPinnedOnLeft) {
      setCompareIndex((prev) => (prev > 0 ? prev - 1 : prev));
    } else {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
    }
  }, [viewMode, pinnedId, isPinnedOnLeft]);

  const handleNext = useCallback(() => {
    if (viewMode === 'split' && pinnedId && isPinnedOnLeft) {
      setCompareIndex((prev) =>
        prev < filteredGroups.length - 1 ? prev + 1 : prev,
      );
    } else {
      setSelectedIndex((prev) =>
        prev < filteredGroups.length - 1 ? prev + 1 : prev,
      );
    }
  }, [viewMode, pinnedId, isPinnedOnLeft, filteredGroups.length]);

  // Select photo from thumbnail list. `visibleIndex` is a position in the
  // currently rendered (searched) list; translate it back to the working set.
  const handleSelectPhoto = useCallback(
    (visibleIndex: number) => {
      const idx = filteredIndices[visibleIndex] ?? visibleIndex;

      if (viewMode === 'split' && pinnedId && isPinnedOnLeft) {
        setCompareIndex(idx);
      } else {
        setSelectedIndex(idx);
        if (viewMode === 'split' && !pinnedId) {
          setCompareIndex(Math.min(idx + 1, filteredGroups.length - 1));
        }
      }
    },
    [viewMode, pinnedId, isPinnedOnLeft, filteredGroups.length, filteredIndices],
  );

  const reportRatingFlagError = useCallback(
    (err: unknown) => {
      console.error('XMP update error:', err);
      toast.error(
        `照片标记未写入 XMP 侧边栏：${String(err)}\n界面上的星级和保留/淘汰仍然有效，但不会同步到 Lightroom。`,
      );
    },
    [toast],
  );

  // Update Rating & Flag (syncs to XMP)
  const handleRate = useCallback(
    async (rating: number, targetGroup: PhotoGroupInfo = currentGroup!) => {
      if (!targetGroup) return;
      const targetPath = targetGroup.raw?.path || targetGroup.jpg?.path;
      if (!targetPath) return;

      // L-11：快照必须在乐观更新**之前**取，否则拿到的已是新值。
      // 同照片连续改动会被 hook 合并，撤销回到这轮操作的起点。
      rememberRating({
        id: targetGroup.id,
        path: targetPath,
        rating: targetGroup.rating,
        flag: targetGroup.flag,
      });

      // Update in local state
      setGroups((prev) =>
        prev.map((g) => (g.id === targetGroup.id ? { ...g, rating } : g)),
      );

      // Sync to XMP in background
      try {
        await api.updateRatingFlag(targetPath, rating, targetGroup.flag, true);
      } catch (err) {
        reportRatingFlagError(err);
      }
    },
    [currentGroup, reportRatingFlagError, rememberRating],
  );

  const handleFlag = useCallback(
    async (
      flag: 'pick' | 'reject' | 'none',
      targetGroup: PhotoGroupInfo = currentGroup!,
    ) => {
      if (!targetGroup) return;
      const targetPath = targetGroup.raw?.path || targetGroup.jpg?.path;
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
      } catch (err) {
        reportRatingFlagError(err);
      }
    },
    [currentGroup, reportRatingFlagError, rememberRating],
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
    const targetPath = currentGroup.raw?.path || currentGroup.jpg?.path;
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

  const handleToggleTonalPanel = useCallback(() => {
    setShowTonalPanel((prev) => !prev);
  }, []);

  const handleHoldOriginalStart = useCallback(() => {
    setIsHoldOriginal(true);
  }, []);

  const handleHoldOriginalEnd = useCallback(() => {
    setIsHoldOriginal(false);
  }, []);

  // Tone adjustments state and handlers
  const currentTone = currentGroup
    ? toneMap[currentGroup.id] || currentGroup.tone || DEFAULT_TONE
    : undefined;

  const handleToneChange = useCallback(
    (newTone: ToneAdjustments) => {
      if (!currentGroup) return;
      setToneMap((prev) => ({ ...prev, [currentGroup.id]: newTone }));
      setGroups((prev) =>
        prev.map((g) =>
          g.id === currentGroup.id ? { ...g, tone: newTone } : g,
        ),
      );
    },
    [currentGroup],
  );

  const handleResetTone = useCallback(() => {
    if (!currentGroup) return;
    setToneMap((prev) => ({ ...prev, [currentGroup.id]: { ...DEFAULT_TONE } }));
    setGroups((prev) =>
      prev.map((g) =>
        g.id === currentGroup.id ? { ...g, tone: { ...DEFAULT_TONE } } : g,
      ),
    );
  }, [currentGroup]);

  const handleAutoTone = useCallback(() => {
    if (!currentGroup) return;
    const src = currentGroup.jpg?.path
      ? api.toAssetUrl(currentGroup.jpg.path)
      : currentGroup.raw?.path
      ? api.toAssetUrl(currentGroup.raw.path)
      : null;
    if (!src) return;

    const finish = (img: HTMLImageElement) =>
      handleToneChange(computeAutoTone(img));

    // The viewport hands us the element it actually rendered, so this works
    // even when two photos share a basename (F-15).
    const rendered = previewImageRef.current;
    if (rendered && rendered.complete && rendered.naturalWidth > 0) {
      finish(rendered);
      return;
    }

    const tempImg = new Image();
    tempImg.crossOrigin = 'anonymous';
    tempImg.onload = () => finish(tempImg);
    tempImg.onerror = () =>
      toast.error('无法读取该照片的像素数据，自动调色已取消。');
    tempImg.src = src;
  }, [currentGroup, handleToneChange, toast]);

  /**
   * 统一保存调色：**一条命令、两个落点**。
   * - 总是写 XMP（Lightroom / Capture One / Photoshop 互操作）；
   * - 引擎可用时同时写入 LUMEN RAW 编辑态并落盘 .lumen 工程；
   * - 引擎失败不回滚 XMP，只把 warning 如实提示出来。
   */
  const handleSaveTone = useCallback(async () => {
    // 重入短路：一次保存还没落地时，再点（键盘/程序化触发）直接忽略。
    if (isSavingTone) return;
    if (!currentGroup) return;
    const toneToSave =
      toneMap[currentGroup.id] || currentGroup.tone || DEFAULT_TONE;
    const targetPath = currentGroup.raw?.path || currentGroup.jpg?.path;
    if (!targetPath) return;

    setIsSavingTone(true);
    try {
      const report = await api.applyTone(targetPath, toneToSave);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === currentGroup.id
            ? { ...g, hasXmp: report.xmpWritten, tone: toneToSave }
            : g,
        ),
      );
      setToneDivergent(false);
      if (report.lumenApplied) {
        toast.success(
          report.projectPath
            ? '调色已保存：XMP 侧边栏 + LUMEN RAW 工程。'
            : '调色已保存：XMP 侧边栏 + LUMEN RAW。',
        );
      } else if (report.warnings.length > 0) {
        // XMP 写成功了，只是引擎那侧没成 —— 必须说清楚，别让用户以为两边都存了
        toast.error(`XMP 已写入，但 LUMEN RAW 未同步：${report.warnings[0]}`);
      } else {
        toast.success('调色参数已写入同名 .xmp 文件。\nPhotoshop / ACR 打开时将自动载入。');
      }
    } catch (err) {
      console.error('Failed to save tone:', err);
      toast.error(`保存调色失败：${String(err)}`);
    } finally {
      // 无论成功/失败/异常都必须复位，否则按钮会永久卡在「保存中…」。
      setIsSavingTone(false);
    }
  }, [currentGroup, toneMap, toast, isSavingTone]);

  /**
   * 打开调色面板时读回统一状态：生效值 + XMP 真值 + lumen 工程真值 + 是否分歧。
   * 引擎关闭时只读 XMP（零请求）。
   */
  useEffect(() => {
    if (!showTonalPanel || !currentGroup) {
      setToneDivergent(false);
      return;
    }
    const targetPath = currentGroup.raw?.path || currentGroup.jpg?.path;
    if (!targetPath) return;
    let active = true;
    api
      .getToneState(targetPath)
      .then((st) => {
        if (!active) return;
        setToneDivergent(st.divergent);
        // 只在宿主还没有本地改动时用真值回填，避免覆盖用户刚拖的滑杆
        if (!toneMap[currentGroup.id]) {
          handleToneChange(st.tone);
        }
      })
      .catch((e) => console.warn('读取调色状态失败:', e));
    return () => {
      active = false;
    };
  }, [showTonalPanel, currentGroup?.id]);

  /**
   * 应用 LUMEN RAW 内置预设（编辑态是进程内 session，后端保证 apply+save 同进程）。
   * 套完用统一读取把真实值拉回来，滑杆立刻反映。
   */
  const handleApplyLumenPreset = useCallback(
    async (name: string) => {
      if (!currentGroup) return;
      const targetPath = currentGroup.raw?.path || currentGroup.jpg?.path;
      if (!targetPath) return;
      try {
        await api.applyLumenPreset(targetPath, name, 100);
        const st = await api.getToneState(targetPath);
        setGroups((prev) =>
          prev.map((g) =>
            g.id === currentGroup.id ? { ...g, tone: st.tone } : g,
          ),
        );
        handleToneChange(st.tone);
        setToneDivergent(st.divergent);
        toast.success(`已应用预设「${name}」。`);
      } catch (err) {
        console.error('Failed to apply preset:', err);
        toast.error(`应用预设失败：${String(err)}`);
      }
    },
    [currentGroup, handleToneChange, toast],
  );

  /** 套用 AI 蒙版（GPU 版实测约 4s，toast 承担进度反馈）。 */
  const handleApplyLumenMask = useCallback(
    async (region: string, dehaze: number) => {
      if (!currentGroup) return;
      const targetPath = currentGroup.raw?.path || currentGroup.jpg?.path;
      if (!targetPath) return;
      const result = await api.applyLumenMask(targetPath, region, {
        exposure: 0,
        highlights: 0,
        shadows: 0,
        dehaze,
        clarity: 0,
        saturation: 0,
        temperature: 0,
      });
      setLumenMasks(result.masks);
      toast.success(
        `已套用「${region}」蒙版（${(result.elapsedMs / 1000).toFixed(1)}s）。`,
      );
    },
    [currentGroup, toast],
  );

  /** 读回工程里现有的 AI 蒙版（面板打开时）。 */
  useEffect(() => {
    if (!showTonalPanel || !currentGroup) {
      setLumenMasks([]);
      return;
    }
    const targetPath = currentGroup.raw?.path || currentGroup.jpg?.path;
    if (!targetPath || !lumenCaps?.aiMasks) return;
    let active = true;
    api
      .listLumenMasks(targetPath)
      .then((m) => active && setLumenMasks(m))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [showTonalPanel, currentGroup?.id, lumenCaps?.aiMasks]);

  /**
   * 设置里的"从 LUMEN RAW 同步评级"：拉 catalog 真值并写回侧边栏。
   * 冲突由后端判定并回报（两侧都改过的不覆盖）。
   */
  const handleSyncLumenRatings = useCallback(
    async (folder: string): Promise<number> => {
      const target =
        folder ||
        settings?.defaultRawFolder ||
        currentGroup?.raw?.path ||
        currentGroup?.jpg?.path ||
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
    const targetPath = currentGroup.raw?.path || currentGroup.jpg?.path;
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

  // L-08：调色面板此前没有任何「按 Esc 关闭」的出口——8 个触发入口都只负责
  // 打开，用户被关进一个只能靠鼠标或原快捷键原路退出的面板。
  //
  // 只在**没有其它弹窗**时生效：各弹窗自己的 Esc 处理优先，否则会出现
  // 「一次 Esc 关两层」（弹窗和面板同时消失）。判断谓词与键盘守卫的
  // `isDialogOpen` 保持一致，避免两处对"什么算弹窗"有不同答案。
  useEffect(() => {
    if (!tonalPanelVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setShowTonalPanel(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tonalPanelVisible]);

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

  const handleFocusSearch = useCallback(() => {
    // The grid has to be mounted for the field to exist.
    setShowTonalPanel(false);
    setGridSearchOpen(true);
    setGridSearchFocusToken((t) => t + 1);
  }, []);

  // Register single-handed keyboard shortcuts
  useKeyboardShortcuts({
    onPrev: handlePrev,
    onNext: handleNext,
    onRate: (r) => handleRate(r),
    onFlag: (f) => handleFlag(f),
    onOpenExternal: handleOpenExternal,
    onToggleCompare: handleToggleCompare,
    onSwapCompare: handleSwapCompare,
    onTogglePinReference: handleTogglePinBenchmark,
    onPinLeft: handleTogglePinLeft,
    onPinRight: handleTogglePinRight,
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
        description: '选择 JPG 或 RAW 文件夹，即可开始极速选片。',
        actionLabel: '选择文件夹',
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
        filterMode={filterMode}
        onFilterChange={setFilterMode}
        filterCounts={filterCounts}
        sortOrder={sortOrder}
        onSortChange={setSortOrder}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onOpenExportModal={() => setIsExportOpen(true)}
        onOpenSettingsModal={() => setIsSettingsOpen(true)}
        onOpenMetadataModal={() => setIsMetadataOpen(true)}
        onToggleTonalAdjuster={handleToggleTonalPanel}
        tonalPanelVisible={tonalPanelVisible}
        tonalToggleDisabled={!currentGroup}
        onOpenLuminar={handleOpenLuminar}
        isLuminarRunning={isLuminarRunning}
        isGridSearchOpen={gridSearchOpen}
        onToggleGridSearch={() => {
          setGridSearchOpen((prev) => {
            const next = !prev;
            if (next) setGridSearchFocusToken((t) => t + 1);
            else setGridSearch('');
            return next;
          });
        }}
      />

      {/* Scan progress (M-05) — 空闲时不渲染，不留空白条 */}
      <TaskProgressBar
        className="px-4 py-2 border-b border-white/10 bg-background-header shrink-0"
        isRunning={scanTask.isRunning}
        processed={scanTask.progress?.processed ?? 0}
        total={scanTask.progress?.total ?? 0}
        label="正在扫描照片"
        onCancel={() => void scanTask.cancel()}
        cancelRequested={scanTask.cancelRequested}
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
            onPrev={handlePrev}
            onNext={handleNext}
            onRate={(r) => handleRate(r)}
            onFlag={(f) => handleFlag(f)}
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
            onPrev={handlePrev}
            onNext={handleNext}
            onRate={(r) => handleRate(r)}
            onFlag={(f) => handleFlag(f)}
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
          />
        )}        {/* Right Sidebar (Thumbnail Grid OR Tonal Adjuster) */}
        <div className="w-[390px] h-full shrink-0 bg-background-base">
          {tonalPanelVisible ? (
            <TonalAdjuster
              tone={currentTone || DEFAULT_TONE}
              onChange={handleToneChange}
              onReset={handleResetTone}
              onAuto={handleAutoTone}
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
              onClose={() => setShowTonalPanel(false)}
            />
          ) : (
            <ThumbnailGrid
              groups={visibleGroups}
              selectedIndex={selectedVisibleIndex}
              pinnedId={pinnedId}
              onSelect={handleSelectPhoto}
              searchQuery={gridSearch}
              searchOpen={gridSearchOpen}
              searchFocusToken={gridSearchFocusToken}
              onSearchQueryChange={setGridSearch}
              onSearchOpenChange={(open) => {
                setGridSearchOpen(open);
                if (!open) setGridSearch('');
                else setGridSearchFocusToken((t) => t + 1);
              }}
              totalLoaded={filteredGroups.length}
              lumenThumbnails={lumenGridThumbs}
              candidateId={rightCompareGroup?.id}
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
        onSettingsSaved={(s) => {
          setSettings(s);
          // N-12：保存后强制重探引擎状态（SettingsModal 自己会 onClose）。
          setLumenRefreshToken((t) => t + 1);
        }}
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

      {/* Update prompt — a real decision with release notes, not a toast */}
      <ConfirmDialog
        isOpen={pendingUpdate !== null}
        onClose={() => setPendingUpdate(null)}
        onConfirm={() => void pendingUpdate?.install()}
        title={`发现新版本 ${pendingUpdate?.version ?? ''}`}
        message={
          <>
            {`更新内容：\n${pendingUpdate?.body ?? ''}`}
            {'\n\n是否立即下载并升级？升级完成后应用会自动重启。'}
          </>
        }
        confirmLabel="下载并升级"
        cancelLabel="稍后再说"
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
