/**
 * 引擎握手状态。两个重点：
 *  1. enabled=false 时**零 invoke**（设置里关掉开关 = 一个包都不发）；
 *  2. detail 是后端给的唯一诊断信息，必须原样透传到 UI，不许被前端改写。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { LUMEN_UNAVAILABLE, useLumenStatus } from './useLumenStatus';
import { invokeCount, lastInvokeArgs, mockInvokeCommand, mockInvokeError } from '../test/setup';

/** 握手刻意延迟 1500ms（不阻塞首屏、给 sidecar 冷启动留时间）。 */
const HANDSHAKE_DELAY = 1500;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 推进定时器并把 promise 链冲干净。 */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useLumenStatus', () => {
  it('enabled=false 时零请求，直接返回降级默认态', async () => {
    mockInvokeCommand('lumen_status_cmd', {
      available: true,
      enabled: true,
      pinnedVersion: '0.5.2',
      foundVersion: '0.5.2',
      detail: 'ok',
    });

    const { result } = renderHook(() => useLumenStatus(false));

    await advance(HANDSHAKE_DELAY + 200);

    expect(invokeCount('lumen_status_cmd')).toBe(0);
    expect(result.current).toEqual(LUMEN_UNAVAILABLE);
    expect(result.current.available).toBe(false);
  });

  it('enabled=true 时延迟握手（不阻塞首屏）', async () => {
    mockInvokeCommand('lumen_status_cmd', {
      available: true,
      enabled: true,
      pinnedVersion: '0.5.2',
      foundVersion: '0.5.2',
      detail: 'ok',
    });

    renderHook(() => useLumenStatus(true));

    // 立刻断言：还没到 1500ms，不应该发
    await advance(200);
    expect(invokeCount('lumen_status_cmd')).toBe(0);

    await advance(HANDSHAKE_DELAY);
    expect(invokeCount('lumen_status_cmd')).toBe(1);
    expect(lastInvokeArgs('lumen_status_cmd')).toBeUndefined();
  });

  it('available=false 时徽标文案走 detail 降级分支', async () => {
    const detail = '未找到 lumen-cli.exe（已查 PATH 与设置中的路径）';
    mockInvokeCommand('lumen_status_cmd', {
      available: false,
      enabled: true,
      pinnedVersion: '0.5.2',
      foundVersion: null,
      detail,
    });

    const { result } = renderHook(() => useLumenStatus(true));

    await advance(HANDSHAKE_DELAY); expect(result.current.enabled).toBe(true);
    expect(result.current.available).toBe(false);
    expect(result.current.detail).toBe(detail);
  });

  it('版本不匹配时 detail 被如实带回，不被前端改写', async () => {
    const detail = 'LUMEN RAW 版本不匹配：需要 0.5.2，实际找到 0.4.8';
    mockInvokeCommand('lumen_status_cmd', {
      available: false,
      enabled: true,
      pinnedVersion: '0.5.2',
      foundVersion: '0.4.8',
      detail,
    });

    const { result } = renderHook(() => useLumenStatus(true));

    await advance(HANDSHAKE_DELAY); expect(result.current.detail).toBe(detail);
    // 版本信息也要留着，UI 才能显示"实际找到 X"
    expect(result.current.foundVersion).toBe('0.4.8');
    expect(result.current.pinnedVersion).toBe('0.5.2');
  });

  it('握手成功时返回完整状态', async () => {
    mockInvokeCommand('lumen_status_cmd', {
      available: true,
      enabled: true,
      pinnedVersion: '0.5.2',
      foundVersion: '0.5.2',
      detail: '已连接',
    });

    const { result } = renderHook(() => useLumenStatus(true));

    await advance(HANDSHAKE_DELAY); expect(result.current.available).toBe(true);
    expect(result.current.foundVersion).toBe('0.5.2');
  });

  it('握手抛错不外泄，静默降级为不可用并给出可读原因', async () => {
    mockInvokeError('lumen_status_cmd', new Error('boom'));

    const { result } = renderHook(() => useLumenStatus(true));

    await advance(HANDSHAKE_DELAY); expect(result.current.detail).toContain('无法连接 LUMEN RAW');
    expect(result.current.available).toBe(false);
    // 请求发出过 = 开关确实是开的，只是连不上
    expect(result.current.enabled).toBe(true);
  });

  it('enabled 从 true 翻到 false 会取消未触发的握手', async () => {
    mockInvokeCommand('lumen_status_cmd', {
      available: true,
      enabled: true,
      pinnedVersion: '0.5.2',
      foundVersion: '0.5.2',
      detail: 'ok',
    });

    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useLumenStatus(enabled), {
      initialProps: { enabled: true },
    });

    rerender({ enabled: false });

    await advance(HANDSHAKE_DELAY + 200);

    expect(invokeCount('lumen_status_cmd')).toBe(0);
    expect(result.current).toEqual(LUMEN_UNAVAILABLE);
  });
});
