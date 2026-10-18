/**
 * FR-10 前端：选片集的保存与打开 —— 边界优先。
 *
 * 这里盯的是「什么时候**不该**做事」，因为每一条都会安静地毁掉用户的东西：
 * - 打开失败却清了当前集合 → 一次打不开的选片集换一次数据丢失；
 * - 保存 0 张仍弹对话框 → 用户存出一个空选片集，还以为成功了；
 * - 被互斥挡住却静默返回 → 按钮像坏了；
 * - 保存后把 `path` 标成选片集 → 顶栏目录框与照片列表互相矛盾。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { TaskMutexProvider, useTaskMutex, type TaskMutexApi } from './useTaskMutex';
import { useAlbum } from './useAlbum';
import { invokeCalls, mockInvokeCommand, mockInvokeError } from '../test/setup';
import type { AlbumItemInput, AlbumOpenResult, AlbumResolvedDoc } from '../types';
import type { AlbumLoad } from '../utils/albumGroups';

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

const saveMock = vi.mocked(saveDialog);
const openMock = vi.mocked(openDialog);

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

function doc(over: Partial<AlbumResolvedDoc> = {}): AlbumResolvedDoc {
  return {
    source: 'a.ARW',
    path: 'D:/shoot/raw/a.ARW',
    exists: true,
    isRaw: true,
    size: 10,
    mtime: 100,
    jpgPath: null,
    jpgExists: false,
    jpgSize: 0,
    jpgMtime: 0,
    hasXmp: false,
    tone: null,
    rating: 0,
    flag: 'none',
    label: '',
    ...over,
  };
}

function openResult(entries: AlbumResolvedDoc[], missing = 0): AlbumOpenResult {
  return { path: 'D:/shoot/pick.galleryalbum', entries, missing };
}

const ITEMS: AlbumItemInput[] = [
  { path: 'D:/shoot/a.ARW', jpgPath: 'D:/shoot/a.JPG', rating: 5, flag: 'pick', label: 'Red' },
];

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

function setup() {
  const loaded: { load: AlbumLoad; path: string }[] = [];
  const hook = renderHook(
    () => useAlbum({ onLoaded: (load, path) => loaded.push({ load, path }) }),
    { wrapper },
  );
  return { ...hook, loaded };
}

/** 最后一条 toast（`Array.prototype.at` 不在本项目的 TS lib 里）。 */
const lastToast = () => toastCalls[toastCalls.length - 1];

const saveCalls = () => invokeCalls('save_album_cmd');
const openCalls = () => invokeCalls('open_album_cmd');

beforeEach(() => {
  toastCalls.length = 0;
  mutexRef = null;
  saveMock.mockReset();
  saveMock.mockResolvedValue(null);
  openMock.mockReset();
  openMock.mockResolvedValue(null);
});

/* -------------------------------------------------------------------------- */

describe('useAlbum —— 保存', () => {
  it('成功后原样传 items，并说清存了多少张', async () => {
    mockInvokeCommand('save_album_cmd', { path: 'D:/shoot/pick.galleryalbum', saved: 1 });
    saveMock.mockResolvedValueOnce('D:/shoot/pick.galleryalbum');
    const { result } = setup();

    let ok = false;
    await act(async () => {
      ok = await result.current.saveAs(ITEMS);
    });

    expect(ok).toBe(true);
    expect(saveCalls()).toHaveLength(1);
    expect(saveCalls()[0].args).toMatchObject({ path: 'D:/shoot/pick.galleryalbum', items: ITEMS });
    expect(lastToast()).toMatchObject({ kind: 'success' });
    expect(lastToast()?.message).toContain('1 张');
  });

  it('保存成功不把自己标成「正在看选片集」', async () => {
    mockInvokeCommand('save_album_cmd', { path: 'D:/shoot/pick.galleryalbum', saved: 1 });
    saveMock.mockResolvedValueOnce('D:/shoot/pick.galleryalbum');
    const { result } = setup();

    await act(async () => {
      await result.current.saveAs(ITEMS);
    });

    // 用户此刻看的仍是原来的目录，标成选片集会让顶栏目录框与列表互相矛盾
    expect(result.current.path).toBeNull();
  });

  it('用户取消对话框 → 一个请求都不发，也不提示（取消不是错误）', async () => {
    saveMock.mockResolvedValueOnce(null);
    const { result } = setup();

    let ok = true;
    await act(async () => {
      ok = await result.current.saveAs(ITEMS);
    });

    expect(ok).toBe(false);
    expect(saveCalls()).toHaveLength(0);
    expect(toastCalls).toHaveLength(0);
  });

  it('没有照片时不弹对话框，直接说明原因', async () => {
    const { result } = setup();

    let ok = true;
    await act(async () => {
      ok = await result.current.saveAs([]);
    });

    expect(ok).toBe(false);
    expect(saveMock).not.toHaveBeenCalled();
    expect(toastCalls[0]).toMatchObject({ kind: 'info' });
  });

  it('写盘失败 → 报错，返回 false', async () => {
    saveMock.mockResolvedValueOnce('D:/shoot/pick.galleryalbum');
    mockInvokeError('save_album_cmd', new Error('磁盘已满'));
    const { result } = setup();

    let ok = true;
    await act(async () => {
      ok = await result.current.saveAs(ITEMS);
    });

    expect(ok).toBe(false);
    expect(lastToast()).toMatchObject({ kind: 'error' });
    expect(lastToast()?.message).toContain('磁盘已满');
  });

  it('扫描进行中时挡住，并给出原因（不是静默返回）', async () => {
    const { result } = setup();
    act(() => {
      mutexRef!.begin('scan');
    });

    let ok = true;
    await act(async () => {
      ok = await result.current.saveAs(ITEMS);
    });

    expect(ok).toBe(false);
    expect(saveMock).not.toHaveBeenCalled();
    expect(toastCalls[0]).toMatchObject({ kind: 'info' });
    expect(toastCalls[0]?.message).toContain('扫描照片');
  });
});

describe('useAlbum —— 打开', () => {
  it('成功后把集合与调色基线交给宿主，并记住来源路径', async () => {
    mockInvokeCommand('open_album_cmd', openResult([doc()]));
    openMock.mockResolvedValueOnce('D:/shoot/pick.galleryalbum');
    const { result, loaded } = setup();

    await act(async () => {
      await result.current.open();
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].path).toBe('D:/shoot/pick.galleryalbum');
    expect(loaded[0].load.groups).toHaveLength(1);
    expect(result.current.path).toBe('D:/shoot/pick.galleryalbum');
    expect(result.current.report).toBeNull();
    expect(lastToast()).toMatchObject({ kind: 'success' });
  });

  it('有缺失项时把报告留在屏幕上（缺失要列得出来）', async () => {
    mockInvokeCommand(
      'open_album_cmd',
      openResult([doc(), doc({ path: 'D:/shoot/gone.ARW', exists: false, source: 'gone.ARW' })], 1),
    );
    openMock.mockResolvedValueOnce('D:/shoot/pick.galleryalbum');
    const { result, loaded } = setup();

    let res: AlbumOpenResult | null = null;
    await act(async () => {
      res = await result.current.open();
    });

    expect(res!.missing).toBe(1);
    expect(result.current.report?.missing).toBe(1);
    expect(loaded[0].load.groups).toHaveLength(1);
    expect(loaded[0].load.missing[0].source).toBe('gone.ARW');
    expect(lastToast()?.message).toContain('1 张找不到');
  });

  it('打开失败不动当前集合（一次打不开的选片集不该换一次数据丢失）', async () => {
    openMock.mockResolvedValueOnce('D:/shoot/broken.galleryalbum');
    mockInvokeError('open_album_cmd', new Error('不是本应用的选片集'));
    const { result, loaded } = setup();

    let res: AlbumOpenResult | null = null;
    await act(async () => {
      res = await result.current.open();
    });

    expect(res).toBeNull();
    expect(loaded).toHaveLength(0);
    expect(result.current.path).toBeNull();
    expect(result.current.report).toBeNull();
    expect(lastToast()).toMatchObject({ kind: 'error' });
  });

  it('取消对话框 → 不调命令、不提示', async () => {
    openMock.mockResolvedValueOnce(null);
    const { result } = setup();

    await act(async () => {
      await result.current.open();
    });

    expect(openCalls()).toHaveLength(0);
    expect(toastCalls).toHaveLength(0);
  });

  it('被互斥挡住时说明原因，不弹对话框', async () => {
    const { result } = setup();
    act(() => {
      mutexRef!.begin('export');
    });

    await act(async () => {
      await result.current.open();
    });

    expect(openMock).not.toHaveBeenCalled();
    expect(toastCalls[0]?.message).toContain('导出照片');
  });

  it('dismissReport 只清报告，不影响来源路径', async () => {
    mockInvokeCommand('open_album_cmd', openResult([doc()], 1));
    openMock.mockResolvedValueOnce('D:/shoot/pick.galleryalbum');
    const { result } = setup();
    await act(async () => {
      await result.current.open();
    });
    expect(result.current.report).not.toBeNull();

    act(() => result.current.dismissReport());
    await waitFor(() => expect(result.current.report).toBeNull());
    expect(result.current.path).toBe('D:/shoot/pick.galleryalbum');
  });

  it('clear() 清掉选片集身份（扫描换数据源时用）', async () => {
    mockInvokeCommand('open_album_cmd', openResult([doc()], 1));
    openMock.mockResolvedValueOnce('D:/shoot/pick.galleryalbum');
    const { result } = setup();
    await act(async () => {
      await result.current.open();
    });

    act(() => result.current.clear());
    await waitFor(() => expect(result.current.path).toBeNull());
    expect(result.current.report).toBeNull();
  });
});
