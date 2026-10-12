/**
 * `useTaskProgress` —— M-05 前端的进度订阅与取消。
 *
 * 契约：
 *  - 事件是全局的（无 task_id）→ **只在任务进行中消费事件**，否则丢弃；
 *  - `cancel()` 是协作式取消 → 只发一次取消命令，`isRunning` 在任务 invoke 返回前
 *    保持 true（"取消中"而不是"已停止"）；
 *  - 任务未运行时 `cancel()` 是 no-op（不发 invoke）。
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTaskProgress } from './useTaskProgress';
import {
  emitMockEvent,
  invokeCount,
  mockInvokeCommand,
  mockInvokeError,
} from '../test/setup';

/** `listen()` 是异步的：多刷两次微任务，确保订阅已注册。 */
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe('useTaskProgress', () => {
  it('start 后收到 scan-progress 更新进度，finish 清空', async () => {
    const { result } = renderHook(() => useTaskProgress('scan'));
    await flush();

    act(() => result.current.start());
    expect(result.current.isRunning).toBe(true);
    expect(result.current.progress).toBeNull();

    act(() =>
      emitMockEvent('scan-progress', { phase: 'exif', processed: 3, total: 10 }),
    );
    expect(result.current.progress).toEqual({
      processed: 3,
      total: 10,
      phase: 'exif',
    });

    act(() => result.current.finish());
    expect(result.current.isRunning).toBe(false);
    expect(result.current.progress).toBeNull();
  });

  it('任务未运行时到达的进度事件被丢弃（事件是全局的）', async () => {
    const { result } = renderHook(() => useTaskProgress('export'));
    await flush();

    act(() =>
      emitMockEvent('export-progress', {
        processed: 1,
        total: 2,
        current: 'a.NEF',
      }),
    );
    expect(result.current.progress).toBeNull();
  });

  it('finish 之后到达的事件被忽略，不会残留进度', async () => {
    const { result } = renderHook(() => useTaskProgress('scan'));
    await flush();

    act(() => result.current.start());
    act(() => result.current.finish());
    act(() =>
      emitMockEvent('scan-progress', { phase: 'sort', processed: 1, total: 2 }),
    );
    expect(result.current.progress).toBeNull();
  });

  it('export 事件归一化出 current 字段', async () => {
    const { result } = renderHook(() => useTaskProgress('export'));
    await flush();

    act(() => result.current.start());
    act(() =>
      emitMockEvent('export-progress', {
        processed: 7,
        total: 20,
        current: 'IMG_7.NEF',
      }),
    );
    expect(result.current.progress).toEqual({
      processed: 7,
      total: 20,
      current: 'IMG_7.NEF',
    });
  });

  it('cancel 只发一次对应命令并置 cancelRequested；任务仍在飞行中', async () => {
    mockInvokeCommand('cancel_export_cmd', null);
    const { result } = renderHook(() => useTaskProgress('export'));
    await flush();

    act(() => result.current.start());
    await act(async () => {
      await result.current.cancel();
    });

    expect(invokeCount('cancel_export_cmd')).toBe(1);
    expect(result.current.cancelRequested).toBe(true);
    expect(result.current.isCancelRequested()).toBe(true);
    // 协作式取消：等后端 invoke 返回前，任务仍是"进行中（取消中）"。
    expect(result.current.isRunning).toBe(true);
  });

  it('任务未运行时 cancel 是 no-op（不发 invoke）', async () => {
    mockInvokeCommand('cancel_scan_cmd', null);
    const { result } = renderHook(() => useTaskProgress('scan'));
    await flush();

    await act(async () => {
      await result.current.cancel();
    });

    expect(invokeCount('cancel_scan_cmd')).toBe(0);
    expect(result.current.cancelRequested).toBe(false);
  });

  it('取消命令失败会回滚 cancelRequested 并把错误抛给调用方', async () => {
    mockInvokeError('cancel_scan_cmd', new Error('boom'));
    const { result } = renderHook(() => useTaskProgress('scan'));
    await flush();

    act(() => result.current.start());
    await act(async () => {
      await expect(result.current.cancel()).rejects.toThrow('boom');
    });

    expect(result.current.cancelRequested).toBe(false);
    expect(result.current.isCancelRequested()).toBe(false);
  });
});
