/**
 * issue #115 · PC 蒙版成组 hook 变异靶点。
 *
 * 钉住「isMasking 与 useActivity('ai') 同处」：运行时互斥表必须能挡住
 * render/export（显式断言占用存在），不能只测 UI 文案。
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TaskMutexProvider, useTaskMutex } from './useTaskMutex';
import { useAiMask } from './useAiMask';

const wrapper = ({ children }: { children: ReactNode }) => (
  <TaskMutexProvider>{children}</TaskMutexProvider>
);

describe('useAiMask —— 蒙版工作流 + 互斥同处', () => {
  it('运行期间 isMasking 为真且互斥占用 ai（render 被挡）', async () => {
    let release!: () => void;
    const onApplyMask = vi.fn(
      () =>
        new Promise<void>((res) => {
          release = res;
        }),
    );
    let mutexApi!: ReturnType<typeof useTaskMutex>;
    const { result } = renderHook(
      () => {
        mutexApi = useTaskMutex();
        return useAiMask({ onApplyMask });
      },
      { wrapper },
    );
    expect(result.current.isMasking).toBe(false);
    expect(mutexApi.canStart('render')).toBe(true);

    let done!: Promise<void>;
    act(() => {
      done = result.current.handleApplyMaskClick();
    });
    // useActivity 走 effect，act 刷一下才生效
    expect(result.current.isMasking).toBe(true);
    expect(mutexApi.canStart('render')).toBe(false);
    expect(mutexApi.canStart('export')).toBe(false);

    await act(async () => {
      release();
      await done;
    });
    expect(result.current.isMasking).toBe(false);
    expect(mutexApi.canStart('render')).toBe(true);
  });

  it('失败写 maskError 且 isMasking 复位', async () => {
    const onApplyMask = vi.fn().mockRejectedValue(new Error('未检测到该区域'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useAiMask({ onApplyMask }), { wrapper });
      await act(async () => {
        await result.current.handleApplyMaskClick();
      });
      expect(result.current.maskError).toBe('未检测到该区域');
      expect(result.current.isMasking).toBe(false);
      expect(result.current.pendingMask).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
