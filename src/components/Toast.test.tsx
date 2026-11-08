/**
 * Toast 生命周期与无障碍语义（L-02 / L-03）。
 *
 * 契约：
 *  - 错误走 `role="alert"` + `aria-live="assertive"`，**不自动消失**；
 *  - 成功/提示走 `role="status"` + `aria-live="polite"`，可自动消失；
 *  - 二者分属**不同的常驻 live region**；
 *  - 同 variant + 同文案在去重窗口内重复入队 → 合并计数（×N），不新增条目；
 *  - 通知级上限 3：被挤掉的只能是通知级，**错误不受通知上限影响**。
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';
import { TOAST_EXIT_MS } from './ToastViewport';

type ToastApi = ReturnType<typeof useToast>;

let api: ToastApi;

const Capture: React.FC = () => {
  api = useToast();
  return null;
};

const renderToasts = () =>
  render(
    <ToastProvider>
      <Capture />
    </ToastProvider>,
  );

describe('Toast —— L-02 / L-03', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('error 不自动消失（必须用户关闭）', () => {
    renderToasts();
    act(() => api.error('写盘失败'));
    expect(screen.getByText('写盘失败')).toBeInTheDocument();

    // 远超旧的 7s 自动消失阈值，错误仍必须留在屏幕上
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('写盘失败')).toBeInTheDocument();
  });

  it('success 4 秒后自动消失', () => {
    renderToasts();
    act(() => api.success('已保存'));
    expect(screen.getByText('已保存')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    // issue #41：队列已移除，但视觉上还要走 TOAST_EXIT_MS 的淡出窗口
    expect(
      (screen.getByText('已保存').parentElement as HTMLElement).getAttribute('data-exiting'),
    ).toBe('true');

    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS);
    });
    expect(screen.queryByText('已保存')).toBeNull();
  });

  it('错误与通知分属不同的 live region（assertive vs polite）', () => {
    renderToasts();
    act(() => {
      api.error('E1');
      api.success('S1');
    });

    const alertRegion = screen.getByRole('alert');
    expect(alertRegion).toHaveAttribute('aria-live', 'assertive');
    const statusRegion = screen.getByRole('status');
    expect(statusRegion).toHaveAttribute('aria-live', 'polite');

    // 错误只在 alert 区，通知只在 status 区 —— 不共用一个区域
    expect(alertRegion).toHaveTextContent('E1');
    expect(alertRegion).not.toHaveTextContent('S1');
    expect(statusRegion).toHaveTextContent('S1');
    expect(statusRegion).not.toHaveTextContent('E1');
  });

  it('同文案错误重复入队会合并计数（×N），不产生多条', () => {
    renderToasts();
    act(() => {
      for (let i = 0; i < 5; i += 1) api.error('同一错误');
    });

    expect(screen.getAllByText('同一错误')).toHaveLength(1);
    expect(screen.getByLabelText('重复 5 次')).toHaveTextContent('×5');
  });

  it('重复的 success 同样合并计数', () => {
    renderToasts();
    act(() => {
      api.success('已保存');
      api.success('已保存');
    });

    expect(screen.getAllByText('已保存')).toHaveLength(1);
    expect(screen.getByLabelText('重复 2 次')).toHaveTextContent('×2');
  });

  it('通知级上限 3：被挤掉的是最旧的通知，错误不受影响', () => {
    renderToasts();
    act(() => api.error('关键错误'));
    act(() => {
      api.success('n1');
      api.success('n2');
      api.success('n3');
      api.success('n4');
    });

    // n1 被挤掉，保留最后 3 条通知
    expect(screen.queryByText('n1')).toBeNull();
    expect(screen.getByText('n2')).toBeInTheDocument();
    expect(screen.getByText('n4')).toBeInTheDocument();
    // 错误不参与通知上限，仍在
    expect(screen.getByText('关键错误')).toBeInTheDocument();
  });

  it('错误可通过关闭按钮移除', () => {
    renderToasts();
    act(() => api.error('E'));
    fireEvent.click(screen.getByLabelText('关闭此提示'));
    // issue #41：点关闭 = 开始退场，而不是同 tick 硬切消失
    expect(screen.queryByText('E')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS);
    });
    expect(screen.queryByText('E')).toBeNull();
  });
});

/**
 * issue #18 · PB-11（本 issue #41 落地）：Toast 退场 presence。
 *
 * 三态时序：`在队列 → 关/自动消失后标 data-exiting（仍挂载）→ 推进 TOAST_EXIT_MS 后移除`。
 * jsdom 不跑 CSS 过渡，所以这里只钉结构与时序；淡出顺不顺由真机回签。
 */
describe('issue #41 —— Toast 退场 presence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const exitMarkOf = (text: string) =>
    (screen.getByText(text).parentElement as HTMLElement).getAttribute('data-exiting');

  /**
   * 临时把 `prefers-reduced-motion` 置为真。
   * `setup.ts:307` 用 `writable: true` 但没有 `configurable`，所以这里**只能赋值**
   * （`defineProperty` 会抛 Cannot redefine property），也不能用 `vi.spyOn`。
   * 赋值后再读一次确认真的生效，避免「没覆盖上还假装绿」。
   */
  const withReducedMotion = (fn: () => void) => {
    const prev = window.matchMedia;
    const stub = (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    (window as unknown as Record<string, unknown>).matchMedia = stub;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      throw new Error('本环境无法覆盖 matchMedia，reduced-motion 用例不能假装通过');
    }
    try {
      fn();
    } finally {
      (window as unknown as Record<string, unknown>).matchMedia = prev;
    }
  };

  it('点关闭后先标 data-exiting 仍挂载，推进 TOAST_EXIT_MS 才移除', () => {
    renderToasts();
    act(() => api.error('写盘失败'));
    expect(exitMarkOf('写盘失败')).toBeNull();

    fireEvent.click(screen.getByLabelText('关闭此提示'));

    // 同一个 tick：元素必须还在 DOM 里，并带退场标记
    expect(screen.queryByText('写盘失败')).not.toBeNull();
    expect(exitMarkOf('写盘失败')).toBe('true');

    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS - 1);
    });
    expect(screen.queryByText('写盘失败')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('写盘失败')).toBeNull();
  });

  it('退场窗口内连点关闭不叠加：始终只有一行，结束后不残留', () => {
    renderToasts();
    act(() => api.error('写盘失败'));
    fireEvent.click(screen.getByLabelText('关闭此提示'));
    // 退场期间关闭按钮仍在 DOM，再点两次（队列侧已移除，渲染侧不能叠加副本）
    fireEvent.click(screen.getByLabelText('关闭此提示'));
    fireEvent.click(screen.getByLabelText('关闭此提示'));

    expect(screen.getAllByText('写盘失败')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS * 3);
    });
    expect(screen.queryByText('写盘失败')).toBeNull();
  });

  it('卸载时清理退场计时器：推进计时器不再有副作用', () => {
    const { unmount } = renderToasts();
    act(() => api.error('写盘失败'));
    fireEvent.click(screen.getByLabelText('关闭此提示'));
    // 卸载前至少挂着这一个退场计时器（不同 pool 下可能另有环境自带占用，
    // 所以用「相对减少」而不是绝对值 0 来断言）
    const pendingBefore = vi.getTimerCount();
    expect(pendingBefore).toBeGreaterThan(0);
    unmount();

    expect(vi.getTimerCount()).toBe(pendingBefore - 1);
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(TOAST_EXIT_MS * 5);
      }),
    ).not.toThrow();
  });

  it('prefers-reduced-motion 下跳过退场窗口，关闭即移除', () => {
    withReducedMotion(() => {
      renderToasts();
      act(() => api.error('写盘失败'));
      fireEvent.click(screen.getByLabelText('关闭此提示'));
      expect(screen.queryByText('写盘失败')).toBeNull();
    });
  });
});
