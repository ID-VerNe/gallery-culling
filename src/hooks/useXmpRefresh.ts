/**
 * FR-08：从 XMP 增量读取 —— 窗口重新聚焦时静默对齐，冲突不自动覆盖。
 *
 * 为什么触发点是「窗口重新聚焦」而不是定时器：
 * 外部改动（Lightroom / Bridge / 别的脚本）只可能发生在用户切走之后。切回来
 * 正是「现在该看一眼磁盘」的时刻；定时轮询会在用户什么都没做的 10k 张目录上
 * 反复 stat，代价与收益倒挂。
 *
 * 三条纪律：
 * - **常态零打扰**：`baselined` / `unchanged` 不产生任何提示。升级用户第一次
 *   刷新会得到 `baselined: 10000`，照「有返回值就提示」写会变成每次开应用都
 *   被一条「已更新 10000 张」的假消息砸中。
 * - **不自动覆盖**：本地有未落盘意图、外部也改了 → 只弹裁决，一个字节都不写。
 * - **弹窗优先**：待裁决列表开着时，聚焦触发的刷新直接让路 —— 换掉列表等于
 *   把用户正在做的裁决凭空抹掉。
 *
 * 与 `useRatingFlagSync` 的分工：那边是「用户改 → 写盘」，这边是「磁盘改 →
 * 回填界面」。两条方向相反的路径共用同一批 XMP，所以本 hook 在运行时会把
 * `refresh` 登记进互斥表（FR-09），扫描/导出/写盘期间自动让路。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { useTaskMutex } from './useTaskMutex';
import { groupPath } from '../utils/groupPath';
import { normalizeFilePath } from '../utils/pathNormalize';
import type {
  CullFlag,
  PhotoGroupInfo,
  XmpConflictChoice,
  XmpRefreshConflict,
  XmpRefreshItem,
  XmpRefreshReport,
} from '../types';

/**
 * 聚焦后的静默窗口：把「切回来又切走再切回来」的抖动合并成一次。
 *
 * 600ms 是经验值：短于用户读完一句 toast 的时间，长于 alt-tab 的误触间隔。
 * 更重要的是它给了外部程序落盘的时间 —— 从 Lightroom 切回来时 XMP 可能
 * 正在被写，立刻 stat 会读到旧 mtime，白等一次。
 */
export const XMP_REFRESH_DEBOUNCE_MS = 600;

export interface UseXmpRefreshOptions {
  /** 当前集合。目标 = 每个分组的主路径（RAW 优先），与写盘路径同源。 */
  groups: PhotoGroupInfo[];
  /** 采用外部值后的界面回填。 */
  onGroupPatched: (id: string, patch: Partial<PhotoGroupInfo>) => void;
  /**
   * 磁盘已成为真值 → 清掉「未同步」角标。
   *
   * 采用外部值之后本地与磁盘一致，角标再留着就是假警报；`keep-local` 写盘
   * 成功同理。
   */
  onSynced: (id: string) => void;
}

export interface XmpRefreshApi {
  /** 待裁决的冲突；null = 没有（弹窗关闭）。 */
  conflicts: XmpRefreshConflict[] | null;
  /** 正在读盘。 */
  refreshing: boolean;
  /** 正在提交裁决。 */
  resolving: boolean;
  /** 手动入口（「从 XMP 重新读取」）。被互斥挡住时给原因，不静默。 */
  refreshNow: () => Promise<void>;
  /** 提交裁决。「逐张选择」也走这条，一次提交多张。 */
  resolveConflicts: (choices: XmpConflictChoice[]) => Promise<void>;
  /** 关闭弹窗：只清状态，不写盘。 */
  dismissConflicts: () => void;
}

/** 路径 → 分组 id。归一化后比较，Windows 的大小写与分隔符差异不算不同。 */
function indexByPath(groups: PhotoGroupInfo[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const g of groups) {
    const path = groupPath(g);
    if (path) index.set(normalizeFilePath(path), g.id);
  }
  return index;
}

/**
 * 后端回传的旗标是字符串（serde 不做枚举校验）。落到 UI 前收一次口：
 * 认不出来就当无色标 —— 宁可少一个角标，也不要让 `flag` 变成类型之外的值
 * 把筛选和快捷键一起带偏。
 */
function toCullFlag(flag: string): CullFlag {
  return flag === 'pick' || flag === 'reject' ? flag : 'none';
}

function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function useXmpRefresh({
  groups,
  onGroupPatched,
  onSynced,
}: UseXmpRefreshOptions): XmpRefreshApi {
  const toast = useToast();
  const mutex = useTaskMutex();

  const [conflicts, setConflicts] = useState<XmpRefreshConflict[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resolving, setResolving] = useState(false);

  /**
   * 全部可变状态走 ref：聚焦监听只注册一次（依赖数组为空），否则每次
   * `groups` 变化都会重新挂监听，防抖窗口被反复重置，刷新永远发不出去。
   * 这与 `useSessionDebounce` 的 `sessionRef` 是同一模式。
   */
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;
  const mutexRef = useRef(mutex);
  mutexRef.current = mutex;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const patchedRef = useRef(onGroupPatched);
  patchedRef.current = onGroupPatched;
  const syncedRef = useRef(onSynced);
  syncedRef.current = onSynced;

  /** 重入保护：一批还没落地时不开第二批（互斥表是给别的任务看的，不是自锁）。 */
  const runningRef = useRef(false);
  const resolvingRef = useRef(false);
  /** 防抖定时器句柄。 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 把后端回传的项按路径落到分组上。匹配不到就跳过（扫描期间分组可能没了）。 */
  const applyItems = useCallback((items: XmpRefreshItem[]) => {
    if (items.length === 0) return;
    const index = indexByPath(groupsRef.current);
    for (const item of items) {
      const id = index.get(normalizeFilePath(item.path));
      if (!id) continue;
      patchedRef.current(id, {
        rating: item.state.rating,
        flag: toCullFlag(item.state.flag),
        label: item.state.label,
      });
      // 界面已与磁盘一致，未同步角标必须撤掉。
      syncedRef.current(id);
    }
  }, []);

  /** 汇总提示。只在「界面真的变了」或「需要用户动手」时说话。 */
  const reportRefresh = useCallback(
    (report: XmpRefreshReport) => {
      const adopted = report.adopted ?? [];
      const found = report.conflicts ?? [];
      const failed = report.failed ?? [];

      applyItems(adopted);
      if (found.length > 0) setConflicts(found);

      const parts: string[] = [];
      if (adopted.length > 0) parts.push(`已从 XMP 更新 ${adopted.length} 张`);
      if (found.length > 0) parts.push(`${found.length} 张有冲突待处理`);
      if (parts.length > 0) {
        const removed = adopted.filter((a) => a.sidecarRemoved).length;
        const tail =
          removed > 0
            ? `（其中 ${removed} 张的侧边栏已被外部删除，标记已清空）`
            : '';
        toastRef.current.info(`${parts.join('，')}。${tail}`);
      }

      if (failed.length > 0) {
        const names = failed.slice(0, 3).map(baseNameOf).join('、');
        const more = failed.length > 3 ? ` 等 ${failed.length} 张` : '';
        toastRef.current.error(
          `${failed.length} 张的 XMP 读不出来（文件被占用或已删除）：${names}${more}。` +
            '下次聚焦时会再试一次。',
        );
      }
    },
    [applyItems],
  );

  /**
   * 真正跑一次。
   *
   * `auto` 区分触发来源，只影响两件事：被互斥挡住时要不要解释（自动触发静默
   * 让路，手动点击必须给原因），以及弹窗开着时要不要让路。
   */
  const runRefresh = useCallback(
    async (auto: boolean) => {
      if (runningRef.current) return;
      // 弹窗开着时自动刷新会让路：换掉列表等于抹掉用户正在做的裁决。
      if (auto && conflictsRef.current !== null) return;

      const current = mutexRef.current;
      if (!current.canStart('refresh')) {
        if (!auto) {
          toastRef.current.info(current.blockReason('refresh') ?? '现在不能读取 XMP。');
        }
        return;
      }

      const targets = groupsRef.current.flatMap((g) => {
        const path = groupPath(g);
        return path ? [{ path, jpgPath: g.jpg?.path ?? null }] : [];
      });
      // 没有照片（还没扫描）→ 一个请求都不发。
      if (targets.length === 0) return;

      runningRef.current = true;
      setRefreshing(true);
      // 登记进互斥表：导出按钮的禁用原因里要能看到「正在读取 XMP」。
      const release = current.begin('refresh');
      try {
        reportRefresh(await api.refreshFromXmp(targets));
      } catch (err) {
        console.error('refresh_from_xmp_cmd failed:', err);
        toastRef.current.error(`读取 XMP 失败：${String(err)}`);
      } finally {
        release();
        runningRef.current = false;
        setRefreshing(false);
      }
    },
    [reportRefresh],
  );

  /** 手动入口：先掐掉待触发的防抖定时器，避免紧接着又跑一次。 */
  const refreshNow = useCallback(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await runRefresh(false);
  }, [runRefresh]);

  /**
   * 窗口重新聚焦 → 防抖后刷新。监听只注册一次，靠 ref 读最新状态。
   *
   * 用 DOM 的 `focus` 而不是 Tauri 的 `onFocusChanged`：WebView 的 window 在
   * 应用窗口重获焦点时同样会收到 focus，行为一致且不需要额外的 ACL 授权。
   */
  useEffect(() => {
    const onFocus = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void runRefresh(true);
      }, XMP_REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [runRefresh]);

  const resolveConflicts = useCallback(
    async (choices: XmpConflictChoice[]) => {
      if (resolvingRef.current) return;
      if (choices.length === 0) return;
      resolvingRef.current = true;
      setResolving(true);
      try {
        const report = await api.resolveXmpConflicts(choices);
        applyItems(report.applied ?? []);

        const failed = report.failed ?? [];
        const failedPaths = new Set(failed.map((f) => normalizeFilePath(f.path)));
        const handled = new Set(choices.map((c) => normalizeFilePath(c.path)));
        /**
         * 弹窗只在**待裁决集合真的空了**时关闭。
         *
         * 两个来源的残留都必须留着：写失败的（磁盘没改，用户该再选一次）、
         * 以及这一批压根没提交的（防御性 —— 界面一次提交全部，但少提交一条
         * 也不该把用户没决定的东西悄悄丢掉）。
         */
        const remaining = (conflictsRef.current ?? []).filter((c) => {
          const p = normalizeFilePath(c.path);
          return !handled.has(p) || failedPaths.has(p);
        });

        if (remaining.length === 0) {
          setConflicts(null);
          toastRef.current.success(
            `已处理 ${(report.applied ?? []).length} 张冲突。`,
          );
          return;
        }

        setConflicts(remaining);
        if (failed.length === 0) {
          toastRef.current.info(`已处理 ${handled.size} 张，还有 ${remaining.length} 张待裁决。`);
          return;
        }
        const head = failed
          .slice(0, 3)
          .map((f) => `· ${baseNameOf(f.path)}：${f.message}`)
          .join('\n');
        const more = failed.length > 3 ? `\n…另有 ${failed.length - 3} 张` : '';
        toastRef.current.error(
          `${failed.length} 张未能写入，仍留在列表里可以再选一次。\n${head}${more}`,
        );
      } catch (err) {
        console.error('resolve_xmp_conflicts_cmd failed:', err);
        // 弹窗保持原样：一张都没落地，用户的选择还该留着。
        toastRef.current.error(`裁决未能生效：${String(err)}`);
      } finally {
        resolvingRef.current = false;
        setResolving(false);
      }
    },
    [applyItems],
  );

  /** 关闭弹窗只清状态 —— 「不自动覆盖」的另一半是「不自动保留」。 */
  const dismissConflicts = useCallback(() => setConflicts(null), []);

  return {
    conflicts,
    refreshing,
    resolving,
    refreshNow,
    resolveConflicts,
    dismissConflicts,
  };
}
