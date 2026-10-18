/**
 * FR-03 回归：批量写盘必须**关掉合并**（`coalesce: false`）。
 *
 * 批量是「每张只改一次」，没有后续按键要等。若走 400ms 防抖，200 张就要多等
 * 80 秒，而且进度条会一直卡在最后一张。这条测试锁住那个参数。
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBatchOps } from './useBatchOps';
import { invokeCalls, mockInvokeCommand } from '../test/setup';
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
  hasXmp: false,
});

const setup = (ids: string[]) => {
  mockInvokeCommand('update_rating_flag_cmd', true);
  const groups = ids.map(group);
  return renderHook(() =>
    useBatchOps({
      filteredGroups: groups,
      selectedIds: new Set(ids),
      onGroupPatched: () => {},
      markSynced: () => {},
      markUnsynced: () => {},
      rememberRating: () => {},
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
});
