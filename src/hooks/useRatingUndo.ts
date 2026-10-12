import { useCallback, useRef, useState } from 'react';
import type { CullFlag } from '../types';

export interface RatingSnapshot {
  id: string;
  /** 写盘用的文件路径（RAW 优先，与 `handleRate` 一致）。 */
  path: string;
  rating: number;
  flag: CullFlag;
}

export interface UseRatingUndoResult {
  /** 是否有可撤销的操作（驱动按钮可用态）。 */
  canUndo: boolean;
  /** 在**乐观更新之前**记录旧值。 */
  remember: (snapshot: RatingSnapshot) => void;
  /** 取出并清空快照（一次撤销只生效一次）。 */
  take: () => RatingSnapshot | null;
  /** 丢弃快照（换目录 / 重新扫描时用）。 */
  clear: () => void;
}

/**
 * 星级/旗标的**单步撤销**（L-11）。
 *
 * 背景：`1..5` / `p` / `x` / `0` 都是"按下即写 `.xmp`"，且没有任何撤销入口 ——
 * 一次误触（尤其在焦点落到下拉/按钮上时）就会改掉磁盘上的评级，用户只能手改
 * `.xmp` 或回 Lightroom 改回来。这里提供一步回退。
 *
 * 关键语义（不是"最近一次写入"，而是"这轮操作的起点"）：
 * `remember` 对**同一张照片**的连续改动**不覆盖**已有快照。否则连按 `1..5`
 * 会把快照刷成"上一步的值"，撤销只回退一格，与用户预期的"撤销这轮改动"
 * 不符。换到另一张照片时快照被替换（单步 = 只撤销最近操作的那一张）。
 *
 * 明确不做（与方案一致）：不做多步栈、不新增后端命令、不改既有写盘错误语义。
 */
export function useRatingUndo(): UseRatingUndoResult {
  const snapshotRef = useRef<RatingSnapshot | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  const remember = useCallback((snapshot: RatingSnapshot) => {
    const existing = snapshotRef.current;
    // 同一张照片：保留这轮最早的旧值，撤销才能回到"改之前"。
    if (existing && existing.id === snapshot.id) {
      // 但若期间已经被撤销过（快照已清空），existing 为 null，会正常写入。
      setCanUndo(true);
      return;
    }
    snapshotRef.current = snapshot;
    setCanUndo(true);
  }, []);

  const take = useCallback((): RatingSnapshot | null => {
    const snapshot = snapshotRef.current;
    snapshotRef.current = null;
    setCanUndo(false);
    return snapshot;
  }, []);

  const clear = useCallback(() => {
    snapshotRef.current = null;
    setCanUndo(false);
  }, []);

  return { canUndo, remember, take, clear };
}
