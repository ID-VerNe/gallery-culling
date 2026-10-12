/**
 * N-14(a) / §6 第 7 行：评级与旗标的 **XMP 写入失败路径**。
 *
 * 语义（必须读准再断言，别把乐观更新写成回滚）：
 *  `handleRate` / `handleFlag` 先**乐观更新本地 UI**，再 `await update_rating_flag_cmd`。
 *  失败时 `reportRatingFlagError` **只弹一个错误 toast**，**不回滚 UI** —— 文案明确写
 *  「界面上的星级和保留/淘汰仍然有效，但不会同步到 Lightroom」。
 *  这是**有意对齐失败（diverged）**的契约：本机可用、侧边栏暂未落盘。
 *
 * 因此三条断言是：
 *  1. 失败弹出错误提示，且文案含「XMP」/「不会同步」；
 *  2. UI 的星级/旗标**仍是新值**（乐观更新保留）——修复成"回滚"反而不符语义；
 *  3. 失败**不产生未处理的 Promise rejection**（错误出口必须兜住）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { mockInvokeCommand, mockInvokeError } from './test/setup';
import type { FolderScanResult, PhotoGroupInfo, ToneState } from './types';
import { DEFAULT_TONE } from './utils/autoTone';

const group: PhotoGroupInfo = {
  id: 'img_0001',
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
}

/** 启动 → 扫描出一张照片，停在单图视口（星级/旗标按钮就绪）。 */
async function scanOne() {
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);
  await screen.findByText(/扫描完成/);
}

// tsconfig 只配 DOM lib，不引 node 类型 —— 用结构化断言拿 process。
const proc = () =>
  (globalThis as unknown as {
    process: {
      on: (e: string, f: (r: unknown) => void) => void;
      off: (e: string, f: (r: unknown) => void) => void;
    };
  }).process;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App —— 评级/旗标 XMP 写入失败 (N-14a)', () => {
  it('评级写入失败：弹错误提示（含 XMP / 不会同步），但星级仍是新值、无未处理 rejection', async () => {
    // reportRatingFlagError 会 console.error —— 抑制噪声，但保留 toast 断言。
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    proc().on('unhandledRejection', unhandled);

    mockStartup();
    mockInvokeError('update_rating_flag_cmd', new Error('disk full'));
    await scanOne();

    fireEvent.click(screen.getByLabelText('评 3 星'));

    // 1) 错误出口：明确告知未写盘、且不会同步到 Lightroom。
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/XMP/);
      expect(alert).toHaveTextContent(/不会同步/);
    });

    // 2) 乐观更新保留：星级**仍然是新值**（不是回滚到 0）。
    expect(screen.getByLabelText('评 3 星')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('评 1 星')).toHaveAttribute('aria-pressed', 'true');

    // 3) 没有未处理的 rejection：错误被 handleRate 的 catch 兜住。
    proc().off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('旗标写入失败：弹错误提示，但保留/淘汰标记仍是新值（乐观更新不回滚）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    proc().on('unhandledRejection', unhandled);

    mockStartup();
    mockInvokeError('update_rating_flag_cmd', new Error('permission denied'));
    await scanOne();

    fireEvent.click(screen.getByLabelText('标记保留 (Pick)'));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/不会同步/),
    );

    // UI 仍是 Pick（aria-pressed=true），证明没有回滚。
    expect(screen.getByLabelText('标记保留 (Pick)')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // 淘汰按钮不应被误置。
    expect(screen.getByLabelText('标记淘汰 (Reject)')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    proc().off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
