/**
 * issue #115 · PB 变异靶点（预设成组 hook）。
 *
 * 钉三件事，任一被改坏必须红（cp 回写还原做变异）：
 * 1. seq 仲裁：连续套用迟到的旧结果不许覆盖新选择；
 * 2. 同帧清零：换照片同一帧就把 appliedPreset 清掉，不闪旧名；
 * 3. 显示晚于事实：只有 onApplyPreset resolve true 才写入名字。
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAppliedPreset } from './useAppliedPreset';

describe('useAppliedPreset —— seq 仲裁 + 同帧清零', () => {
  it('成功后才写入已套用名：resolve true 才有名字', async () => {
    const onApplyPreset = vi.fn(async (): Promise<boolean> => true);
    const { result } = renderHook(() =>
      useAppliedPreset({ photoId: 'IMG_010', onApplyPreset }),
    );
    expect(result.current.appliedPreset).toBeNull();
    act(() => result.current.requestPreset('Neutral'));
    expect(result.current.pendingPreset).toBe('Neutral');
    await act(async () => {
      await result.current.confirmPreset();
    });
    expect(result.current.appliedPreset).toBe('Neutral');
  });

  it('连续套用以最后一次确认为准：迟到的旧结果不覆盖新选择', async () => {
    const resolvers: Array<(ok: boolean) => void> = [];
    const onApplyPreset = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { result } = renderHook(() =>
      useAppliedPreset({ photoId: 'IMG_010', onApplyPreset }),
    );

    act(() => result.current.requestPreset('Neutral'));
    let first!: Promise<void>;
    act(() => {
      first = result.current.confirmPreset();
    });
    act(() => result.current.requestPreset('Portra Warm'));
    let second!: Promise<void>;
    act(() => {
      second = result.current.confirmPreset();
    });

    // 第 2 次先成功 → 显示 'Portra Warm'
    await act(async () => {
      resolvers[1](true);
      await second;
    });
    expect(result.current.appliedPreset).toBe('Portra Warm');

    // 第 1 次现在才成功 —— 迟到的结果不许把显示翻回 'Neutral'
    await act(async () => {
      resolvers[0](true);
      await first;
    });
    expect(result.current.appliedPreset).toBe('Portra Warm');
  });

  it('失败不写标记：保留上一次成功的名字', async () => {
    const onApplyPreset = vi
      .fn(async (): Promise<boolean> => true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { result } = renderHook(() =>
      useAppliedPreset({ photoId: 'IMG_010', onApplyPreset }),
    );

    act(() => result.current.requestPreset('Neutral'));
    await act(async () => {
      await result.current.confirmPreset();
    });
    expect(result.current.appliedPreset).toBe('Neutral');

    act(() => result.current.requestPreset('Portra Warm'));
    await act(async () => {
      await result.current.confirmPreset();
    });
    expect(result.current.appliedPreset).toBe('Neutral');
  });

  it('换照片同帧清零：appliedPreset 立即回到 null', async () => {
    const onApplyPreset = vi.fn(async (): Promise<boolean> => true);
    const { result, rerender } = renderHook(
      ({ photoId }) => useAppliedPreset({ photoId, onApplyPreset }),
      { initialProps: { photoId: 'IMG_010' as string | undefined } },
    );
    act(() => result.current.requestPreset('Neutral'));
    await act(async () => {
      await result.current.confirmPreset();
    });
    expect(result.current.appliedPreset).toBe('Neutral');

    rerender({ photoId: 'IMG_011' });
    // 同帧清零：rerender 返回后状态已清，不经过一次旧名闪烁
    expect(result.current.appliedPreset).toBeNull();
  });
});
