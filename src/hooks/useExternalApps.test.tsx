/**
 * issue #106：外部打开的静默回落必须可见。
 * - 后端 `open_in_photoshop_cmd` 路径缺失时返回 false（走了默认程序）。
 * - 前端 `openInPhotoshop` 抛错时回落默认程序成功也要 toast。
 * 两条都走 toast，测到才算锁住；改回 `console.warn` 静默必红。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { mockInvokeCommand, mockInvokeError } from '../test/setup';
import { useExternalApps } from './useExternalApps';
import { makeGroup, makeFile } from '../test/factories';

const { toastApi, toastCalls } = vi.hoisted(() => {
  const calls: { kind: 'success' | 'error' | 'info'; message: string }[] = [];
  const push =
    (kind: 'success' | 'error' | 'info') => (message: string) => {
      calls.push({ kind, message });
    };
  return {
    toastCalls: calls,
    toastApi: { success: push('success'), error: push('error'), info: push('info') },
  };
});

vi.mock('../components/Toast', () => ({ useToast: () => toastApi }));

const group = makeGroup('g1', {
  baseName: 'DSC00001',
  raw: makeFile('D:/shoot/RAW/DSC00001.ARW', { extension: 'ARW', size: 1, mtime: 1 }),
  jpg: makeFile('D:/shoot/JPG/DSC00001.JPG', { extension: 'JPG', size: 1, mtime: 1 }),
  status: 'COMPLETE',
});

const setup = () =>
  renderHook(() =>
    useExternalApps({
      currentGroup: group,
      photoshopPath: 'C:/Program Files/Adobe/Adobe Photoshop 2026/Photoshop.exe',
      onGroupPatched: () => {},
    }),
  );

beforeEach(() => {
  toastCalls.length = 0;
});

describe('useExternalApps —— 回落必须可见 (issue #106)', () => {
  it('后端回落(false)时 toast 提示已改用默认程序带设置指引', async () => {
    mockInvokeCommand('open_in_photoshop_cmd', false);
    const { result } = setup();
    await act(async () => {
      await result.current.openExternal();
    });
    expect(toastCalls.some((c) => c.message.includes('默认程序'))).toBe(true);
    expect(toastCalls.some((c) => c.message.includes('Photoshop 路径'))).toBe(true);
  });

  it('PS 启动失败回落成功时同样要 toast（而非仅 console.warn）', async () => {
    mockInvokeError('open_in_photoshop_cmd', new Error('启动 Photoshop 失败'));
    mockInvokeCommand('open_in_default_app_cmd', true);
    const { result } = setup();
    await act(async () => {
      await result.current.openExternal();
    });
    expect(toastCalls.some((c) => c.message.includes('默认程序'))).toBe(true);
  });

  it('PS 直连成功时不走回落 toast', async () => {
    mockInvokeCommand('open_in_photoshop_cmd', true);
    const { result } = setup();
    await act(async () => {
      await result.current.openExternal();
    });
    expect(toastCalls.some((c) => c.message.includes('默认程序'))).toBe(false);
  });
});
