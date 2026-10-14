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
 * 撤销栈深度上限。原先只保留**一步**且对不同照片互相覆盖：给 A 打星 → 切到 B
 * 打星，`Ctrl+Z` 只回退 B，A 的误改再也回不去（B5）。改为最多 5 步的小栈。
 */
const MAX_UNDO_STEPS = 5;

/**
 * 星级/旗标的**单步撤销**（L-11）。
 *
 * 背景：`1..5` / `p` / `x` / `0` 都是"按下即写 `.xmp`"，且没有任何撤销入口 ——
 * 一次误触（尤其在焦点落到下拉/按钮上时）就会改掉磁盘上的评级，用户只能手改
 * `.xmp` 或回 Lightroom 改回来。这里提供一步回退。
 *
 * 关键语义（不是"最近一次写入"，而是"这轮操作的起点"）：
 * `remember` 对**同一张照片**的连续改动**不覆盖**栈顶快照。否则连按 `1..5`
 * 会把快照刷成"上一步的值"，撤销只回退一格，与用户预期的"撤销这轮改动"
 * 不符。换到另一张照片时在栈顶新增一层（最多 5 步，先进先出淘汰最旧的）。
 *
 * 明确不做（与方案一致）：不新增后端命令、不改既有写盘错误语义。
 */
export function useRatingUndo(): UseRatingUndoResult {
  const stackRef = useRef<RatingSnapshot[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  const remember = useCallback((snapshot: RatingSnapshot) => {
    const stack = stackRef.current;
    const top = stack[stack.length - 1];
    // 同一张照片：保留这轮最早的旧值，撤销才能回到"改之前"。
    if (top && top.id === snapshot.id) {
      setCanUndo(true);
      return;
    }
    stack.push(snapshot);
    // 超过上限时淘汰最旧的一步，避免长会话里无限增长。
    if (stack.length > MAX_UNDO_STEPS) stack.shift();
    setCanUndo(true);
  }, []);

  const take = useCallback((): RatingSnapshot | null => {
    const stack = stackRef.current;
    const snapshot = stack.length > 0 ? stack.pop()! : null;
    setCanUndo(stack.length > 0);
    return snapshot;
  }, []);

  const clear = useCallback(() => {
    stackRef.current = [];
    setCanUndo(false);
  }, []);

  return { canUndo, remember, take, clear };
}
