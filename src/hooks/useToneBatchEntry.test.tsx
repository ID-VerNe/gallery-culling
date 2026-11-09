/**
 * issue #115 · PD 批量入口成组 hook。
 *
 * 只收状态与互斥读数：applyWriteLumen 默认 false，applyBlockedReason 与
 * useTaskMutex 的 apply-tone 占用同源。
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TaskMutexProvider, useTaskMutex } from './useTaskMutex';
import { useToneBatchEntry } from './useToneBatchEntry';

const wrapper = ({ children }: { children: ReactNode }) => (
  <TaskMutexProvider>{children}</TaskMutexProvider>
);

describe('useToneBatchEntry —— 批量入口状态', () => {
  it('applyWriteLumen 默认为 false，可切换', () => {
    const { result } = renderHook(() => useToneBatchEntry(), { wrapper });
    expect(result.current.applyWriteLumen).toBe(false);
    act(() => result.current.setApplyWriteLumen(true));
    expect(result.current.applyWriteLumen).toBe(true);
  });

  it('空闲时 applyBlockedReason 为 null；有占用时给出原因', () => {
    let mutexApi!: ReturnType<typeof useTaskMutex>;
    const { result } = renderHook(
      () => {
        mutexApi = useTaskMutex();
        return useToneBatchEntry();
      },
      { wrapper },
    );
    expect(result.current.applyBlockedReason).toBeNull();
    let release!: () => void;
    act(() => {
      release = mutexApi.begin('export');
    });
    expect(result.current.applyBlockedReason).toContain('正在导出照片');
    act(() => release());
    expect(result.current.applyBlockedReason).toBeNull();
  });
});
