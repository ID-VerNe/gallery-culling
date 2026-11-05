/**
 * issue #68：随包引擎预热失败必须变成用户看得见的错误提示。
 */
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ToastProvider } from '../components/Toast';
import { emitMockEvent } from '../test/setup';
import { LUMEN_STARTUP_ERROR_EVENT, useLumenStartupNotice } from './useLumenStartupNotice';

function Harness() {
  useLumenStartupNotice();
  return null;
}

describe('useLumenStartupNotice', () => {
  it('收到启动失败事件后显示常驻错误提示', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    // listen 是异步注册的：先让微任务跑完，再派发事件。
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitMockEvent(LUMEN_STARTUP_ERROR_EVENT, '未检测到 LUMEN RAW 引擎');
    });

    expect(
      await screen.findByText(/LUMEN RAW 引擎启动失败：未检测到 LUMEN RAW 引擎/),
    ).toBeInTheDocument();
  });
});
