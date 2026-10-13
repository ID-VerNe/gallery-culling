/**
 * WP7 接线回归（只在 App 层可验证的部分）：
 *  - M-14：筛选下拉的 `(N)` 与切档后宫格实际张数必须同源；
 *  - L-08：调色面板的 Esc 出口，以及「一次 Esc 只关一层」。
 *
 * 纯谓词与下拉文案的真值在 `utils/filterMatch.test.ts` / `TopBar.test.tsx`，
 * 这里只钉「宿主接线正确」。
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { mockInvokeCommand } from './test/setup';
import type { CullFlag, FolderScanResult, PhotoGroupInfo, ToneState } from './types';
import { DEFAULT_TONE } from './utils/autoTone';

const mkGroup = (
  baseName: string,
  rating: number,
  flag: CullFlag,
): PhotoGroupInfo => ({
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
  rating,
  flag,
  hasXmp: false,
});

// all=5 · pick=1 · reject=1 · unmarked=1 · star3=2 · star5=1
const allGroups = [
  mkGroup('DSC_1001', 3, 'none'),
  mkGroup('DSC_1002', 5, 'pick'),
  mkGroup('DSC_2001', 0, 'reject'),
  mkGroup('DSC_2002', 0, 'none'),
  mkGroup('DSC_3001', 2, 'none'),
];

const scanResult: FolderScanResult = {
  groups: allGroups,
  totalCount: allGroups.length,
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
}

async function scanFive() {
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);
  await screen.findByText(/扫描完成/);
}

describe('WP7 接线 —— M-14 筛选档位计数', () => {
  it('下拉每档显示计数', async () => {
    mockStartup();
    await scanFive();

    const select = screen.getByRole('combobox', { name: '照片筛选过滤' });
    expect(within(select).getByRole('option', { name: '全部照片 (5)' })).toBeInTheDocument();
    expect(
      within(select).getByRole('option', { name: '仅已保留 (Pick) (1)' }),
    ).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: '已淘汰 (Reject) (1)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: '★3 星以上 (2)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: '★5 星精选 (1)' })).toBeInTheDocument();
  });

  it('切到「★3 星以上」后宫格实际张数 == 下拉里承诺的 N', async () => {
    mockStartup();
    await scanFive();

    const select = screen.getByRole('combobox', { name: '照片筛选过滤' });
    fireEvent.change(select, { target: { value: 'star3' } });

    const grid = screen.getByRole('listbox');
    await waitFor(() => expect(within(grid).getAllByRole('option')).toHaveLength(2));
  });

  it('切到「已淘汰」后宫格实际张数 == 下拉里承诺的 N', async () => {
    mockStartup();
    await scanFive();

    const select = screen.getByRole('combobox', { name: '照片筛选过滤' });
    fireEvent.change(select, { target: { value: 'reject' } });

    const grid = screen.getByRole('listbox');
    await waitFor(() => expect(within(grid).getAllByRole('option')).toHaveLength(1));
    expect(within(grid).getByRole('option', { name: /DSC_2001/ })).toBeInTheDocument();
  });
});

describe('WP7 接线 —— L-08 调色面板的 Esc 出口', () => {
  const panel = () => document.getElementById('tonal-adjuster-panel');

  it('打开调色面板后按 Esc 关闭', async () => {
    mockStartup();
    await scanFive();

    fireEvent.click(screen.getAllByRole('button', { name: '调色面板' })[0]);
    await waitFor(() => expect(panel()).not.toBeNull());

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(panel()).toBeNull());
  });

  it('弹窗打开时按 Esc 不连带关掉面板（一次 Esc 只关一层）', async () => {
    mockStartup();
    await scanFive();

    fireEvent.click(screen.getAllByRole('button', { name: '调色面板' })[0]);
    await waitFor(() => expect(panel()).not.toBeNull());

    // 打开一个真正的模态弹窗（role=dialog + aria-modal），Esc 归它处理
    // （底栏有两个"全部快捷键"入口：宽/窄布局各一个）
    fireEvent.click(screen.getAllByRole('button', { name: '查看全部快捷键' })[0]);
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull(),
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(panel()).not.toBeNull();
  });
});
