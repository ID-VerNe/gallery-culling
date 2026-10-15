import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { useTaskProgress } from './useTaskProgress';
import { isTaskCancelled } from '../services/taskApi';
import type { SortOrder, ToneAdjustments } from '../types';

interface ScanResult {
  groups: import('../types').PhotoGroupInfo[];
}

/**
 * 目录扫描：JPG/RAW 路径、排序、进度与取消。
 *
 * 扫描命中后要做的事很多（回填调色、恢复会话位置、丢弃钉基准、记默认目录），
 * 但这些都属于**别的领域**（集合 / 对比 / 设置），所以本 hook 只接收一个
 * `onScanned` 回调把结果交出去，不持有它们的 state。
 *
 * 这样避免了「先抽 handleScan 要传 8-10 个 setter，之后每步都得改它的
 * 参数表」的返工。
 */
export function useFolderScan(opts: {
  /**
   * 扫描成功后把结果交给上层（集合/对比/调色各自消费）。
   *
   * `selectedIndexAtStart` = 扫描**启动那一刻**的选中索引（由 `getSelectedIndex`
   * 提供；调用方未提供则为 null）。完成回调里若它与「当前值」不同，说明用户在
   * 扫描窗口内改过选中 —— 上层必须优先尊重用户操作，而不是恢复会话位置。
   */
  onScanned: (
    groups: ScanResult['groups'],
    initialTones: Record<string, ToneAdjustments>,
    historyIndex: number | null,
    selectedIndexAtStart: number | null,
  ) => void;
  /** 重新扫描前清空撤销栈：旧快照可能已指向不存在的照片。 */
  beforeScan?: () => void;
  /** 扫描结束后把本次目录记为默认。 */
  persistFolders: (jpg: string, raw: string, sortOrder: SortOrder) => void;
  /** 取「当前选中索引」；用于扫描启动时的快照（判定用户是否在扫描期间动过）。 */
  getSelectedIndex?: () => number;
}) {
  const { onScanned, beforeScan, persistFolders, getSelectedIndex } = opts;

  const toast = useToast();
  const [jpgFolder, setJpgFolder] = useState('');
  const [rawFolder, setRawFolder] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('time_filename');
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

  const scanTask = useTaskProgress('scan');
  // 解构出**稳定引用**的成员：`start/finish/isCancelRequested` 都不随进度
  // 变化，因此 `handleScan` 的 identity 不会因为进度事件每几十毫秒刷新一次
  // 而抖动（否则会连带触发 [sortOrder] 那个重扫 effect）。
  const { start: scanStart, finish: scanFinish, cancel: scanCancel } = scanTask;

  const handleScan = useCallback(async () => {
    if (!jpgFolder.trim()) return;
    // 扫描是异步的（几百 ms 到几秒）：在**任何 await 之前**快照选中索引，
    // 完成时交给 onScanned 判定「用户在扫描窗口内是否动过选中」。
    // 没有这一步，扫描完成会用会话 lastIndex 无条件覆盖用户的点击
    // （2026-10-15 e2e run5 实锤：点击 IMG_010 被翻回 IMG_011，apply 写错文件）。
    const selectedIndexAtStart = getSelectedIndex?.() ?? null;
    setIsLoading(true);
    // 每次重新扫描都先清掉上一轮的错误，避免旧故障文案挂在新扫描上。
    setScanError(null);
    scanStart();
    beforeScan?.();

    try {
      const res = await api.scanFolders(jpgFolder, rawFolder, sortOrder);

      // Populate initial tones from XMP
      const initialTones: Record<string, ToneAdjustments> = {};
      res.groups.forEach((g) => {
        if (g.tone) initialTones[g.id] = g.tone;
      });

      // Check session history for this folder
      const history = await api.loadSession(jpgFolder);

      onScanned(res.groups, initialTones, history ? history[0] : null, selectedIndexAtStart);

      // Save as default in settings
      persistFolders(jpgFolder, rawFolder, sortOrder);

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
    toast,
    scanStart,
    scanFinish,
    beforeScan,
    onScanned,
    persistFolders,
    getSelectedIndex,
  ]);

  /**
   * E3：扫描取消要**捕获失败**。原先 `onCancel={() => void scanTask.cancel()}`
   * 把 rejection 丢掉 —— 取消请求失败时按钮悄悄弹回"取消"，用户零反馈。
   */
  const handleCancelScan = useCallback(() => {
    scanCancel().catch((err) => {
      console.error('Cancel scan failed:', err);
      toast.error(`取消扫描失败：${String(err)}\n扫描可能仍在进行，请稍后重试。`);
    });
  }, [scanCancel, toast]);

  // Re-scan when the sort order changes —— **仅限用户主动改排序**。
  //
  // 上一版从 onChange 里直接调 `handleScan()`，闭包拿到的是**旧** sortOrder，
  // 每次改排序都用旧值重扫（F-12）—— 改成 effect 监听 [sortOrder]，由新值驱动。
  //
  // 旧版用「跳过首次」guard 想挡住「settings 回填顺带带回的 sortOrder」，
  // 但 settings 是**异步**加载（useAppSettings 在 useEffect 里 fetch），回填
  // 必然晚于本 effect 首次运行 —— guard 早已置位，迟到变化照样触发扫描：
  // 打开应用即静默自动扫描（2026-10-15 e2e run5 实锤：该次自动扫描与手动
  // 扫描并发，两次会话恢复把用户的点击覆盖掉）。
  //
  // 改为「来源标记」：只有经 `handleSortOrderChange`（用户操作）的改动才重扫；
  // settings 回填走裸 `setSortOrder`，不置标记、不触发。
  const sortOrderChangedByUser = useRef(false);
  const handleSortOrderChange = useCallback((order: SortOrder) => {
    sortOrderChangedByUser.current = true;
    setSortOrder(order);
  }, []);
  useEffect(() => {
    // 无条件消费标记：即使本次变化不触发扫描，也不给下次留脏状态。
    const byUser = sortOrderChangedByUser.current;
    sortOrderChangedByUser.current = false;
    if (!byUser) return;
    if (!jpgFolder.trim()) return;
    void handleScan();
    // 依赖刻意是 [sortOrder] 而非 [handleScan]：
    // handleScan 的 identity 会被 persistFolders（settings 读回后重建）与
    // onScanned 带动而抖动，挂在它上面会让**设置加载完就凭空扫一次目录**。
    // 这里只在排序真的变了时重扫 —— 与拆分前的行为逐字一致。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortOrder]);

  // 目录选择失败（无权限 / 对话框起不来）必须报出来：静默返回空会让用户
  // 以为按钮坏了。用当前值作为对话框起始位置。
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

  return {
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
    /** 裸 setter：settings 回填专用（不触发重扫）。用户改排序走 handleSortOrderChange。 */
    setSortOrder,
    /** 用户主动改排序：置来源标记并触发重扫。 */
    handleSortOrderChange,
    dismissScanError: useCallback(() => setScanError(null), []),
  };
}