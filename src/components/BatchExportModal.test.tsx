/**
 * 批量导出的结果呈现（数据安全护栏）。
 *
 * 契约：导出的写入路径是本轮最高危项，**部分失败绝不能伪装成成功**。
 * - `failed.length > 0` → 琥珀色 + AlertTriangle + role="alert"，Toast 走 onError；
 * - `failed.length === 0` → 绿色 + CheckCircle2 + role="status"，**不弹 Toast**
 *   （结果条与用户视线同一屏，再弹一条同义句是噪音）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BatchExportModal } from './BatchExportModal';
import { TaskMutexProvider } from '../hooks/useTaskMutex';
import {
  emitMockEvent,
  invokeCount,
  mockInvokeCommand,
  setInvokeHandler,
} from '../test/setup';
import type { PhotoGroupInfo } from '../types';

const group: PhotoGroupInfo = {
  id: 'g1',
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
  // 默认导出范围是「已保留或已打星」，pick 保证这张在候选里
  flag: 'pick',
  label: '', hasXmp: false,
};

function setup() {
  const onError = vi.fn();
  const user = userEvent.setup();
  render(
    <BatchExportModal
      isOpen
      onClose={vi.fn()}
      groups={[group]}
      onError={onError}
    />,
    { wrapper: TaskMutexProvider },
  );
  return { user, onError };
}

async function runExport(user: ReturnType<typeof userEvent.setup>) {
  // 目标目录不能等于源目录（D:/shoot/JPG），否则会被前端护栏拦下
  await user.type(screen.getByLabelText('目标导出目录'), 'D:/out');
  await user.click(screen.getByRole('button', { name: '开始导出' }));
}

describe('BatchExportModal —— 结果呈现', () => {
  it('部分失败：amber + AlertTriangle + role=alert，Toast 走 onError，不出绿色成功态', async () => {
    mockInvokeCommand('batch_export_cmd', {
      exported: 2,
      skipped: 1,
      failed: [{ path: '/x/a.NEF', reason: '拒绝访问' }],
    });
    const { user, onError } = setup();

    await runExport(user);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    // 结果框：警示态（alert），不是 status
    const alert = screen.getByRole('alert');
    expect(screen.queryByRole('status')).toBeNull();

    // 失败数在最前，三个计数都在
    expect(alert).toHaveTextContent('导出未完全成功：失败 1 个 · 已导出 2 个 · 跳过 1 个');
    // 失败原因如实列出
    expect(alert).toHaveTextContent('/x/a.NEF');
    expect(alert).toHaveTextContent('拒绝访问');
    // 琥珀色（非绿色）
    expect(alert.className).toContain('text-amber-200');
    expect(alert.className).not.toContain('emerald');
    // 图标是 AlertTriangle，不是 CheckCircle2
    const iconClass = alert.querySelector('svg')?.getAttribute('class') ?? '';
    expect(iconClass).toContain('lucide-triangle-alert');
    expect(iconClass).not.toContain('circle-check');
  });

  it('全部成功：绿色 + CheckCircle2 + role=status，且不弹任何 Toast', async () => {
    mockInvokeCommand('batch_export_cmd', { exported: 3, skipped: 0, failed: [] });
    const { user, onError } = setup();

    await runExport(user);

    const status = await screen.findByRole('status');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(status).toHaveTextContent('导出完成：已导出 3 个');
    expect(status.className).toContain('emerald');
    expect(status.className).not.toContain('amber');
    const iconClass = status.querySelector('svg')?.getAttribute('class') ?? '';
    expect(iconClass).toContain('lucide-circle-check');
    // 成功不再重复弹 Toast：结果条已经说全了
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('BatchExportModal —— 导出进度与取消（M-05）', () => {
  it('导出进行中：按钮禁用显示「导出中…」，并展示 aria-live 进度', async () => {
    // 永久挂起的导出：让"进行中"状态稳定，便于断言进度 UI。
    setInvokeHandler((cmd) => {
      if (cmd === 'batch_export_cmd') return new Promise(() => {});
      return null;
    });
    const { user } = setup();

    await user.type(screen.getByLabelText('目标导出目录'), 'D:/out');
    await user.click(screen.getByRole('button', { name: '开始导出' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '导出中…' })).toBeDisabled();
    });

    // 进度条在进行中即出现（尚无非确定性进度则显示"已处理 0 项"）
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    act(() => {
      emitMockEvent('export-progress', {
        processed: 5,
        total: 20,
        current: 'IMG_0005.NEF',
      });
    });

    // 确定性进度 + aria-live 区域承载"已处理 N / M"
    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '5');
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '20');
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('5 / 20');
    expect(screen.getByText('IMG_0005.NEF')).toBeInTheDocument();
  });

  it('取消后不再发起新的导出 invoke（导出永挂起）', async () => {
    setInvokeHandler((cmd) => {
      if (cmd === 'batch_export_cmd') return new Promise(() => {});
      if (cmd === 'cancel_export_cmd') return null;
      return null;
    });
    const { user } = setup();

    await user.type(screen.getByLabelText('目标导出目录'), 'D:/out');
    await user.click(screen.getByRole('button', { name: '开始导出' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '导出中…' })).toBeDisabled();
    });
    expect(invokeCount('batch_export_cmd')).toBe(1);

    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(invokeCount('cancel_export_cmd')).toBe(1));

    // 关键负向断言：取消之后不得再有任何新的 batch_export_cmd（不重复发起）
    expect(invokeCount('batch_export_cmd')).toBe(1);
    // 已请求取消 → 按钮切到「取消中…」并禁用，防止重复下发
    expect(screen.getByRole('button', { name: '取消中…' })).toBeDisabled();
  });

  it('后端返回 cancelled：精确陈述「目标目录未产生任何文件」', async () => {
    mockInvokeCommand('batch_export_cmd', {
      exported: 0,
      skipped: 0,
      failed: [],
      cancelled: true,
    });
    const { user, onError } = setup();

    await runExport(user);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('已取消导出：目标目录未产生任何文件');
    // 取消 ≠ 失败，也绝不写"已导出 N 个"这类会被误读为已落盘的措辞
    expect(status).not.toHaveTextContent('已导出');
    expect(onError).not.toHaveBeenCalled();
  });
});
