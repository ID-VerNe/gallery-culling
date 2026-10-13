import { useCallback, useMemo, useState } from 'react';
import { deriveCompareGroups } from '../utils/compareGroups';
import type { PhotoGroupInfo } from '../types';

/**
 * 对比基准（pin）：谁被钉为基准、基准在左还是在右、交换、切换基准。
 *
 * 推导逻辑本身早就在 `utils/compareGroups` 里（已对 filterMode × gridSearch ×
 * pinnedId 的组合做过穷举回归），本 hook 只持有**状态**并把动作收敛成四个
 * 语义的函数。
 *
 * 无基准时 `leftCompareGroup` 恒等于 selectedIndex 那张、`rightCompareGroup`
 * 恒等于 compareIndex 那张 —— 这正是空格「设为基准」不能复用
 * `togglePinRight` 的原因：无基准时 right 是另一张照片，单图视口下会把用户
 * 没选的那张钉成基准，界面上完全看不出发生了什么。
 */
export function useComparePin(opts: {
  filteredGroups: PhotoGroupInfo[];
  selectedIndex: number;
  compareIndex: number;
  currentGroup: PhotoGroupInfo | undefined;
  onSwapIndices: () => void;
}) {
  const { filteredGroups, selectedIndex, compareIndex, currentGroup, onSwapIndices } =
    opts;

  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [isPinnedOnLeft, setIsPinnedOnLeft] = useState<boolean>(true);

  // 推导逻辑抽到 `utils/compareGroups`，以便对 filterMode × gridSearch × pinnedId
  // 的四种组合做穷举回归（见该模块的 N-01/N-03 说明）。
  const { leftCompareGroup, rightCompareGroup, isLeftPinned, isRightPinned } =
    useMemo(
      () =>
        deriveCompareGroups(
          filteredGroups,
          selectedIndex,
          compareIndex,
          pinnedId,
          isPinnedOnLeft,
        ),
      [filteredGroups, selectedIndex, compareIndex, pinnedId, isPinnedOnLeft],
    );

  // Pin / Unpin Left as Reference
  const togglePinLeft = useCallback(() => {
    if (isLeftPinned) {
      setPinnedId(null);
    } else if (leftCompareGroup) {
      setPinnedId(leftCompareGroup.id);
      setIsPinnedOnLeft(true);
    }
  }, [isLeftPinned, leftCompareGroup]);

  // Pin / Unpin Right as Reference
  const togglePinRight = useCallback(() => {
    if (isRightPinned) {
      setPinnedId(null);
    } else if (rightCompareGroup) {
      setPinnedId(rightCompareGroup.id);
      setIsPinnedOnLeft(false);
    }
  }, [isRightPinned, rightCompareGroup]);

  // 空格「设为基准」：落在**当前照片**上，且是切换语义。
  //
  // 不用 togglePinRight —— 见文件头说明。钉在右侧窗格（比较视图里看得到
  // "基准 vs 候选"），与左/中/右位置无关。
  const togglePinCurrent = useCallback(() => {
    if (!currentGroup) return;
    setPinnedId((prev) => (prev === currentGroup.id ? null : currentGroup.id));
  }, [currentGroup]);

  // Swap A / B (Candidate becomes new pinned benchmark or swap positions)
  const swap = useCallback(() => {
    if (pinnedId) {
      if (isPinnedOnLeft && rightCompareGroup) {
        setPinnedId(rightCompareGroup.id);
      } else if (!isPinnedOnLeft && leftCompareGroup) {
        setPinnedId(leftCompareGroup.id);
      }
    } else {
      onSwapIndices();
    }
  }, [
    pinnedId,
    isPinnedOnLeft,
    rightCompareGroup,
    leftCompareGroup,
    onSwapIndices,
  ]);

  // Benchmark toggle shortcut (B)
  const togglePinBenchmark = useCallback(() => {
    if (pinnedId) {
      setPinnedId(null);
    } else if (leftCompareGroup) {
      setPinnedId(leftCompareGroup.id);
      setIsPinnedOnLeft(true);
    }
  }, [pinnedId, leftCompareGroup]);

  return {
    pinnedId,
    isPinnedOnLeft,
    isLeftPinned,
    isRightPinned,
    leftCompareGroup,
    rightCompareGroup,
    togglePinLeft,
    togglePinRight,
    togglePinCurrent,
    togglePinBenchmark,
    swap,
    setPinnedId,
  };
}