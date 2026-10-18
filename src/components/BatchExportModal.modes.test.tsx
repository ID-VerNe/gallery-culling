/**
 * 双模式导出的集成契约（方案文档 F1–F10）。
 *
 * 这里锁的是「用户点了之后到底发生了哪次 IPC、参数对不对、失败有没有被说清」，
 * 而不是像素。导出是本项目最高危的写入路径，所以断言偏向「调用与措辞」。
 *
 * 与原 `BatchExportModal.test.tsx` 的分工：那份守住复制模式的既有行为不回退，
 * 这份守住新接入的模式分叉、引擎门禁与成片专属参数。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BatchExportModal } from './BatchExportModal';
import { TaskMutexProvider } from '../hooks/useTaskMutex';
import type { LumenGateStatus } from './export/LumenGateNotice';
import {
  emitMockEvent,
  invokeCount,
  lastInvokeArgs,
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
  flag: 'pick',
  label: '', hasXmp: false,
};

/** 带 RAW 的组（COMPLETE），用于验证「含 RAW」档与「无画质提示」。 */
const groupWithRaw: PhotoGroupInfo = {
  ...group,
  id: 'g2',
  baseName: 'IMG_0002',
  raw: {
    name: 'IMG_0002.NEF',
    extension: 'nef',
    path: 'D:/shoot/RAW/IMG_0002.NEF',
    size: 4096,
    mtime: 0,
  },
  status: 'COMPLETE',
};

/** 各命令的「全部成功」返回。 */
const ok = { exported: 1, skipped: 0, failed: [] };

interface SetupProps {
  lumenStatus?: LumenGateStatus;
  lumenDetail?: string;
  onOpenSettings?: () => void;
}

/** FR-09：导出弹窗会读全局互斥表，组件测试必须提供 Provider。 */
const renderWithProvider = (ui: Parameters<typeof render>[0]) =>
  render(ui, { wrapper: TaskMutexProvider });

function setup(props: SetupProps = {}) {
  const onError = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <BatchExportModal
      isOpen
      onClose={onClose}
      groups={[group]}
      onError={onError}
      {...props}
    />,
    { wrapper: TaskMutexProvider },
  );
  return { user, onError, onClose };
}

const fillTarget = (user: ReturnType<typeof userEvent.setup>) =>
  user.type(screen.getByLabelText('目标导出目录'), 'D:/out');

const switchToRender = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByLabelText(/调色成片/));

describe('F1–F2 模式分叉：只调对应命令', () => {
  it('F1 默认原片复制：调 batch_export_cmd，绝不碰成片命令', async () => {
    mockInvokeCommand('batch_export_cmd', ok);
    const { user } = setup();
    await fillTarget(user);
    await user.click(screen.getByRole('button', { name: '开始导出' }));

    await waitFor(() => expect(invokeCount('batch_export_cmd')).toBe(1));
    expect(invokeCount('batch_render_export_cmd')).toBe(0);
  });

  it('F2 成片模式：调 batch_render_export_cmd，且带上 format / longEdge / quality', async () => {
    mockInvokeCommand('batch_render_export_cmd', ok);
    const { user } = setup();
    await switchToRender(user);
    await fillTarget(user);
    await user.selectOptions(screen.getByLabelText('长边尺寸'), '2560');
    await user.click(screen.getByRole('button', { name: '开始生成成片' }));

    await waitFor(() => expect(invokeCount('batch_render_export_cmd')).toBe(1));
    expect(invokeCount('batch_export_cmd')).toBe(0);
    expect(lastInvokeArgs('batch_render_export_cmd')).toMatchObject({
      targetFolder: 'D:/out',
      format: 'jpg',
      longEdge: 2560,
      quality: 92,
    });
  });
});

describe('F3–F4 LUMEN 门禁', () => {
  it('F3 引擎不可用：alert + 去设置，开始按钮禁用且零 invoke', async () => {
    const onOpenSettings = vi.fn();
    const { user } = setup({
      lumenStatus: 'unavailable',
      lumenDetail: '未找到 lumen-cli.exe',
      onOpenSettings,
    });
    await switchToRender(user);
    await fillTarget(user);

    expect(screen.getByRole('alert')).toHaveTextContent('未找到 lumen-cli.exe');

    const start = screen.getByRole('button', { name: '开始生成成片' });
    expect(start).toBeDisabled();
    await user.click(start);
    expect(invokeCount('batch_render_export_cmd')).toBe(0);

    await user.click(screen.getByRole('button', { name: /去设置/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('F4 探测中：不拦路，按钮可用且没有 alert', async () => {
    const { user } = setup({ lumenStatus: 'probing' });
    await switchToRender(user);
    await fillTarget(user);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/正在检测/);
    expect(screen.getByRole('button', { name: '开始生成成片' })).toBeEnabled();
  });

  it('复制模式不显示引擎状态（复制不依赖引擎）', async () => {
    const { user } = setup({
      lumenStatus: 'unavailable',
      lumenDetail: '未找到 lumen-cli.exe',
    });
    await fillTarget(user);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: '开始导出' })).toBeEnabled();
  });
});

describe('F5 模式切换', () => {
  it('选项区互换，且旧结果被清空', async () => {
    mockInvokeCommand('batch_export_cmd', ok);
    const { user } = setup();
    await fillTarget(user);
    await user.click(screen.getByRole('button', { name: '开始导出' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已导出 1 个');

    await switchToRender(user);

    // 复制选项消失、成片选项出现
    expect(screen.queryByLabelText('复制 RAW 原片及 XMP 侧边栏')).toBeNull();
    expect(screen.queryByLabelText('复制对应 JPG 预览')).toBeNull();
    expect(screen.getByLabelText('JPEG 质量')).toBeInTheDocument();
    // 上一次的绿色结果不能残留
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('footer 预计量随模式换词', async () => {
    const { user } = setup();
    expect(screen.getByText(/预计导出/)).toBeInTheDocument();
    await switchToRender(user);
    expect(screen.getByText(/预计生成/)).toBeInTheDocument();
  });
});

describe('F6–F7 成片参数', () => {
  it('F6 TIFF / DNG 不展示质量输入，切回 JPEG 恢复', async () => {
    const { user } = setup();
    await switchToRender(user);
    expect(screen.getByLabelText('JPEG 质量')).toBeInTheDocument();

    await user.click(screen.getByLabelText('TIFF'));
    expect(screen.queryByLabelText('JPEG 质量')).toBeNull();

    await user.click(screen.getByLabelText('DNG'));
    expect(screen.queryByLabelText('JPEG 质量')).toBeNull();

    await user.click(screen.getByLabelText('JPEG'));
    expect(screen.getByLabelText('JPEG 质量')).toBeInTheDocument();
  });

  it('F7 质量越界：输入时保留中间态，失焦后规整到边界', async () => {
    const { user } = setup();
    await switchToRender(user);
    const input = screen.getByLabelText('JPEG 质量');

    await user.clear(input);
    await user.type(input, '200');
    // 输入过程中保留原文，否则用户打不出「92」（会被夹成 50）
    expect(input).toHaveValue(200);
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue(100));

    await user.clear(input);
    await user.type(input, '10');
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue(50));
  });
});

describe('F8 进度', () => {
  it('进度事件驱动 aria-valuenow 与当前文件名', async () => {
    setInvokeHandler((cmd) =>
      cmd === 'batch_render_export_cmd' ? new Promise(() => {}) : null,
    );
    const { user } = setup();
    await switchToRender(user);
    await fillTarget(user);
    await user.click(screen.getByRole('button', { name: '开始生成成片' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '成片生成中…' })).toBeDisabled(),
    );
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    act(() => {
      emitMockEvent('export-progress', {
        processed: 7,
        total: 12,
        current: 'IMG_0007.NEF',
      });
    });

    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '7'),
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '12');
    expect(screen.getByText('IMG_0007.NEF')).toBeInTheDocument();
  });
});

describe('F9 取消', () => {
  it('取消只下发一次，按钮切「取消中…」并禁用', async () => {
    setInvokeHandler((cmd) => {
      if (cmd === 'batch_render_export_cmd') return new Promise(() => {});
      return null;
    });
    const { user } = setup();
    await switchToRender(user);
    await fillTarget(user);
    await user.click(screen.getByRole('button', { name: '开始生成成片' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '成片生成中…' })).toBeDisabled(),
    );
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(invokeCount('cancel_export_cmd')).toBe(1));

    expect(screen.getByRole('button', { name: '取消中…' })).toBeDisabled();
    // 不重复发起导出
    expect(invokeCount('batch_render_export_cmd')).toBe(1);
  });

  it('后端返回 cancelled：文案指向成片，且不弹 Toast', async () => {
    mockInvokeCommand('batch_render_export_cmd', {
      exported: 0,
      skipped: 0,
      failed: [],
      cancelled: true,
    });
    const { user, onError } = setup();
    await switchToRender(user);
    await fillTarget(user);
    await user.click(screen.getByRole('button', { name: '开始生成成片' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('目标目录未产生任何成片');
    expect(status).not.toHaveTextContent('已生成');
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('F10 运行中锁定', () => {
  it('模式与全部输入禁用，关闭按钮也不可用', async () => {
    setInvokeHandler((cmd) =>
      cmd === 'batch_render_export_cmd' ? new Promise(() => {}) : null,
    );
    const { user } = setup();
    await switchToRender(user);
    await fillTarget(user);
    await user.click(screen.getByRole('button', { name: '开始生成成片' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '成片生成中…' })).toBeDisabled(),
    );

    expect(screen.getByLabelText(/原片复制/)).toBeDisabled();
    expect(screen.getByLabelText(/调色成片/)).toBeDisabled();
    expect(screen.getByLabelText('目标导出目录')).toBeDisabled();
    expect(screen.getByLabelText('JPEG')).toBeDisabled();
    expect(screen.getByLabelText('长边尺寸')).toBeDisabled();
    expect(screen.getByLabelText('JPEG 质量')).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  });
});

describe('导出范围：含 RAW', () => {
  it('只收带 RAW 的组，JPG-only 不计入（也不影响「全部」）', async () => {
    const user = userEvent.setup();
    render(
      <BatchExportModal isOpen onClose={vi.fn()} groups={[group, groupWithRaw]} />,
      { wrapper: TaskMutexProvider },
    );

    // 两组都是 pick：全部 = 2，含 RAW = 1
    expect(screen.getByLabelText(/全部非淘汰照片/).closest('label')).toHaveTextContent(
      '(2)',
    );
    expect(screen.getByLabelText(/含 RAW 的组/).closest('label')).toHaveTextContent(
      '(1)',
    );

    await user.click(screen.getByLabelText(/含 RAW 的组/));
    await user.type(screen.getByLabelText('目标导出目录'), 'D:/out');
    expect(screen.getByRole('button', { name: '开始导出' })).toBeEnabled();
  });

  it('候选全被该档排除时拦下，提示先打星/保留', async () => {
    const user = userEvent.setup();
    renderWithProvider(<BatchExportModal isOpen onClose={vi.fn()} groups={[group]} />);
    await user.click(screen.getByLabelText(/含 RAW 的组/));
    await user.type(screen.getByLabelText('目标导出目录'), 'D:/out');

    // group 是 JPG-only → 候选为空 → 按钮禁用
    expect(screen.getByRole('button', { name: '开始导出' })).toBeDisabled();
  });
});

describe('成片质量提示（JPG 源二次压缩）', () => {
  it('候选含 JPG-only 时提示，组数与候选数一致', async () => {
    const { user } = setup(); // group 无 raw
    await switchToRender(user);
    const tip = screen.getByText(/1 组仅含 JPG/);
    expect(tip).toHaveTextContent(/二次压缩/);
  });

  it('候选全部带 RAW 时不提示', async () => {
    const user = userEvent.setup();
    renderWithProvider(<BatchExportModal isOpen onClose={vi.fn()} groups={[groupWithRaw]} />);
    await user.click(screen.getByLabelText(/调色成片/));
    expect(screen.queryByText(/仅含 JPG/)).toBeNull();
  });

  it('切到 TIFF 后提示消失，切回 JPEG 恢复', async () => {
    const { user } = setup();
    await switchToRender(user);
    expect(screen.getByText(/仅含 JPG/)).toBeInTheDocument();

    await user.click(screen.getByLabelText('TIFF'));
    expect(screen.queryByText(/仅含 JPG/)).toBeNull();

    await user.click(screen.getByLabelText('JPEG'));
    expect(screen.getByText(/仅含 JPG/)).toBeInTheDocument();
  });
});
