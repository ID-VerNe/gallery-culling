/**
 * `useSessionDebounce` —— M-17 前端侧防抖与会话 flush。
 *
 * 契约：
 *  - 500ms 窗口内的连续选中变化**合并为一次** `save_session_cmd`，且写的是**最新值**；
 *  - 卸载 / 目录切换 / 窗口关闭请求三处必须 flush 未落盘的那一次；
 *  - `jpgFolder` 为空或 `lastIndex < 0` 时不写。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionDebounce } from './useSessionDebounce';
import {
  emitCloseRequested,
  invokeCount,
  lastInvokeArgs,
  mockInvokeCommand,
} from '../test/setup';

interface Props {
  folder?: string;
  idx?: number;
}

const useIt = ({ folder = 'D:/shoot', idx = 0 }: Props, flushOnClose = false) =>
  useSessionDebounce(
    {
      jpgFolder: folder,
      rawFolder: 'D:/raw',
      lastIndex: idx,
      sortOrder: 'time_filename',
    },
    { delayMs: 500, flushOnClose },
  );

describe('useSessionDebounce —— M-17', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvokeCommand('save_session_cmd', true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('500ms 内的连续选中变化合并为一次写，且写最新值', () => {
    const { rerender } = renderHook(({ idx }: Props) => useIt({ idx }), {
      initialProps: { idx: 0 } as Props,
    });

    // 初次挂载会排一次防抖
    act(() => vi.advanceTimersByTime(500));
    expect(invokeCount('save_session_cmd')).toBe(1);

    // 模拟快速连翻 4 次（都在窗口内）
    rerender({ idx: 1 });
    rerender({ idx: 2 });
    rerender({ idx: 3 });
    rerender({ idx: 4 });
    expect(invokeCount('save_session_cmd')).toBe(1); // 还没到点，没有新写

    act(() => vi.advanceTimersByTime(500));
    expect(invokeCount('save_session_cmd')).toBe(2); // 只多写一次
    expect(lastInvokeArgs('save_session_cmd')).toMatchObject({ lastIndex: 4 });
  });

  it('卸载时 flush 未落盘的那一次（防抖会丢的最后一次）', () => {
    const { rerender, unmount } = renderHook(({ idx }: Props) => useIt({ idx }), {
      initialProps: { idx: 0 } as Props,
    });
    act(() => vi.advanceTimersByTime(500));
    expect(invokeCount('save_session_cmd')).toBe(1);

    // 变更后**不等**防抖窗口直接卸载
    rerender({ idx: 9 });
    expect(invokeCount('save_session_cmd')).toBe(1);
    unmount();

    expect(invokeCount('save_session_cmd')).toBe(2);
    expect(lastInvokeArgs('save_session_cmd')).toMatchObject({ lastIndex: 9 });
  });

  it('目录切换：先 flush 旧目录的最后进度，再为新目录起定时器', () => {
    const { rerender } = renderHook(
      ({ folder, idx }: Props) => useIt({ folder, idx }),
      { initialProps: { folder: 'A', idx: 1 } as Props },
    );

    // 旧目录还没到 500ms 就切到新目录
    act(() => vi.advanceTimersByTime(100));
    rerender({ folder: 'B', idx: 0 });

    // 旧目录的 {A, 1} 必须已落地（否则会被 clearTimeout 丢掉）
    expect(invokeCount('save_session_cmd')).toBe(1);
    expect(lastInvokeArgs('save_session_cmd')).toMatchObject({
      jpgFolder: 'A',
      lastIndex: 1,
    });

    // 新目录在窗口到点后再写一次
    act(() => vi.advanceTimersByTime(500));
    expect(invokeCount('save_session_cmd')).toBe(2);
    expect(lastInvokeArgs('save_session_cmd')).toMatchObject({
      jpgFolder: 'B',
      lastIndex: 0,
    });
  });

  it('窗口关闭请求触发 flush（flushOnClose 默认接管）', async () => {
    const { rerender } = renderHook(({ idx }: Props) => useIt({ idx }, true), {
      initialProps: { idx: 0 } as Props,
    });
    rerender({ idx: 7 });
    expect(invokeCount('save_session_cmd')).toBe(0);

    await act(async () => {
      emitCloseRequested();
      await Promise.resolve();
    });

    expect(invokeCount('save_session_cmd')).toBe(1);
    expect(lastInvokeArgs('save_session_cmd')).toMatchObject({ lastIndex: 7 });
  });

  it('jpgFolder 为空时不写 session', () => {
    renderHook(() => useIt({ folder: '', idx: 0 }));
    act(() => vi.advanceTimersByTime(2000));
    expect(invokeCount('save_session_cmd')).toBe(0);
  });
});
