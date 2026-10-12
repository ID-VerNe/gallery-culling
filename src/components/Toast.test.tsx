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
    expect(screen.queryByText('E')).toBeNull();
  });
});
