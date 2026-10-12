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
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useLumenStatus } from './hooks/useLumenStatus';
import type { ViewportEmptyState } from './components/PreviewViewport';
import {
  AppSettings,
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

function AppShell() {
  const toast = useToast();

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
  const lumenStatus = useLumenStatus(settings?.lumenEnabled ?? false);
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
  const filteredGroups = useMemo(() => {
    return groups.filter((g) => {
      switch (filterMode) {
        case 'pick':
          return g.flag === 'pick';
        case 'reject':
          return g.flag === 'reject';
        case 'unmarked':
          return g.flag === 'none' && g.rating === 0;
        case 'star3':
          return g.rating >= 3;
        case 'star5':
          return g.rating === 5;
        case 'all':
        default:
          return true;
      }
    });
  }, [groups, filterMode]);

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
    }
  }, [filteredIndices, gridSearch]);

  const currentGroup = filteredGroups[selectedIndex] || undefined;

  // Compute compare groups based on pinned reference
  const { leftCompareGroup, rightCompareGroup, isLeftPinned, isRightPinned } =
    useMemo(() => {
      const leftBase = filteredGroups[selectedIndex];

      // When the working set shrinks (filter change, scan), the clamped indices
      // can collide. Showing the same photo on both sides of a comparison is
      // never useful, so fall through to a neighbour.
      let rightDefault = filteredGroups[compareIndex];
      if (
        !rightDefault ||
        (rightDefault.id === leftBase?.id && filteredGroups.length > 1)
      ) {
        rightDefault =
          filteredGroups[selectedIndex + 1] ?? filteredGroups[0];
      }

      if (!pinnedId) {
        return {
          leftCompareGroup: leftBase,
          rightCompareGroup: rightDefault,
          isLeftPinned: false,
          isRightPinned: false,
        };
      }

      const pinnedGroup =
        filteredGroups.find((g) => g.id === pinnedId) || leftBase;

      if (isPinnedOnLeft) {
        return {
          leftCompareGroup: pinnedGroup,
          rightCompareGroup: filteredGroups[compareIndex] || rightDefault,
          isLeftPinned: true,
          isRightPinned: false,
        };
      } else {
        return {
          leftCompareGroup: filteredGroups[selectedIndex] || leftBase,
          rightCompareGroup: pinnedGroup,
          isLeftPinned: false,
          isRightPinned: true,
        };
      }
    }, [filteredGroups, selectedIndex, compareIndex, pinnedId, isPinnedOnLeft]);

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
      console.error('Scan failed:', err);
      toast.error(
        `扫描失败：${String(err)}\n请确认文件夹路径存在且有读取权限，然后重试。`,
      );
    } finally {
      setIsLoading(false);
    }
  }, [jpgFolder, rawFolder, sortOrder, settings, toast]);

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
    [currentGroup, reportRatingFlagError],
  );

  const handleFlag = useCallback(
    async (
      flag: 'pick' | 'reject' | 'none',
      targetGroup: PhotoGroupInfo = currentGroup!,
    ) => {
      if (!targetGroup) return;
      const targetPath = targetGroup.raw?.path || targetGroup.jpg?.path;
      if (!targetPath) return;

      setGroups((prev) =>
        prev.map((g) => (g.id === targetGroup.id ? { ...g, flag } : g)),
      );

      try {
        await api.updateRatingFlag(targetPath, targetGroup.rating, flag, true);
      } catch (err) {
        reportRatingFlagError(err);
      }
    },
    [currentGroup, reportRatingFlagError],
  );

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
    if (!currentGroup) return;
    const toneToSave =
      toneMap[currentGroup.id] || currentGroup.tone || DEFAULT_TONE;
    const targetPath = currentGroup.raw?.path || currentGroup.jpg?.path;
    if (!targetPath) return;

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
    }
  }, [currentGroup, toneMap, toast]);

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

  // Save session when index changes
  useEffect(() => {
    if (jpgFolder && selectedIndex >= 0) {
      api
        .saveSession(jpgFolder, rawFolder, selectedIndex, sortOrder)
        .catch((err) => console.error('Failed to save session:', err));
    }
  }, [selectedIndex, jpgFolder, rawFolder, sortOrder]);

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
        isLoading={isLoading}
        filterMode={filterMode}
        onFilterChange={setFilterMode}
        sortOrder={sortOrder}
        onSortChange={setSortOrder}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onOpenExportModal={() => setIsExportOpen(true)}
        onOpenSettingsModal={() => setIsSettingsOpen(true)}
        onOpenMetadataModal={() => setIsMetadataOpen(true)}
        onToggleTonalAdjuster={handleToggleTonalPanel}
        showTonalPanel={showTonalPanel}
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
            isTonalPanelOpen={showTonalPanel}
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
            isTonalPanelOpen={showTonalPanel}
            isLuminarRunning={isLuminarRunning}
            emptyState={viewportEmptyState}
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
            onSelectLeft={() => {}}
            onSelectRight={() => {
              if (compareIndex >= 0 && compareIndex < filteredGroups.length) {
                setSelectedIndex(compareIndex);
              }
            }}
          />
        )}        {/* Right Sidebar (Thumbnail Grid OR Tonal Adjuster) */}
        <div className="w-[390px] h-full shrink-0 bg-background-base">
          {showTonalPanel && currentGroup ? (
            <TonalAdjuster
              tone={currentTone || DEFAULT_TONE}
              onChange={handleToneChange}
              onReset={handleResetTone}
              onAuto={handleAutoTone}
              onSave={handleSaveTone}
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
        onSettingsSaved={(s) => setSettings(s)}
        onError={(m) => toast.error(m)}
        lumenStatus={lumenStatus}
        capabilities={lumenCaps}
        onSyncRatings={lumenStatus?.available ? handleSyncLumenRatings : undefined}
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
