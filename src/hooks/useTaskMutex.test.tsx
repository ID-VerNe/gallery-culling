/**
 * FR-09 `useTaskMutex`：注册 / 注销 / 幂等 / 自动释放。
 *
 * 互斥表是纯函数，容易测；真正容易出错的是**生命周期**：
 * 任务抛错没释放 → 按钮永久变灰（死锁）；重复释放 → 把别人的占用一起清掉；
 * 组件卸载没释放 → 关掉弹窗后整个应用再也导不了。
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  TaskMutexProvider,
  useActivity,
  useTaskMutex,
  type TaskMutexApi,
} from './useTaskMutex';

const wrapper = ({ children }: { children: ReactNode }) => (
  <TaskMutexProvider>{children}</TaskMutexProvider>
);

describe('useTaskMutex —— 注册与释放', () => {
  it('注册后互斥任务被挡，释放后恢复', () => {
    const { result } = renderHook(() => useTaskMutex(), { wrapper });

    expect(result.current.canStart('scan')).toBe(true);
    let release!: () => void;
    act(() => {
      release = result.current.begin('export');
    });
    expect(result.current.canStart('scan')).toBe(false);
    expect(result.current.blockReason('scan')).toContain('正在导出照片');

    act(() => release());
    expect(result.current.canStart('scan')).toBe(true);
  });

  it('release 幂等：重复调用不会误放别人的占用', () => {
    const { result } = renderHook(() => useTaskMutex(), { wrapper });

    let releaseA!: () => void;
    let releaseB!: () => void;
    act(() => {
      releaseA = result.current.begin('export');
      releaseB = result.current.begin('export');
    });
    act(() => releaseA());
    // 还剩 B 的占用 —— 导出仍然算在跑。
    expect(result.current.canStart('scan')).toBe(false);
    act(() => releaseA());
    expect(result.current.canStart('scan')).toBe(false);
    act(() => releaseB());
    expect(result.current.canStart('scan')).toBe(true);
  });

  it('同一活动多个 token：全部释放后才解除', () => {
    const { result } = renderHook(() => useTaskMutex(), { wrapper });

    let r1!: () => void;
    let r2!: () => void;
    act(() => {
      r1 = result.current.begin('ai');
      r2 = result.current.begin('ai');
    });
    act(() => r1());
    expect(result.current.canStart('render')).toBe(false);
    act(() => r2());
    expect(result.current.canStart('render')).toBe(true);
  });

  it('多个活动同时占用：原因按表顺序列出', () => {
    const { result } = renderHook(() => useTaskMutex(), { wrapper });

    act(() => {
      result.current.begin('export');
      result.current.begin('render');
    });
    expect(result.current.blockReason('scan')).toBe(
      '正在导出照片、渲染导出，暂时不能扫描照片。',
    );
  });

  it('占用状态属于 Provider 实例，不会跨实例泄漏成全局单例', () => {
    let api!: TaskMutexApi;
    function Capture() {
      api = useTaskMutex();
      return null;
    }
    const first = render(
      <TaskMutexProvider>
        <Capture />
      </TaskMutexProvider>,
    );
    act(() => {
      api.begin('export');
    });
    expect(api.canStart('scan')).toBe(false);
    first.unmount();

    // 新实例必须是干净的：若状态被写成模块级变量，这里会是 false。
    const fresh = renderHook(() => useTaskMutex(), { wrapper });
    expect(fresh.result.current.canStart('scan')).toBe(true);
  });
});

describe('useTaskMutex —— useActivity 自动跟随', () => {
  function Probe({ running }: { running: boolean }) {
    useActivity('export', running);
    return null;
  }

  it('running=true 自动占用，false 自动释放', () => {
    let api!: TaskMutexApi;
    function Capture() {
      api = useTaskMutex();
      return null;
    }
    const { rerender } = render(
      <TaskMutexProvider>
        <Capture />
        <Probe running={false} />
      </TaskMutexProvider>,
    );
    expect(api.canStart('scan')).toBe(true);

    rerender(
      <TaskMutexProvider>
        <Capture />
        <Probe running={true} />
      </TaskMutexProvider>,
    );
    expect(api.canStart('scan')).toBe(false);

    rerender(
      <TaskMutexProvider>
        <Capture />
        <Probe running={false} />
      </TaskMutexProvider>,
    );
    expect(api.canStart('scan')).toBe(true);
  });

  it('卸载时 running 仍为 true：占用必须释放', () => {
    let api!: TaskMutexApi;
    function Capture() {
      api = useTaskMutex();
      return null;
    }
    const { rerender } = render(
      <TaskMutexProvider>
        <Capture />
        <Probe running={true} />
      </TaskMutexProvider>,
    );
    expect(api.canStart('scan')).toBe(false);

    rerender(
      <TaskMutexProvider>
        <Capture />
      </TaskMutexProvider>,
    );
    expect(api.canStart('scan')).toBe(true);
  });

  it('重复渲染同一 running=true 不会重复占用（effect 依赖不变）', () => {
    let api!: TaskMutexApi;
    function Capture() {
      api = useTaskMutex();
      return null;
    }
    const tree = (n: number) => (
      <TaskMutexProvider>
        <Capture />
        <Probe running={true} />
        <span>{n}</span>
      </TaskMutexProvider>
    );
    const { rerender } = render(tree(0));
    rerender(tree(1));
    rerender(tree(2));
    // 只有一个 token：释放一次就该解除。
    act(() => {
      // 通过卸载 Probe 触发清理
      rerender(
        <TaskMutexProvider>
          <Capture />
          <span>3</span>
        </TaskMutexProvider>,
      );
    });
    expect(api.canStart('scan')).toBe(true);
  });
});

describe('useTaskMutex —— 使用边界', () => {
  it('Provider 外调用直接抛错，而不是静默降级成"永远可用"', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useTaskMutex())).toThrow(/TaskMutexProvider/);
    spy.mockRestore();
  });
});
