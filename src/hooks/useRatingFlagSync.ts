import { useCallback, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { useCullUndo } from './useCullUndo';
import { groupPath } from '../utils/groupPath';
import {
  summarizeClear,
  summarizeFlag,
  summarizeLabel,
  summarizeRating,
  type CullCommand,
  type MetaState,
} from '../utils/cullCommand';
import type { BatchAction } from './useBatchOps';
import type { ColorLabel, CullFlag, PhotoGroupInfo } from '../types';

/**
 * 评级与旗标的写盘：乐观更新 + 后台写 XMP + 失败留角标 + 多步撤销/重做。
 *
 * 三条约定，任何一条都不能破：
 * - **乐观更新**：界面先变，磁盘后追。写盘失败不回滚 UI —— 星级在屏幕上
 *   是有效的，只是没同步到 Lightroom。回滚会让用户以为自己手滑了。
 * - **写盘失败要留痕**：toast 会消失，格子上的"未同步"角标不会。两者都给。
 * - **评分与淘汰互斥**：给「已淘汰」的照片打星 = 解除淘汰。否则后端按
 *   reject 写 Rating=-1，界面显示「4 星」、磁盘仍是 -1，怎么打都摆脱不掉。
 */
export function useRatingFlagSync(opts: {
  currentGroup: PhotoGroupInfo | undefined;
  /** 乐观更新落回集合。 */
  onGroupPatched: (id: string, patch: Partial<PhotoGroupInfo>) => void;
  selectedCount: number;
}) {
  const { currentGroup, onGroupPatched, selectedCount } = opts;
  const toast = useToast();

  /**
   * B6：写盘失败、尚未同步到 XMP 的照片 id。用于格子上的持久"未同步"角标
   * （toast 会消失，角标不会），并提供点击重试。
   */
  const [unsyncedIds, setUnsyncedIds] = useState<Set<string>>(new Set());

  /**
   * B1：待确认的批量操作（确认后才真正逐张写盘）。
   *
   * state 归本 hook 持有而非批量执行器：打分/旗标/清除三个入口都在这里，
   * 让它们直接写同一个 state，不必把 setter 绕一圈传给批量执行器再传回来。
   */
  const [pendingBatch, setPendingBatch] = useState<BatchAction | null>(null);

  // FR-04：多步撤销。批量操作由 useBatchOps 自己压一整条命令，这里只管单张。
  const {
    canUndo,
    canRedo,
    undoSummary,
    redoSummary,
    push: pushCommand,
    undo: takeUndoCommand,
    redo: takeRedoCommand,
    clear: clearCullUndo,
  } = useCullUndo();

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
        `照片标记未能完整落盘：${String(err)}\n界面上的星级和保留/淘汰仍然有效，但重启或重新扫描后可能丢失。`,
      );
    },
    [toast, markUnsynced],
  );

  /**
   * 单张改动压栈。必须在乐观更新**之前**调用 —— `before` 取的是改之前的值。
   */
  const pushSingle = useCallback(
    (summary: string, group: PhotoGroupInfo, path: string, after: MetaState) => {
      pushCommand({
        summary,
        items: [
          {
            id: group.id,
            path,
            before: { rating: group.rating, flag: group.flag, label: group.label },
            after,
          },
        ],
      });
    },
    [pushCommand],
  );

  // Update Rating & Flag (syncs to XMP)
  const rate = useCallback(
    async (rating: number, targetGroup: PhotoGroupInfo = currentGroup!) => {
      if (!targetGroup) return;
      const targetPath = groupPath(targetGroup);
      if (!targetPath) return;

      // 评分必须与淘汰态互斥：给「已淘汰」的照片打星 = 解除淘汰。
      //
      // 否则原样透传 flag=reject，后端按 reject 写 Rating=-1 ——
      // 界面显示「4 星」、磁盘仍是 -1，用户打多少星都摆脱不掉淘汰标记。
      // pick 语义与评分正交（打了星仍是 pick），故只有 reject 被清掉。
      const nextFlag: CullFlag =
        targetGroup.flag === 'reject' && rating > 0 ? 'none' : targetGroup.flag;

      pushSingle(summarizeRating(rating), targetGroup, targetPath, {
        rating,
        flag: nextFlag,
        label: targetGroup.label,
      });

      onGroupPatched(targetGroup.id, { rating, flag: nextFlag });

      // Sync to XMP in background
      try {
        // 色标整组透传：只改星级不能顺手把用户设的色标清掉。
        await api.updateRatingFlag(
          targetPath,
          rating,
          nextFlag,
          true,
          true,
          targetGroup.label,
        );
        markSynced(targetGroup.id);
      } catch (err) {
        reportRatingFlagError(err, targetGroup.id);
      }
    },
    [currentGroup, reportRatingFlagError, pushSingle, markSynced, onGroupPatched],
  );

  const setFlag = useCallback(
    async (
      flag: 'pick' | 'reject' | 'none',
      targetGroup: PhotoGroupInfo = currentGroup!,
    ) => {
      if (!targetGroup) return;
      const targetPath = groupPath(targetGroup);
      if (!targetPath) return;

      pushSingle(summarizeFlag(flag), targetGroup, targetPath, {
        rating: targetGroup.rating,
        flag,
        label: targetGroup.label,
      });

      onGroupPatched(targetGroup.id, { flag });

      try {
        await api.updateRatingFlag(
          targetPath,
          targetGroup.rating,
          flag,
          true,
          true,
          targetGroup.label,
        );
        markSynced(targetGroup.id);
      } catch (err) {
        reportRatingFlagError(err, targetGroup.id);
      }
    },
    [currentGroup, reportRatingFlagError, pushSingle, markSynced, onGroupPatched],
  );

  /**
   * 设置色标。**重复按同一个色标 = 取消**（与 Lightroom 一致）。
   *
   * 色标是 `xmp:Label` 的唯一真值，与旗标（本地 store）互不影响：红标不代表
   * 淘汰，绿标也不代表保留 —— 这正是 ADR-001 把两个语义拆开的收益。
   */
  const setLabel = useCallback(
    async (next: ColorLabel, targetGroup: PhotoGroupInfo = currentGroup!) => {
      if (!targetGroup) return;
      const targetPath = groupPath(targetGroup);
      if (!targetPath) return;

      const label = targetGroup.label === next ? '' : next;

      pushSingle(summarizeLabel(label), targetGroup, targetPath, {
        rating: targetGroup.rating,
        flag: targetGroup.flag,
        label,
      });

      onGroupPatched(targetGroup.id, { label });

      try {
        await api.updateRatingFlag(
          targetPath,
          targetGroup.rating,
          targetGroup.flag,
          true,
          true,
          label,
        );
        markSynced(targetGroup.id);
      } catch (err) {
        reportRatingFlagError(err, targetGroup.id);
      }
    },
    [currentGroup, reportRatingFlagError, pushSingle, markSynced, onGroupPatched],
  );

  /**
   * B1：把"打分"入口按选区状态分流。多选 ≥2 张时先弹确认（批量写盘不可轻率），
   * 否则保持原有的单张即时写入。
   */
  const applyRating = useCallback(
    (rating: number) => {
      if (selectedCount > 1) setPendingBatch({ kind: 'rate', value: rating });
      else void rate(rating);
    },
    [selectedCount, rate],
  );

  /** B1：旗标入口同样的分流。 */
  const applyFlag = useCallback(
    (flag: CullFlag) => {
      if (selectedCount > 1) setPendingBatch({ kind: 'flag', value: flag });
      else void setFlag(flag);
    },
    [selectedCount, setFlag],
  );

  /**
   * 色标入口：多选时弹批量确认（批量是"设为"而不是"切换"），否则单张切换。
   */
  const applyLabel = useCallback(
    (label: ColorLabel) => {
      if (selectedCount > 1) setPendingBatch({ kind: 'label', value: label });
      else void setLabel(label);
    },
    [selectedCount, setLabel],
  );

  /** B6：点击格子上"未同步"角标时，用该张当前值重写 XMP。 */
  const retrySync = useCallback(
    async (group: PhotoGroupInfo) => {
      const targetPath = groupPath(group);
      if (!targetPath) return;
      try {
        // 显式重试：用户点了一次就该立刻写，不必等防抖窗口。
        await api.updateRatingFlag(
          targetPath,
          group.rating,
          group.flag,
          true,
          false,
          group.label,
        );
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
  const clearRatingFlag = useCallback(async () => {
    if (selectedCount > 1) {
      setPendingBatch({ kind: 'clear' });
      return;
    }
    const targetGroup = currentGroup;
    if (!targetGroup) return;
    const targetPath = groupPath(targetGroup);
    if (!targetPath) return;

    pushSingle(summarizeClear(), targetGroup, targetPath, {
      rating: 0,
      flag: 'none',
      // 色标不动：`0`/`U` 清的是星级与旗标，色标是另一个维度。
      label: targetGroup.label,
    });

    onGroupPatched(targetGroup.id, { rating: 0, flag: 'none' });
    try {
      await api.updateRatingFlag(
        targetPath,
        0,
        'none',
        true,
        true,
        targetGroup.label,
      );
      markSynced(targetGroup.id);
    } catch (err) {
      reportRatingFlagError(err, targetGroup.id);
    }
  }, [
    currentGroup,
    pushSingle,
    reportRatingFlagError,
    markSynced,
    onGroupPatched,
    selectedCount,
  ]);

  /**
   * 执行一条命令：逐条回填 UI + 写盘。`undo` 写 `before`，`redo` 写 `after`。
   *
   * 写盘必须 `coalesce=false`：撤销是一次确定的回填，用户不会再连按同一个键，
   * 等 400ms 静默窗口只会在批量撤销时把 200 张的收尾拖长。
   *
   * 错误处理刻意**整条命令只弹一次**：批量撤销 200 张若逐张报错会刷屏。首条失败
   * 仍走 `reportRatingFlagError`（保持"界面有效、未同步 XMP"的既有承诺），其余
   * 只打角标，末尾补一句张数。
   */
  const applyCommand = useCallback(
    async (command: CullCommand, direction: 'undo' | 'redo'): Promise<number> => {
      const key = direction === 'undo' ? 'before' : 'after';
      let failed = 0;
      let firstError: unknown = null;
      let firstErrorId: string | undefined;

      for (const item of command.items) {
        const state = item[key];
        onGroupPatched(item.id, state);
        try {
          await api.updateRatingFlag(
            item.path,
            state.rating,
            state.flag,
            true,
            false,
            state.label,
          );
          markSynced(item.id);
        } catch (err) {
          console.error('XMP update error:', err);
          markUnsynced(item.id);
          failed++;
          if (firstError === null) {
            firstError = err;
            firstErrorId = item.id;
          }
        }
      }

      if (failed > 0) {
        reportRatingFlagError(firstError, firstErrorId);
        if (failed > 1) {
          toast.error(`另有 ${failed - 1} 张未能落盘（格子上有红色角标，可点击重试）。`);
        }
      }
      return failed;
    },
    [markSynced, markUnsynced, onGroupPatched, reportRatingFlagError, toast],
  );

  /**
   * FR-04 撤销：弹出最近一条命令，把每张照片的 `before` 写回去。
   *
   * 注意「上次写盘失败」的情形：此时 UI = 新值、磁盘 = 旧值。撤销把 UI 恢复成
   * 快照（= 当时的旧值）并照常发起写入 —— 内容与磁盘现值相同，收敛一致，
   * 只是多一次无害写入。刻意**不**因上次失败而跳过。
   */
  const undo = useCallback(async () => {
    const command = takeUndoCommand();
    if (!command) {
      toast.info('没有可撤销的操作。');
      return;
    }
    const failed = await applyCommand(command, 'undo');
    if (failed === 0) toast.success(`已撤销「${command.summary}」。`);
  }, [takeUndoCommand, applyCommand, toast]);

  /** FR-04 重做：把命令的 `after` 再写一遍。 */
  const redo = useCallback(async () => {
    const command = takeRedoCommand();
    if (!command) {
      toast.info('没有可重做的操作。');
      return;
    }
    const failed = await applyCommand(command, 'redo');
    if (failed === 0) toast.success(`已重做「${command.summary}」。`);
  }, [takeRedoCommand, applyCommand, toast]);

  return {
    unsyncedIds,
    pendingBatch,
    setPendingBatch,
    canUndo,
    canRedo,
    undoSummary,
    redoSummary,
    markSynced,
    markUnsynced,
    reportRatingFlagError,
    rate,
    setFlag,
    setLabel,
    applyRating,
    applyFlag,
    applyLabel,
    retrySync,
    clearRatingFlag,
    undo,
    redo,
    pushCommand,
    clearCullUndo,
  };
}
