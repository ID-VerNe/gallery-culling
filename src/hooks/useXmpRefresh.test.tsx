/**
 * FR-08 前端：聚焦增量刷新与冲突裁决 —— 边界优先的测试。
 *
 * 这个 hook 的难点全在「什么时候**不该**做事」：
 * - 10k 张第一次刷新会返回 `baselined: 10000`，若照「有返回值就提示」写，
 *   用户每次开应用都会被一条「已更新 10000 张」的假消息砸中；
 * - 扫描/导出/写盘正在跑时刷新会读到写了一半的 sidecar，必须让路；
 * - 弹窗开着时若被聚焦触发的刷新换掉列表，用户正在做的裁决会凭空消失；
 * - 关掉弹窗不能写盘（「不自动覆盖」的另一半是「不自动保留」）。
 *
 * 另一半是「结果怎么落地」：路径大小写/分隔符不同仍是同一张（Windows），
 * 回填不到分组就等于刷新白跑；部分裁决失败的那几条必须留在弹窗里。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TaskMutexProvider, useTaskMutex, type TaskMutexApi } from './useTaskMutex';
import { XMP_REFRESH_DEBOUNCE_MS, useXmpRefresh } from './useXmpRefresh';
import {
  invokeCalls,
  mockInvokeCommand,
  mockInvokeError,
  setInvokeHandler,
} from '../test/setup';
import type {
  CullStateSnapshot,
  PhotoGroupInfo,
  XmpConflictChoice,
  XmpRefreshReport,
} from '../types';

/* -------------------------------------------------------------------------- */
/* toast 截获                                                                  */
/* -------------------------------------------------------------------------- */

const { toastApi, toastCalls } = vi.hoisted(() => {
  const calls: { kind: 'success' | 'error' | 'info'; message: string }[] = [];
  const push = (kind: 'success' | 'error' | 'info') => (message: string) => {
    calls.push({ kind, message });
  };
  return {
    toastCalls: calls,
    toastApi: { success: push('success'), error: push('error'), info: push('info') },
  };
});

vi.mock('../components/Toast', () => ({ useToast: () => toastApi }));

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

function group(id: string, extra: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    raw: {
      name: `${id}.ARW`,
      extension: 'ARW',
      path: `D:/shoot/RAW/${id}.ARW`,
      size: 1,
      mtime: 1,
    },
    jpg: {
      name: `${id}.JPG`,
      extension: 'JPG',
      path: `D:/shoot/JPG/${id}.JPG`,
      size: 1,
      mtime: 1,
    },
    status: 'COMPLETE',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: true,
    ...extra,
  };
}

const state = (
  rating: number,
  flag = 'none',
  label = '',
): CullStateSnapshot => ({ rating, flag, label });

/** 一份「什么都没发生」的报告 —— 各用例只覆盖自己关心的那几个字段。 */
const emptyReport = (): XmpRefreshReport => ({
  checked: 0,
  unchanged: 0,
  baselined: 0,
  adopted: [],
  conflicts: [],
  failed: [],
});

/** 捕获 TaskMutex，让用例能把「别的长任务正在跑」造出来。 */
let mutexRef: TaskMutexApi | null = null;
function CaptureMutex() {
  mutexRef = useTaskMutex();
  return null;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <TaskMutexProvider>
    <CaptureMutex />
    {children}
  </TaskMutexProvider>
);

interface SetupOpts {
  groups: PhotoGroupInfo[];
}

function setup(opts: SetupOpts) {
  const patched: Array<{ id: string; patch: Partial<PhotoGroupInfo> }> = [];
  const synced: string[] = [];
  const hook = renderHook(
    () =>
      useXmpRefresh({
        groups: opts.groups,
        onGroupPatched: (id, patch) => patched.push({ id, patch }),
        onSynced: (id) => synced.push(id),
      }),
    { wrapper },
  );
  return { ...hook, patched, synced };
}

const refreshCalls = () => invokeCalls('refresh_from_xmp_cmd');
const resolveCalls = () => invokeCalls('resolve_xmp_conflicts_cmd');

/** 派发一次窗口聚焦并把防抖窗口走完。 */
async function focusAndSettle() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(XMP_REFRESH_DEBOUNCE_MS);
  });
}

/** 直接走手动入口。 */
async function manualRefresh(result: { current: { refreshNow: () => Promise<void> } }) {
  await act(async () => {
    await result.current.refreshNow();
  });
}

beforeEach(() => {
  toastCalls.length = 0;
  mutexRef = null;
  mockInvokeCommand('refresh_from_xmp_cmd', emptyReport());
  mockInvokeCommand('resolve_xmp_conflicts_cmd', { applied: [], failed: [] });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* 触发条件                                                                    */
/* -------------------------------------------------------------------------- */

describe('useXmpRefresh —— 什么时候不发请求', () => {
  it('没有任何照片：聚焦不发 IPC', async () => {
    setup({ groups: [] });
    await focusAndSettle();
    expect(refreshCalls()).toHaveLength(0);
  });

  it('扫描正在跑：聚焦让路（会读到写了一半的 sidecar）', async () => {
    setup({ groups: [group('A')] });
    let release!: () => void;
    act(() => {
      release = mutexRef!.begin('scan');
    });

    await focusAndSettle();
    expect(refreshCalls()).toHaveLength(0);

    act(() => release());
    await focusAndSettle();
    expect(refreshCalls()).toHaveLength(1);
  });

  it('导出正在跑：聚焦同样让路', async () => {
    setup({ groups: [group('A')] });
    let release!: () => void;
    act(() => {
      release = mutexRef!.begin('export');
    });
    await focusAndSettle();
    expect(refreshCalls()).toHaveLength(0);
    act(() => release());
  });

  it('冲突弹窗开着：聚焦不刷新，避免把用户正在看的列表换掉', async () => {
    const { result } = setup({ groups: [group('A')] });
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      conflicts: [{ path: 'D:/shoot/RAW/A.ARW', local: state(5), external: state(1) }],
    });
    await manualRefresh(result);
    expect(result.current.conflicts).toHaveLength(1);

    await focusAndSettle();
    expect(refreshCalls()).toHaveLength(1);
  });

  it('卸载后聚焦不再发 IPC', async () => {
    const { unmount } = setup({ groups: [group('A')] });
    unmount();
    await focusAndSettle();
    expect(refreshCalls()).toHaveLength(0);
  });
});

describe('useXmpRefresh —— 触发与去重', () => {
  it('聚焦一次：发一次，目标与 groupPath 一致（RAW 优先）并带 jpgPath', async () => {
    setup({ groups: [group('A'), group('B')] });
    await focusAndSettle();

    const calls = refreshCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args?.targets).toEqual([
      { path: 'D:/shoot/RAW/A.ARW', jpgPath: 'D:/shoot/JPG/A.JPG' },
      { path: 'D:/shoot/RAW/B.ARW', jpgPath: 'D:/shoot/JPG/B.JPG' },
    ]);
  });

  it('只有 JPG 的分组：主路径退回 JPG，jpgPath 仍是它自己', async () => {
    setup({ groups: [group('J', { raw: undefined, status: 'JPG_ONLY' })] });
    await focusAndSettle();
    expect(refreshCalls()[0].args?.targets).toEqual([
      { path: 'D:/shoot/JPG/J.JPG', jpgPath: 'D:/shoot/JPG/J.JPG' },
    ]);
  });

  it('防抖窗口内连续聚焦只合并成一次', async () => {
    setup({ groups: [group('A')] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(XMP_REFRESH_DEBOUNCE_MS / 3);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(XMP_REFRESH_DEBOUNCE_MS / 3);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(XMP_REFRESH_DEBOUNCE_MS);
    });
    expect(refreshCalls()).toHaveLength(1);
  });

  it('刷新进行中再次聚焦：不开第二份', async () => {
    let resolveFirst!: (v: XmpRefreshReport) => void;
    setInvokeHandler((command) => {
      if (command !== 'refresh_from_xmp_cmd') return undefined;
      return new Promise<XmpRefreshReport>((res) => {
        resolveFirst = res;
      });
    });
    setup({ groups: [group('A')] });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(XMP_REFRESH_DEBOUNCE_MS);
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(XMP_REFRESH_DEBOUNCE_MS);
    });
    expect(refreshCalls()).toHaveLength(1);

    await act(async () => {
      resolveFirst(emptyReport());
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it('同一 tick 内两次手动触发：只发一次（互斥表的占用还没重渲染）', async () => {
    let resolveFirst!: (v: XmpRefreshReport) => void;
    setInvokeHandler((command) => {
      if (command !== 'refresh_from_xmp_cmd') return undefined;
      return new Promise<XmpRefreshReport>((res) => {
        resolveFirst = res;
      });
    });
    const { result } = setup({ groups: [group('A')] });

    await act(async () => {
      // 双击 / 聚焦与点击撞在一起：两次调用都发生在互斥表重渲染之前。
      void result.current.refreshNow();
      void result.current.refreshNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshCalls()).toHaveLength(1);

    await act(async () => {
      resolveFirst(emptyReport());
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it('groups 变了之后聚焦用的是新集合（不是首次渲染的陈旧闭包）', async () => {
    const first = [group('A')];
    const { rerender } = renderHook(
      ({ groups }: { groups: PhotoGroupInfo[] }) =>
        useXmpRefresh({ groups, onGroupPatched: () => {}, onSynced: () => {} }),
      { wrapper, initialProps: { groups: first } },
    );
    rerender({ groups: [group('A'), group('B')] });
    await focusAndSettle();
    expect((refreshCalls()[0].args?.targets as unknown[]).length).toBe(2);
  });

  it('手动入口被互斥挡住：给出原因而不是静默无反应', async () => {
    const { result } = setup({ groups: [group('A')] });
    let release!: () => void;
    act(() => {
      release = mutexRef!.begin('apply-tone');
    });

    await manualRefresh(result);
    expect(refreshCalls()).toHaveLength(0);
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].kind).toBe('info');
    expect(toastCalls[0].message).toContain('套用调色');
    act(() => release());
  });

  it('刷新期间把自己登记进互斥表：导出按钮的禁用原因能看到「读取 XMP」', async () => {
    let resolveFirst!: (v: XmpRefreshReport) => void;
    setInvokeHandler((command) => {
      if (command !== 'refresh_from_xmp_cmd') return undefined;
      return new Promise<XmpRefreshReport>((res) => {
        resolveFirst = res;
      });
    });
    const { result } = setup({ groups: [group('A')] });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(XMP_REFRESH_DEBOUNCE_MS);
    });
    expect(mutexRef!.blockReason('export')).toContain('读取 XMP');

    await act(async () => {
      resolveFirst(emptyReport());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mutexRef!.blockReason('export')).toBeNull();
    expect(result.current.refreshing).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 结果落地                                                                    */
/* -------------------------------------------------------------------------- */

describe('useXmpRefresh —— 结果落地', () => {
  it('只有 baselined / unchanged：一句话都不说（升级用户首次刷新不刷屏）', async () => {
    mockInvokeCommand('refresh_from_xmp_cmd', {
      checked: 10000,
      unchanged: 0,
      baselined: 10000,
      adopted: [],
      conflicts: [],
      failed: [],
    });
    const { result, patched } = setup({ groups: [group('A')] });
    await manualRefresh(result);

    expect(toastCalls).toHaveLength(0);
    expect(patched).toHaveLength(0);
    expect(result.current.conflicts).toBeNull();
  });

  it('adopted：按路径回填星级/旗标/色标，并清掉未同步角标', async () => {
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      checked: 1,
      adopted: [
        {
          path: 'd:/shoot/raw/a.arw', // 大小写 + 分隔符都不同，仍是同一张
          state: state(4, 'pick', 'Red'),
          sidecarRemoved: false,
        },
      ],
    });
    const { result, patched, synced } = setup({ groups: [group('A')] });
    await manualRefresh(result);

    expect(patched).toEqual([
      { id: 'A', patch: { rating: 4, flag: 'pick', label: 'Red' } },
    ]);
    expect(synced).toEqual(['A']);
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].kind).toBe('info');
    expect(toastCalls[0].message).toContain('已从 XMP 更新 1 张');
  });

  it('侧边栏被外部删除：值被清空，并单独提示一句', async () => {
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      adopted: [
        {
          path: 'D:/shoot/RAW/A.ARW',
          state: state(0, 'none', ''),
          sidecarRemoved: true,
        },
      ],
    });
    const { result, patched } = setup({ groups: [group('A', { rating: 5, label: 'Blue' })] });
    await manualRefresh(result);

    expect(patched[0].patch).toEqual({ rating: 0, flag: 'none', label: '' });
    expect(toastCalls[0].message).toContain('侧边栏');
    expect(toastCalls[0].message).toContain('删除');
  });

  it('adopted 与 conflicts 同时出现：一句话说清两件事', async () => {
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      adopted: [
        { path: 'D:/shoot/RAW/A.ARW', state: state(3), sidecarRemoved: false },
        { path: 'D:/shoot/RAW/B.ARW', state: state(2), sidecarRemoved: false },
      ],
      conflicts: [
        { path: 'D:/shoot/RAW/C.ARW', local: state(5), external: state(1) },
      ],
    });
    const { result } = setup({ groups: [group('A'), group('B'), group('C')] });
    await manualRefresh(result);

    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].message).toContain('已从 XMP 更新 2 张');
    expect(toastCalls[0].message).toContain('1 张有冲突待处理');
    expect(result.current.conflicts).toHaveLength(1);
    expect(result.current.conflicts![0].local.rating).toBe(5);
    expect(result.current.conflicts![0].external.rating).toBe(1);
  });

  it('读失败的路径：报错，但不妨碍已经读到的那几张回填', async () => {
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      adopted: [
        { path: 'D:/shoot/RAW/A.ARW', state: state(3), sidecarRemoved: false },
      ],
      failed: ['D:/shoot/RAW/B.ARW'],
    });
    const { result, patched } = setup({ groups: [group('A'), group('B')] });
    await manualRefresh(result);

    expect(patched).toHaveLength(1);
    expect(toastCalls.some((c) => c.kind === 'error')).toBe(true);
    expect(toastCalls.find((c) => c.kind === 'error')!.message).toContain('B.ARW');
  });

  it('IPC 抛错：报错并复位 refreshing，不会卡在「读取中」', async () => {
    mockInvokeError('refresh_from_xmp_cmd', new Error('E_BUSY: 正在导出照片'));
    const { result } = setup({ groups: [group('A')] });
    await manualRefresh(result);

    expect(result.current.refreshing).toBe(false);
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].kind).toBe('error');
    expect(toastCalls[0].message).toContain('E_BUSY');
  });

  it('后端给出类型之外的旗标：落到界面时收口成「无」，不污染筛选与快捷键', async () => {
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      adopted: [
        // `Green` 是旧版 xmp:Label 的取值，不是旗标。真出现时不能当 pick 用。
        { path: 'D:/shoot/RAW/A.ARW', state: state(3, 'Green'), sidecarRemoved: false },
      ],
    });
    const { result, patched } = setup({ groups: [group('A')] });
    await manualRefresh(result);

    expect(patched[0].patch.flag).toBe('none');
  });

  it('分组已不在集合里（扫描期间被删）：跳过回填，不抛错', async () => {
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      adopted: [
        { path: 'D:/shoot/RAW/GONE.ARW', state: state(3), sidecarRemoved: false },
      ],
    });
    const { result, patched } = setup({ groups: [group('A')] });
    await manualRefresh(result);
    expect(patched).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 裁决                                                                        */
/* -------------------------------------------------------------------------- */

const CONFLICTS = [
  { path: 'D:/shoot/RAW/A.ARW', local: state(5, 'pick'), external: state(1) },
  { path: 'D:/shoot/RAW/B.ARW', local: state(4), external: state(2, 'reject') },
];

async function openWithConflicts(groups = [group('A'), group('B')]) {
  mockInvokeCommand('refresh_from_xmp_cmd', {
    ...emptyReport(),
    conflicts: CONFLICTS,
  });
  const ctx = setup({ groups });
  await manualRefresh(ctx.result);
  expect(ctx.result.current.conflicts).toHaveLength(2);
  return ctx;
}

describe('useXmpRefresh —— 裁决', () => {
  it('keep-local 原样提交，不回传 external；没提交的那几张留在弹窗里', async () => {
    const { result } = await openWithConflicts();
    mockInvokeCommand('resolve_xmp_conflicts_cmd', {
      applied: [{ path: 'D:/shoot/RAW/A.ARW', state: state(5, 'pick'), sidecarRemoved: false }],
      failed: [],
    });
    toastCalls.length = 0;

    const choices: XmpConflictChoice[] = [{ path: 'D:/shoot/RAW/A.ARW', action: 'keep-local' }];
    await act(async () => {
      await result.current.resolveConflicts(choices);
    });

    expect(resolveCalls()[0].args?.choices).toEqual([
      { path: 'D:/shoot/RAW/A.ARW', action: 'keep-local' },
    ]);
    // 只提交了一张 → 另一张仍在弹窗里，且提示的是「还有 1 张」而不是「完成」
    expect(result.current.conflicts).toHaveLength(1);
    expect(result.current.conflicts![0].path).toBe('D:/shoot/RAW/B.ARW');
    expect(toastCalls[0].kind).toBe('info');
    expect(toastCalls[0].message).toContain('还有 1 张待裁决');
  });

  it('use-external 把弹窗里显示的外部值一并回传（后端据此推进游标，不重读磁盘）', async () => {
    const { result } = await openWithConflicts();
    mockInvokeCommand('resolve_xmp_conflicts_cmd', {
      applied: [{ path: 'D:/shoot/RAW/B.ARW', state: state(2, 'reject'), sidecarRemoved: false }],
      failed: [],
    });

    await act(async () => {
      await result.current.resolveConflicts([
        {
          path: 'D:/shoot/RAW/B.ARW',
          action: 'use-external',
          external: state(2, 'reject'),
        },
      ]);
    });

    expect(resolveCalls()[0].args?.choices).toEqual([
      {
        path: 'D:/shoot/RAW/B.ARW',
        action: 'use-external',
        external: { rating: 2, flag: 'reject', label: '' },
      },
    ]);
  });

  it('全部裁决成功：弹窗关闭、applied 回填界面、给一句成功提示', async () => {
    const { result, patched, synced } = await openWithConflicts();
    mockInvokeCommand('resolve_xmp_conflicts_cmd', {
      applied: [
        { path: 'D:/shoot/RAW/A.ARW', state: state(5, 'pick'), sidecarRemoved: false },
        { path: 'D:/shoot/RAW/B.ARW', state: state(2, 'reject'), sidecarRemoved: false },
      ],
      failed: [],
    });
    toastCalls.length = 0;

    await act(async () => {
      await result.current.resolveConflicts([
        { path: 'D:/shoot/RAW/A.ARW', action: 'keep-local' },
        { path: 'D:/shoot/RAW/B.ARW', action: 'use-external', external: state(2, 'reject') },
      ]);
    });

    expect(result.current.conflicts).toBeNull();
    expect(patched).toEqual([
      { id: 'A', patch: { rating: 5, flag: 'pick', label: '' } },
      { id: 'B', patch: { rating: 2, flag: 'reject', label: '' } },
    ]);
    expect(synced).toEqual(['A', 'B']);
    expect(toastCalls[0].kind).toBe('success');
  });

  it('部分失败：失败的那几条留在弹窗里（可以再选一次），成功的移除', async () => {
    const { result } = await openWithConflicts();
    mockInvokeCommand('resolve_xmp_conflicts_cmd', {
      applied: [{ path: 'D:/shoot/RAW/A.ARW', state: state(5, 'pick'), sidecarRemoved: false }],
      failed: [{ path: 'D:/shoot/RAW/B.ARW', message: '拒绝访问 (os error 5)' }],
    });
    toastCalls.length = 0;

    await act(async () => {
      await result.current.resolveConflicts([
        { path: 'D:/shoot/RAW/A.ARW', action: 'keep-local' },
        { path: 'D:/shoot/RAW/B.ARW', action: 'keep-local' },
      ]);
    });

    expect(result.current.conflicts).toHaveLength(1);
    expect(result.current.conflicts![0].path).toBe('D:/shoot/RAW/B.ARW');
    expect(toastCalls[0].kind).toBe('error');
    expect(toastCalls[0].message).toContain('拒绝访问');
  });

  it('裁决 IPC 抛错：弹窗保持原样，不假装成功', async () => {
    const { result } = await openWithConflicts();
    mockInvokeError('resolve_xmp_conflicts_cmd', new Error('E_BUSY: 正在扫描照片'));
    toastCalls.length = 0;

    await act(async () => {
      await result.current.resolveConflicts([
        { path: 'D:/shoot/RAW/A.ARW', action: 'keep-local' },
      ]);
    });

    expect(result.current.conflicts).toHaveLength(2);
    expect(result.current.resolving).toBe(false);
    expect(toastCalls[0].kind).toBe('error');
  });

  it('裁决进行中重复提交：只发一次', async () => {
    const { result } = await openWithConflicts();
    let resolveOnce!: (v: unknown) => void;
    setInvokeHandler((command) => {
      if (command !== 'resolve_xmp_conflicts_cmd') return undefined;
      return new Promise((res) => {
        resolveOnce = res;
      });
    });

    await act(async () => {
      void result.current.resolveConflicts([
        { path: 'D:/shoot/RAW/A.ARW', action: 'keep-local' },
      ]);
      void result.current.resolveConflicts([
        { path: 'D:/shoot/RAW/B.ARW', action: 'keep-local' },
      ]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(resolveCalls()).toHaveLength(1);

    await act(async () => {
      resolveOnce({ applied: [], failed: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it('关掉弹窗：清空待裁决，一个字节都不写', async () => {
    const { result } = await openWithConflicts();
    act(() => result.current.dismissConflicts());

    expect(result.current.conflicts).toBeNull();
    expect(resolveCalls()).toHaveLength(0);
  });

  it('空选择直接返回，不发空请求', async () => {
    const { result } = await openWithConflicts();
    await act(async () => {
      await result.current.resolveConflicts([]);
    });
    expect(resolveCalls()).toHaveLength(0);
    expect(result.current.conflicts).toHaveLength(2);
  });
});
