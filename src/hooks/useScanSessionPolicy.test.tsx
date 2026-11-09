/**
 * `useScanSessionPolicy` 接线单测（issue #112）。
 *
 * 纯决策在 `scanSessionPolicy.test.ts` 逐分支锁定；这里只锁 hook 的
 * 副作用接线：灌集合/放行门控/调色灌基线/恢复或钳制/钉选清空/选片集
 * 身份撤掉，顺序与原 AppShell.handleScanned 一致。
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useScanSessionPolicy } from './useScanSessionPolicy';
import type { PhotoGroupInfo } from '../types';
import type { StartupHistory } from '../utils/scanSessionPolicy';

const g = (id: string): PhotoGroupInfo => ({
  id,
  baseName: id.toUpperCase(),
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
});

const five = ['a', 'b', 'c', 'd', 'e'].map(g);

function setup(
  overrides: {
    selectedIndexAtStart?: number | null;
    currentSelectedIndex?: number;
    historyIndex?: number | null;
    startupHistory?: StartupHistory | null;
  } = {},
) {
  const setGroups = vi.fn();
  const setScannedFolder = vi.fn();
  const toneSeed = vi.fn();
  const setSelectedIndex = vi.fn();
  const setCompareIndex = vi.fn();
  const setPinnedId = vi.fn();
  const albumClear = vi.fn();
  const selectedIndexRef = { current: overrides.currentSelectedIndex ?? 0 };
  const startupHistoryRef = {
    current: overrides.startupHistory ?? (null as StartupHistory | null),
  };
  const { result } = renderHook(() =>
    useScanSessionPolicy({
      setGroups,
      setScannedFolder,
      toneSeed,
      setSelectedIndex,
      setCompareIndex,
      setPinnedId,
      albumClearRef: { current: albumClear },
      selectedIndexRef: selectedIndexRef as { current: number },
      startupHistoryRef: startupHistoryRef as { current: StartupHistory | null },
    }),
  );
  const invoke = () =>
    act(() => {
      result.current(
        five,
        {},
        overrides.historyIndex ?? null,
        overrides.selectedIndexAtStart ?? null,
        'D:/shoot/JPG',
      );
    });
  return {
    setGroups,
    setScannedFolder,
    toneSeed,
    setSelectedIndex,
    setCompareIndex,
    setPinnedId,
    albumClear,
    invoke,
  };
}

describe('useScanSessionPolicy', () => {
  it('无历史 → 默认第 0/1 张，且集合/门控/调色基线/钉选/选片集身份逐项接线', () => {
    const s = setup({ selectedIndexAtStart: 0, currentSelectedIndex: 0 });
    s.invoke();
    expect(s.setGroups).toHaveBeenCalledWith(five);
    expect(s.setScannedFolder).toHaveBeenCalledWith('D:/shoot/JPG');
    expect(s.toneSeed).toHaveBeenCalledWith({});
    expect(s.setSelectedIndex).toHaveBeenCalledWith(0);
    expect(s.setCompareIndex).toHaveBeenCalledWith(1);
    expect(s.setPinnedId).toHaveBeenCalledWith(null);
    expect(s.albumClear).toHaveBeenCalledTimes(1);
  });

  it('会话断点有效 → 恢复断点（compareIndex = 断点 + 1）', () => {
    const s = setup({ historyIndex: 2, selectedIndexAtStart: 0, currentSelectedIndex: 0 });
    s.invoke();
    expect(s.setSelectedIndex).toHaveBeenCalledWith(2);
    expect(s.setCompareIndex).toHaveBeenCalledWith(3);
  });

  it('用户在扫描窗口内动过 → 钳制旧索引（不恢复会话）', () => {
    const s = setup({ historyIndex: 2, selectedIndexAtStart: 1, currentSelectedIndex: 4 });
    s.invoke();
    // clamp 分支走函数式更新：入参是 updater 函数，下游 clamp(prev) 必须保持在范围。
    const upd = s.setSelectedIndex.mock.calls[0][0] as (prev: number) => number;
    expect(typeof upd).toBe('function');
    expect(upd(4)).toBe(4);
    expect(upd(99)).toBe(4);
  });
});
