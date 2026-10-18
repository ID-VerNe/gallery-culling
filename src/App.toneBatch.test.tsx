/**
 * FR-07 App 接线：多选后「套用到选中」必须真的落到 IPC，且目标不含源照片。
 *
 * 组件测试只管按钮出现与否，hook 测试只管目标集合与写盘；这条补的是
 * **App 把 selectedIds / currentTone / patchGroup 串对了吗**。
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { invokeCalls, mockInvokeCommand } from './test/setup';
import type { FolderScanResult, PhotoGroupInfo, ToneState } from './types';
import { DEFAULT_TONE } from './utils/autoTone';

const group = (id: string): PhotoGroupInfo => ({
  id,
  baseName: id,
  raw: {
    name: `${id}.ARW`,
    extension: 'ARW',
    path: `D:/shoot/RAW/${id}.ARW`,
    size: 1024,
    mtime: 1,
  },
  status: 'RAW_ONLY',
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
});

const scanResult: FolderScanResult = {
  groups: [group('IMG_0001'), group('IMG_0002'), group('IMG_0003')],
  totalCount: 3,
  jpgFolder: 'D:/shoot/JPG',
  rawFolder: 'D:/shoot/RAW',
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
    defaultRawFolder: 'D:/shoot/RAW',
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
  mockInvokeCommand('apply_tone_cmd', {
    xmpWritten: true,
    lumenApplied: false,
    projectPath: null,
    warnings: [],
  });
}

/** 渲染 → 扫描，停在宫格可见的状态（多选只能在宫格上做）。 */
async function scanPhotos() {
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);
  await screen.findByText(/扫描完成/);
}

/** 打开调色面板（宫格被面板替换，之后不能再多选）。 */
async function openTonalPanel() {
  fireEvent.click(screen.getAllByRole('button', { name: '调色面板' })[0]);
  await screen.findByRole('button', { name: '保存调色' });
}

/** 扫描 + 打开面板（单选场景）。 */
async function openPanel() {
  await scanPhotos();
  await openTonalPanel();
}

/**
 * Ctrl 点选两张：第 2 张先入集合，再补第 1 张（源），使选中集含源。
 *
 * 用 `aria-posinset` 过滤 —— `getAllByRole('option')` 会连 TopBar 的
 * `<select>` 选项一起抓进来（那些也是 role="option"），数量对不上。
 */
function ctrlSelectFirstTwo() {
  const options = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"][aria-posinset]'),
  );
  expect(options).toHaveLength(3);
  fireEvent.click(options[1], { ctrlKey: true });
  fireEvent.click(options[0], { ctrlKey: true });
}

const toneCalls = () => invokeCalls('apply_tone_cmd');

describe('App —— 套用调色到选中', () => {
  it('单选（无多选）时不出现套用入口', async () => {
    mockStartup();
    await openPanel();

    expect(screen.queryByRole('button', { name: /套用到选中/ })).toBeNull();
  });

  it('多选 2 张（含当前照片）→ 只对另一张写盘，默认不写 LUMEN 工程', async () => {
    mockStartup();
    await scanPhotos();
    ctrlSelectFirstTwo();
    await openTonalPanel();

    const btn = await screen.findByRole('button', { name: /套用到选中 2 张/ });
    fireEvent.click(btn);

    await waitFor(() => expect(toneCalls()).toHaveLength(1));
    const call = toneCalls()[0];
    expect(call.args?.filePath).toBe('D:/shoot/RAW/IMG_0002.ARW');
    expect(call.args?.writeLumen).toBe(false);
    // 只复制 6 个 tone 字段，绝不夹带选片标记。
    expect(Object.keys(call.args?.tone as object).sort()).toEqual([
      'contrast',
      'exposure',
      'highlights',
      'shadows',
      'temperature',
      'tint',
    ]);
  });

  it('勾选「同时写入 LUMEN 工程」后 writeLumen=true', async () => {
    mockStartup();
    await scanPhotos();
    ctrlSelectFirstTwo();
    await openTonalPanel();

    fireEvent.click(await screen.findByRole('checkbox', { name: /同时写入 LUMEN 工程/ }));
    fireEvent.click(screen.getByRole('button', { name: /套用到选中 2 张/ }));

    await waitFor(() => expect(toneCalls()).toHaveLength(1));
    expect(toneCalls()[0].args?.writeLumen).toBe(true);
  });

  it('批量进行中显示进度条与「套用中…」，按钮不可再点', async () => {
    mockStartup();
    // 挂起第一张的写入，让批量停在运行态。
    mockInvokeCommand('apply_tone_cmd', () => new Promise(() => {}));
    await scanPhotos();
    ctrlSelectFirstTwo();
    await openTonalPanel();

    fireEvent.click(await screen.findByRole('button', { name: /套用到选中 2 张/ }));

    await screen.findByText('正在套用调色');
    expect(screen.getByRole('button', { name: /套用中/ })).toBeDisabled();
  });
});
