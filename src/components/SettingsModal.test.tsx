/**
 * 首选项弹窗里的 LUMEN RAW 区块。
 *
 * 三条契约：开关的**依赖顺序**（宫格开关必须先开引擎）、握手 detail 的如实展示、
 * 以及保存时整份设置（含新增字段）一次性上报。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from './SettingsModal';
import { mockInvokeCommand, mockInvokeError } from '../test/setup';
import type { AppSettings, LumenStatus } from '../types';

const baseSettings: AppSettings = {
  defaultJpgFolder: 'D:/shoot/JPG',
  defaultRawFolder: 'D:/shoot/RAW',
  photoshopPath: 'C:/Program Files/Adobe/Photoshop.exe',
  thumbnailWidth: 200,
  sortOrder: 'time_filename',
  lumenEnabled: false,
  lumenCliPath: '',
  lumenGridThumbnails: false,
};

const okStatus: LumenStatus = {
  available: true,
  enabled: true,
  pinnedVersion: '0.5.2',
  foundVersion: '0.5.2',
  detail: '已连接',
};

function setup(overrides: Partial<AppSettings> = {}, lumenStatus?: LumenStatus | null) {
  mockInvokeCommand('get_settings_cmd', { ...baseSettings, ...overrides });
  mockInvokeCommand('save_settings_cmd', true);

  const onSettingsSaved = vi.fn();
  const onClose = vi.fn();
  const onError = vi.fn();

  const user = userEvent.setup();
  render(
    <SettingsModal
      isOpen
      onClose={onClose}
      onSettingsSaved={onSettingsSaved}
      onError={onError}
      lumenStatus={lumenStatus ?? null}
    />,
  );

  return { user, onSettingsSaved, onClose, onError };
}

const engineToggle = () => screen.getByLabelText(/启用 LUMEN RAW 引擎/);
const gridToggle = () => screen.getByLabelText(/宫格缩略图也用 LUMEN RAW 渲染/);
const saveButton = () => screen.getByRole('button', { name: /保存设置/ });

describe('SettingsModal —— LUMEN RAW 开关', () => {
  it('lumenEnabled=false 时宫格引擎开关 disabled（不能先开后端再开前端）', async () => {
    setup({ lumenEnabled: false });

    await waitFor(() => expect(gridToggle()).toBeInTheDocument());
    expect(gridToggle()).toBeDisabled();
    expect(engineToggle()).toBeEnabled();
  });

  it('勾掉引擎开关会连带禁用宫格开关', async () => {
    const { user } = setup({ lumenEnabled: true, lumenGridThumbnails: true });

    await waitFor(() => expect(gridToggle()).toBeEnabled());

    await user.click(engineToggle());

    expect(engineToggle()).not.toBeChecked();
    expect(gridToggle()).toBeDisabled();
  });

  it('lumenEnabled=false 时不渲染握手状态区域', async () => {
    setup({ lumenEnabled: false }, { ...okStatus, available: false, detail: '未启用' });

    await waitFor(() => expect(engineToggle()).toBeInTheDocument());
    expect(screen.queryByRole('status', { name: '' })).toBeNull();
    expect(screen.queryByText('未启用')).toBeNull();
  });

  it('引擎开关本身不是 disabled（用户必须能打开它）', async () => {
    setup({ lumenEnabled: false });
    await waitFor(() => expect(engineToggle()).toBeEnabled());
    expect(engineToggle()).not.toBeDisabled();
  });
});

describe('SettingsModal —— 握手状态展示', () => {
  it('available=true 时展示版本号', async () => {
    setup({ lumenEnabled: true }, okStatus);

    await waitFor(() => expect(screen.getByText('已连接 LUMEN RAW 0.5.2')).toBeInTheDocument());
  });

  it('available=false 时如实展示 detail（版本不匹配的诊断信息）', async () => {
    const detail = 'LUMEN RAW 版本不匹配：需要 0.5.2，实际找到 0.4.8';
    setup({ lumenEnabled: true }, { ...okStatus, available: false, foundVersion: '0.4.8', detail });

    await waitFor(() => expect(screen.getByText(detail)).toBeInTheDocument());
    expect(screen.queryByText(/已连接 LUMEN RAW/)).toBeNull();
  });

  it('握手区域是 aria-live=polite，引擎状态变化会被读屏播报', async () => {
    mockInvokeCommand('get_settings_cmd', { ...baseSettings, lumenEnabled: true });
    const { container } = render(
      <SettingsModal
        isOpen
        onClose={vi.fn()}
        onSettingsSaved={vi.fn()}
        lumenStatus={{ ...okStatus, available: false, detail: '找不到 lumen-cli.exe' }}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
        '找不到 lumen-cli.exe',
      ),
    );
    // aria-live 区域同时带 role=status
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('有 lumenStatus 但引擎未启用时不显示状态区', async () => {
    setup({ lumenEnabled: false }, okStatus);
    await waitFor(() => expect(engineToggle()).toBeInTheDocument());
    expect(screen.queryByText(/已连接 LUMEN RAW/)).toBeNull();
  });

  it('lumenStatus 为 null 且引擎启用时显示探测中占位', async () => {
    setup({ lumenEnabled: true }, null);
    await waitFor(() => expect(screen.getByText('正在探测引擎…')).toBeInTheDocument());
  });
});

describe('SettingsModal —— 保存', () => {
  it('勾选 lumenGridThumbnails 后保存，会连同整份设置上报', async () => {
    const { user, onSettingsSaved, onClose } = setup({ lumenEnabled: true });

    await waitFor(() => expect(gridToggle()).toBeEnabled());
    await user.click(gridToggle());
    expect(gridToggle()).toBeChecked();

    await user.click(saveButton());

    await waitFor(() => expect(onSettingsSaved).toHaveBeenCalledTimes(1));
    expect(onSettingsSaved).toHaveBeenCalledWith(
      expect.objectContaining({ lumenEnabled: true, lumenGridThumbnails: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('保存时透传用户刚改的路径字段', async () => {
    const { user, onSettingsSaved } = setup({ lumenEnabled: true });

    await waitFor(() => expect(gridToggle()).toBeEnabled());
    const path = screen.getByLabelText('lumen-cli.exe 路径');
    await user.clear(path);
    await user.type(path, 'C:/tools/lumen-cli.exe');

    await user.click(saveButton());

    await waitFor(() => expect(onSettingsSaved).toHaveBeenCalled());
    expect(onSettingsSaved.mock.calls[0][0]).toMatchObject({
      lumenCliPath: 'C:/tools/lumen-cli.exe',
    });
  });

  it('保存失败时走 onError，不调用 onSettingsSaved', async () => {
    mockInvokeCommand('get_settings_cmd', { ...baseSettings, lumenEnabled: true });
    mockInvokeError('save_settings_cmd', new Error('db locked'));

    const onSettingsSaved = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SettingsModal isOpen onClose={onClose} onSettingsSaved={onSettingsSaved} onError={onError} />);

    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toContain('保存设置失败');
    expect(onSettingsSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('读取设置失败时提示且不渲染表单', async () => {
    mockInvokeError('get_settings_cmd', new Error('no db'));

    const onError = vi.fn();
    render(<SettingsModal isOpen onClose={vi.fn()} onSettingsSaved={vi.fn()} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toContain('读取设置失败');
    expect(screen.getByText('正在读取设置…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /保存设置/ })).toBeDisabled();
  });

  it('取消按钮不保存', async () => {
    const { user, onSettingsSaved, onClose } = setup({ lumenEnabled: true });

    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSettingsSaved).not.toHaveBeenCalled();
  });
});

describe('SettingsModal —— 评级同步', () => {
  it('引擎不可用时不显示同步评级按钮', async () => {
    mockInvokeCommand('get_settings_cmd', { ...baseSettings, lumenEnabled: true });
    const onSyncRatings = vi.fn(async () => 3);
    render(
      <SettingsModal
        isOpen
        onClose={vi.fn()}
        onSettingsSaved={vi.fn()}
        lumenStatus={{ ...okStatus, available: false, detail: 'nope' }}
        onSyncRatings={onSyncRatings}
      />,
    );

    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /从 LUMEN RAW 同步评级/ })).toBeNull();
  });

  it('引擎可用时显示同步按钮并在点击后回报数量', async () => {
    mockInvokeCommand('get_settings_cmd', { ...baseSettings, lumenEnabled: true });
    const onSyncRatings = vi.fn(async () => 7);
    const onError = vi.fn();
    const user = userEvent.setup();
    render(
      <SettingsModal
        isOpen
        onClose={vi.fn()}
        onSettingsSaved={vi.fn()}
        onError={onError}
        lumenStatus={okStatus}
        onSyncRatings={onSyncRatings}
      />,
    );

    const button = await screen.findByRole('button', { name: /从 LUMEN RAW 同步评级/ });
    await user.click(button);

    await waitFor(() => expect(onSyncRatings).toHaveBeenCalledWith(''));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('同步 7 张'));
  });
});
