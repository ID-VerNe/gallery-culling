/**
 * 星级 toggle 契约（issue #65）。
 *
 * 帮助弹窗已经承诺「再按一次同星取消」，但 `rate()` 过去是无条件写回同值；
 * 这里把「单张同值 = 清零」与「批量仍是设为」两条语义钉死，防止实现漂移。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRatingFlagSync } from './useRatingFlagSync';
import { invokeCalls, mockInvokeCommand } from '../test/setup';
import type { PhotoGroupInfo } from '../types';

function group(overrides: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id: 'A0001',
    baseName: 'A0001',
    raw: {
      name: 'A0001.ARW',
      extension: 'ARW',
      path: 'D:/shoot/A0001.ARW',
      size: 1,
      mtime: 1,
    },
    status: 'RAW_ONLY',
    rating: 3,
    flag: 'none',
    label: '',
    hasXmp: false,
    ...overrides,
  };
}

function setup(g: PhotoGroupInfo, selectedCount = 1) {
  mockInvokeCommand('update_rating_flag_cmd', true);
  const onGroupPatched = vi.fn();
  const { result } = renderHook(() =>
    useRatingFlagSync({
      currentGroup: g,
      onGroupPatched,
      selectedCount,
    }),
  );
  return { result, onGroupPatched };
}

const lastArgs = () => {
  const calls = invokeCalls('update_rating_flag_cmd');
  return calls[calls.length - 1]?.args as Record<string, unknown>;
};

describe('星级 toggle（issue #65）', () => {
  it('同键再按 = 清零，且不动旗标与色标', async () => {
    const { result, onGroupPatched } = setup(group({ rating: 3, flag: 'pick', label: 'Red' }));
    await act(async () => {
      await result.current.rate(3);
    });

    expect(onGroupPatched).toHaveBeenCalledWith('A0001', { rating: 0, flag: 'pick' });
    expect(lastArgs()).toMatchObject({ rating: 0, flag: 'pick', label: 'Red' });
  });

  it('不同键 = 改为新分值', async () => {
    const { result, onGroupPatched } = setup(group({ rating: 3 }));
    await act(async () => {
      await result.current.rate(5);
    });

    expect(onGroupPatched).toHaveBeenCalledWith('A0001', { rating: 5, flag: 'none' });
    expect(lastArgs()).toMatchObject({ rating: 5 });
  });

  it('toggle 与 R 的星级结果一致；R 额外清旗标，toggle 不清', async () => {
    const { result } = setup(group({ rating: 4, flag: 'pick' }));
    await act(async () => {
      await result.current.rate(4);
    });
    const afterToggle = lastArgs();

    await act(async () => {
      await result.current.clearRatingFlag();
    });
    const afterClear = lastArgs();

    expect(afterToggle).toMatchObject({ rating: 0, flag: 'pick' });
    expect(afterClear).toMatchObject({ rating: 0, flag: 'none' });
    expect(afterToggle.rating).toBe(afterClear.rating);
  });

  it('多选仍走批量「设为 N 星」，不得逐张 toggle', () => {
    const { result } = setup(group({ rating: 3 }), 3);

    act(() => {
      result.current.applyRating(3);
    });

    expect(result.current.pendingBatch).toEqual({ kind: 'rate', value: 3 });
    expect(invokeCalls('update_rating_flag_cmd')).toHaveLength(0);
  });

  it('打新星级仍解除淘汰（rating > 0 的既有契约不回归）', async () => {
    const { result, onGroupPatched } = setup(group({ rating: 0, flag: 'reject' }));
    await act(async () => {
      await result.current.rate(2);
    });

    expect(onGroupPatched).toHaveBeenCalledWith('A0001', { rating: 2, flag: 'none' });
    expect(lastArgs()).toMatchObject({ rating: 2, flag: 'none' });
  });
});
