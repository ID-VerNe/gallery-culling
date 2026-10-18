/**
 * FR-11 App 集成：Lightroom 导入入口真的接在应用上。
 *
 * 单元测试证明了匹配与写盘分支；这一层证明**它们真的接在一起**：
 * 点「导入 LR」能开弹窗、选目录后真的读到、按导入后写盘参数正确、
 * 而且写的是当前集合里的照片（不是 LR 库里的任意一张）。
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import App from './App';
import { invokeCalls, mockInvokeCommand } from './test/setup';
import type { FolderScanResult, LrcatReadResult, PhotoGroupInfo } from './types';

const openMock = vi.mocked(openDialog);

const group: PhotoGroupInfo = {
  id: 'IMG_0001',
  baseName: 'IMG_0001',
  jpg: {
    name: 'IMG_0001.jpg',
    extension: 'jpg',
    path: 'D:/shoot/JPG/IMG_0001.jpg',
    size: 1024,
    mtime: 1,
  },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
};

const scanResult: FolderScanResult = {
  groups: [group],
  totalCount: 1,
  jpgFolder: 'D:/shoot/JPG',
  rawFolder: '',
  isViewerMode: false,
};

const lrcatResult: LrcatReadResult = {
  catalog: 'D:/LR/Lightroom Catalog.lrcat',
  photos: [
    { path: 'D:/shoot/JPG/IMG_0001.jpg', rating: 5, flag: 'pick', label: 'Red' },
    { path: 'D:/shoot/JPG/IMG_9999.jpg', rating: 2, flag: 'none', label: '' },
  ],
  skippedVirtual: 0,
  total: 2,
  copied: false,
};

function mockStartup() {
  mockInvokeCommand('get_settings_cmd', {
    defaultJpgFolder: 'D:/shoot/JPG',
    defaultRawFolder: '',
    photoshopPath: '',
    thumbnailWidth: 200,
    sortOrder: 'time_filename',
    lumenEnabled: false,
    lumenCliPath: '',
    lumenGridThumbnails: false,
    lumenExpectAi: false,
  });
  mockInvokeCommand('save_settings_cmd', true);
  mockInvokeCommand('save_session_cmd', true);
  mockInvokeCommand('scan_folders_cmd', scanResult);
  mockInvokeCommand('load_session_cmd', null);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('get_tone_state_cmd', null);
  mockInvokeCommand('refresh_from_xmp_cmd', {
    checked: 0,
    unchanged: 0,
    baselined: 0,
    adopted: [],
    conflicts: [],
    failed: [],
  });
  mockInvokeCommand('read_lrcat_cmd', lrcatResult);
  mockInvokeCommand('update_rating_flag_cmd', true);
}

async function renderApp() {
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  return scanBtn;
}

describe('App —— Lightroom 导入', () => {
  it('点「导入 LR」打开弹窗，没扫描时先说明原因', async () => {
    mockStartup();
    await renderApp();

    fireEvent.click(screen.getByRole('button', { name: '导入 Lightroom 目录' }));
    expect(await screen.findByText(/导入 Lightroom 目录/)).toBeInTheDocument();

    // 还没扫描：按钮点下去应该被挡住并解释，而不是弹文件对话框。
    fireEvent.click(screen.getByRole('button', { name: /选择目录/ }));
    await waitFor(() => expect(openMock).not.toHaveBeenCalled());
  });

  it('扫描后读目录 → 匹配 → 写入参数是整组状态', async () => {
    mockStartup();
    const scanBtn = await renderApp();
    fireEvent.click(scanBtn);
    await screen.findAllByText('IMG_0001');

    fireEvent.click(screen.getByRole('button', { name: '导入 Lightroom 目录' }));
    openMock.mockResolvedValueOnce('D:/LR/Lightroom Catalog.lrcat');
    fireEvent.click(await screen.findByRole('button', { name: /选择目录/ }));

    // 读命令收到的是当前目录（而不是全库）
    await waitFor(() => expect(invokeCalls('read_lrcat_cmd')).toHaveLength(1));
    expect(invokeCalls('read_lrcat_cmd')[0].args).toMatchObject({
      path: 'D:/LR/Lightroom Catalog.lrcat',
      folders: ['D:/shoot/JPG'],
    });

    // 只有一张能对上（IMG_9999 不在当前集合里）
    const applyBtn = await screen.findByRole('button', { name: '导入 1 张' });
    fireEvent.click(applyBtn);

    await waitFor(() => expect(invokeCalls('update_rating_flag_cmd')).toHaveLength(1));
    expect(invokeCalls('update_rating_flag_cmd')[0].args).toMatchObject({
      filePath: 'D:/shoot/JPG/IMG_0001.jpg',
      rating: 5,
      flag: 'pick',
      label: 'Red',
      syncXmp: true,
      coalesce: false,
    });
  });
});
