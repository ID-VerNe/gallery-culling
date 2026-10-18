/**
 * FR-04 多步撤销：命令栈的纯逻辑回归。
 *
 * 与旧的单步快照相比有三处语义变化，每条都有用例锁定：
 * - **批量算一步**：一条命令可以带多个条目，撤销一次整批回退。
 * - **有重做**：撤销不是丢弃，而是把命令挪到重做栈；新操作才清空重做栈。
 * - **深度 50**：超过上限淘汰最旧的一步，避免长会话里无限增长。
 *
 * 刻意保留「同一张照片连续改动合并成一步」的旧行为：连按 `1..5` 时用户想要的是
 * 「撤销这轮改动」，而不是退一格。合并只发生在**栈顶且双方都是单条目**时。
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCullUndo } from './useCullUndo';
import type { CullCommand, CullItem, MetaState } from '../utils/cullCommand';

const state = (over: Partial<MetaState> = {}): MetaState => ({
  rating: 0,
  flag: 'none',
  label: '',
  ...over,
});

const item = (
  id: string,
  before: Partial<MetaState> = {},
  after: Partial<MetaState> = {},
): CullItem => ({
  id,
  path: `D:/shoot/${id}.jpg`,
  before: state(before),
  after: state(after),
});

const cmd = (summary: string, ...items: CullItem[]): CullCommand => ({ summary, items });

describe('useCullUndo —— 命令栈', () => {
  it('初始两个栈都空，摘要为空串', () => {
    const { result } = renderHook(() => useCullUndo());

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.undoSummary).toBe('');
    expect(result.current.redoSummary).toBe('');

    let undone: CullCommand | null = null;
    let redone: CullCommand | null = null;
    act(() => {
      undone = result.current.undo();
      redone = result.current.redo();
    });
    expect(undone).toBeNull();
    expect(redone).toBeNull();
  });

  it('push 后 undo 取回该命令，并转入重做栈', () => {
    const { result } = renderHook(() => useCullUndo());
    const c = cmd('设为 4 星', item('a', { rating: 0 }, { rating: 4 }));

    act(() => result.current.push(c));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.undoSummary).toBe('设为 4 星');

    let taken: CullCommand | null = null;
    act(() => {
      taken = result.current.undo();
    });
    expect(taken).toBe(c);

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
    expect(result.current.redoSummary).toBe('设为 4 星');
  });

  it('redo 把命令送回撤销栈，可以反复往返', () => {
    const { result } = renderHook(() => useCullUndo());
    const c = cmd('标记为淘汰', item('a', { flag: 'none' }, { flag: 'reject' }));

    act(() => result.current.push(c));

    act(() => {
      result.current.undo();
    });
    let redone: CullCommand | null = null;
    act(() => {
      redone = result.current.redo();
    });
    expect(redone).toBe(c);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    // 再撤一次仍能取回同一条：往返不丢命令。
    let again: CullCommand | null = null;
    act(() => {
      again = result.current.undo();
    });
    expect(again).toBe(c);
  });

  it('新操作清空重做栈（分支后不能重做旧路径）', () => {
    const { result } = renderHook(() => useCullUndo());

    act(() => result.current.push(cmd('设为 1 星', item('a', {}, { rating: 1 }))));
    act(() => {
      result.current.undo();
    });
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.push(cmd('设为 5 星', item('b', {}, { rating: 5 }))));

    expect(result.current.canRedo).toBe(false);
    expect(result.current.redoSummary).toBe('');
  });

  it('同一张照片连续改动合并成一步：before 保留最早，after 取最新', () => {
    const { result } = renderHook(() => useCullUndo());

    act(() => result.current.push(cmd('设为 1 星', item('a', { rating: 0 }, { rating: 1 }))));
    act(() => result.current.push(cmd('设为 2 星', item('a', { rating: 1 }, { rating: 2 }))));
    act(() => result.current.push(cmd('设为 3 星', item('a', { rating: 2 }, { rating: 3 }))));

    let taken: CullCommand | null = null;
    act(() => {
      taken = result.current.undo();
    });
    // 回到「按下 1 之前」，而不是「按下 3 之前」。
    expect(taken!.items).toHaveLength(1);
    expect(taken!.items[0].before.rating).toBe(0);
    expect(taken!.items[0].after.rating).toBe(3);
    // 合并后只占一步：再撤一次就是空。
    expect(result.current.canUndo).toBe(false);
  });

  it('不同照片不合并，各自占一步', () => {
    const { result } = renderHook(() => useCullUndo());

    act(() => result.current.push(cmd('设为 1 星', item('a', {}, { rating: 1 }))));
    act(() => result.current.push(cmd('设为 2 星', item('b', {}, { rating: 2 }))));

    expect(result.current.undoSummary).toBe('设为 2 星');
    let first: CullCommand | null = null;
    act(() => {
      first = result.current.undo();
    });
    expect(first!.items[0].id).toBe('b');
    expect(result.current.undoSummary).toBe('设为 1 星');
  });

  it('多条目命令（批量）整体算一步，不会被单条命令合并', () => {
    const { result } = renderHook(() => useCullUndo());

    act(() =>
      result.current.push(
        cmd('淘汰 3 张', item('a', {}, { flag: 'reject' }), item('b', {}, { flag: 'reject' }), item('c', {}, { flag: 'reject' })),
      ),
    );
    // 紧跟着再对其中一张做单张操作：不应与批量合并。
    act(() => result.current.push(cmd('设为 5 星', item('a', {}, { rating: 5 }))));

    let top: CullCommand | null = null;
    act(() => {
      top = result.current.undo();
    });
    expect(top!.items).toHaveLength(1);

    let batch: CullCommand | null = null;
    act(() => {
      batch = result.current.undo();
    });
    expect(batch!.items).toHaveLength(3);
    expect(result.current.canUndo).toBe(false);
  });

  it('深度上限 50：超过后淘汰最旧的一步', () => {
    const { result } = renderHook(() => useCullUndo());

    for (let i = 1; i <= 55; i++) {
      act(() => result.current.push(cmd(`第 ${i} 步`, item(`p${i}`, {}, { rating: 1 }))));
    }

    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      let taken: CullCommand | null = null;
      act(() => {
        taken = result.current.undo();
      });
      if (taken) ids.push((taken as CullCommand).items[0].id);
    }

    // 后进先出；最旧的 p1..p5 因超过 50 步被淘汰。
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe('p55');
    expect(ids[49]).toBe('p6');
    expect(result.current.canUndo).toBe(false);
  });

  it('空命令被忽略（不占步、不清重做栈）', () => {
    const { result } = renderHook(() => useCullUndo());

    act(() => result.current.push(cmd('设为 2 星', item('a', {}, { rating: 2 }))));
    act(() => {
      result.current.undo();
    });
    act(() => result.current.push(cmd('空操作')));

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it('peek 只看不取：命令留在原栈（冲突检查没通过时还能再撤）', () => {
    const { result } = renderHook(() => useCullUndo());
    const c = cmd('设为 4 星', item('a', {}, { rating: 4 }));

    act(() => result.current.push(c));

    let peeked: CullCommand | null = null;
    act(() => {
      peeked = result.current.peekUndo();
    });
    expect(peeked).toBe(c);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    act(() => {
      result.current.undo();
    });
    let peekedRedo: CullCommand | null = null;
    act(() => {
      peekedRedo = result.current.peekRedo();
    });
    expect(peekedRedo).toBe(c);
    expect(result.current.canRedo).toBe(true);
  });

  it('clear 同时清空两个栈（换目录 / 重新扫描）', () => {
    const { result } = renderHook(() => useCullUndo());

    act(() => result.current.push(cmd('设为 3 星', item('a', {}, { rating: 3 }))));
    act(() => {
      result.current.undo();
    });
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.clear());

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);

    let undone: CullCommand | null = null;
    let redone: CullCommand | null = null;
    act(() => {
      undone = result.current.undo();
      redone = result.current.redo();
    });
    expect(undone).toBeNull();
    expect(redone).toBeNull();
  });
});
