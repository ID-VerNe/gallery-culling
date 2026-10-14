/**
 * L-11 回归：星级/旗标的单步撤销。
 *
 * 核心不是"记住最近一次写入"，而是"记住这轮操作的起点"——否则连按 `1..5`
 * 会把快照刷成上一步的值，撤销只退一格，用户会觉得"撤销没生效"。
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRatingUndo, type RatingSnapshot } from './useRatingUndo';

const snap = (over: Partial<RatingSnapshot> = {}): RatingSnapshot => ({
  id: 'a',
  path: 'D:/shoot/IMG_0001.jpg',
  rating: 3,
  flag: 'pick',
  ...over,
});

describe('useRatingUndo —— 单步撤销', () => {
  it('初始没有可撤销的操作', () => {
    const { result } = renderHook(() => useRatingUndo());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.take()).toBeNull();
  });

  it('remember 后 canUndo 为真，take 一次后清空（撤销只生效一次）', () => {
    const { result } = renderHook(() => useRatingUndo());

    act(() => result.current.remember(snap()));
    expect(result.current.canUndo).toBe(true);

    let taken: RatingSnapshot | null = null;
    act(() => {
      taken = result.current.take();
    });
    expect(taken).toMatchObject({ rating: 3, flag: 'pick' });

    expect(result.current.canUndo).toBe(false);
    expect(result.current.take()).toBeNull();
  });

  it('同一张照片连续改动被合并：撤销回到这轮最早的值', () => {
    const { result } = renderHook(() => useRatingUndo());

    act(() => result.current.remember(snap({ rating: 0, flag: 'none' })));
    act(() => result.current.remember(snap({ rating: 1 })));
    act(() => result.current.remember(snap({ rating: 5 })));

    let taken: RatingSnapshot | null = null;
    act(() => {
      taken = result.current.take();
    });
    // 回到"按下 1 之前"，而不是"按下 5 之前"
    expect(taken).toMatchObject({ rating: 0, flag: 'none' });
  });

  it('换到另一张照片时压入新的一层（后进先出：先撤销最近的那张）', () => {
    const { result } = renderHook(() => useRatingUndo());

    act(() => result.current.remember(snap({ id: 'a', rating: 0 })));
    act(() => result.current.remember(snap({ id: 'b', path: 'D:/b.jpg', rating: 2 })));

    let taken: RatingSnapshot | null = null;
    act(() => {
      taken = result.current.take();
    });
    expect(taken).toMatchObject({ id: 'b', rating: 2 });
  });

  it('B5：多步撤销栈 —— 连续改多张可逐层回退，最多保留 5 步', () => {
    const { result } = renderHook(() => useRatingUndo());

    // 改 6 张不同照片：只有最后 5 步留在栈里（最旧的 a 被淘汰）。
    act(() => result.current.remember(snap({ id: 'a', rating: 0 })));
    act(() => result.current.remember(snap({ id: 'b', path: 'D:/b.jpg', rating: 1 })));
    act(() => result.current.remember(snap({ id: 'c', path: 'D:/c.jpg', rating: 2 })));
    act(() => result.current.remember(snap({ id: 'd', path: 'D:/d.jpg', rating: 3 })));
    act(() => result.current.remember(snap({ id: 'e', path: 'D:/e.jpg', rating: 4 })));
    act(() => result.current.remember(snap({ id: 'f', path: 'D:/f.jpg', rating: 5 })));

    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      let taken: RatingSnapshot | null = null;
      act(() => {
        taken = result.current.take();
      });
      if (taken) order.push((taken as RatingSnapshot).id);
    }

    // 后进先出：f → b，最旧的 a 因超过 5 步上限已被淘汰。
    expect(order).toEqual(['f', 'e', 'd', 'c', 'b']);
    expect(result.current.canUndo).toBe(false);
  });

  it('撤销后再改同一张：新的一轮重新取快照（不是旧的）', () => {
    const { result } = renderHook(() => useRatingUndo());

    act(() => result.current.remember(snap({ rating: 0 })));
    act(() => result.current.take()); // 撤销掉

    act(() => result.current.remember(snap({ rating: 4 })));
    let taken: RatingSnapshot | null = null;
    act(() => {
      taken = result.current.take();
    });
    expect(taken).toMatchObject({ rating: 4 });
  });

  it('clear 丢弃快照（换目录 / 重新扫描时用）', () => {
    const { result } = renderHook(() => useRatingUndo());

    act(() => result.current.remember(snap()));
    act(() => result.current.clear());

    expect(result.current.canUndo).toBe(false);
    expect(result.current.take()).toBeNull();
  });
});
