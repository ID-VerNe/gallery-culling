/**
 * issue #115 · PD：批量套用入口成组 hook。
 *
 * 只收「批量区自己的状态 + 互斥读数」（原 TonalAdjuster:214,222,549-579）：
 * - `applyWriteLumen`：套用时是否同时写 LUMEN 工程（默认关 —— 200 张会非常慢）；
 * - `applyBlockedReason`：经 `useTaskMutex` 读 `apply-tone` 占用。
 *
 * 批量执行的循环本身在 `useToneBatch`（App 侧），这里只管面板入口的状态。
 */
import { useState } from 'react';
import { useTaskMutex } from './useTaskMutex';

export interface UseToneBatchEntryResult {
  applyWriteLumen: boolean;
  setApplyWriteLumen: (writeLumen: boolean) => void;
  applyBlockedReason: string | null;
}

export function useToneBatchEntry(): UseToneBatchEntryResult {
  /** FR-07：套用时是否同时写 LUMEN 工程（默认关 —— 200 张会非常慢）。 */
  const [applyWriteLumen, setApplyWriteLumen] = useState(false);

  const mutex = useTaskMutex();
  const applyBlockedReason = mutex.blockReason('apply-tone');

  return {
    applyWriteLumen,
    setApplyWriteLumen,
    applyBlockedReason,
  };
}
