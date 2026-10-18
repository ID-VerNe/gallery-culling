/**
 * FR-09 App 集成：互斥必须真的落到按钮上，且原因**画在屏幕上**。
 *
 * 单元测试证明了表对称、hook 会释放；这条证明「扫描在跑时，导出真的点不了，
 * 而且用户看得到为什么」。disabled 按钮不可聚焦，所以断言的是可见文本，
 * 不是 title / aria-describedby。
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { mockInvokeCommand } from './test/setup';
import type { FolderScanResult, PhotoGroupInfo } from './types';

const group = (id: string): PhotoGroupInfo => ({
  id,
  baseName: id,
  jpg: {
    name: `${id}.jpg`,
    extension: 'jpg',
    path: `D:/shoot/JPG/${id}.jpg`,
    size: 1024,
    mtime: 1,
  },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
});

const scanResult: FolderScanResult = {
  groups: [group('IMG_0001'), group('IMG_0002'), group('IMG_0003')],
  totalCount: 3,
  jpgFolder: 'D:/shoot/JPG',
  rawFolder: '',
  isViewerMode: false,
};

function mockStartup(overrides: { scan?: unknown } = {}) {
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
  mockInvokeCommand('scan_folders_cmd', overrides.scan ?? scanResult);
  mockInvokeCommand('load_session_cmd', null);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('get_tone_state_cmd', null);
}

const scanButton = () => screen.getByRole('button', { name: '扫描照片目录' });

describe('FR-09 —— 批量写盘进行中，导出被挡', () => {
  it('开始导出按钮禁用，并在弹窗内常驻原因', async () => {
    mockStartup();
    // 第一张写盘永不返回：批量停在运行态。
    mockInvokeCommand('update_rating_flag_cmd', () => new Promise(() => {}));
    render(<App />);

    const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(scanBtn).toBeEnabled());
    fireEvent.click(scanBtn);
    await screen.findByText(/扫描完成/);

    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"][aria-posinset]'),
    );
    fireEvent.click(options[1], { ctrlKey: true });
    fireEvent.click(options[0], { ctrlKey: true });
    fireEvent.keyDown(document.body, { key: '1' });
    fireEvent.click(await screen.findByRole('button', { name: '写入 XMP' }));
    await screen.findByText('正在批量写入 XMP');

    // 打开导出弹窗：候选非空、目录填好，唯一阻断原因就是互斥。
    fireEvent.click(screen.getByRole('button', { name: '批量挑选导出照片' }));
    fireEvent.change(document.getElementById('export-target-folder')!, {
      target: { value: 'D:/out' },
    });

    const start = await screen.findByRole('button', { name: '开始导出' });
    expect(start).toBeDisabled();
    expect(
      screen.getByText('正在批量写盘，暂时不能导出照片。'),
    ).toBeInTheDocument();
  });
});

describe('FR-09 —— 批量写盘进行中，扫描被挡', () => {
  it('扫描按钮禁用，并显示「正在批量写盘」的原因', async () => {
    mockStartup();
    // 第一张写盘永不返回：批量停在运行态。
    mockInvokeCommand('update_rating_flag_cmd', () => new Promise(() => {}));
    render(<App />);

    const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(scanBtn).toBeEnabled());
    fireEvent.click(scanBtn);
    await screen.findByText(/扫描完成/);

    // 多选 2 张 → 按 1 → 确认，触发批量写盘。
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"][aria-posinset]'),
    );
    fireEvent.click(options[1], { ctrlKey: true });
    fireEvent.click(options[0], { ctrlKey: true });
    fireEvent.keyDown(document.body, { key: '1' });
    fireEvent.click(await screen.findByRole('button', { name: '写入 XMP' }));

    await screen.findByText('正在批量写入 XMP');
    await waitFor(() => expect(scanButton()).toBeDisabled());
    expect(
      screen.getByText('正在批量写盘，暂时不能扫描照片。'),
    ).toBeInTheDocument();
  });
});
