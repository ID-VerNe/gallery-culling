/**
 * 键盘星级 toggle 端到端（issue #65）：
 * `useKeyboardShortcuts` 的数字键 → `applyRating` → `rate()` 的整条链路。
 *
 * 缺陷背景：帮助弹窗写「再按一次同星取消」，但键盘路径一直写回同值；
 * 鼠标点击底栏当前星级却能清零。这里锁住键盘侧，并确认 `Shift+1` 色标
 * 不会被误当成「同键取消」。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { invokeCount, lastInvokeArgs, mockInvokeCommand } from './test/setup';
import { makeSettings } from './test/settingsFactory';

const photo = (i: number, over: Record<string, unknown> = {}) => ({
  id: `p${i}`,
  baseName: `IMG_${i}`,
  jpg: { name: `IMG_${i}.JPG`, extension: 'JPG', path: `D:/shoot/IMG_${i}.JPG`, size: 1, mtime: 0 },
  raw: { name: `IMG_${i}.CR3`, extension: 'CR3', path: `D:/shoot/IMG_${i}.CR3`, size: 1, mtime: 0 },
  status: 'PAIRED',
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
  ...over,
});

function mockStartup(groups: unknown[]) {
  mockInvokeCommand('get_settings_cmd', makeSettings());
  mockInvokeCommand('save_settings_cmd', true);
  mockInvokeCommand('save_session_cmd', true);
  mockInvokeCommand('scan_folders_cmd', {
    groups,
    totalFiles: groups.length * 2,
    skippedFiles: 0,
  });
  mockInvokeCommand('load_session_cmd', null);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('update_rating_flag_cmd', true);
}

async function scan(groups: unknown[]) {
  mockStartup(groups);
  render(<App />);
  const btn = await screen.findByRole('button', { name: /扫描照片目录/ });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.click(btn);
  await screen.findByText(/扫描完成/);
}

const cellLabel = () =>
  (document.querySelector('[role="option"]') as HTMLElement).getAttribute('aria-label') ?? '';

describe('键盘星级 toggle（issue #65）', () => {
  beforeEach(() => {
    invokeCount('update_rating_flag_cmd');
  });

  it('★同一数字键再按一次：1 星清零', async () => {
    await scan([photo(1), photo(2), photo(3)]);

    fireEvent.keyDown(document.body, { key: '1' });
    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(1));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 1 });

    fireEvent.keyDown(document.body, { key: '1' });
    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(2));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 0 });
    await waitFor(() => expect(cellLabel()).toContain('未打分'));
  });

  it('不同数字键：1 星 → 2 星', async () => {
    await scan([photo(1, { rating: 1 }), photo(2), photo(3)]);

    fireEvent.keyDown(document.body, { key: '2' });

    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(1));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 2 });
    await waitFor(() => expect(cellLabel()).toContain('2 星'));
  });

  it('Shift+1 只改色标，不把星级当成「同键取消」', async () => {
    await scan([photo(1, { rating: 3 }), photo(2), photo(3)]);

    fireEvent.keyDown(document.body, { key: '!', code: 'Digit1', shiftKey: true });

    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(1));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({
      rating: 3,
      label: 'Red',
    });
  });

  it('toggle 清零后按 R：星级仍为 0，旗标归零', async () => {
    await scan([photo(1, { rating: 2 }), photo(2), photo(3)]);

    fireEvent.keyDown(document.body, { key: '2' });
    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(1));
    // 第一步必须先证明 toggle 生效：未修复时这里读到 2，后面 R 也会归零，
    // 只断言最终值会让该用例在 base 上假绿（评审阻断项）。
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 0 });

    fireEvent.keyDown(document.body, { key: '2' });
    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(2));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 2 });

    fireEvent.keyDown(document.body, { key: 'r' });
    await waitFor(() => expect(invokeCount('update_rating_flag_cmd')).toBe(3));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({
      rating: 0,
      flag: 'none',
    });
  });
});
