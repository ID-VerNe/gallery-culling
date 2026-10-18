/**
 * FR-02 色标写入：重复按同一个色标 = 取消，且**改星级/旗标不能清掉色标**。
 *
 * 后一条是本轮最容易被写坏的地方：命令契约是"整组状态"，评级写入如果漏传
 * `label`，后端会按"无色标"处理，用户打一颗星就把 Lightroom 里的红标删了。
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

function setup(g: PhotoGroupInfo) {
  mockInvokeCommand('update_rating_flag_cmd', true);
  const onGroupPatched = vi.fn();
  const { result } = renderHook(() =>
    useRatingFlagSync({
      currentGroup: g,
      onGroupPatched,
      selectedCount: 1,
    }),
  );
  return { result, onGroupPatched };
}

const lastArgs = () => {
  const calls = invokeCalls('update_rating_flag_cmd');
  return calls[calls.length - 1]?.args as Record<string, unknown>;
};

describe('色标写入', () => {
  it('设新色标：乐观更新 + 落盘', async () => {
    const { result, onGroupPatched } = setup(group());
    await act(async () => {
      await result.current.setLabel('Red');
    });

    expect(onGroupPatched).toHaveBeenCalledWith('A0001', { label: 'Red' });
    expect(lastArgs()).toMatchObject({ rating: 3, flag: 'none', label: 'Red' });
  });

  it('重复按同一个色标 = 取消（写空串）', async () => {
    const { result, onGroupPatched } = setup(group({ label: 'Red' }));
    await act(async () => {
      await result.current.setLabel('Red');
    });

    expect(onGroupPatched).toHaveBeenCalledWith('A0001', { label: '' });
    expect(lastArgs()).toMatchObject({ label: '' });
  });

  it('按另一个色标 = 替换', async () => {
    const { result } = setup(group({ label: 'Red' }));
    await act(async () => {
      await result.current.setLabel('Blue');
    });
    expect(lastArgs()).toMatchObject({ label: 'Blue' });
  });

  it('改星级必须透传当前色标（否则打星会删掉红标）', async () => {
    const { result } = setup(group({ label: 'Red' }));
    await act(async () => {
      await result.current.rate(5);
    });
    expect(lastArgs()).toMatchObject({ rating: 5, label: 'Red' });
  });

  it('改旗标同样透传色标', async () => {
    const { result } = setup(group({ label: 'Purple' }));
    await act(async () => {
      await result.current.setFlag('pick');
    });
    expect(lastArgs()).toMatchObject({ flag: 'pick', label: 'Purple' });
  });

  it('0/U 清除星级与旗标时保留色标', async () => {
    const { result } = setup(group({ rating: 4, flag: 'pick', label: 'Blue' }));
    await act(async () => {
      await result.current.clearRatingFlag();
    });
    expect(lastArgs()).toMatchObject({ rating: 0, flag: 'none', label: 'Blue' });
  });

  it('多选时进入批量确认而不是逐张写盘', () => {
    mockInvokeCommand('update_rating_flag_cmd', true);
    const { result } = renderHook(() =>
      useRatingFlagSync({
        currentGroup: group(),
        onGroupPatched: vi.fn(),
        selectedCount: 3,
      }),
    );

    act(() => {
      result.current.applyLabel('Green');
    });

    expect(result.current.pendingBatch).toEqual({ kind: 'label', value: 'Green' });
    expect(invokeCalls('update_rating_flag_cmd')).toHaveLength(0);
  });
});
