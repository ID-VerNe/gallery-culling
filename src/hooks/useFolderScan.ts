import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { useTaskProgress } from './useTaskProgress';
import { isTaskCancelled } from '../services/taskApi';
import type {
  FolderMode,
  FolderProbe,
  PhotoGroupInfo,
  SortOrder,
  ToneAdjustments,
} from '../types';
import { folderDisplayName, folderProbeSummary } from '../utils/folderDetection';

interface ScanResult {
  groups: PhotoGroupInfo[];
}

/**
 * 从扫描结果反推目录构成（#66）。
 *
 * 用分组而不是文件数做判定：一组最多一个 JPG/RAW，含 jpg 的组数就是 JPG 文件数。
 * 空结果一律视为空目录 —— 此时文案要提醒检查子目录，而不是谎报「扫描成功 0 组」。
 */
function deriveDetection(groups: ScanResult['groups']): FolderProbe {
  const jpgCount = groups.filter((g) => g.jpg).length;
  const rawCount = groups.filter((g) => g.raw).length;
  const mode: FolderMode =
    groups.length === 0
      ? 'empty'
      : jpgCount > 0 && rawCount > 0
        ? 'mixed'
        : rawCount > 0
          ? 'raw_only'
          : 'jpg_only';
  return { mode, jpgCount, rawCount, subdirCount: 0 };
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
  /**
   * #66：最近一次「自动识别」结果（选目录时的 probe，或扫描结果回填）。
   *
   * `null` = 用户正在手动填路径，顶栏不显示自动识别标记。任何手动编辑都会
   * 清空它，避免把「自动识别」的牌子挂在用户手填的配置上。
   */
  const [folderDetection, setFolderDetection] = useState<FolderProbe | null>(null);

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

      // #66：扫描结果同样是识别真值 —— 手填路径（不经过 browse）也能看到
      // 「这次到底扫到了什么」，避免「RAW 被静默忽略」再次发生。
      const detection = deriveDetection(res.groups);
      setFolderDetection(detection);

      if (res.groups.length === 0) {
        // 0 组不是「成功」，需要给下一步：换目录 / 选具体子目录。
        toast.info(
          '扫描完成，但这个文件夹里没有可识别的 JPG / RAW 照片。\n如果照片在子文件夹里，请选择具体子文件夹（本应用不递归扫描子目录）。',
        );
      } else {
        toast.success(
          `扫描完成，共 ${res.groups.length} 组照片。已按${
            sortOrder === 'time_filename'
              ? '拍摄时间'
              : sortOrder === 'filename'
              ? '文件名'
              : '星级'
          }排序。`,
        );
      }
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

  /**
   * #66「选一个目录就够了」：选一个文件夹 → 识别 → 自动填两个源。
   *
   * 判定表：
   * - 仅 JPG：JPG = dir，RAW 留空（保持 viewer 模式）
   * - 仅 RAW / 混合：JPG = dir，RAW = dir（后端同路径只枚举一次）
   * - 空目录：**不改动**原路径（自动识别不能静默清掉用户已有的配置），
   *   只把识别结果与下一步文案画出来。
   *
   * 识别结果会写入 `folderDetection`，顶栏常驻显示；用户手动改任一输入框即清除。
   */
  const handleBrowseAuto = useCallback(async () => {
    try {
      const selected = await api.selectFolderDialog(jpgFolder || rawFolder);
      if (!selected) return;
      const probe = await api.probeFolder(selected);

      if (probe.mode === 'empty') {
        setFolderDetection(probe);
        const name = folderDisplayName(selected);
        if (probe.subdirCount > 0) {
          toast.error(
            `「${name}」根目录没有 JPG 或 RAW 照片，但它下面有 ${probe.subdirCount} 个子文件夹。\n请选择具体拍摄子文件夹（本应用不递归扫描子目录）。`,
          );
        } else {
          toast.error(`「${name}」里没有 JPG 或 RAW 照片。请换一个包含照片的文件夹。`);
        }
        return;
      }

      // 识别成功才改路径；这里是一次显式用户动作，且结果会同时画在顶栏上，
      // 不属于「静默替用户改路径」。
      setJpgFolder(selected);
      setRawFolder(probe.mode === 'jpg_only' ? '' : selected);
      setFolderDetection(probe);
      toast.success(
        `已识别「${folderDisplayName(selected)}」：${folderProbeSummary(probe)}。\n已自动填入扫描源；也可以直接改下面两个路径手动覆盖。`,
      );
    } catch (err) {
      toast.error(
        `识别文件夹失败：${String(err)}\n请确认路径存在且有读取权限，或直接用两个输入框手动指定。`,
      );
    }
  }, [jpgFolder, rawFolder, toast]);

  // 手动编辑 = 用户接管：清掉「自动识别」标记，避免标记与手填配置自相矛盾。
  const handleJpgFolderChange = useCallback((val: string) => {
    setJpgFolder(val);
    setFolderDetection(null);
  }, []);

  const handleRawFolderChange = useCallback((val: string) => {
    setRawFolder(val);
    setFolderDetection(null);
  }, []);

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
    handleBrowseAuto,
    handleJpgFolderChange,
    handleRawFolderChange,
    folderDetection,
    setJpgFolder,
    setRawFolder,
    /** 裸 setter：settings 回填专用（不触发重扫）。用户改排序走 handleSortOrderChange。 */
    setSortOrder,
    /** 用户主动改排序：置来源标记并触发重扫。 */
    handleSortOrderChange,
    dismissScanError: useCallback(() => setScanError(null), []),
  };
}