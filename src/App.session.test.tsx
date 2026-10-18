/**
 * N-14(b) / §6 第 8 行：扫描会话的**保存 / 恢复**。
 *
 * M-17 把会话写盘改成 500ms 防抖（`useSessionDebounce`，四个 flush 点：目录切换 /
 * 卸载 / 页面隐藏-beforeunload / Tauri 关闭请求）。所以这里断言的是「**合并后的**
 * 最终一次写入」，不是「每次翻页都写」：
 *  1. 连续翻页（窗口内）→ `save_session_cmd` **不增长**；
 *  2. 推进 500ms 窗口 → **只多一次**，且写的是**最后一次**的索引；
 *  3. `load_session_cmd` 给出历史索引 → 扫描后恢复到该索引（经底栏计数间接断言）；
 *  4. 重扫静默丢弃钉基准（既有语义：`handleScan` 里 `setPinnedId(null)`）。
 *
 * 计时器说明：`render(<App/>)` 全程用 **fake timers**，因此**不用 `waitFor`**
 * （RTL 的 waitFor 在 vitest fake timers 下不保证推进）；改用「冲微任务 + 显式
 * `vi.advanceTimersByTime`」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { invokeCount, lastInvokeArgs, mockInvokeCommand } from './test/setup';
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

const allGroups = ['DSC_1001', 'DSC_1002', 'DSC_1003', 'DSC_1004', 'DSC_1005'].map(mkGroup);

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

function mockStartup(history: [number, string] | null = null) {
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
  mockInvokeCommand('load_session_cmd', history);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('get_tone_state_cmd', toneState);
}

/** 冲掉 async 链（invoke 是 async spy，getSettings/scan/loadSession 都是微任务）。 */
async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 推进 fake 时钟并冲一次微任务（防抖回调本身是同步 fire-and-forget 的 async）。 */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush(2);
}

/** 渲染 → 等设置读回 → 点扫描 → 等扫描完成。 */
async function scanCompleted() {
  render(<App />);
  await flush();
  const btn = screen.getByRole('button', { name: '扫描照片目录' });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  await flush();
  expect(screen.getByText(/扫描完成/)).toBeInTheDocument();
  return btn;
}

/** 在「聚焦的」body 上派发键盘事件（派到 window 会让 e.target===window，守卫失真）。 */
const pressNext = () => fireEvent.keyDown(document.body, { key: 'd' });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('App —— 扫描会话防抖保存 (N-14b)', () => {
  it('防抖窗口内的连续翻页合并为一次写，且写的是最后一次的索引', async () => {
    mockStartup(null);
    await scanCompleted();

    // 让「目录设置完成后」排队的那次防抖先落地，得到一个基线。
    await advance(500);
    const base = invokeCount('save_session_cmd');
    expect(base).toBe(1);

    // 窗口内快翻 3 次（0→1→2→3）——都不该触发新的写盘。
    pressNext();
    pressNext();
    pressNext();
    await flush(1);
    expect(invokeCount('save_session_cmd')).toBe(base); // 合并生效，没有随之增长

    // 推进窗口：只多写一次，且 lastIndex 是最后一次（3）。
    await advance(500);
    expect(invokeCount('save_session_cmd')).toBe(base + 1);
    expect(lastInvokeArgs('save_session_cmd')).toMatchObject({ lastIndex: 3 });
  });

  it('load_session_cmd 返回历史索引时，扫描完成后恢复到该索引', async () => {
    // 历史索引 = 2 → 恢复后底栏应为「当前第 3 张，共 5 张」。
    mockStartup([2, 'time_filename']);
    await scanCompleted();
    await advance(500);

    expect(screen.getByLabelText('当前第 3 张，共 5 张')).toBeInTheDocument();
  });

  it('重新扫描会静默丢弃钉基准（既有语义，用测试钉住）', async () => {
    mockStartup(null);
    const scanBtn = await scanCompleted();

    // 进入对比视图
    fireEvent.click(screen.getByRole('button', { name: '双图对比 (快捷键 C)' }));
    await flush(1);

    // 把左图（DSC_1001）设为基准
    fireEvent.click(screen.getByLabelText('将 DSC_1001 锁定为对比基准（[ 或 B）'));
    await flush(1);
    // 基准态：按钮文案翻转为「取消将 … 锁定为对比基准」
    expect(
      screen.getByLabelText('取消将 DSC_1001 锁定为对比基准'),
    ).toBeInTheDocument();

    // 重新扫描 → handleScan 里 setPinnedId(null) 静默清基准
    fireEvent.click(scanBtn);
    await flush();
    expect(screen.getByText(/扫描完成/)).toBeInTheDocument();
    await flush(1);

    // 基准已清：不再存在「取消将 … 锁定为对比基准」的按钮。
    expect(
      screen.queryByLabelText('取消将 DSC_1001 锁定为对比基准'),
    ).toBeNull();
  });
});
