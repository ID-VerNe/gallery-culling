/**
 * WP6 状态真值集成回归：M-07（同屏计数单一真值）与 N-04（对比候选落回可见集）。
 *
 * 这两条只能在整体 App 里验证 —— 它们分别由 `visibleGroups` ↔ `BottomBar`
 * 的传参链、以及 `gridSearch` 触发的救援 effect 决定，都不是纯函数。
 * 索引联动的纯逻辑矩阵见 `utils/compareGroups.test.ts`。
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { mockInvokeCommand } from './test/setup';
import type { FolderScanResult, PhotoGroupInfo, ToneState } from './types';
import { DEFAULT_TONE } from './utils/autoTone';

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

// `DSC_1` 命中前两张；`DSC_2001` 只被用来证明「候选已离开可见集」。
const NAMES = ['DSC_1001', 'DSC_1002', 'DSC_2001', 'DSC_2002', 'DSC_3001'];
const allGroups = NAMES.map(mkGroup);

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

/** 打开宫格搜索并返回输入框。 */
function openSearch() {
  fireEvent.click(screen.getByRole('button', { name: '按文件名搜索' }));
  return screen.getByRole('textbox', { name: '在宫格中按文件名搜索照片' });
}

describe('WP6 集成 —— 搜索计数单一真值 (M-07)', () => {
  it('搜索激活后，底栏同时给出「命中数/工作集」与「当前位置/工作集」', async () => {
    mockStartup();
    await scanFive();

    const input = openSearch();
    fireEvent.change(input, { target: { value: 'DSC_1' } });

    // 命中 2 张、工作集 5 张、当前停在第 1 张（选中项未被搜索踢走）。
    await waitFor(() =>
      expect(screen.getByText(/宫格筛选 2\/5 · 当前 1\/5/)).toBeInTheDocument(),
    );
  });

  it('清空搜索后计数回到整集口径', async () => {
    mockStartup();
    await scanFive();

    const input = openSearch();
    fireEvent.change(input, { target: { value: 'DSC_1' } });
    await waitFor(() => expect(screen.getByText(/宫格筛选 2\/5/)).toBeInTheDocument());

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() =>
      expect(screen.queryByText(/宫格筛选/)).not.toBeInTheDocument(),
    );
  });
});

describe('WP6 集成 —— 对比候选随搜索收窄 (N-04)', () => {
  it('搜索把宫格收窄后，右侧候选不再停留在搜索结果之外', async () => {
    mockStartup();
    await scanFive();

    // 进入对比模式
    fireEvent.click(screen.getByRole('button', { name: /双图对比/ }));

    // 点第 2 张：selectedIndex=1，compareIndex 被推到 2 → 右图为 DSC_2001
    fireEvent.click(screen.getByRole('option', { name: /DSC_1002/ }));
    await waitFor(() =>
      expect(screen.getAllByText('DSC_2001').length).toBeGreaterThan(0),
    );

    // 搜索只命中前两张：compareIndex=2 已落在可见集之外
    const input = openSearch();
    fireEvent.change(input, { target: { value: 'DSC_1' } });

    // 修复前：右图仍是 DSC_2001（不在搜索结果里）；修复后候选被拉回可见集
    await waitFor(() =>
      expect(screen.queryAllByText('DSC_2001')).toHaveLength(0),
    );
    expect(screen.getAllByText('DSC_1001').length).toBeGreaterThan(0);
  });
});
