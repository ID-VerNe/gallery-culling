/**
 * H-02 回归：调色「保存」必须在写入期间禁用并挡住重入。
 *
 * 修复前 `App` 渲染 `<TonalAdjuster>` 时没有传 `isSaving`，组件里
 * `disabled={isSaving}` 与「保存中…」都是死分支 —— 双击保存会发两次
 * `apply_tone_cmd`（后端重复写 XMP/工程，存在截断竞态）。
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { invokeCount, mockInvokeCommand } from './test/setup';
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

/** 声明 App 启动 + 扫描 + 打开调色面板所触达的全部命令（未注册的命令会让测试炸出来）。 */
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
}

/** 渲染 App → 扫描出 1 张照片 → 打开调色面板，停在「保存调色」按钮上。 */
async function openTonalPanelWithPhoto() {
  render(<App />);

  // 默认目录来自设置，扫描按钮在设置读回后可用
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);

  // 扫描完成 → 当前照片就位，调色面板可打开
  await screen.findByText(/扫描完成/);
  fireEvent.click(
    screen.getByRole('button', { name: '轻量调色预检面板' }),
  );

  await screen.findByRole('button', { name: '保存调色' });
}

/** 让 apply_tone_cmd 返回一个永不 resolve 的 Promise，模拟写入挂起。 */
function mockPendingSave() {
  mockInvokeCommand('apply_tone_cmd', () => new Promise(() => {}));
}

const saveBtn = () => screen.getByRole('button', { name: '保存调色' });

describe('App —— 调色保存挂起期间不可重入 (H-02)', () => {
  it('保存挂起时双击「保存调色」，apply_tone_cmd 只发一次', async () => {
    mockStartup();
    mockPendingSave();

    await openTonalPanelWithPhoto();

    fireEvent.click(saveBtn());
    fireEvent.click(saveBtn());

    expect(invokeCount('apply_tone_cmd')).toBe(1);
  });

  it('保存挂起时保存按钮 disabled 且文案含「保存中…」', async () => {
    mockStartup();
    mockPendingSave();

    await openTonalPanelWithPhoto();

    fireEvent.click(saveBtn());

    await waitFor(() => expect(saveBtn()).toBeDisabled());
    expect(saveBtn()).toHaveTextContent('保存中…');
  });
});
