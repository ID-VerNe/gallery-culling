/**
 * issue #75：引擎下载状态必须能被前端读到、被事件更新，并支持手动重试。
 */
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { emitMockEvent, invokeCount, mockInvokeCommand, mockInvokeError } from '../test/setup';
import { LUMEN_ENGINE_STATUS_EVENT, useLumenEngine } from './useLumenEngine';

function Harness() {
  const { status, retrying, retry } = useLumenEngine();
  return (
    <div>
      <span data-testid="phase">{status?.phase ?? 'none'}</span>
      <span data-testid="detail">{status?.detail ?? ''}</span>
      <button onClick={retry}>{retrying ? 'retrying' : 'retry'}</button>
    </div>
  );
}

const flush = () => act(async () => Promise.resolve());

describe('useLumenEngine', () => {
  it('启动时主动读一次状态（避免漏掉早期事件）', async () => {
    mockInvokeCommand('lumen_engine_status_cmd', {
      phase: 'downloading',
      version: '1.6.0',
      detail: '正在下载 LUMEN RAW 引擎…',
      downloadedBytes: 1024,
      totalBytes: 2048,
    });
    render(<Harness />);
    expect(await screen.findByText('downloading')).toBeInTheDocument();
    expect(screen.getByTestId('detail')).toHaveTextContent('正在下载');
    expect(invokeCount('lumen_engine_status_cmd')).toBe(1);
  });

  it('收到状态事件后更新（含失败文案）', async () => {
    mockInvokeCommand('lumen_engine_status_cmd', {
      phase: 'missing',
      version: '1.6.0',
      detail: '尚未准备',
      downloadedBytes: 0,
      totalBytes: 0,
    });
    render(<Harness />);
    await flush();
    act(() => {
      emitMockEvent(LUMEN_ENGINE_STATUS_EVENT, {
        phase: 'failed',
        version: '1.6.0',
        detail: '下载引擎失败：HTTP 503。下一步：稍后点「重试」。',
        downloadedBytes: 0,
        totalBytes: 0,
      });
    });
    expect(screen.getByTestId('phase')).toHaveTextContent('failed');
    expect(screen.getByTestId('detail')).toHaveTextContent('下一步');
  });

  it('重试走 lumen_engine_ensure_cmd，失败也要有可操作文案', async () => {
    mockInvokeCommand('lumen_engine_status_cmd', {
      phase: 'failed',
      version: '1.6.0',
      detail: '旧错误',
      downloadedBytes: 0,
      totalBytes: 0,
    });
    mockInvokeError('lumen_engine_ensure_cmd', new Error('磁盘空间不足'));
    render(<Harness />);
    await screen.findByText('failed');

    act(() => {
      screen.getByRole('button', { name: 'retry' }).click();
    });
    await screen.findByText('retry');

    expect(invokeCount('lumen_engine_ensure_cmd')).toBe(1);
    expect(screen.getByTestId('detail')).toHaveTextContent('重试失败');
    expect(screen.getByTestId('detail')).toHaveTextContent('手动指定');
  });
});
