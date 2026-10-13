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
import { computeAutoTone, DEFAULT_TONE, toneEquals } from './utils/autoTone';
import { deriveCompareGroups } from './utils/compareGroups';
import { countByFilter, matchesFilter } from './utils/filterMatch';
import { groupPath } from './utils/groupPath';


/** L-11 撤销提示里用到的旗标文案（与宫格/底栏的叫法保持一致）。 */
const FLAG_LABELS: Record<CullFlag, string> = {
  pick: '保留',
  reject: '淘汰',
  none: '未标记',
};

function AppShell() {
  const toast = useToast();

  // 扫描的进度与取消（M-05）。解构出**稳定引用**的成员：`start/finish/
  // isCancelRequested` 都不随进度变化，因此 `handleScan` 的 identity 不会
  // 因为进度事件每几十毫秒刷新一次而抖动（否则会连带触发 [sortOrder] 那个
  // effect 反复重新扫描）。
  const scanTask = useTaskProgress('scan');
  const { start: scanStart, finish: scanFinish, cancel: scanCancel } = scanTask;

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

  const [jpgFolder, setJpgFolder] = useState('');
  const [rawFolder, setRawFolder] = useState('');
  const [groups, setGroups] = useState<PhotoGroupInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [compareIndex, setCompareIndex] = useState<number>(1);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [isPinnedOnLeft, setIsPinnedOnLeft] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState(false);
  /**
   * UX-15：最近一次扫描的真实失败原因（`null` = 无失败）。
   *
   * 原先失败只走一次 toast 就消失了：批量扫描时用户会同时盯着宫格和
   * 进度条，toast 3 秒后自动退场，等反应过来已经不知道是哪一步坏了。
   * 这里保留文案并在顶栏常驻，用户可自行「忽略」。
   * 用户主动取消**不**算失败（后端以 `任务已取消` 哨兵返回）。
   */
  const [scanError, setScanError] = useState<string | null>(null);
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

  /**
   * B1：宫格多选集合（受控）。空集 = 沿用单选取值。
   * 有 ≥2 张时按 `1..5 / P / X` 走批量写盘（带确认与进度）。
   */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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
  /**
   * C3：调色未保存时"离开"动作的暂存。用户在确认框里选"放弃改动"才执行它，
   * 选"继续编辑"就丢弃。null = 没有待确认的离开。
   */
  const [pendingLeaveTone, setPendingLeaveTone] = useState<
    { run: () => void } | null
  >(null);
  /** A1：更新下载/安装进行中（弹窗保持可见并显示进度）。 */
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState('');

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
  /** UX-12：auto-tone 计算中。RAW-only 要等 LUMEN 预览渲染，采样也是异步的，
      全程数秒无任何反馈，按钮看起来像没生效。 */
  const [isAutoToning, setIsAutoToning] = useState(false);
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

  /** A13：打开调色面板前的焦点元素，关闭时归还（键盘用户的"回家"路径）。 */
  const tonalTriggerRef = useRef<HTMLElement | null>(null);

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
            // A1：安装期间保持弹窗可见并显示进度，避免"点了没反应以为死机"。
            setUpdateBusy(true);
            setUpdateStatus('正在准备下载…');
            let downloaded = 0;
            let total: number | null = null;
            try {
              await update.downloadAndInstall((event) => {
                if (event.event === 'Started') {
                  total = event.data.contentLength ?? null;
                  setUpdateStatus('正在下载…');
                } else if (event.event === 'Progress') {
                  downloaded += event.data.chunkLength;
                  setUpdateStatus(
                    total
                      ? `正在下载 ${Math.min(
                          100,
                          Math.round((downloaded / total) * 100),
                        )}%`
                      : '正在下载…',
                  );
                } else if (event.event === 'Finished') {
                  setUpdateStatus('正在安装，即将重启…');
                }
              });
              await relaunch();
            } catch (err) {
              console.error('Failed to install update:', err);
              setUpdateBusy(false);
              setUpdateStatus('');
              setPendingUpdate(null);
              toast.error(
                `升级失败：${String(err)}\n请检查网络后重试，或到发布页手动下载安装包。`,
              );
            }
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
  //
  // B4：光按**下标**裁剪会让"当前照片"无声消失（下标的含义在切换前后不同）。
  // 切档时先记下当前照片的 id，切完优先按 id 找回同一张；确实不在结果里时
  // 才退化到下标裁剪，并明确提示。
  const preferredSelectIdRef = useRef<string | null>(null);

  useEffect(() => {
    const max = filteredGroups.length;
    if (max === 0) {
      setSelectedIndex(0);
      setCompareIndex(0);
      preferredSelectIdRef.current = null;
      return;
    }
    const wanted = preferredSelectIdRef.current;
    preferredSelectIdRef.current = null;
    if (wanted) {
      const idx = filteredGroups.findIndex((g) => g.id === wanted);
      if (idx >= 0) {
        setSelectedIndex(idx);
        setCompareIndex((prev) => Math.min(prev, max - 1));
        return;
      }
      // 当前照片不在新筛选结果里 —— 明确告知，而不是静默跳走。
      toast.info('当前照片不在该筛选结果中，已切换到首张匹配。');
    }
    setSelectedIndex((prev) => Math.min(prev, max - 1));
    setCompareIndex((prev) => Math.min(prev, max - 1));
    // 仅在筛选结果集合变化时重算；`filteredGroups` 是 useMemo 派生，引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredGroups]);

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
   * B4：切筛选档位前记下"当前照片"的 id，切完由 effect 优先按 id 找回同一张。
   * 下标在切换前后含义不同，直接沿用会让当前照片无声消失。
   */
  const handleFilterChange = useCallback(
    (m: FilterMode) => {
      preferredSelectIdRef.current = filteredGroups[selectedIndex]?.id ?? null;
      // 切档后旧的选区多半已不在结果里，清空避免"看不见的选区"被批量写盘。
      setSelectedIds(new Set());
      setFilterMode(m);
    },
    [filteredGroups, selectedIndex],
  );

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

  // 空格「设为基准」：落在**当前照片**上，且是切换语义。
  //
  // 不用 handleTogglePinRight —— 无基准时 right 恒等于 compareIndex 那张，
  // 单图视口下会把另一张照片钉为基准，界面上看不出发生了什么。
  // 钉在右侧窗格（比较视图里看得到"基准 vs 候选"），与左/中/右位置无关。
  const handleTogglePinCurrent = useCallback(() => {
    if (!currentGroup) return;
    setPinnedId((prev) => (prev === currentGroup.id ? null : currentGroup.id));
  }, [currentGroup]);

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
    // 每次重新扫描都先清掉上一轮的错误，避免旧故障文案挂在新扫描上。
    setScanError(null);
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
        // UX-15：常驻顶栏，不只靠一次 toast。
        setScanError(String(err));
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

  /**
   * E3：扫描取消要**捕获失败**。原先 `onCancel={() => void scanTask.cancel()}`
   * 把 rejection 丢掉 —— 取消请求失败时按钮悄悄弹回"取消"，用户零反馈。
   */
  const handleCancelScan = useCallback(() => {
    scanCancel().catch((err) => {
      console.error('Cancel scan failed:', err);
      toast.error(
        `取消扫描失败：${String(err)}\n扫描可能仍在进行，请稍后重试。`,
      );
    });
  }, [scanCancel, toast]);

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

  const handleToggleTonalPanel = useCallback(() => {
    // A13：记下打开前的焦点元素，关闭面板时归还焦点，键盘用户不会"迷路"。
    if (!showTonalPanel) {
      const ae = document.activeElement;
      if (ae instanceof HTMLElement) tonalTriggerRef.current = ae;
    }
    setShowTonalPanel((prev) => !prev);
  }, [showTonalPanel]);

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
      // C3：编辑只落在内存（toneMap）。**不再同步写 `groups[].tone`** —— 那是
      // "磁盘真值"的基线，一旦被编辑覆盖，"是否有未保存改动"就无从判断。
      // 保存成功（handleSaveTone）时才把基线更新为新值，dirty 随之清零。
      setToneMap((prev) => ({ ...prev, [currentGroup.id]: newTone }));
    },
    [currentGroup],
  );

  const handleResetTone = useCallback(() => {
    if (!currentGroup) return;
    setToneMap((prev) => ({ ...prev, [currentGroup.id]: { ...DEFAULT_TONE } }));
  }, [currentGroup]);

  /** C3：调色是否有未保存改动（当前编辑值 ≠ 磁盘基线）。 */
  const toneDirty =
    !!currentGroup &&
    !!currentTone &&
    !toneEquals(currentTone, currentGroup.tone ?? DEFAULT_TONE);

  /** C3：丢弃当前照片的未保存编辑，回到磁盘基线。 */
  const discardToneEdits = useCallback(() => {
    if (!currentGroup) return;
    setToneMap((prev) => {
      const next = { ...prev };
      delete next[currentGroup.id];
      return next;
    });
  }, [currentGroup]);

  /**
   * C3：离开保护。切图 / 关面板前若存在未保存改动，先弹确认，避免静默丢失。
   * 用户选"放弃改动"才真正执行离开动作（并丢弃内存中的编辑）。
   */
  const guardToneLeave = useCallback(
    (run: () => void) => {
      if (toneDirty) {
        setPendingLeaveTone({
          run: () => {
            discardToneEdits();
            run();
          },
        });
      } else {
        run();
      }
    },
    [toneDirty, discardToneEdits],
  );

  /** C3：关闭调色面板（带未保存保护）。 */
  const closeTonePanel = useCallback(() => {
    guardToneLeave(() => setShowTonalPanel(false));
  }, [guardToneLeave]);

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

  const handleAutoTone = useCallback(async () => {
    if (!currentGroup || isAutoToning) return;
    const finish = (img: HTMLImageElement) => {
      handleToneChange(computeAutoTone(img));
      setIsAutoToning(false);
    };

    const loadAndFinish = (src: string) => {
      const tempImg = new Image();
      tempImg.crossOrigin = 'anonymous';
      tempImg.onload = () => finish(tempImg);
      tempImg.onerror = () => {
        setIsAutoToning(false);
        toast.error('无法读取该照片的像素数据，自动调色已取消。');
      };
      tempImg.src = src;
    };

    // The viewport hands us the element it actually rendered, so this works
    // even when two photos share a basename (F-15). 仅单图模式有注入，
    // 对比/前后模式 `previewImageRef` 可能残留旧图，必须忽略。
    const rendered = previewImageRef.current;
    if (
      viewMode === 'single' &&
      rendered &&
      rendered.complete &&
      rendered.naturalWidth > 0
    ) {
      setIsAutoToning(true);
      finish(rendered);
      return;
    }

    // 有 JPG 就直接采样 JPG，零成本且必成功。
    if (currentGroup.jpg?.path) {
      setIsAutoToning(true);
      loadAndFinish(api.toAssetUrl(currentGroup.jpg.path));
      return;
    }

    // C10：RAW-only 时不能再回落到 `raw.path`（那是 .NEF，浏览器解不了，
    // 必然 onerror）。改为采样 LUMEN RAW 渲染出的预览图；引擎不可用时给出
    // 明确说明，而不是丢一句"无法读取像素数据"。
    const rawPath = currentGroup.raw?.path;
    if (rawPath && lumenAvailable) {
      setIsAutoToning(true);
      try {
        const prev = await api.getLumenPreview(rawPath, { width: 1024 });
        if (prev.previewPath) {
          loadAndFinish(api.toAssetUrl(prev.previewPath));
          return;
        }
      } catch (e) {
        console.warn('自动调色：LUMEN 预览取样失败', e);
      }
    }

    setIsAutoToning(false);
    toast.error(
      '无法读取该照片的像素数据：RAW 自动调色需要启用 LUMEN RAW 引擎（或同时选择 JPG 文件夹）。',
    );
  }, [currentGroup, handleToneChange, isAutoToning, toast, viewMode, lumenAvailable]);

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
    const targetPath = groupPath(currentGroup);
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
    const targetPath = groupPath(currentGroup);
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
      const targetPath = groupPath(currentGroup);
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
      const targetPath = groupPath(currentGroup);
      if (!targetPath) return;
      // 后端拒绝（引擎未启用 / 非 GPU 版 / 区域非法）会走到这里。原实现没有
      // try/catch，Promise 拒绝变成 unhandled rejection：用户看不到任何提示，
      // 面板也停在半开状态。
      try {
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
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        toast.error(`蒙版应用失败：${reason}。请确认使用 GPU 版 LUMEN RAW。`);
      }
    },
    [currentGroup, toast],
  );

  /** 读回工程里现有的 AI 蒙版（面板打开时）。 */
  useEffect(() => {
    if (!showTonalPanel || !currentGroup) {
      setLumenMasks([]);
      return;
    }
    const targetPath = groupPath(currentGroup);
    if (!targetPath || !lumenCaps?.aiMasks) return;
    let active = true;
    api
      .listLumenMasks(targetPath)
      .then((m) => active && setLumenMasks(m))
      // 读回失败不要静默吞掉：至少留一条 console.warn，比兄弟 getLumenCapabilities
      // /getToneState 都更不透明。完全静默会让「面板里没有蒙版」看起来像
      // 「这张图本来就没蒙版」，无法区分。
      .catch((e) => console.warn('listLumenMasks failed', e));
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
      // C3：走带未保存保护的关闭路径（有改动时先确认）。
      closeTonePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tonalPanelVisible, closeTonePanel]);

  // A13：面板从"可见"变为"不可见"时，把焦点归还给打开它的那个元素。
  const prevTonalVisibleRef = useRef(false);
  useEffect(() => {
    if (prevTonalVisibleRef.current && !tonalPanelVisible) {
      const el = tonalTriggerRef.current;
      if (el && document.contains(el)) el.focus({ preventScroll: true });
      tonalTriggerRef.current = null;
    }
    prevTonalVisibleRef.current = tonalPanelVisible;
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
        onDismissScanError={() => setScanError(null)}
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
        onClose={() => {
          // A1：下载/安装进行中不许关窗（否则进度无从查看，用户以为卡死）。
          if (!updateBusy) setPendingUpdate(null);
        }}
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
        busy={updateBusy}
        busyLabel={updateStatus || '正在更新…'}
        closeOnConfirm={false}
      />

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
