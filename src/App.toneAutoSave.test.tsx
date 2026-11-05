/**
 * 调色自动保存（issue #67）。
 *
 * 锁住四条行为：
 * 1. 全新安装（设置里没有 `toneAutoSave` 键）默认开启：拖一次滑杆就会写盘；
 * 2. 用户显式关掉（`toneAutoSave: false`）后不自动写盘（重启后仍关由 Rust 侧用例锁定）；
 * 3. 400ms 静默窗口内连续拖动只写一次（ADR-002 同窗口时长）；
 * 4. 自动保存失败必须可见：出现 role="alert"，不能只是 console.warn。
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import {
  invokeCount,
  lastInvokeArgs,
  mockInvokeCommand,
  mockInvokeError,
} from './test/setup';
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

const toneState: ToneState = {
  tone: { ...DEFAULT_TONE },
  xmpTone: { ...DEFAULT_TONE },
  lumenTone: null,
  divergent: false,
  lumenAvailable: false,
};

const toneReport = {
  xmpWritten: true,
  lumenApplied: false,
  projectPath: null,
  warnings: [],
};

/**
 * 声明 App 启动 + 扫描 + 调色面板所触达的全部命令。
 * `settingsOverride` 用来模拟「全新安装（缺键）」与「显式关闭」两种设置状态。
 */
function mockStartup(
  settingsOverride: Record<string, unknown> = {},
  groups: PhotoGroupInfo[] = [group],
) {
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
    ...settingsOverride,
  });
  mockInvokeCommand('save_settings_cmd', true);
  mockInvokeCommand('save_session_cmd', true);
  mockInvokeCommand('scan_folders_cmd', { ...scanResult, groups, totalCount: groups.length });
  mockInvokeCommand('load_session_cmd', null);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('get_tone_state_cmd', toneState);
  mockInvokeCommand('apply_tone_cmd', toneReport);
}

/** 渲染 App → 扫描出 1 张照片 → 打开调色面板。 */
async function openTonalPanelWithPhoto() {
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);
  await screen.findByText(/扫描完成/);
  fireEvent.click(screen.getAllByRole('button', { name: '调色面板' })[0]);
  await screen.findByRole('button', { name: '保存调色' });
}

/** 曝光滑杆（6 根滑杆里唯一匹配「曝光」的那根）。 */
const exposureSlider = () => screen.getByRole('slider', { name: /曝光/ });

/** 模拟一次拖动：值变化会走输入框的 onChange（与真实滑杆同一路径）。 */
function dragExposure(value: string) {
  fireEvent.change(exposureSlider(), { target: { value } });
}

describe('App —— 调色自动保存 (issue #67)', () => {
  it('全新安装（设置里缺 toneAutoSave 键）默认开启，拖一次滑杆就自动写盘', async () => {
    mockStartup();
    await openTonalPanelWithPhoto();

    dragExposure('1.2');

    await waitFor(() => expect(invokeCount('apply_tone_cmd')).toBe(1), {
      timeout: 2000,
    });
    expect(screen.getByText('已自动保存')).toBeInTheDocument();
  });

  it('400ms 静默窗口内连续拖动 3 次，只写一次盘', async () => {
    mockStartup();
    await openTonalPanelWithPhoto();

    dragExposure('1.2');
    dragExposure('1.4');
    dragExposure('1.6');

    // 静默窗口未结束前绝不允许写盘：这条能打红「把 debounce 改成 0」的变异。
    await new Promise((r) => setTimeout(r, 200));
    expect(invokeCount('apply_tone_cmd')).toBe(0);

    await waitFor(() => expect(invokeCount('apply_tone_cmd')).toBe(1), {
      timeout: 2000,
    });
    // 再等一个完整窗口：过期的拖动不应该再补写第二次。
    await new Promise((r) => setTimeout(r, 600));
    expect(invokeCount('apply_tone_cmd')).toBe(1);
  });

  it('用户显式关掉（toneAutoSave: false）后不自动写盘', async () => {
    mockStartup({ toneAutoSave: false });
    await openTonalPanelWithPhoto();

    dragExposure('1.2');

    // 超过一个静默窗口后仍应没有任何写盘调用。
    await new Promise((r) => setTimeout(r, 800));
    expect(invokeCount('apply_tone_cmd')).toBe(0);
    // 关闭自动保存时必须保留「未保存」提示，避免用户以为已落盘。
    expect(screen.getByText('未保存')).toBeInTheDocument();
  });

  it('自动保存失败必须有可见错误（role="alert"），不能静默吞掉', async () => {
    mockStartup();
    mockInvokeError('apply_tone_cmd');
    await openTonalPanelWithPhoto();

    dragExposure('1.2');

    await waitFor(() => expect(invokeCount('apply_tone_cmd')).toBe(1), {
      timeout: 2000,
    });
    const alerts = await screen.findAllByRole('alert');
    expect(
      alerts.some((el) => /自动保存失败/.test(el.textContent ?? '')),
    ).toBe(true);
    // 失败原因必须常驻在面板里（toast 只是补充）：这条打红「把错误原因吞掉」的变异。
    expect(
      screen.getByText(/自动保存失败：Error: apply_tone_cmd failed/),
    ).toBeInTheDocument();
  });

  it('关闭面板时立即 flush 待写任务，不会等静默窗口', async () => {
    mockStartup();
    await openTonalPanelWithPhoto();

    dragExposure('1.2');
    // 静默窗口未结束就关面板：待写任务必须**同步**落盘，而不是等 400ms 后才写。
    fireEvent.click(screen.getByRole('button', { name: '关闭面板' }));

    expect(invokeCount('apply_tone_cmd')).toBe(1);
    expect(lastInvokeArgs('apply_tone_cmd')?.filePath).toBe(
      'D:/shoot/JPG/IMG_0001.jpg',
    );
  });

  it('手动保存会接管待写任务，不会在窗口结束后重复写一次', async () => {
    mockStartup();
    await openTonalPanelWithPhoto();

    dragExposure('1.2');
    fireEvent.click(screen.getByRole('button', { name: '保存调色' }));

    await waitFor(() => expect(invokeCount('apply_tone_cmd')).toBe(1), {
      timeout: 2000,
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(invokeCount('apply_tone_cmd')).toBe(1);
  });
});
