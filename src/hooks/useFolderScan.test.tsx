/**
 * #66「选一个目录就够了」的前端判定表。
 *
 * 锁三件事：
 * 1. probe 的四种模式如何映射到 JPG / RAW 两个源（空目录绝不清空用户已有路径）；
 * 2. 手动编辑任一输入框会清掉「自动识别」标记（不能让标记与手填配置自相矛盾）；
 * 3. 扫描结果会反填识别状态 —— 手填路径也能看到「这次到底扫到了什么」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';
import { useFolderScan } from './useFolderScan';
import { mockInvokeCommand } from '../test/setup';
import type { FolderProbe, PhotoGroupInfo } from '../types';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  message: vi.fn(async () => undefined),
  confirm: vi.fn(async () => false),
}));

const opts = () => ({
  onScanned: vi.fn(),
  persistFolders: vi.fn(),
});

const chooseFolder = (path: string) => {
  vi.mocked(open).mockResolvedValueOnce(path);
};

const probe = (mode: FolderProbe['mode'], extra: Partial<FolderProbe> = {}): FolderProbe => ({
  mode,
  jpgCount: mode === 'jpg_only' || mode === 'mixed' ? 12 : 0,
  rawCount: mode === 'raw_only' || mode === 'mixed' ? 4 : 0,
  subdirCount: 0,
  ...extra,
});

const file = (name: string) => ({
  name,
  extension: name.split('.').pop()!.toLowerCase(),
  path: name,
  size: 1,
  mtime: 1,
});

const group = (id: string, status: PhotoGroupInfo['status']): PhotoGroupInfo => ({
  id,
  baseName: id,
  status,
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
  ...(status !== 'RAW_ONLY' ? { jpg: file(`${id}.jpg`) } : {}),
  ...(status !== 'JPG_ONLY' ? { raw: file(`${id}.nef`) } : {}),
});

afterEach(() => {
  vi.mocked(open).mockReset();
  vi.mocked(open).mockResolvedValue(null);
});

describe('useFolderScan —— 单目录自动识别', () => {
  it('混合目录：两个源都填同一路径', async () => {
    const o = opts();
    mockInvokeCommand('probe_folder_cmd', probe('mixed'));
    chooseFolder('D:/shoot');
    const { result } = renderHook(() => useFolderScan(o));

    await act(async () => {
      await result.current.handleBrowseAuto();
    });

    expect(result.current.jpgFolder).toBe('D:/shoot');
    expect(result.current.rawFolder).toBe('D:/shoot');
    expect(result.current.folderDetection).toMatchObject({ mode: 'mixed', jpgCount: 12, rawCount: 4 });
  });

  it('纯 JPG 目录：只看 JPG，RAW 保持为空', async () => {
    const o = opts();
    mockInvokeCommand('probe_folder_cmd', probe('jpg_only'));
    chooseFolder('D:/shoot/jpg');
    const { result } = renderHook(() => useFolderScan(o));

    await act(async () => {
      await result.current.handleBrowseAuto();
    });

    expect(result.current.jpgFolder).toBe('D:/shoot/jpg');
    expect(result.current.rawFolder).toBe('');
    expect(result.current.folderDetection?.mode).toBe('jpg_only');
  });

  it('纯 RAW 目录：同一路径同时填入两个源', async () => {
    const o = opts();
    mockInvokeCommand('probe_folder_cmd', probe('raw_only'));
    chooseFolder('D:/shoot/raw');
    const { result } = renderHook(() => useFolderScan(o));

    await act(async () => {
      await result.current.handleBrowseAuto();
    });

    expect(result.current.jpgFolder).toBe('D:/shoot/raw');
    expect(result.current.rawFolder).toBe('D:/shoot/raw');
    expect(result.current.folderDetection?.mode).toBe('raw_only');
  });

  it('空目录：不改动已有路径，只把「空目录」标出来', async () => {
    const o = opts();
    mockInvokeCommand('probe_folder_cmd', probe('empty'));
    chooseFolder('D:/empty');

    const { result } = renderHook(() => useFolderScan(o));
    act(() => result.current.setJpgFolder('D:/kept'));
    act(() => result.current.setRawFolder('D:/kept/raw'));

    await act(async () => {
      await result.current.handleBrowseAuto();
    });

    expect(result.current.jpgFolder).toBe('D:/kept');
    expect(result.current.rawFolder).toBe('D:/kept/raw');
    expect(result.current.folderDetection?.mode).toBe('empty');
  });

  it('识别失败（目录不存在/无权限）时路径不变，也不留下假的识别标记', async () => {
    const o = opts();
    mockInvokeCommand('probe_folder_cmd', () => {
      throw new Error('RAW 文件夹不存在');
    });
    chooseFolder('D:/missing');

    const { result } = renderHook(() => useFolderScan(o));
    act(() => result.current.setJpgFolder('D:/kept'));

    await act(async () => {
      await result.current.handleBrowseAuto();
    });

    expect(result.current.jpgFolder).toBe('D:/kept');
    expect(result.current.folderDetection).toBeNull();
  });

  it('手动编辑任一输入框会清掉自动识别标记', async () => {
    const o = opts();
    mockInvokeCommand('probe_folder_cmd', probe('mixed'));
    chooseFolder('D:/shoot');
    const { result } = renderHook(() => useFolderScan(o));

    await act(async () => {
      await result.current.handleBrowseAuto();
    });
    expect(result.current.folderDetection).not.toBeNull();

    act(() => result.current.handleJpgFolderChange('D:/manual/jpg'));
    expect(result.current.folderDetection).toBeNull();

    act(() => result.current.handleRawFolderChange('D:/manual/raw'));
    expect(result.current.folderDetection).toBeNull();
  });

  it('用输入框内的浏览按钮换目录也会清掉自动识别标记', async () => {
    const o = opts();
    mockInvokeCommand('probe_folder_cmd', probe('mixed'));
    chooseFolder('D:/shoot');
    const { result } = renderHook(() => useFolderScan(o));

    await act(async () => {
      await result.current.handleBrowseAuto();
    });
    expect(result.current.folderDetection).not.toBeNull();

    chooseFolder('D:/other');
    await act(async () => {
      await result.current.handleBrowseJpg();
    });

    expect(result.current.jpgFolder).toBe('D:/other');
    expect(result.current.folderDetection).toBeNull();
  });

  it('扫描结果反填识别状态：混合目录即使手填也能看到 JPG/RAW 两侧', async () => {
    const o = opts();
    mockInvokeCommand('scan_folders_cmd', {
      groups: [group('A', 'COMPLETE'), group('B', 'JPG_ONLY'), group('C', 'RAW_ONLY')],
      totalCount: 3,
      jpgFolder: 'D:/shoot',
      rawFolder: '',
      isViewerMode: false,
    });
    mockInvokeCommand('load_session_cmd', null);

    const { result } = renderHook(() => useFolderScan(o));
    act(() => result.current.setJpgFolder('D:/shoot'));

    await act(async () => {
      await result.current.handleScan();
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.folderDetection).toMatchObject({ mode: 'mixed', jpgCount: 2, rawCount: 2 });
  });
});
