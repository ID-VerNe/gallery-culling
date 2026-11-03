/**
 * issue #18 · PB-13 右侧栏交叉淡入——结构契约（jsdom 测不了过渡视觉）。
 *
 * 钉的三件事：
 *  1. 右侧栏容器有过渡类（`transition-opacity` + `duration-`），交叉淡入靠它。
 *  2. 切换瞬间，旧面板标 `data-exiting="true"` 仍在 DOM 里（退场面板延迟卸载）。
 *  3. 推进 EXIT_MS 后，退场面板才从 DOM 卸载。
 *
 * 不钉：过渡看着顺不顺（jsdom 不渲染像素，由真机回签）。
 *
 * 计时器说明：不用 `vi.useFakeTimers()`——它会卡住 RTL 的 `findByText/findByRole`
 * 轮询（那些内部也走 setTimeout）。退场延迟只有 200ms（`EXIT_MS`），直接用真实计时器 +
 * `waitFor`（默认 1s 足够覆盖）。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { mockInvokeCommand } from './test/setup';
import type { FolderScanResult, PhotoGroupInfo, ToneState } from './types';
import { DEFAULT_TONE } from './utils/autoTone';

const group: PhotoGroupInfo = {
  id: 'IMG_0001',
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

async function scanPhotos() {
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);
  await screen.findByText(/扫描完成/);
}

const togglePanel = () =>
  fireEvent.click(screen.getAllByRole('button', { name: '调色面板' })[0]);

describe('App 右侧栏交叉淡入（PB-13）', () => {
  it('右侧栏容器带 transition-opacity + duration 类', async () => {
    mockStartup();
    await scanPhotos();
    const sidebar = document.querySelector('[data-testid="right-sidebar"]');
    expect(sidebar).not.toBeNull();
    expect(sidebar!.className).toContain('transition-opacity');
    expect(sidebar!.className).toMatch(/duration-\d+/);
  });

  it('切换瞬间旧面板仍挂载且带 data-exiting，新面板不带', async () => {
    mockStartup();
    await scanPhotos();

    // 起点：宫格在场（没有 data-exiting）
    let gridPanel = document.querySelector('[data-testid="sidebar-grid"]');
    expect(gridPanel).not.toBeNull();
    expect(gridPanel!.getAttribute('data-exiting')).toBeNull();

    // 切到调色面板
    togglePanel();

    // 调色面板挂载
    const tonalPanel = document.querySelector('[data-testid="sidebar-tonal"]');
    expect(tonalPanel).not.toBeNull();
    expect(tonalPanel!.getAttribute('data-exiting')).toBeNull();
    // 宫格仍在 DOM，但标了 data-exiting
    gridPanel = document.querySelector('[data-testid="sidebar-grid"]');
    expect(gridPanel).not.toBeNull();
    expect(gridPanel!.getAttribute('data-exiting')).toBe('true');
  });

  it('推进 EXIT_MS 后退场面板从 DOM 卸载', async () => {
    mockStartup();
    await scanPhotos();
    togglePanel();
    // 切换瞬间宫格仍在
    expect(document.querySelector('[data-testid="sidebar-grid"]')).not.toBeNull();
    // 退场延迟只有 200ms（EXIT_MS）；waitFor 默认 1s 足够覆盖
    await waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-grid"]')).toBeNull();
    });
    // 调色面板仍在
    expect(document.querySelector('[data-testid="sidebar-tonal"]')).not.toBeNull();
  });
});
