import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { groupPath } from '../utils/groupPath';
import { LABEL_NAMES } from '../utils/labels';
import { FLAG_NAMES, type CullCommand, type CullItem } from '../utils/cullCommand';
import type { ColorLabel, CullFlag, PhotoGroupInfo } from '../types';

export type BatchAction =
  | { kind: 'rate'; value: number }
  | { kind: 'flag'; value: CullFlag }
  | { kind: 'label'; value: ColorLabel }
  | { kind: 'clear' };

/**
 * 批量命令的可读摘要（底栏「撤销：淘汰 3 张」与撤销 toast 共用）。
 *
 * 旗标读作「淘汰 3 张」而不是「标记为淘汰（3 张）」：底栏宽度有限，
 * 且旗标动作本身就是动词。
 */
function summarizeBatch(action: BatchAction, count: number): string {
  if (action.kind === 'rate') return `设为 ${action.value} 星（${count} 张）`;
  if (action.kind === 'flag') return `${FLAG_NAMES[action.value]} ${count} 张`;
  if (action.kind === 'label') return `色标设为${LABEL_NAMES[action.value]}（${count} 张）`;
  return `清除 ${count} 张的星级与标记`;
}

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
  /**
   * FR-04：整批只压**一条**命令。旧实现逐张 `rememberRating`，200 张批量在
   * 5 步上限里只留下最后 5 张 —— 撤销一次退一张，整批退不回去。
   */
  pushCommand: (command: CullCommand) => void;
  /** 待确认的批量操作。state 归 useRatingFlagSync 持有（它是唯一入口）。 */
  pendingBatch: BatchAction | null;
}) {
  const {
    filteredGroups,
    selectedIds,
    onGroupPatched,
    markSynced,
    markUnsynced,
    pushCommand,
    pendingBatch,
  } = opts;
  const toast = useToast();

  const [batchProgress, setBatchProgress] = useState<{
    processed: number;
    total: number;
  } | null>(null);
  /** 批量执行中"跳过剩余"的协作标志（读取走 ref，避免闭包陈旧）。 */
  const batchCancelRef = useRef(false);
  /**
   * FR-09：重入保护。快捷键可以在批量进行中再次触发（确认框 → 确认），
   * 两批同时写同一批文件会互相覆盖，且共用一条进度条。
   */
  const runningRef = useRef(false);
  const [batchCancelling, setBatchCancelling] = useState(false);
  /**
   * B1：执行批量写盘。逐张乐观更新 + 写 XMP，进度条实时推进；单张失败不中断
   * 整批（失败的那张打持久"未同步"角标），结束时如实汇报成功/失败张数。
   */
  const runBatch = useCallback(
    async (action: BatchAction) => {
      if (runningRef.current) return;
      const targets = filteredGroups.filter((g) => selectedIds.has(g.id));
      if (targets.length === 0) return;

      runningRef.current = true;
      batchCancelRef.current = false;
      setBatchCancelling(false);
      setBatchProgress({ processed: 0, total: targets.length });

      let ok = 0;
      let failed = 0;
      /**
       * 实际处理过的照片。**只有进入写盘流程的才记**：中途「跳过剩余」时，
       * 没碰过的照片不该出现在撤销命令里 —— 否则撤销会把它们也"恢复"成
       * 一个它们从未改变过的旧值。
       */
      const items: CullItem[] = [];
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
        // 批量色标是"设为"而不是"切换"：20 张里有 3 张已是红标时，
        // 逐张切换会让结果取决于各自原值，用户无法预期。
        const nextLabel = action.kind === 'label' ? action.value : g.label;

        items.push({
          id: g.id,
          path: targetPath,
          before: { rating: g.rating, flag: g.flag, label: g.label },
          after: { rating: nextRating, flag: nextFlag, label: nextLabel },
        });
        onGroupPatched(g.id, {
          rating: nextRating,
          flag: nextFlag,
          label: nextLabel,
        });

        try {
          // 每张只改一次，没有「后续改动」需要等：关掉合并，直接落盘。
          await api.updateRatingFlag(
            targetPath,
            nextRating,
            nextFlag,
            true,
            false,
            nextLabel,
          );
          markSynced(g.id);
          ok++;
        } catch (err) {
          console.error('Batch XMP update error:', err);
          markUnsynced(g.id);
          failed++;
        }
        setBatchProgress({ processed: i + 1, total: targets.length });
      }

      // 整批一条命令：撤销一次回到批量之前，而不是退一张。
      if (items.length > 0) {
        pushCommand({ summary: summarizeBatch(action, items.length), items });
      }

      const cancelled = batchCancelRef.current;
      runningRef.current = false;
      setBatchProgress(null);
      setBatchCancelling(false);
      if (failed > 0) {
        toast.error(
          `批量写入完成：${ok} 张成功，${failed} 张未同步到 XMP（格子上有红色角标，可点击重试）。`,
        );
      } else if (cancelled) {
        toast.info(`已停止：${ok} 张已写入 XMP。`);
      } else {
        toast.success(`已批量写入 ${ok} 张的星级/标记/色标到 XMP 侧边栏。`);
      }
    },
    [filteredGroups, selectedIds, onGroupPatched, markSynced, markUnsynced, pushCommand, toast],
  );

  const pendingBatchSummary = useMemo(() => {
    if (!pendingBatch) return '';
    const count = selectedIds.size;
    if (pendingBatch.kind === 'rate') {
      return `将 ${count} 张照片的星级设为 ${pendingBatch.value} 星`;
    }
    if (pendingBatch.kind === 'flag') {
      return `将 ${count} 张照片标记为「${FLAG_NAMES[pendingBatch.value]}」`;
    }
    if (pendingBatch.kind === 'label') {
      return `将 ${count} 张照片的色标设为「${LABEL_NAMES[pendingBatch.value]}」`;
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