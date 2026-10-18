/**
 * FR-11 前端：Lightroom 目录导入 —— 边界优先。
 *
 * 盯的是「什么时候不该做事」和「参数传对了没有」：
 * - 没扫描就导入 → 无意义（没有可对齐的目标），要解释而不是弹对话框；
 * - 只读当前目录 → LR 库常有几万张，全量读回来既慢又没法用；
 * - 默认只填空白 → 覆盖用户在 LR 之外做的判断是不可逆的；
 * - 单张失败不连坐 → 一张坏 XMP 不该让剩下 300 张都不导；
 * - 写盘走 `update_rating_flag_cmd` 且 `coalesce=false` → 与手动评级同一条落盘路径。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { TaskMutexProvider, useTaskMutex, type TaskMutexApi } from './useTaskMutex';
import { useLrcatImport } from './useLrcatImport';
import { invokeCalls, mockInvokeCommand, mockInvokeError } from '../test/setup';
import type { LrcatPhoto, LrcatReadResult, PhotoGroupInfo } from '../types';

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

const openMock = vi.mocked(openDialog);

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

function group(base: string, over: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id: `D:/shoot/${base}`,
    baseName: base,
    raw: { name: `${base}.ARW`, extension: 'ARW', path: `D:/shoot/${base}.ARW`, size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: false,
    ...over,
  } as PhotoGroupInfo;
}

function photo(over: Partial<LrcatPhoto> = {}): LrcatPhoto {
  return { path: 'D:/shoot/A.ARW', rating: 0, flag: 'none', label: '', ...over };
}

function readResult(photos: LrcatPhoto[], over: Partial<LrcatReadResult> = {}): LrcatReadResult {
  return {
    catalog: 'D:/LR/Lightroom Catalog.lrcat',
    photos,
    skippedVirtual: 0,
    total: photos.length,
    copied: false,
    ...over,
  };
}

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

function setup(groups: PhotoGroupInfo[] = [group('A'), group('B', { rating: 3 })]) {
  const patched: { id: string; patch: Partial<PhotoGroupInfo> }[] = [];
  const hook = renderHook(
    () =>
      useLrcatImport({
        groups,
        onGroupPatched: (id, patch) => patched.push({ id, patch }),
      }),
    { wrapper },
  );
  return { ...hook, patched };
}

const lastToast = () => toastCalls[toastCalls.length - 1];
const readCalls = () => invokeCalls('read_lrcat_cmd');
const writeCalls = () => invokeCalls('update_rating_flag_cmd');

beforeEach(() => {
  toastCalls.length = 0;
  mutexRef = null;
  openMock.mockReset();
  openMock.mockResolvedValue(null);
});

/* -------------------------------------------------------------------------- */

describe('useLrcatImport —— 读取', () => {
  it('没扫描目录时先说明原因，不弹文件对话框', async () => {
    const { result } = setup([]);
    let ok = true;
    await act(async () => {
      ok = await result.current.pick();
    });
    expect(ok).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
    expect(readCalls()).toHaveLength(0);
    expect(lastToast()?.message).toContain('先扫描');
  });

  it('对话框取消是静默的', async () => {
    openMock.mockResolvedValueOnce(null);
    const { result } = setup();
    let ok = true;
    await act(async () => {
      ok = await result.current.pick();
    });
    expect(ok).toBe(false);
    expect(readCalls()).toHaveLength(0);
    expect(toastCalls).toHaveLength(0);
  });

  it('只把当前集合涉及的目录传给后端（去重）', async () => {
    openMock.mockResolvedValueOnce('D:/LR/Lightroom Catalog.lrcat');
    mockInvokeCommand('read_lrcat_cmd', readResult([photo({ rating: 5 })]));
    const { result } = setup();

    await act(async () => {
      await result.current.pick();
    });

    expect(readCalls()).toHaveLength(1);
    expect(readCalls()[0].args).toMatchObject({
      path: 'D:/LR/Lightroom Catalog.lrcat',
      folders: ['D:/shoot'],
    });
  });

  it('读到 0 张时解释「只对齐当前目录」，不让用户以为 LR 是空的', async () => {
    openMock.mockResolvedValueOnce('D:/LR/Lightroom Catalog.lrcat');
    mockInvokeCommand('read_lrcat_cmd', readResult([]));
    const { result } = setup();

    await act(async () => {
      await result.current.pick();
    });

    expect(lastToast()).toMatchObject({ kind: 'info' });
    expect(lastToast()?.message).toContain('当前文件夹');
    expect(result.current.plan?.items).toHaveLength(0);
  });

  it('读失败时不留半截报告', async () => {
    openMock.mockResolvedValueOnce('D:/LR/Lightroom Catalog.lrcat');
    mockInvokeError('read_lrcat_cmd', new Error('database is locked'));
    const { result } = setup();

    await act(async () => {
      await result.current.pick();
    });

    expect(lastToast()).toMatchObject({ kind: 'error' });
    expect(result.current.report).toBeNull();
    expect(result.current.plan).toBeNull();
  });

  it('读成功后 plan 能对上（报告与按钮都靠它）', async () => {
    openMock.mockResolvedValueOnce('D:/LR/Lightroom Catalog.lrcat');
    mockInvokeCommand(
      'read_lrcat_cmd',
      readResult([photo({ rating: 5, flag: 'pick' }), photo({ path: 'D:/shoot/GONE.ARW' })]),
    );
    const { result } = setup();

    await act(async () => {
      await result.current.pick();
    });

    await waitFor(() => expect(result.current.plan).not.toBeNull());
    expect(result.current.plan?.items).toHaveLength(1);
    expect(result.current.plan?.unmatched).toHaveLength(1);
    expect(result.current.report?.catalog).toContain('Lightroom Catalog.lrcat');
  });
});

describe('useLrcatImport —— 写盘', () => {
  async function readThenApply(
    result: { current: ReturnType<typeof useLrcatImport> },
    overwrite: boolean,
  ) {
    openMock.mockResolvedValueOnce('D:/LR/Lightroom Catalog.lrcat');
    mockInvokeCommand(
      'read_lrcat_cmd',
      readResult([
        photo({ path: 'D:/shoot/A.ARW', rating: 5, flag: 'pick', label: 'Red' }),
        photo({ path: 'D:/shoot/B.ARW', rating: 1 }),
      ]),
    );
    await act(async () => {
      await result.current.pick();
    });
    let written = 0;
    await act(async () => {
      written = await result.current.apply(overwrite);
    });
    return written;
  }

  it('默认只填空白组，写盘参数是整组状态且不等合并窗口', async () => {
    mockInvokeCommand('update_rating_flag_cmd', true);
    const { result, patched } = setup();
    const written = await readThenApply(result, false);

    expect(written).toBe(1);
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0].args).toMatchObject({
      filePath: 'D:/shoot/A.ARW',
      rating: 5,
      flag: 'pick',
      label: 'Red',
      syncXmp: true,
      coalesce: false,
    });
    expect(patched).toEqual([
      { id: 'D:/shoot/A', patch: { rating: 5, flag: 'pick', label: 'Red' } },
    ]);
  });

  it('勾了覆盖就两张都写', async () => {
    mockInvokeCommand('update_rating_flag_cmd', true);
    const { result } = setup();
    const written = await readThenApply(result, true);

    expect(written).toBe(2);
    expect(writeCalls().map((c) => (c.args as { filePath: string }).filePath)).toEqual([
      'D:/shoot/A.ARW',
      'D:/shoot/B.ARW',
    ]);
  });

  it('单张失败不连坐，失败项带上路径与原因', async () => {
    mockInvokeCommand('update_rating_flag_cmd', (args) => {
      const a = args as { filePath: string };
      if (a.filePath.includes('A.ARW')) throw new Error('sidecar 只读');
      return true;
    });
    const { result, patched } = setup();
    const written = await readThenApply(result, true);

    expect(written).toBe(1);
    expect(patched.map((p) => p.id)).toEqual(['D:/shoot/B']);
    expect(result.current.failures).toEqual([
      { name: 'A', path: 'D:/shoot/A.ARW', reason: expect.stringContaining('sidecar 只读') },
    ]);
    expect(lastToast()).toMatchObject({ kind: 'error' });
    // 有失败时保留报告，让用户能看着失败列表处理。
    expect(result.current.plan).not.toBeNull();
  });

  it('全部成功后收起报告（导入是一次性动作）', async () => {
    mockInvokeCommand('update_rating_flag_cmd', true);
    const { result } = setup();
    await readThenApply(result, true);

    expect(result.current.report).toBeNull();
    expect(result.current.plan).toBeNull();
    expect(lastToast()).toMatchObject({ kind: 'success' });
  });

  it('被互斥挡住时解释原因，不写盘', async () => {
    mockInvokeCommand('update_rating_flag_cmd', true);
    const { result } = setup();
    openMock.mockResolvedValueOnce('D:/LR/Lightroom Catalog.lrcat');
    mockInvokeCommand('read_lrcat_cmd', readResult([photo({ rating: 5 })]));
    await act(async () => {
      await result.current.pick();
    });

    // 另一个活动占着写盘
    act(() => {
      mutexRef!.begin('scan');
    });
    let written = 1;
    await act(async () => {
      written = await result.current.apply(false);
    });

    expect(written).toBe(0);
    expect(writeCalls()).toHaveLength(0);
    expect(lastToast()).toMatchObject({ kind: 'info' });
  });

  it('没有可写项时说清「已有判断，勾覆盖才会改」', async () => {
    const { result } = setup([group('B', { rating: 3 })]);
    openMock.mockResolvedValueOnce('D:/LR/Lightroom Catalog.lrcat');
    mockInvokeCommand('read_lrcat_cmd', readResult([photo({ path: 'D:/shoot/B.ARW', rating: 5 })]));
    await act(async () => {
      await result.current.pick();
    });
    let written = 1;
    await act(async () => {
      written = await result.current.apply(false);
    });

    expect(written).toBe(0);
    expect(writeCalls()).toHaveLength(0);
    expect(lastToast()?.message).toContain('覆盖');
  });

  it('取消后不再写剩下的，已写的保留', async () => {
    let resolveFirst: (v: boolean) => void = () => {};
    mockInvokeCommand('update_rating_flag_cmd', () => {
      if (writeCalls().length === 1) {
        return new Promise<boolean>((r) => {
          resolveFirst = r;
        });
      }
      return true;
    });
    const { result } = setup();
    openMock.mockResolvedValueOnce('D:/LR/Lightroom Catalog.lrcat');
    mockInvokeCommand(
      'read_lrcat_cmd',
      readResult([
        photo({ path: 'D:/shoot/A.ARW', rating: 5 }),
        photo({ path: 'D:/shoot/B.ARW', rating: 4 }),
      ]),
    );
    await act(async () => {
      await result.current.pick();
    });

    let done: Promise<number> | null = null;
    act(() => {
      done = result.current.apply(true);
    });
    // 第一张在飞时取消
    await act(async () => {
      result.current.cancel();
      resolveFirst(true);
      await done;
    });

    expect(writeCalls()).toHaveLength(1);
    expect(lastToast()?.message).toContain('已取消');
  });
});
