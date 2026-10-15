/**
 * 扫描重扫的触发条件 —— settings 回填 vs 用户主动改排序。
 *
 * 缺陷背景（2026-10-15 e2e 实锤，run5）：useAppSettings 在启动后**异步**回填
 * `setSortOrder(saved)`。当 `saved ≠ state 初始值（'time_filename'）` 时，
 * useFolderScan 里「跳过首次」的 guard（sortOrderInitialised）早已置位，拦不住
 * 这次迟到变化 —— 打开应用即**静默自动扫描**（与源码注释意图
 * "restoring a session does not silently launch a scan" 直接矛盾）。
 *
 * 危害不止多扫一次：该自动扫描与用户随后的手动扫描并发，两次 `onScanned`
 * 都会用会话 lastIndex 恢复选中 —— 用户在扫描窗口内的点击会被覆盖
 * （run5 里 e2e 点击 IMG_010 被翻转回 IMG_011，apply 因此写错文件）。
 *
 * 修复语义：只有**用户主动改排序**才触发重扫；settings 回填不触发。
 */
import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { invokeCount, mockInvokeCommand } from './test/setup';
import type { FolderScanResult, PhotoGroupInfo } from './types';

const mkGroup = (baseName: string): PhotoGroupInfo => ({
  id: baseName.toLowerCase(),
  baseName,
  jpg: {
    name: `${baseName}.jpg`,
    extension: 'jpg',
    path: `D:/shoot/JPG/${baseName}.jpg`,
    size: 1024,
    mtime: 0,
  },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  hasXmp: false,
});

const allGroups = ['DSC_1001', 'DSC_1002', 'DSC_1003', 'DSC_1004', 'DSC_1005'].map(mkGroup);

const scanResult: FolderScanResult = {
  groups: allGroups,
  totalCount: allGroups.length,
  jpgFolder: 'D:/shoot/JPG',
  rawFolder: '',
  isViewerMode: false,
};

/** 启动 mock；sortOrder 可指定（模拟本机库里保存过的排序），history 为会话索引。 */
function mockStartup(
  savedSortOrder: string,
  history: [number, string] | null = null,
) {
  mockInvokeCommand('get_settings_cmd', {
    defaultJpgFolder: 'D:/shoot/JPG',
    defaultRawFolder: '',
    photoshopPath: '',
    thumbnailWidth: 200,
    sortOrder: savedSortOrder,
    lumenEnabled: false,
    lumenCliPath: '',
    lumenGridThumbnails: false,
    lumenExpectAi: false,
  });
  mockInvokeCommand('save_settings_cmd', true);
  mockInvokeCommand('save_session_cmd', true);
  mockInvokeCommand('load_session_cmd', history);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('scan_folders_cmd', scanResult);
}

describe('扫描重扫触发条件（settings 回填 vs 用户改排序）', () => {
  it('settings 回填的 sortOrder（与 state 初始值不同）不触发扫描', async () => {
    // 库里存过 'filename'，而 useFolderScan 的 state 初始值是 'time_filename'
    mockStartup('filename');

    render(<App />);
    // 等界面就绪（settings 回填已完成、按钮可用）
    const btn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(btn).toBeEnabled());

    // 再给若干宏任务的时间让任何迟到 effect 跑完
    await new Promise((r) => setTimeout(r, 120));
    expect(invokeCount('scan_folders_cmd')).toBe(0);
  });

  it('用户主动改排序会重扫（核心行为保留）', async () => {
    // 库值与初始值一致：回填不产生 sortOrder 变化，排除干扰
    mockStartup('time_filename');

    render(<App />);
    const btn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(btn).toBeEnabled());

    // 先手动扫描一次，建立 jpgFolder
    fireEvent.click(btn);
    await screen.findByText(/扫描完成/);
    expect(invokeCount('scan_folders_cmd')).toBe(1);

    // 用户改排序 → 必须以新排序重扫
    fireEvent.change(screen.getByLabelText('照片排序方式'), {
      target: { value: 'filename' },
    });
    await waitFor(() => expect(invokeCount('scan_folders_cmd')).toBe(2));
  });
});

describe('扫描完成与会话恢复的竞态（用户操作优先）', () => {
  it('扫描期间用户点击 → 完成后保留用户选择，不恢复会话位置', async () => {
    // 会话记录：上次停在第 3 张（索引 2）
    mockStartup('time_filename', [2, 'time_filename']);

    render(<App />);
    const btn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(btn).toBeEnabled());

    // 第一次扫描：正常完成 → 恢复到会话索引 2
    fireEvent.click(btn);
    await waitFor(() =>
      expect(screen.getByLabelText('当前第 3 张，共 5 张')).toBeInTheDocument(),
    );

    // 用户点到第 5 张
    fireEvent.click(screen.getByRole('option', { name: /DSC_1005/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('当前第 5 张，共 5 张')).toBeInTheDocument(),
    );

    // 重新扫描：挂起模拟慢扫描；期间用户又点到第 4 张
    let resolveScan: (v: FolderScanResult) => void = () => {};
    mockInvokeCommand(
      'scan_folders_cmd',
      () =>
        new Promise<FolderScanResult>((res) => {
          resolveScan = res;
        }),
    );
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('option', { name: /DSC_1004/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('当前第 4 张，共 5 张')).toBeInTheDocument(),
    );

    // 扫描完成 → 必须保留用户当前的第 4 张。
    // 修复前：无条件 setSelectedIndex(historyIndex=2)，用户点击被翻回第 3 张。
    await act(async () => {
      resolveScan(scanResult);
    });
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());

    expect(screen.getByLabelText('当前第 4 张，共 5 张')).toBeInTheDocument();
  });
});
