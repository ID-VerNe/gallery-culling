import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { groupPath } from '../utils/groupPath';
import type { CullFlag, PhotoGroupInfo } from '../types';

/** 批量确认框里的旗标叫法，与宫格/底栏保持一致。 */
const FLAG_LABELS: Record<CullFlag, string> = {
  pick: '保留',
  reject: '淘汰',
  none: '未标记',
};

export type BatchAction =
  | { kind: 'rate'; value: number }
  | { kind: 'flag'; value: CullFlag }
  | { kind: 'clear' };

/**
 * 批量评分/旗标写盘。
 *
 * 三条约定：
 * - **逐张乐观更新 + 逐张推进度**。用户看着进度条推进，比一个不动的转圈可信。
 * - **单张失败不中断整批**。失败的那张打持久"未同步"角标（toast 会消失，
 *   角标不会），用户可以逐张点重试。
 * - **取消走协作标志**：执行前先读 `batchCancelRef`，而不是靠 `await` 中断。
 *   前端逐张写盘没有后端进度事件，中断点只能自己埋。
 */
export function useBatchOps(opts: {
  filteredGroups: PhotoGroupInfo[];
  selectedIds: Set<string>;
  onGroupPatched: (id: string, patch: Partial<PhotoGroupInfo>) => void;
  markSynced: (id: string) => void;
  markUnsynced: (id: string) => void;
  rememberRating: (s: {
    id: string;
    path: string;
    rating: number;
    flag: CullFlag;
  }) => void;
  /** 待确认的批量操作。state 归 useRatingFlagSync 持有（它是唯一入口）。 */
  pendingBatch: BatchAction | null;
}) {
  const {
    filteredGroups,
    selectedIds,
    onGroupPatched,
    markSynced,
    markUnsynced,
    rememberRating,
    pendingBatch,
  } = opts;
  const toast = useToast();

  const [batchProgress, setBatchProgress] = useState<{
    processed: number;
    total: number;
  } | null>(null);
  /** 批量执行中"跳过剩余"的协作标志（读取走 ref，避免闭包陈旧）。 */
  const batchCancelRef = useRef(false);
  const [batchCancelling, setBatchCancelling] = useState(false);
  /**
   * B1：执行批量写盘。逐张乐观更新 + 写 XMP，进度条实时推进；单张失败不中断
   * 整批（失败的那张打持久"未同步"角标），结束时如实汇报成功/失败张数。
   */
  const runBatch = useCallback(
    async (action: BatchAction) => {
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
          action.kind === 'rate' ? action.value : action.kind === 'clear' ? 0 : g.rating;
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
        onGroupPatched(g.id, { rating: nextRating, flag: nextFlag });

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
    [filteredGroups, selectedIds, onGroupPatched, markSynced, markUnsynced, rememberRating, toast],
  );

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

  return {
    batchProgress,
    batchCancelling,
    pendingBatch,
    pendingBatchSummary,
    runBatch,
    /** 「跳过剩余」：置协作标志，当前这张写完即退出循环。 */
    skipRemaining: useCallback(() => {
      batchCancelRef.current = true;
      setBatchCancelling(true);
    }, []),
  };
}