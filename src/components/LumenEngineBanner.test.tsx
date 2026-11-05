/**
 * issue #75：引擎下载横幅的三种可见状态。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LumenEngineBanner } from './LumenEngineBanner';

const base = {
  version: '1.6.0',
  downloadedBytes: 0,
  totalBytes: 0,
};

describe('LumenEngineBanner', () => {
  it('ready / missing 时不渲染', () => {
    const { container: ready } = render(
      <LumenEngineBanner status={{ ...base, phase: 'ready', detail: '已就绪' }} />,
    );
    expect(ready).toBeEmptyDOMElement();
    const { container: missing } = render(
      <LumenEngineBanner status={{ ...base, phase: 'missing', detail: '' }} />,
    );
    expect(missing).toBeEmptyDOMElement();
  });

  it('下载中显示进度百分比（role=status）', () => {
    render(
      <LumenEngineBanner
        status={{
          ...base,
          phase: 'downloading',
          detail: '正在下载 LUMEN RAW 引擎…',
          downloadedBytes: 50,
          totalBytes: 100,
        }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('正在下载 LUMEN RAW 引擎');
    expect(screen.getByRole('status')).toHaveTextContent('50%');
  });

  it('失败时 role=alert、常驻画出重试与手动指定路径', () => {
    const onRetry = vi.fn();
    render(
      <LumenEngineBanner
        status={{
          ...base,
          phase: 'failed',
          detail: '下载引擎失败：HTTP 503。下一步：稍后点「重试」。',
        }}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('LUMEN RAW 引擎下载失败');
    expect(alert).toHaveTextContent('下一步');
    expect(alert).toHaveTextContent('手动指定 lumen-cli.exe');
    screen.getByRole('button', { name: /重试/ }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('重试进行中按钮禁用并换文案', () => {
    render(
      <LumenEngineBanner
        status={{ ...base, phase: 'failed', detail: '失败' }}
        retrying
        onRetry={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: /正在重试/ });
    expect(button).toBeDisabled();
  });
});
