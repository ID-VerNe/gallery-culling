/**
 * WP5 集成回归（M-05 扫描侧）—— 只在 App 层可验证的部分。
 *
 * 修复前：扫描期间只有按钮里一个转圈的图标，没有条数、没有进度、**没有取消**；
 * 万张目录一按下就只能等，或者强杀进程。
 *
 * 后端契约：`scan-progress` 事件（`{phase, processed, total}`）、
 * `cancel_scan_cmd` 命令；取消时 `scan_folders_cmd` 以 `Err("TASK_CANCELLED")`
 * 返回。前端按「是否请求过取消」而非错误文案区分取消与失败。
 */
import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { emitMockEvent, invokeCount, mockInvokeCommand } from './test/setup';
import { TASK_CANCELLED_SENTINEL } from './services/taskApi';
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
  label: '', hasXmp: false,
});

const allGroups = ['DSC_1001', 'DSC_1002', 'DSC_2001'].map(mkGroup);

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
  mockInvokeCommand('load_session_cmd', null);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('get_tone_state_cmd', toneState);
  mockInvokeCommand('cancel_scan_cmd', undefined);
}

// 扫描按钮的 aria-label 会随状态切换（`扫描照片目录` ↔ `正在扫描照片目录`），
// 所以用前缀匹配而不是精确名，否则"忙碌中"那一帧会查不到元素。
const scanButton = () => screen.getByRole('button', { name: /扫描照片目录/ });
const cancelButton = () => screen.getByRole('button', { name: /^取消/ });

describe('WP5 集成 —— 扫描进度与取消 (M-05)', () => {
  it('扫描进行中：按钮禁用、出现进度条与 aria-live，进度事件推进会更新读数', async () => {
    mockStartup();
    mockInvokeCommand('scan_folders_cmd', () => new Promise(() => {}));

    render(<App />);
    const btn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(btn).toBeEnabled());

    fireEvent.click(btn);

    // 进度条出现（总量未知时是不确定进度）
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
    expect(scanButton()).toBeDisabled();

    // 进度事件到达后变成确定性进度
    act(() => {
      emitMockEvent('scan-progress', { phase: 'read', processed: 12, total: 40 });
    });

    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '12'),
    );
    expect(screen.getByText('12 / 40（30%）')).toBeInTheDocument();
    // 外层是礼貌播报的 live region（§6 验收点）
    expect(screen.getByRole('progressbar').parentElement).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  it('点取消会下发 cancel_scan_cmd，且按钮改文案避免重复下发', async () => {
    mockStartup();
    mockInvokeCommand('scan_folders_cmd', () => new Promise(() => {}));

    render(<App />);
    const btn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);

    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    fireEvent.click(cancelButton());

    await waitFor(() => expect(invokeCount('cancel_scan_cmd')).toBe(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /取消中/ })).toBeDisabled(),
    );
    // 取消是幂等的：再点也不会重复下发
    expect(invokeCount('cancel_scan_cmd')).toBe(1);
  });

  it('取消后扫描以 Err 返回 → 按「已取消」呈现，不误报扫描失败', async () => {
    mockStartup();
    let rejectScan: (reason: unknown) => void = () => {};
    mockInvokeCommand(
      'scan_folders_cmd',
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = reject;
        }),
    );

    render(<App />);
    const btn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);

    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    fireEvent.click(cancelButton());
    await waitFor(() => expect(invokeCount('cancel_scan_cmd')).toBe(1));

    act(() => {
      rejectScan(TASK_CANCELLED_SENTINEL);
    });

    await waitFor(() => expect(screen.getByText(/已取消扫描/)).toBeInTheDocument());
    expect(screen.queryByText(/扫描失败/)).toBeNull();
    // 取消后进度条收起，按钮回到可用
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    expect(scanButton()).toBeEnabled();
  });

  it('点过取消但错误是真实失败 → 仍报「扫描失败」，不能用取消文案掩盖真错误', async () => {
    mockStartup();
    let rejectScan: (reason: unknown) => void = () => {};
    mockInvokeCommand(
      'scan_folders_cmd',
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = reject;
        }),
    );

    render(<App />);
    const btn = await screen.findByRole('button', { name: /扫描照片目录/ });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);

    await waitFor(() => expect(cancelButton()).toBeInTheDocument());
    fireEvent.click(cancelButton());
    await waitFor(() => expect(invokeCount('cancel_scan_cmd')).toBe(1));

    // 与取消同一时刻发生的真实错误：不是哨兵文案
    act(() => {
      rejectScan(new Error('permission denied'));
    });

    await waitFor(() => expect(screen.getByText(/扫描失败/)).toBeInTheDocument());
    expect(screen.queryByText(/已取消扫描/)).toBeNull();
  });

  it('未取消的扫描失败仍走失败态（不能用「取消」文案掩盖真错误）', async () => {
    mockStartup();
    mockInvokeCommand('scan_folders_cmd', () => Promise.reject(new Error('permission denied')));

    render(<App />);
    const btn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByText(/扫描失败/)).toBeInTheDocument());
    expect(screen.queryByText(/已取消扫描/)).toBeNull();
    expect(invokeCount('cancel_scan_cmd')).toBe(0);
  });

  it('顺利完成的扫描不留下进度条', async () => {
    mockStartup();
    mockInvokeCommand('scan_folders_cmd', scanResult);

    render(<App />);
    const btn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);

    await screen.findByText(/扫描完成/);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(scanButton()).toBeEnabled();
  });
});
