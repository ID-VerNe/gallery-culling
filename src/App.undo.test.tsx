/**
 * L-11 集成回归：星级/旗标改动可一步回退。
 *
 * `1..5` / `p` / `x` / `0` 都是"按下即写 .xmp"，修复前**没有任何撤销入口** ——
 * 一次误触（例如焦点落在下拉/按钮上时）就把磁盘上的评级改掉了，用户只能手改
 * 侧边栏或回 Lightroom 改回来。
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { invokeCount, lastInvokeArgs, mockInvokeCommand } from './test/setup';
import type { FolderScanResult, PhotoGroupInfo, ToneState } from './types';
import { DEFAULT_TONE } from './utils/autoTone';

const group: PhotoGroupInfo = {
  id: 'g1',
  baseName: 'IMG_0001',
  jpg: {
    name: 'IMG_0001.jpg',
    extension: 'jpg',
    path: 'D:/shoot/JPG/IMG_0001.jpg',
    size: 1024,
    mtime: 0,
  },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  hasXmp: false,
};

const scanResult: FolderScanResult = {
  groups: [group],
  totalCount: 1,
  jpgFolder: 'D:/shoot/JPG',
  rawFolder: '',
  isViewerMode: false,
};

const toneState: ToneState = {
  tone: { ...DEFAULT_TONE },
  xmpTone: { ...DEFAULT_TONE },
  lumenTone: null,
  divergent: false,
  lumenAvailable: false,
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
  mockInvokeCommand('get_tone_state_cmd', toneState);
  mockInvokeCommand('update_rating_flag_cmd', true);
}

async function scanOne() {
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: /扫描照片目录/ });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);
  await screen.findByText(/扫描完成/);
}

const rateCalls = () => invokeCount('update_rating_flag_cmd');

describe('L-11 —— 撤销：键盘', () => {
  it('打分后 Ctrl+Z 把 XMP 写回旧值', async () => {
    mockStartup();
    await scanOne();

    fireEvent.keyDown(document.body, { key: '3' });
    await waitFor(() => expect(rateCalls()).toBe(1));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 3 });

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(rateCalls()).toBe(2));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 0 });
    await waitFor(() => expect(screen.getByText(/已撤销上一处改动/)).toBeInTheDocument());
  });

  it('连按 1..5 后撤销回到这轮起点，而不是上一步', async () => {
    mockStartup();
    await scanOne();

    fireEvent.keyDown(document.body, { key: '1' });
    fireEvent.keyDown(document.body, { key: '3' });
    fireEvent.keyDown(document.body, { key: '5' });
    await waitFor(() => expect(rateCalls()).toBe(3));

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(rateCalls()).toBe(4));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 0 });
  });

  it('没有可撤销的操作时给出提示，且不发写盘请求', async () => {
    mockStartup();
    await scanOne();

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(screen.getByText(/没有可撤销的操作/)).toBeInTheDocument());
    expect(rateCalls()).toBe(0);
  });

  it('输入框内的 Ctrl+Z 仍是原生「撤销输入」，不触发照片撤销', async () => {
    mockStartup();
    await scanOne();

    // 先制造一次可撤销的改动
    fireEvent.keyDown(document.body, { key: '4' });
    await waitFor(() => expect(rateCalls()).toBe(1));

    // 打开宫格搜索框并聚焦，在其中按 Ctrl+Z
    fireEvent.click(screen.getByRole('button', { name: '按文件名搜索' }));
    const input = screen.getByRole('textbox', { name: '按文件名搜索照片' });
    input.focus();
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });

    // 没有新的写盘 → 说明撤销没有抢走输入框的原生 Ctrl+Z
    await new Promise((r) => setTimeout(r, 30));
    expect(rateCalls()).toBe(1);
  });
});

describe('L-11 —— 撤销：鼠标入口', () => {
  it('底栏「撤销」按钮在无可撤销时禁用，改动后可用并能撤销', async () => {
    mockStartup();
    await scanOne();

    const undoBtn = () => screen.getByRole('button', { name: '撤销上一处星级或标记改动' });
    expect(undoBtn()).toBeDisabled();

    fireEvent.keyDown(document.body, { key: '2' });
    await waitFor(() => expect(rateCalls()).toBe(1));
    await waitFor(() => expect(undoBtn()).toBeEnabled());

    fireEvent.click(undoBtn());

    await waitFor(() => expect(rateCalls()).toBe(2));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 0 });
    await waitFor(() => expect(undoBtn()).toBeDisabled());
  });

  it('旗标改动（X 淘汰）同样可撤销', async () => {
    mockStartup();
    await scanOne();

    fireEvent.keyDown(document.body, { key: 'x' });
    await waitFor(() => expect(rateCalls()).toBe(1));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ flag: 'reject' });

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(rateCalls()).toBe(2));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ flag: 'none' });
  });
});
