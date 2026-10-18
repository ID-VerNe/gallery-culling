/**
 * FR-07 套用调色到选中 —— 边界优先的测试。
 *
 * 这里的每一条都对应一个真实会出错的场景，而不是「跑通一次」：
 * - 源照片可能就在选中里（套给自己 = 无意义写盘）；
 * - 路径大小写/分隔符不同仍是同一张（Windows）；
 * - 一张失败不能连坐后面 199 张；
 * - 取消只记「已处理」，不能把没碰过的照片算进结果；
 * - 目标照片若还留着未保存的旧编辑，套用后会被旧值遮蔽 —— 必须清掉。
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useToneBatch, type ToneBatchFailure } from './useToneBatch';
import { invokeCalls, mockInvokeCommand, setInvokeHandler } from '../test/setup';
import type { PhotoGroupInfo, ToneAdjustments } from '../types';

const TONE: ToneAdjustments = {
  exposure: 0.5,
  highlights: -20,
  shadows: 15,
  temperature: 8,
  tint: -4,
  contrast: 12,
};

const group = (
  id: string,
  path = `D:/shoot/RAW/${id}.ARW`,
  extra: Partial<PhotoGroupInfo> = {},
): PhotoGroupInfo => ({
  id,
  baseName: id,
  raw: { name: `${id}.ARW`, extension: 'ARW', path, size: 1, mtime: 1 },
  status: 'RAW_ONLY',
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
  ...extra,
});

const okReport = {
  xmpWritten: true,
  lumenApplied: false,
  projectPath: null,
  warnings: [],
};

interface SetupOpts {
  groups: PhotoGroupInfo[];
  selectedIds: string[];
  source?: PhotoGroupInfo | undefined;
  tone?: ToneAdjustments | undefined;
}

function setup(opts: SetupOpts) {
  const groups = opts.groups;
  const source = opts.source === undefined ? groups[0] : opts.source;
  // `tone: undefined` 是**显式**用例（验证不猜默认值），不能被解构默认值吞掉。
  const tone = 'tone' in opts ? opts.tone : TONE;
  const patched: Array<{ id: string; patch: Partial<PhotoGroupInfo> }> = [];
  const discarded: string[][] = [];
  mockInvokeCommand('apply_tone_cmd', okReport);
  const hook = renderHook(() =>
    useToneBatch({
      filteredGroups: groups,
      selectedIds: new Set(opts.selectedIds),
      sourceGroup: source,
      tone,
      onGroupPatched: (id, patch) => patched.push({ id, patch }),
      onToneDiscarded: (ids) => discarded.push(ids),
    }),
  );
  return { ...hook, patched, discarded };
}

const toneCalls = () => invokeCalls('apply_tone_cmd');

describe('useToneBatch —— 目标集合', () => {
  it('源不在选中：选中的每一张都写，套用值就是面板当前值', async () => {
    const { result, patched } = setup({
      groups: [group('S'), group('A'), group('B')],
      selectedIds: ['A', 'B'],
      source: group('S'),
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    const calls = toneCalls();
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args?.filePath)).toEqual([
      'D:/shoot/RAW/A.ARW',
      'D:/shoot/RAW/B.ARW',
    ]);
    // 6 个 tone 字段原样传递，不夹带 rating/flag/label。
    expect(calls[0].args?.tone).toEqual(TONE);
    expect(calls[0].args).not.toHaveProperty('rating');
    expect(calls[0].args).not.toHaveProperty('label');
    expect(patched.map((p) => p.id)).toEqual(['A', 'B']);
    expect(patched[0].patch.tone).toEqual(TONE);
  });

  it('源在选中：排除源本身，绝不对自己重复写盘', async () => {
    const { result } = setup({
      groups: [group('S'), group('A'), group('B')],
      selectedIds: ['S', 'A', 'B'],
      source: group('S'),
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(toneCalls().map((c) => c.args?.filePath)).toEqual([
      'D:/shoot/RAW/A.ARW',
      'D:/shoot/RAW/B.ARW',
    ]);
  });

  it('路径大小写与分隔符不同也认作同一张：按路径排除而非按 id', async () => {
    // 同一张照片在两个集合里可能拿到不同写法的路径（扫描缓存 / 会话恢复）。
    const source = group('S', 'D:\\shoot\\RAW\\a.ARW');
    const same = group('S2', 'd:/shoot/raw/A.ARW');
    const { result } = setup({
      groups: [same, group('B')],
      selectedIds: ['S2', 'B'],
      source,
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(toneCalls().map((c) => c.args?.filePath)).toEqual(['D:/shoot/RAW/B.ARW']);
  });

  it('选中里只有源自己：零写盘，也不报错', async () => {
    const { result, patched, discarded } = setup({
      groups: [group('S')],
      selectedIds: ['S'],
      source: group('S'),
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(toneCalls()).toHaveLength(0);
    expect(patched).toHaveLength(0);
    expect(discarded).toHaveLength(0);
    expect(result.current.toneBatchProgress).toBeNull();
  });

  it('tone 未定义：直接返回，绝不猜一个默认值写进用户照片', async () => {
    const { result } = setup({
      groups: [group('S'), group('A')],
      selectedIds: ['A'],
      tone: undefined,
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(toneCalls()).toHaveLength(0);
  });
});

describe('useToneBatch —— 失败隔离与报告', () => {
  it('中间一张失败不中断：后面的照片照常写入', async () => {
    let n = 0;
    setInvokeHandler(async (command) => {
      if (command !== 'apply_tone_cmd') return okReport;
      n++;
      if (n === 2) throw new Error('XMP 只读');
      return okReport;
    });

    const { result, patched } = setup({
      groups: [group('S'), group('A'), group('B'), group('C')],
      selectedIds: ['A', 'B', 'C'],
      source: group('S'),
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(n).toBe(3);
    expect(patched.map((p) => p.id)).toEqual(['A', 'C']);
    expect(result.current.toneBatchFailures).toHaveLength(1);
    const failure = result.current.toneBatchFailures![0] as ToneBatchFailure;
    expect(failure.name).toBe('B.ARW');
    expect(failure.path).toBe('D:/shoot/RAW/B.ARW');
    expect(failure.reason).toContain('XMP 只读');
  });

  it('没有可写路径的目标计为失败，且不占用一次 IPC', async () => {
    const noPath: PhotoGroupInfo = {
      id: 'X',
      baseName: 'X',
      status: 'RAW_ONLY',
      rating: 0,
      flag: 'none',
      label: '',
      hasXmp: false,
    };
    const { result } = setup({
      groups: [group('S'), noPath, group('C')],
      selectedIds: ['X', 'C'],
      source: group('S'),
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(toneCalls()).toHaveLength(1);
    expect(result.current.toneBatchFailures).toHaveLength(1);
    expect(result.current.toneBatchFailures![0].reason).toContain('没有可写入');
  });

  it('XMP 成功但 LUMEN 工程失败：算成功，但警告单独留档', async () => {
    const { result, patched } = setup({
      groups: [group('S'), group('A')],
      selectedIds: ['A'],
      source: group('S'),
    });
    // setup 之后覆盖：报告带 warning，但命令本身是成功的。
    mockInvokeCommand('apply_tone_cmd', {
      xmpWritten: true,
      lumenApplied: false,
      projectPath: null,
      warnings: ['保存 LUMEN RAW 工程失败: 超时'],
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(patched).toHaveLength(1);
    expect(result.current.toneBatchFailures).toBeNull();
    expect(result.current.toneBatchWarnings).toHaveLength(1);
    expect(result.current.toneBatchWarnings![0]).toContain('超时');
  });
});

describe('useToneBatch —— 取消与重入', () => {
  it('取消只记已处理的照片：跳过剩余后不再发 IPC', async () => {
    let writes = 0;
    let hook: { current: ReturnType<typeof useToneBatch> } | null = null;
    setInvokeHandler(async (command) => {
      if (command === 'apply_tone_cmd') {
        writes++;
        if (writes === 1) hook?.current.skipRemaining();
      }
      return okReport;
    });

    const { result, patched, discarded } = setup({
      groups: [group('S'), group('A'), group('B'), group('C')],
      selectedIds: ['A', 'B', 'C'],
      source: group('S'),
    });
    hook = result;

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(writes).toBe(1);
    expect(patched.map((p) => p.id)).toEqual(['A']);
    expect(discarded).toEqual([['A']]);
    expect(result.current.toneBatchProgress).toBeNull();
  });

  it('进行中再次触发被忽略：不会两批同时写同一张照片', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    setInvokeHandler(async (command) => {
      if (command !== 'apply_tone_cmd') return okReport;
      calls++;
      await gate;
      return okReport;
    });

    const { result } = setup({
      groups: [group('S'), group('A'), group('B')],
      selectedIds: ['A', 'B'],
      source: group('S'),
    });

    let first!: Promise<void>;
    act(() => {
      first = result.current.runApplyTone();
    });
    await act(async () => {
      await result.current.runApplyTone();
    });
    await act(async () => {
      release();
      await first;
    });

    expect(calls).toBe(2);
  });
});

describe('useToneBatch —— 写盘选项与基线', () => {
  it('writeLumen 默认 false：只写 XMP，不拖 200 次工程落盘', async () => {
    const { result } = setup({
      groups: [group('S'), group('A')],
      selectedIds: ['A'],
      source: group('S'),
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(toneCalls()[0].args?.writeLumen).toBe(false);
  });

  it('勾选后 writeLumen=true 透传到命令', async () => {
    const { result } = setup({
      groups: [group('S'), group('A')],
      selectedIds: ['A'],
      source: group('S'),
    });

    await act(async () => {
      await result.current.runApplyTone({ writeLumen: true });
    });

    expect(toneCalls()[0].args?.writeLumen).toBe(true);
  });

  it('成功的目标要清掉未保存编辑，否则旧值会遮蔽新基线', async () => {
    const { result, discarded } = setup({
      groups: [group('S'), group('A'), group('B')],
      selectedIds: ['A', 'B'],
      source: group('S'),
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    // 一次批量只清一次（避免每张都触发一次 setState）。
    expect(discarded).toEqual([['A', 'B']]);
  });

  it('全部失败时不发"清除编辑"回调：磁盘没变，用户的编辑不该被丢', async () => {
    const { result, discarded } = setup({
      groups: [group('S'), group('A')],
      selectedIds: ['A'],
      source: group('S'),
    });
    // setup 会先注册成功返回值；这里必须在其后覆盖，否则抛错分支走不到。
    mockInvokeCommand('apply_tone_cmd', () => {
      throw new Error('磁盘满');
    });

    await act(async () => {
      await result.current.runApplyTone();
    });

    expect(discarded).toHaveLength(0);
    expect(result.current.toneBatchFailures).toHaveLength(1);
  });
});
