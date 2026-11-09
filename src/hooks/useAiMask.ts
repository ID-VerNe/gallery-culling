/**
 * issue #115 · PC：AI 蒙版成组 hook。
 *
 * `isMasking` 与 `useActivity('ai')` 必须同处：AI 蒙版占用 LUMEN 编辑态，
 * 运行期间不能让渲染导出或套用调色插进来（FR-09）。把 isMasking 抽走
 * 却留下 useActivity 在面板里是已否决的拆法 —— 这里一起收进来。
 *
 * `aiBlockedReason` 也在同一 hook 内经 `useTaskMutex` 读取，
 * 与 TonalAdjuster 原 `:219-222` 三行一一对应。
 */
import { useState } from 'react';
import { useActivity, useTaskMutex } from './useTaskMutex';

export interface UseAiMaskOptions {
  onApplyMask?: (region: string, dehaze: number) => Promise<void>;
}

export interface UseAiMaskResult {
  maskRegion: string;
  setMaskRegion: (region: string) => void;
  maskDehaze: number;
  setMaskDehaze: (dehaze: number) => void;
  isMasking: boolean;
  maskError: string | null;
  pendingMask: boolean;
  setPendingMask: (pending: boolean) => void;
  /** 被其它长任务挡住时的常驻说明（AI 蒙版要占 LUMEN 编辑态）。 */
  aiBlockedReason: string | null;
  handleApplyMaskClick: () => Promise<void>;
}

export function useAiMask({ onApplyMask }: UseAiMaskOptions): UseAiMaskResult {
  const [maskRegion, setMaskRegion] = useState('sky');
  const [maskDehaze, setMaskDehaze] = useState(60);
  const [isMasking, setIsMasking] = useState(false);
  const [maskError, setMaskError] = useState<string | null>(null);
  const [pendingMask, setPendingMask] = useState(false);

  /**
   * FR-09：AI 蒙版接进全局互斥表。占用 LUMEN 编辑态，运行期间不能让
   * 渲染导出或套用调色插进来。
   */
  const mutex = useTaskMutex();
  useActivity('ai', isMasking);
  const aiBlockedReason = mutex.blockReason('ai');

  const handleApplyMaskClick = async () => {
    if (!onApplyMask) return;
    setIsMasking(true);
    setMaskError(null);
    try {
      await onApplyMask(maskRegion, maskDehaze);
      // 任务成功才关对话框（closeOnConfirm={false} 已阻止乐观关闭）。
      setPendingMask(false);
    } catch (err) {
      console.error('AI 蒙版失败:', err);
      setMaskError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsMasking(false);
    }
  };

  return {
    maskRegion,
    setMaskRegion,
    maskDehaze,
    setMaskDehaze,
    isMasking,
    maskError,
    pendingMask,
    setPendingMask,
    aiBlockedReason,
    handleApplyMaskClick,
  };
}
