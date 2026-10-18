/**
 * P0-1 前端侧：给**已淘汰**的照片打分必须同时解除淘汰。
 *
 * 缺陷：`handleRate` 原样透传 `targetGroup.flag`，于是对 reject 照片打 4 星会发
 * `updateRatingFlag(4, 'reject')`，后端按 reject 写 `Rating=-1` ——
 * 界面显示「4 星」、磁盘仍是 -1，用户打多少星都摆脱不掉淘汰标记。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { invokeCount, lastInvokeArgs, mockInvokeCommand } from './test/setup';

const photo = (i: number, over: Record<string, unknown> = {}) => ({
  id: `p${i}`,
  baseName: `IMG_${i}`,
  jpg: { name: `IMG_${i}.JPG`, extension: 'JPG', path: `D:/shoot/IMG_${i}.JPG`, size: 1, mtime: 0 },
  raw: { name: `IMG_${i}.CR3`, extension: 'CR3', path: `D:/shoot/IMG_${i}.CR3`, size: 1, mtime: 0 },
  status: 'PAIRED',
  rating: 0,
  flag: 'none',
  label: '', hasXmp: false,
  ...over,
});

const scanResult = {
  groups: [photo(1), photo(2), photo(3)],
  totalFiles: 6,
  skippedFiles: 0,
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
  mockInvokeCommand('update_rating_flag_cmd', true);
}

async function scanWithRejectedFirst() {
  mockStartup();
  // 第一张就是"已淘汰"（Rating=-1 / flag=reject），模拟磁盘上的真实状态
  mockInvokeCommand('scan_folders_cmd', {
    ...scanResult,
    groups: [photo(1, { rating: 0, flag: 'reject' }), photo(2), photo(3)],
  });
  render(<App />);
  const btn = await screen.findByRole('button', { name: /扫描照片目录/ });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.click(btn);
  await screen.findByText(/扫描完成/);
}

describe('P0-1 —— 打分解除淘汰', () => {
  beforeEach(() => {
    // 每个用例独立计数
    invokeCount('update_rating_flag_cmd');
  });

  it('★给已淘汰照片打分：flag 必须变成 none，不得透传 reject', async () => {
    await scanWithRejectedFirst();

    fireEvent.keyDown(document.body, { key: '4' });

    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(1));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({
      rating: 4,
      flag: 'none',
    });
  });

  it('★给已淘汰照片打分后，界面不再显示"已淘汰"', async () => {
    await scanWithRejectedFirst();

    const cell = () => document.querySelector('[role="option"]') as HTMLElement;
    expect(cell().getAttribute('aria-label')).toContain('已淘汰');

    fireEvent.keyDown(document.body, { key: '4' });

    await waitFor(() => expect(cell().getAttribute('aria-label')).toContain('4 星'));
    expect(cell().getAttribute('aria-label')).not.toContain('已淘汰');
  });

  it('给未淘汰照片打分：flag 原样保持，不被误改', async () => {
    mockStartup();
    render(<App />);
    const btn = await screen.findByRole('button', { name: /扫描照片目录/ });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await screen.findByText(/扫描完成/);

    fireEvent.keyDown(document.body, { key: '5' });

    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(1));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({
      rating: 5,
      flag: 'none',
    });
  });

  it('给已保留(Pick)照片打分：flag 仍为 pick', async () => {
    mockStartup();
    mockInvokeCommand('scan_folders_cmd', {
      ...scanResult,
      groups: [photo(1, { flag: 'pick', rating: 2 }), photo(2), photo(3)],
    });
    render(<App />);
    const btn = await screen.findByRole('button', { name: /扫描照片目录/ });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await screen.findByText(/扫描完成/);

    fireEvent.keyDown(document.body, { key: '3' });

    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(1));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({
      rating: 3,
      flag: 'pick',
    });
  });
});