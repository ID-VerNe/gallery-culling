import type { PhotoGroupInfo } from '../types';

export interface CompareGroups {
  leftCompareGroup: PhotoGroupInfo | undefined;
  rightCompareGroup: PhotoGroupInfo | undefined;
  isLeftPinned: boolean;
  isRightPinned: boolean;
}

/**
 * Split-view 两侧照片的单一推导入口（WP6 状态真值）。
 *
 * 从 `App.tsx` 里抽出来是为了能被穷举测试：这里住着全项目最密集的索引联动，
 * 而 `filterMode × gridSearch × pinnedId` 的组合无法靠渲染整体 App 穷举。
 * 抽成纯函数后，四种组合（有/无基准 × 左/右基准）可以在毫秒级逐个断言。
 *
 * 两条历史缺陷在此闭环：
 * - **N-01** 同图守卫原先只写在 `!pinnedId` 分支之前，钉了基准之后
 *   `isPinnedOnLeft` 的两个分支不再做同图判断，于是「钉左再走到基准下标」或
 *   「钉右再让 selectedIndex 走到基准下标」都会左右同图。现在守卫只在所有
 *   分支算完后统一执行一次，三条路径都被覆盖，且**撞图时让流动的一侧让位、
 *   基准一侧固定不动**。
 * - **N-03** 基准图被筛选/搜索排除出工作集时，原先回退到当前选中却仍返回
 *   `isLeftPinned/isRightPinned: true`，视口会给一张并非基准的照片挂上「基准」
 *   徽章。现在「不在工作集内的基准 = 未钉」，但 `pinnedId` 由调用方保留，
 *   放宽筛选后基准自动回来。
 */
export function deriveCompareGroups(
  filteredGroups: PhotoGroupInfo[],
  selectedIndex: number,
  compareIndex: number,
  pinnedId: string | null,
  isPinnedOnLeft: boolean,
): CompareGroups {
  const leftBase = filteredGroups[selectedIndex];

  const pinnedGroup = pinnedId
    ? filteredGroups.find((g) => g.id === pinnedId)
    : undefined;
  const hasBenchmark = !!pinnedGroup;

  let left: PhotoGroupInfo | undefined;
  let right: PhotoGroupInfo | undefined;
  let leftPinned = false;
  let rightPinned = false;

  if (hasBenchmark && isPinnedOnLeft) {
    left = pinnedGroup;
    right = filteredGroups[compareIndex];
    leftPinned = true;
  } else if (hasBenchmark) {
    left = filteredGroups[selectedIndex];
    right = pinnedGroup;
    rightPinned = true;
  } else {
    left = leftBase;
    right = filteredGroups[compareIndex];
  }

  // N-01：同图守卫收口到唯一一处，覆盖无基准 / 左基准 / 右基准三条路径。
  //
  // 关键点：**基准那一侧不动**。基准是用户显式钉住的锚点，撞图时必须让
  // 「流动的那一侧」让位；只有两侧都不是基准时，才沿用旧行为（右侧候选跟随）。
  // 早先的写法无条件改右值，会把钉在右侧的基准顶掉，反而破坏基准语义。
  if (!right || (left && right.id === left.id)) {
    if (filteredGroups.length > 1) {
      const pickAlternative = (excludeId: string | undefined) => {
        const primary =
          filteredGroups[selectedIndex + 1] ?? filteredGroups[selectedIndex - 1];
        if (primary && primary.id !== excludeId) return primary;
        return filteredGroups.find((x) => x.id !== excludeId);
      };
      if (rightPinned) left = pickAlternative(right.id);
      else right = pickAlternative(left?.id);
    }
  }

  return {
    leftCompareGroup: left,
    rightCompareGroup: right,
    isLeftPinned: leftPinned,
    isRightPinned: rightPinned,
  };
}
