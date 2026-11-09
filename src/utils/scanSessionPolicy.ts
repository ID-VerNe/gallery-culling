/**
 * 扫描会话「恢复/钳制」策略（issue #112，源自 AppShell.handleScanned 内联逻辑）。
 *
 * 扫描是异步的：用户可能在扫描窗口内已经改过选中。此时会话恢复会**覆盖
 * 用户操作**（2026-10-15 e2e run5 实锤：点击 IMG_010 被翻回 IMG_011，随后
 * 的 apply 写错了文件）。规则：扫描开始时的选中快照与当前值不等 → 用户
 * 动过，只把旧索引钳制到新集合范围内，不做会话恢复。
 *
 * PB 兜底：扫描时读回的会话断点为空才用启动预读（同目录才用，归一化
 * 比较防写法分叉）；有扫描时值以扫描时为准。
 */
import { isSameDir } from './pathNormalize';

/** 启动预读的会话断点（folder 精确匹配、归一化比较）。 */
export interface StartupHistory {
  folder: string;
  index: number;
}

/**
 * 用户是否在扫描窗口内动过选中：只有「有快照且快照 ≠ 当前值」才算动过。
 */
export function userMovedDuringScan(
  selectedIndexAtStart: number | null,
  currentSelectedIndex: number,
): boolean {
  return selectedIndexAtStart !== null && selectedIndexAtStart !== currentSelectedIndex;
}

/**
 * 生效的会话断点：扫描时读回优先，读回为空才用启动预读（仅同目录）。
 */
export function effectiveHistoryIndex(
  historyIndex: number | null,
  startupHistory: StartupHistory | null,
  scannedJpgFolder: string,
): number | null {
  return (
    historyIndex ??
    (startupHistory && isSameDir(startupHistory.folder, scannedJpgFolder)
      ? startupHistory.index
      : null)
  );
}

/**
 * 扫描完成后的索引决策。
 * - `clamp`：用户动过，调用方把两个旧索引都钳制到新范围内（需要 prev 值）。
 * - `restore`：恢复到会话断点。
 * - `default`：回到第 0 张（对比位按张数取 1 或 0）。
 */
export type ScanIndexDecision =
  | { kind: 'clamp' }
  | { kind: 'restore'; selectedIndex: number; compareIndex: number }
  | { kind: 'default'; selectedIndex: number; compareIndex: number };

export interface DecideScanIndexRestoreInput {
  scannedCount: number;
  historyIndex: number | null;
  selectedIndexAtStart: number | null;
  currentSelectedIndex: number;
  startupHistory: StartupHistory | null;
  scannedJpgFolder: string;
}

export function decideScanIndexRestore(input: DecideScanIndexRestoreInput): ScanIndexDecision {
  if (
    userMovedDuringScan(input.selectedIndexAtStart, input.currentSelectedIndex)
  ) {
    return { kind: 'clamp' };
  }
  const effectiveHistory = effectiveHistoryIndex(
    input.historyIndex,
    input.startupHistory,
    input.scannedJpgFolder,
  );
  if (effectiveHistory !== null && effectiveHistory < input.scannedCount) {
    return {
      kind: 'restore',
      selectedIndex: effectiveHistory,
      compareIndex: Math.min(effectiveHistory + 1, input.scannedCount - 1),
    };
  }
  return {
    kind: 'default',
    selectedIndex: 0,
    compareIndex: input.scannedCount > 1 ? 1 : 0,
  };
}
