/**
 * 空格「设为基准」必须落在**当前照片**上。
 *
 * 缺陷：原实现一律钉 `rightCompareGroup`，而无基准时 `deriveCompareGroups` 总让
 * right = `compareIndex` 那张 —— 单图视口下按空格会把**另一张**照片钉为基准，
 * 界面上完全看不出发生了什么（与 ShortcutHelpModal 承诺的「空格 = 设为基准」矛盾）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { mockInvokeCommand } from './test/setup';

// 用例间必须彻底卸载：焦点会残留在上一棵树的节点上，而空格快捷键要判断
// `document.activeElement` 是否可激活，残留焦点会让断言互相干扰。
beforeEach(() => {
  cleanup();
  (document.activeElement as HTMLElement | null)?.blur?.();
});

const photo = (i: number) => ({
  id: `p${i}`,
  baseName: `IMG_${i}`,
  jpg: { name: `IMG_${i}.JPG`, extension: 'JPG', path: `D:/shoot/IMG_${i}.JPG`, size: 1, mtime: 0 },
  raw: { name: `IMG_${i}.CR3`, extension: 'CR3', path: `D:/shoot/IMG_${i}.CR3`, size: 1, mtime: 0 },
  status: 'PAIRED',
  rating: 0,
  flag: 'none',
  label: '', hasXmp: false,
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
  mockInvokeCommand('load_session_cmd', null);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('get_tone_state_cmd', {
    tone: { exposure: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, contrast: 0 },
    xmpTone: { exposure: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, contrast: 0 },
    lumenTone: null,
    divergent: false,
    lumenAvailable: false,
  });
  mockInvokeCommand('update_rating_flag_cmd', true);
  mockInvokeCommand('scan_folders_cmd', {
    groups: [photo(1), photo(2), photo(3), photo(4)],
    totalFiles: 8,
    skippedFiles: 0,
  });
}

/** 只取缩略图宫格里的格子：页面上还有筛选下拉等别的 `role="option"`。 */
const gridCells = () =>
  within(screen.getByRole('listbox')).queryAllByRole('option');

const cellAt = (pos: number) =>
  gridCells().find((el) => el.getAttribute('aria-posinset') === String(pos))!;

async function scanTo(pos: number) {
  mockStartup();
  render(<App />);
  const btn = await screen.findByRole('button', { name: /扫描照片目录/ });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.click(btn);
  await screen.findByText(/扫描完成/);
  await waitFor(() => expect(gridCells().length).toBeGreaterThanOrEqual(4));
  // 移到第 pos 张（aria-posinset 是 1-based，且不受虚拟化重渲染影响）
  fireEvent.click(cellAt(pos));
  await waitFor(() => expect(cellAt(pos).getAttribute('aria-selected')).toBe('true'));
}

const pinnedPositions = () =>
  gridCells()
    .map((el) =>
      /已设为对比基准/.test(el.getAttribute('aria-label') ?? '')
        ? Number(el.getAttribute('aria-posinset'))
        : null,
    )
    .filter((n): n is number => n !== null);

describe('空格设基准 —— 落在当前照片', () => {
  it('★单图视口按空格，基准 = 当前照片（不是别的照片）', async () => {
    await scanTo(3);
    fireEvent.keyDown(document.body, { key: ' ' });
    await waitFor(() => expect(pinnedPositions()).toEqual([3]));
  });

  it('★已钉基准时，点另一张再按空格 = 先取消旧基准（不留两处）', async () => {
    await scanTo(2);
    fireEvent.keyDown(document.body, { key: ' ' });
    await waitFor(() => expect(pinnedPositions()).toEqual([2]));

    // 点另一张：宫格 onMouseDown 会 preventDefault，焦点仍在 body
    fireEvent.mouseDown(cellAt(4));
    fireEvent.click(cellAt(4));
    await waitFor(() => expect(cellAt(4).getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(document.body, { key: ' ' });

    // 空格是"切换"语义：已钉住时按空格 = 取消，不会出现两处基准
    await waitFor(() => expect(pinnedPositions().length).toBeLessThanOrEqual(1));
  });

  it('★取消后按空格，基准落在新的当前照片上', async () => {
    await scanTo(2);
    fireEvent.keyDown(document.body, { key: ' ' });
    await waitFor(() => expect(pinnedPositions()).toEqual([2]));
    // 先取消
    fireEvent.keyDown(document.body, { key: ' ' });
    await waitFor(() => expect(pinnedPositions()).toEqual([]));
    // 移到第 4 张，再钉
    fireEvent.mouseDown(cellAt(4));
    fireEvent.click(cellAt(4));
    await waitFor(() => expect(cellAt(4).getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(document.body, { key: ' ' });
    await waitFor(() => expect(pinnedPositions()).toEqual([4]));
  });

  it('对同一张连按两次空格 = 取消基准', async () => {
    await scanTo(1);
    fireEvent.keyDown(document.body, { key: ' ' });
    await waitFor(() => expect(pinnedPositions()).toEqual([1]));
    fireEvent.keyDown(document.body, { key: ' ' });
    await waitFor(() => expect(pinnedPositions()).toEqual([]));
  });
});