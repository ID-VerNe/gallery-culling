/**
 * FR-03 回归：批量写盘必须**关掉合并**（`coalesce: false`）。
 *
 * 批量是「每张只改一次」，没有后续按键要等。若走 400ms 防抖，200 张就要多等
 * 80 秒，而且进度条会一直卡在最后一张。这条测试锁住那个参数。
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBatchOps } from './useBatchOps';
import { invokeCalls, mockInvokeCommand, setInvokeHandler } from '../test/setup';
import type { CullCommand } from '../utils/cullCommand';
import type { PhotoGroupInfo } from '../types';

const group = (id: string): PhotoGroupInfo => ({
  id,
  baseName: id,
  raw: {
    name: `${id}.ARW`,
    extension: 'ARW',
    path: `D:/shoot/${id}.ARW`,
    size: 1,
    mtime: 1,
  },
  status: 'RAW_ONLY',
  rating: 0,
  flag: 'none',
  label: '', hasXmp: false,
});

const setup = (ids: string[], pushCommand: (c: CullCommand) => void = () => {}) => {
  mockInvokeCommand('update_rating_flag_cmd', true);
  const groups = ids.map(group);
  return renderHook(() =>
    useBatchOps({
      filteredGroups: groups,
      selectedIds: new Set(ids),
      onGroupPatched: () => {},
      markSynced: () => {},
      markUnsynced: () => {},
      pushCommand,
      pendingBatch: null,
    }),
  );
};

describe('useBatchOps —— 写盘合并', () => {
  it('批量评分：逐张落盘且关闭合并', async () => {
    const { result } = setup(['A', 'B']);

    await act(async () => {
      await result.current.runBatch({ kind: 'rate', value: 4 });
    });

    const calls = invokeCalls('update_rating_flag_cmd');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toMatchObject({ rating: 4, coalesce: false });
    }
  });

  it('批量清除：同样是每张一次、关闭合并', async () => {
    const { result } = setup(['A', 'B', 'C']);

    await act(async () => {
      await result.current.runBatch({ kind: 'clear' });
    });

    const calls = invokeCalls('update_rating_flag_cmd');
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args).toMatchObject({ rating: 0, flag: 'none', coalesce: false });
    }
  });

  it('批量色标是"设为"：逐张写同一个色标，星级/旗标原样保留', async () => {
    const { result } = setup(['A', 'B']);

    await act(async () => {
      await result.current.runBatch({ kind: 'label', value: 'Purple' });
    });

    const calls = invokeCalls('update_rating_flag_cmd');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toMatchObject({
        rating: 0,
        flag: 'none',
        label: 'Purple',
        coalesce: false,
      });
    }
  });
});

describe('useBatchOps —— 撤销命令（FR-04）', () => {
  it('整批只压一条命令：撤销一次回退整批，而不是退一张', async () => {
    const pushed: CullCommand[] = [];
    const { result } = setup(['A', 'B', 'C'], (c) => pushed.push(c));

    await act(async () => {
      await result.current.runBatch({ kind: 'flag', value: 'reject' });
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0].summary).toBe('淘汰 3 张');
    expect(pushed[0].items.map((i) => i.id)).toEqual(['A', 'B', 'C']);
    // before/after 必须成对：撤销写 before，重做写 after。
    expect(pushed[0].items[0].before).toEqual({ rating: 0, flag: 'none', label: '' });
    expect(pushed[0].items[0].after).toEqual({ rating: 0, flag: 'reject', label: '' });
  });

  it('清除批量：命令里的 after 是 0 星 + 未标记，色标不动', async () => {
    const pushed: CullCommand[] = [];
    const { result } = setup(['A', 'B'], (c) => pushed.push(c));

    await act(async () => {
      await result.current.runBatch({ kind: 'clear' });
    });

    expect(pushed[0].summary).toBe('清除 2 张的星级与标记');
    expect(pushed[0].items[0].after).toEqual({ rating: 0, flag: 'none', label: '' });
  });

  it('中途跳过剩余：命令只含已处理的照片，未碰过的不进撤销栈', async () => {
    const pushed: CullCommand[] = [];
    let writes = 0;
    let hook: { current: ReturnType<typeof useBatchOps> } | null = null;

    setInvokeHandler(async (command) => {
      if (command === 'update_rating_flag_cmd') {
        writes++;
        // 第一张写完后请求「跳过剩余」：第二圈的循环头会读到这个标志。
        if (writes === 1) hook?.current.skipRemaining();
      }
      return true;
    });

    const { result } = setup(['A', 'B', 'C'], (c) => pushed.push(c));
    hook = result;

    await act(async () => {
      await result.current.runBatch({ kind: 'rate', value: 5 });
    });

    expect(writes).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].items).toHaveLength(1);
    expect(pushed[0].items[0].id).toBe('A');
  });
});
