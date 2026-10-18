import { useCallback, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { useRatingUndo } from './useRatingUndo';
import { groupPath } from '../utils/groupPath';
import type { BatchAction } from './useBatchOps';
import type { CullFlag, PhotoGroupInfo } from '../types';

/** L-11 撤销提示里的旗标文案（与宫格/底栏的叫法保持一致）。 */
const FLAG_LABELS: Record<CullFlag, string> = {
  pick: '保留',
  reject: '淘汰',
  none: '未标记',
};

/**
 * 评级与旗标的写盘：乐观更新 + 后台写 XMP + 失败留角标 + 单步撤销。
 *
 * 三条约定，任何一条都不能破：
 * - **乐观更新**：界面先变，磁盘后追。写盘失败不回滚 UI —— 星��在屏幕上
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

  // L-11：星级/旗标的单步撤销。`1..5/p/x/0` 按下即写 .xmp 且原先无路可退，
  // 一次误触只能手改侧边栏或回 Lightroom。这里保留一步回退（Ctrl/Cmd+Z，
  // 或底栏的「撤销」按钮）。
  const {
    canUndo,
    remember: rememberRating,
    take: takeRatingSnapshot,
    clear: clearRatingUndo,
  } = useRatingUndo();

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

  // Update Rating & Flag (syncs to XMP)
  const rate = useCallback(
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
      // 否则原样透传 flag=reject，后端按 reject 写 Rating=-1 ——
      // 界面显示「4 星」、磁盘仍是 -1，用户打多少星都摆脱不掉淘汰标记。
      // pick 语义与评分正交（打了星仍是 pick），故只有 reject 被清掉。
      const nextFlag: CullFlag =
        targetGroup.flag === 'reject' && rating > 0 ? 'none' : targetGroup.flag;

      onGroupPatched(targetGroup.id, { rating, flag: nextFlag });

      // Sync to XMP in background
      try {
        await api.updateRatingFlag(targetPath, rating, nextFlag, true);
        markSynced(targetGroup.id);
      } catch (err) {
        reportRatingFlagError(err, targetGroup.id);
      }
    },
    [currentGroup, reportRatingFlagError, rememberRating, markSynced, onGroupPatched],
  );

  const setFlag = useCallback(
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

      onGroupPatched(targetGroup.id, { flag });

      try {
        await api.updateRatingFlag(targetPath, targetGroup.rating, flag, true);
        markSynced(targetGroup.id);
      } catch (err) {
        reportRatingFlagError(err, targetGroup.id);
      }
    },
    [currentGroup, reportRatingFlagError, rememberRating, markSynced, onGroupPatched],
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

  /** B6：点击格子上"未同步"角标时，用该张当前值重写 XMP。 */
  const retrySync = useCallback(
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
  const clearRatingFlag = useCallback(async () => {
    if (selectedCount > 1) {
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
    onGroupPatched(targetGroup.id, { rating: 0, flag: 'none' });
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
    onGroupPatched,
    selectedCount,
  ]);

  /**
   * L-11 撤销：回填本地状态 + 用**同一套错误语义**重写 XMP。
   *
   * 注意「上次写盘失败」的情形：此时 UI = 新值、磁盘 = 旧值。撤销把 UI 恢复成
   * 快照（= 当时的旧值）并照常发起写入 —— 内容与磁盘现值相同，收敛一致，
   * 只是多一次无害写入。刻意**不**因上次失败而跳过，也刻意不引入第二种错误
   * 文案（仍走 `reportRatingFlagError`，保持"界面有效、未同步 XMP"的既有承诺）。
   */
  const undo = useCallback(async () => {
    const snapshot = takeRatingSnapshot();
    if (!snapshot) {
      toast.info('没有可撤销的操作。');
      return;
    }

    onGroupPatched(snapshot.id, {
      rating: snapshot.rating,
      flag: snapshot.flag,
    });

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
  }, [takeRatingSnapshot, toast, reportRatingFlagError, onGroupPatched]);

  return {
    unsyncedIds,
    pendingBatch,
    setPendingBatch,
    canUndo,
    markSynced,
    markUnsynced,
    reportRatingFlagError,
    rate,
    setFlag,
    applyRating,
    applyFlag,
    retrySync,
    clearRatingFlag,
    undo,
    rememberRating,
    clearRatingUndo,
  };
}