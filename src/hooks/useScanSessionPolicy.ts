/**
 * 扫描会话策略 hook（issue #112）。
 *
 * 组装 `handleScanned` 的副作用接线，决策本体在
 * `utils/scanSessionPolicy.ts` 的纯函数里（可独立单测）。
 *
 * `toneSeed` 与 `setPinnedId` 在 AppShell 中声明在扫描完成回调之后，
 * 用 ref 前转（与 `albumClearRef` / `selectedIndexRef` 同一模式），
 * 回调本身保持稳定 identity，不让 useFolderScan 的 handleScan 抖动。
 */
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PhotoGroupInfo, ToneAdjustments } from '../types';
import {
  decideScanIndexRestore,
  type StartupHistory,
} from '../utils/scanSessionPolicy';

export interface UseScanSessionPolicyDeps {
  setGroups: (groups: PhotoGroupInfo[]) => void;
  setScannedFolder: (folder: string) => void;
  toneSeed: (tones: Record<string, ToneAdjustments>) => void;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setCompareIndex: Dispatch<SetStateAction<number>>;
  setPinnedId: (id: string | null) => void;
  albumClearRef: { current: () => void };
  selectedIndexRef: { current: number };
  startupHistoryRef: { current: StartupHistory | null };
}

export function useScanSessionPolicy(deps: UseScanSessionPolicyDeps) {
  const {
    setGroups,
    setScannedFolder,
    toneSeed,
    setSelectedIndex,
    setCompareIndex,
    setPinnedId,
    albumClearRef,
    selectedIndexRef,
    startupHistoryRef,
  } = deps;

  return useCallback(
    (
      scanned: PhotoGroupInfo[],
      initialTones: Record<string, ToneAdjustments>,
      historyIndex: number | null,
      selectedIndexAtStart: number | null,
      scannedJpgFolder: string,
    ) => {
      setGroups(scanned);
      // PA 门控放行：当前目录已完成一次成功扫描。
      setScannedFolder(scannedJpgFolder);
      toneSeed(initialTones);
      const decision = decideScanIndexRestore({
        scannedCount: scanned.length,
        historyIndex,
        selectedIndexAtStart,
        currentSelectedIndex: selectedIndexRef.current,
        startupHistory: startupHistoryRef.current,
        scannedJpgFolder,
      });
      if (decision.kind === 'clamp') {
        // 尊重用户选择：只把旧索引钳制到新集合范围内，不做会话恢复。
        const clamp = (prev: number) =>
          Math.max(0, Math.min(prev, scanned.length - 1));
        setSelectedIndex(clamp);
        setCompareIndex(clamp);
      } else {
        setSelectedIndex(decision.selectedIndex);
        setCompareIndex(decision.compareIndex);
      }
      // Drop anything pinned to a photo that no longer exists.
      setPinnedId(null);
      // 集合换了来源：选片集身份失效（不这么做顶栏会一直声称来自某本选片集）。
      albumClearRef.current();
    },
    [
      setGroups,
      setScannedFolder,
      toneSeed,
      setSelectedIndex,
      setCompareIndex,
      setPinnedId,
      albumClearRef,
      selectedIndexRef,
      startupHistoryRef,
    ],
  );
}
