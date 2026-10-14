/**
 * 设置弹窗的「脏检查 + 关闭确认」与「状态行单真值」（M-06）。
 *
 * 修复前：取消 / X / Esc 三条关闭路径都直接 `onClose`，改过的设置静默蒸发；
 * 且状态行由本地（未保存）勾选门控、文案却来自基于已保存配置的握手结果，
 * 于是"刚勾上引擎"时会看到与勾选矛盾的死文案。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from './SettingsModal';
import { mockInvokeCommand } from '../test/setup';
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
  lumenExpectAi: false,
};

function setup(
  overrides: Partial<AppSettings> = {},
  props: Partial<React.ComponentProps<typeof SettingsModal>> = {},
) {
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
      {...props}
    />,
  );

  return { user, onSettingsSaved, onClose, onError };
}

const engineToggle = () => screen.getByLabelText(/启用 LUMEN RAW 引擎/);
const cancelButton = () => screen.getByRole('button', { name: '取消' });

describe('SettingsModal —— 未保存更改的关闭确认 (M-06)', () => {
  it('改动后点取消：应提示而不是静默丢弃', async () => {
    const { user, onClose } = setup({ lumenEnabled: false });

    await waitFor(() => expect(engineToggle()).toBeEnabled());
    await user.click(engineToggle()); // 变脏

    await user.click(cancelButton());

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/放弃未保存/)).toBeInTheDocument();
  });

  it('未修改时点取消：直接关闭，不弹确认', async () => {
    const { user, onClose } = setup({ lumenEnabled: true });

    await waitFor(() => expect(engineToggle()).toBeEnabled());
    await user.click(cancelButton());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/放弃未保存/)).toBeNull();
  });

  it('未保存的引擎勾选不再与握手状态行自相矛盾', async () => {
    const status: LumenStatus = {
      available: false,
      enabled: false,
      pinnedVersion: '0.5.2',
      foundVersion: null,
      detail: '未启用 LUMEN RAW 引擎',
    };
    const { user } = setup(
      { lumenEnabled: false },
      { lumenStatus: status, savedLumenEnabled: false },
    );

    await waitFor(() => expect(engineToggle()).toBeEnabled());
    await user.click(engineToggle());

    // 修复前：状态行显示"未启用 LUMEN RAW 引擎"，与已勾上的开关自相矛盾。
    expect(screen.queryByText('未启用 LUMEN RAW 引擎')).toBeNull();
    // 取而代之：同一句话 + 「保存后生效」标注（同源真值）。
    expect(screen.getByText(/保存后生效/)).toBeInTheDocument();
  });
});
