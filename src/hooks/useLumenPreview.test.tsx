/**
 * LUMEN RAW 预览 hook 的降级契约。
 *
 * 这个 hook 的全部价值在于"什么时候**不**发请求"：翻片时引擎抖动、切换照片时
 * 的旧 promise，都不能变成重试风暴或串图。所以断言以 invoke 次数为主。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLumenPreview } from './useLumenPreview';
import { LUMEN_UNAVAILABLE } from './useLumenStatus';
import {
  invokeCalls,
  invokeCount,
  lastInvokeArgs,
  mockInvokeCommand,
  mockInvokeError,
} from '../test/setup';
import type { LumenStatus, PhotoGroupInfo } from '../types';

const available: LumenStatus = {
  available: true,
  enabled: true,
  pinnedVersion: '0.5.2',
  foundVersion: '0.5.2',
  detail: 'ok',
};

function photo(id: string, overrides: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    raw: {
      name: `${id}.CR3`,
      extension: 'CR3',
      path: `D:/shoot/${id}.CR3`,
      size: 1,
      mtime: 0,
    },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    hasXmp: false,
    ...overrides,
  };
}

describe('useLumenPreview', () => {
  it('引擎未启用时零请求：连 lumen_preview_cmd 都不该发出', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: 'p.jpg', width: 1600, original: false, cached: false });

    renderHook(() => useLumenPreview(photo('a'), LUMEN_UNAVAILABLE));

    await Promise.resolve();

    expect(invokeCount('lumen_preview_cmd')).toBe(0);
    expect(invokeCalls('lumen_preview_cmd')).toHaveLength(0);
  });

  it('有 JPG 时零请求（JPG 优先，速度优先）', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: 'p.jpg', width: 1600, original: false, cached: false });

    renderHook(() =>
      useLumenPreview(
        photo('a', {
          jpg: { name: 'a.jpg', extension: 'jpg', path: 'D:/shoot/a.jpg', size: 1, mtime: 0 },
        }),
        available,
      ),
    );

    await Promise.resolve();
    expect(invokeCount('lumen_preview_cmd')).toBe(0);
  });

  it('无 raw 路径时零请求', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: 'p.jpg', width: 1600, original: false, cached: false });

    renderHook(() => useLumenPreview(photo('a', { raw: undefined, status: 'JPG_ONLY' }), available));

    await Promise.resolve();
    expect(invokeCount('lumen_preview_cmd')).toBe(0);
  });

  it('有效 previewPath 经 convertFileSrc 转成 asset URL', async () => {
    mockInvokeCommand('lumen_preview_cmd', {
      previewPath: 'C:/cache/a-1600.jpg',
      width: 1600,
      original: false,
      cached: true,
    });

    const { result } = renderHook(() => useLumenPreview(photo('a'), available));

    await waitFor(() => expect(result.current.url).not.toBeNull());

    expect(result.current.url).toBe('asset://localhost/C:/cache/a-1600.jpg');
    expect(result.current.failed).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('按 rawPath + width + original=false 请求', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: 'p.jpg', width: 1600, original: false, cached: false });

    renderHook(() => useLumenPreview(photo('a'), available, 2200));
    await waitFor(() => expect(invokeCount('lumen_preview_cmd')).toBe(1));

    expect(lastInvokeArgs('lumen_preview_cmd')).toMatchObject({
      filePath: 'D:/shoot/a.CR3',
      width: 2200,
      original: false,
    });
  });

  it('previewPath=null → 标记 failed 且不重试成风暴', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: null, width: 1600, original: false, cached: false });

    const { result, rerender } = renderHook(({ group }: { group: PhotoGroupInfo }) =>
      useLumenPreview(group, available),
      { initialProps: { group: photo('a') } },
    );

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.url).toBeNull();

    // 反复 rerender（真实场景里光标/滚动会持续触发父组件重渲染）不应再发请求
    for (let i = 0; i < 5; i++) {
      rerender({ group: photo('a') });
      await Promise.resolve();
    }
    expect(invokeCount('lumen_preview_cmd')).toBe(1);
  });

  it('渲染失败（invoke 抛错）→ failed，且不产生未捕获异常', async () => {
    mockInvokeError('lumen_preview_cmd', new Error('sidecar crashed'));

    const onUnhandled = vi.fn();
    window.addEventListener('unhandledrejection', onUnhandled);

    const { result } = renderHook(() => useLumenPreview(photo('a'), available));

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.url).toBeNull();
    expect(result.current.loading).toBe(false);

    window.removeEventListener('unhandledrejection', onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it('同一张图最多尝试 MAX_ATTEMPTS=2 次，之后彻底静默', async () => {
    mockInvokeError('lumen_preview_cmd', new Error('sidecar crashed'));

    // width 在依赖数组里，改它就能在**不换图**的前提下强制 effect 重跑
    const { result, rerender } = renderHook(
      ({ group, width }: { group: PhotoGroupInfo; width: number }) =>
        useLumenPreview(group, available, width),
      { initialProps: { group: photo('a'), width: 1600 } },
    );

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(invokeCount('lumen_preview_cmd')).toBe(1);

    // 第二次尝试：仍允许
    rerender({ group: photo('a'), width: 1601 });
    await waitFor(() => expect(invokeCount('lumen_preview_cmd')).toBe(2));

    // 第三次：已达上限，直接标 failed，不再发请求
    rerender({ group: photo('a'), width: 1602 });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(invokeCount('lumen_preview_cmd')).toBe(2);
  });

  it('切换照片同步作废旧 URL（防串图），不必等新预览回来', async () => {
    // 让 b 的预览挂住，才能观察到「旧 URL 被立刻清空」这个中间态
    let resolveB!: (v: unknown) => void;
    mockInvokeCommand('lumen_preview_cmd', (args) => {
      if (String(args?.filePath).includes('b.CR3')) {
        return new Promise((r) => {
          resolveB = r as (v: unknown) => void;
        });
      }
      return {
        previewPath: String(args?.filePath) + ".thumb",
        width: 1600,
        original: false,
        cached: false,
      };
    });

    const { result, rerender } = renderHook(({ group }: { group: PhotoGroupInfo }) =>
      useLumenPreview(group, available),
      { initialProps: { group: photo('a') } },
    );

    await waitFor(() => expect(result.current.url).toContain('a.CR3'));

    // 不 await act：effect 同步跑完，旧 URL 必须已经没了
    rerender({ group: photo('b') });
    expect(result.current.url).toBeNull();

    await act(async () => {
      resolveB({ previewPath: 'b.preview', width: 1600, original: false, cached: false });
      await Promise.resolve();
    });
    expect(result.current.url).toBe('asset://localhost/b.preview');
  });

  it('卸载后迟到的响应被丢弃（不写 state、不告警）', async () => {
    let resolve!: (v: unknown) => void;
    mockInvokeCommand('lumen_preview_cmd', () => new Promise((r) => (resolve = r)));

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useLumenPreview(photo('a'), available));

    await waitFor(() => expect(invokeCount('lumen_preview_cmd')).toBe(1));
    unmount();

    await act(async () => {
      resolve({ previewPath: 'late.jpg', width: 1600, original: false, cached: false });
      await Promise.resolve();
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
