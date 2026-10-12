/**
 * 批量导出的结果呈现（数据安全护栏）。
 *
 * 契约：导出的写入路径是本轮最高危项，**部分失败绝不能伪装成成功**。
 * - `failed.length > 0` → 琥珀色 + AlertTriangle + role="alert"，Toast 走 onError；
 * - `failed.length === 0` → 绿色 + CheckCircle2 + role="status"，Toast 走 onSuccess。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BatchExportModal } from './BatchExportModal';
import { mockInvokeCommand } from '../test/setup';
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
  hasXmp: false,
};

function setup() {
  const onError = vi.fn();
  const onSuccess = vi.fn();
  const user = userEvent.setup();
  render(
    <BatchExportModal
      isOpen
      onClose={vi.fn()}
      groups={[group]}
      onError={onError}
      onSuccess={onSuccess}
    />,
  );
  return { user, onError, onSuccess };
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
    const { user, onError, onSuccess } = setup();

    await runExport(user);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onSuccess).not.toHaveBeenCalled();

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

  it('全部成功：绿色 + CheckCircle2 + role=status，Toast 走 onSuccess', async () => {
    mockInvokeCommand('batch_export_cmd', { exported: 3, skipped: 0, failed: [] });
    const { user, onError, onSuccess } = setup();

    await runExport(user);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();

    const status = screen.getByRole('status');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(status).toHaveTextContent('导出完成：已导出 3 个');
    expect(status.className).toContain('emerald');
    expect(status.className).not.toContain('amber');
    const iconClass = status.querySelector('svg')?.getAttribute('class') ?? '';
    expect(iconClass).toContain('lucide-circle-check');
  });
});
