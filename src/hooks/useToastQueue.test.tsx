/**
 * toast 队列规则（FE-04 抽出的 useToastQueue）。
 *
 * 这些不变量此前只能通过渲染整个 App 间接验证，改动时极易悄悄坏掉：
 *   - 同 variant + 同文案在去重窗口内合并计数，而非新增条目
 *   - 通知级（success/info）同屏上限 3
 *   - 错误不自动消失
 *   - 错误永不被通知挤掉（独立的 live region）
 *   - 通知永远挤不掉错误
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useToastQueue } from './useToastQueue';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const mount = () => renderHook(() => useToastQueue());

describe('去重窗口', () => {
  it('同 variant + 同文案在窗口内合并计数，不新增条目', () => {
    const { result } = mount();
    act(() => result.current.api.success('已保存'));
    act(() => result.current.api.success('已保存'));
    act(() => result.current.api.success('已保存'));

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].count).toBe(3);
  });

  it('不同 variant 的同文案不合并', () => {
    const { result } = mount();
    act(() => result.current.api.success('同一句'));
    act(() => result.current.api.info('同一句'));
    expect(result.current.toasts).toHaveLength(2);
  });

  it('窗口外的重复会作为新条目出现', () => {
    const { result } = mount();
    act(() => result.current.api.success('已保存'));
    act(() => {
      vi.advanceTimersByTime(4000); // 超出自动消失时长，也超出去重窗口
    });
    act(() => result.current.api.success('已保存'));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].count).toBe(1);
  });
});

describe('分区间截断', () => {
  it('通知级最多同时存在 3 条', () => {
    const { result } = mount();
    act(() => {
      for (let i = 0; i < 6; i += 1) result.current.api.info(`通知 ${i}`);
    });
    expect(result.current.toasts.filter((t) => t.variant !== 'error')).toHaveLength(3);
  });

  it('★通知永远挤不掉错误', () => {
    const { result } = mount();
    act(() => result.current.api.error('磁盘写入失败'));
    act(() => {
      for (let i = 0; i < 10; i += 1) result.current.api.info(`通知 ${i}`);
    });

    const errors = result.current.toasts.filter((t) => t.variant === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('磁盘写入失败');
  });
});

describe('自动消失', () => {
  it('通知在 4s 后自动消失', () => {
    const { result } = mount();
    act(() => result.current.api.info('稍后消失'));
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('★错误不自动消失（必须由用户点关闭）', () => {
    const { result } = mount();
    act(() => result.current.api.error('需要用户处理'));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.toasts).toHaveLength(1);
  });

  it('dismiss 手动移除指定条目', () => {
    const { result } = mount();
    act(() => result.current.api.info('一条'));
    const id = result.current.toasts[0].id;
    act(() => result.current.dismiss(id));
    expect(result.current.toasts).toHaveLength(0);
  });
});
