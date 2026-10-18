/**
 * FR-08 App 集成：切回窗口 → 增量读 XMP → 界面回填 / 冲突裁决。
 *
 * 单元测试证明了 hook 的分支与弹窗的三选一；这一层证明**它们真的接在一起**：
 * 聚焦事件能走到 IPC、返回值能落到宫格的星级上、冲突弹窗里点「应用」才写盘、
 * 弹窗出现的那一刻一个字节都没写。
 *
 * 出口标准（报告 §8.2）：「外部 mtime 变化可增量读；冲突三选一；不自动覆盖；
 * 汇总提示」—— 四条各有一个用例。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { invokeCalls, invokeCount, mockInvokeCommand } from './test/setup';
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
  groups: [group('IMG_0001')],
  totalCount: 1,
  jpgFolder: 'D:/shoot/JPG',
  rawFolder: '',
  isViewerMode: false,
};

const emptyReport = () => ({
  checked: 0,
  unchanged: 0,
  baselined: 0,
  adopted: [],
  conflicts: [],
  failed: [],
});

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
  mockInvokeCommand('refresh_from_xmp_cmd', emptyReport());
}

/** 启动 → 扫描出一张照片。 */
async function scanOne() {
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);
  await screen.findByText(/扫描完成/);
}

/** 派发一次窗口聚焦并等防抖走完（真实计时器，600ms）。 */
async function windowFocus() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}

const gridCell = () =>
  document.querySelector<HTMLElement>('[role="option"][aria-posinset]');

afterEach(() => {
  vi.useRealTimers();
});

describe('FR-08 —— 聚焦增量读取', () => {
  it('切回窗口：只把变化的那张读回来，界面跟着磁盘走', async () => {
    mockStartup();
    await scanOne();
    // 界面此刻是「未打分」
    expect(gridCell()!.getAttribute('aria-label')).toContain('未打分');

    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      checked: 1,
      adopted: [
        {
          path: 'D:/shoot/JPG/IMG_0001.jpg',
          state: { rating: 4, flag: 'pick', label: 'Red' },
          sidecarRemoved: false,
        },
      ],
    });

    await windowFocus();

    await waitFor(() => expect(invokeCount('refresh_from_xmp_cmd')).toBe(1));
    // 请求里的目标就是分组主路径（RAW 优先，这里只有 JPG）
    expect(invokeCalls('refresh_from_xmp_cmd')[0].args?.targets).toEqual([
      { path: 'D:/shoot/JPG/IMG_0001.jpg', jpgPath: 'D:/shoot/JPG/IMG_0001.jpg' },
    ]);

    await waitFor(() => {
      const label = gridCell()!.getAttribute('aria-label') ?? '';
      expect(label).toContain('4 星');
      expect(label).toContain('已保留');
      expect(label).toContain('色标红');
    });
    expect(await screen.findByText(/已从 XMP 更新 1 张/)).toBeInTheDocument();
  });

  it('baselined / unchanged 一律静默：升级用户首次刷新不该刷屏', async () => {
    mockStartup();
    await scanOne();
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      checked: 1,
      baselined: 1,
    });

    await windowFocus();
    await waitFor(() => expect(invokeCount('refresh_from_xmp_cmd')).toBe(1));

    expect(screen.queryByText(/已从 XMP 更新/)).not.toBeInTheDocument();
    expect(screen.queryByText(/有冲突待处理/)).not.toBeInTheDocument();
  });
});

describe('FR-08 —— 冲突不自动覆盖', () => {
  it('冲突弹窗出现时一个字节都没写', async () => {
    mockStartup();
    await scanOne();
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      conflicts: [
        {
          path: 'D:/shoot/JPG/IMG_0001.jpg',
          local: { rating: 5, flag: 'pick', label: '' },
          external: { rating: 1, flag: 'none', label: '' },
        },
      ],
    });

    await windowFocus();

    expect(await screen.findByText('XMP 已被其他程序修改')).toBeInTheDocument();
    expect(screen.getByText(/本地（未写盘）/)).toBeInTheDocument();
    // 关键：没有替用户做决定
    expect(invokeCount('resolve_xmp_conflicts_cmd')).toBe(0);
    expect(invokeCount('update_rating_flag_cmd')).toBe(0);
    // 汇总提示同时说明「有待处理」
    expect(await screen.findByText(/1 张有冲突待处理/)).toBeInTheDocument();
  });

  it('选「采用外部」→ 应用：才发裁决，界面回填、弹窗关闭', async () => {
    mockStartup();
    await scanOne();
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      conflicts: [
        {
          path: 'D:/shoot/JPG/IMG_0001.jpg',
          local: { rating: 5, flag: 'pick', label: '' },
          external: { rating: 2, flag: 'reject', label: 'Blue' },
        },
      ],
    });
    mockInvokeCommand('resolve_xmp_conflicts_cmd', {
      applied: [
        {
          path: 'D:/shoot/JPG/IMG_0001.jpg',
          state: { rating: 2, flag: 'reject', label: 'Blue' },
          sidecarRemoved: false,
        },
      ],
      failed: [],
    });

    await windowFocus();
    await screen.findByText('XMP 已被其他程序修改');

    fireEvent.click(screen.getByRole('radio', { name: 'IMG_0001.jpg 采用外部' }));
    // 先确认选择真的落到了控件上：否则下面的断言失败会看起来像「后端没收到」
    expect(
      screen.getByRole('radio', { name: 'IMG_0001.jpg 采用外部' }),
    ).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: '应用 1 张' }));

    await waitFor(() => expect(invokeCount('resolve_xmp_conflicts_cmd')).toBe(1));
    expect(invokeCalls('resolve_xmp_conflicts_cmd')[0].args?.choices).toEqual([
      {
        path: 'D:/shoot/JPG/IMG_0001.jpg',
        action: 'use-external',
        external: { rating: 2, flag: 'reject', label: 'Blue' },
      },
    ]);

    await waitFor(() => {
      const label = gridCell()!.getAttribute('aria-label') ?? '';
      expect(label).toContain('2 星');
      expect(label).toContain('已淘汰');
      expect(label).toContain('色标蓝');
    });
    await waitFor(() =>
      expect(screen.queryByText('XMP 已被其他程序修改')).not.toBeInTheDocument(),
    );
  });

  it('取消弹窗：不发裁决、不写盘，界面保持原样', async () => {
    mockStartup();
    await scanOne();
    mockInvokeCommand('refresh_from_xmp_cmd', {
      ...emptyReport(),
      conflicts: [
        {
          path: 'D:/shoot/JPG/IMG_0001.jpg',
          local: { rating: 5, flag: 'pick', label: '' },
          external: { rating: 1, flag: 'none', label: '' },
        },
      ],
    });

    await windowFocus();
    await screen.findByText('XMP 已被其他程序修改');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() =>
      expect(screen.queryByText('XMP 已被其他程序修改')).not.toBeInTheDocument(),
    );
    expect(invokeCount('resolve_xmp_conflicts_cmd')).toBe(0);
    expect(invokeCount('update_rating_flag_cmd')).toBe(0);
    expect(gridCell()!.getAttribute('aria-label')).toContain('未打分');
  });
});

describe('FR-08 —— 手动入口', () => {
  it('点「从 XMP 重新读取」也会发一次（不必等聚焦）', async () => {
    mockStartup();
    await scanOne();

    fireEvent.click(screen.getByRole('button', { name: '从 XMP 重新读取' }));
    await waitFor(() => expect(invokeCount('refresh_from_xmp_cmd')).toBe(1));
  });

  it('扫描进行中点击：当场说明被谁挡住（不是静默无反应）', async () => {
    mockStartup();
    // 扫描永不返回 → 停在运行态
    mockInvokeCommand('scan_folders_cmd', () => new Promise(() => {}));
    render(<App />);

    const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
    await waitFor(() => expect(scanBtn).toBeEnabled());
    fireEvent.click(scanBtn);
    await waitFor(() => expect(scanBtn).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: '从 XMP 重新读取' }));

    expect(
      await screen.findByText('正在扫描照片，暂时不能读取 XMP。'),
    ).toBeInTheDocument();
    expect(invokeCount('refresh_from_xmp_cmd')).toBe(0);
  });
});
