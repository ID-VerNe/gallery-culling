/**
 * 设置弹窗里的 LUMEN 路径体验（M-15）。
 *
 * 三条契约：
 *  1. 「浏览」把所选路径写回输入框（与 Photoshop 路径对称）；
 *  2. 「测试连接」探测的是**输入框里尚未保存的路径**（这正是新命令的价值）；
 *  3. 探测失败时展示可读错误，绝不静默。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { open } from '@tauri-apps/plugin-dialog';
import { SettingsModal } from './SettingsModal';
import { probeLumen } from '../services/lumenApi';
import { lastInvokeArgs, mockInvokeCommand, mockInvokeError } from '../test/setup';
import type { AppSettings } from '../types';

const baseSettings: AppSettings = {
  defaultJpgFolder: 'D:/shoot/JPG',
  defaultRawFolder: 'D:/shoot/RAW',
  photoshopPath: '',
  thumbnailWidth: 200,
  sortOrder: 'time_filename',
  lumenEnabled: true,
  lumenCliPath: '',
  lumenGridThumbnails: false,
  lumenExpectAi: false,
};

function setup(overrides: Partial<AppSettings> = {}, user = userEvent.setup()) {
  mockInvokeCommand('get_settings_cmd', { ...baseSettings, ...overrides });
  mockInvokeCommand('save_settings_cmd', true);
  render(
    <SettingsModal
      isOpen
      onClose={vi.fn()}
      onSettingsSaved={vi.fn()}
      onError={vi.fn()}
    />,
  );
  return { user };
}

const lumenPathInput = () => screen.findByLabelText('lumen-cli.exe 路径');
const testButton = () => screen.findByRole('button', { name: '测试 LUMEN RAW 连接' });

describe('SettingsModal —— lumen-cli 路径浏览（M-15）', () => {
  it('点击浏览后把所选路径写回输入框', async () => {
    vi.mocked(open).mockResolvedValueOnce('C:/tools/lumen-cli.exe');
    const { user } = setup();

    await user.click(await screen.findByRole('button', { name: '选择 lumen-cli 路径' }));

    await waitFor(async () =>
      expect(await lumenPathInput()).toHaveValue('C:/tools/lumen-cli.exe'),
    );
  });

  it('取消对话框时不改动输入框', async () => {
    vi.mocked(open).mockResolvedValueOnce(null);
    const { user } = setup({ lumenCliPath: 'C:/keep/lumen-cli.exe' });

    await user.click(await screen.findByRole('button', { name: '选择 lumen-cli 路径' }));

    expect(await lumenPathInput()).toHaveValue('C:/keep/lumen-cli.exe');
  });
});

describe('SettingsModal —— 测试连接（M-15）', () => {
  it('探测成功时展示「连接成功 + 版本」', async () => {
    mockInvokeCommand('probe_lumen_cmd', { available: true, version: '1.6.0', error: null });
    const { user } = setup({ lumenCliPath: 'C:/tools/lumen-cli.exe' });

    await user.click(await testButton());

    await waitFor(() =>
      expect(screen.getByText('连接成功：LUMEN RAW 1.6.0')).toBeInTheDocument(),
    );
  });

  it('探测失败时如实展示后端错误（不静默）', async () => {
    const error = '未找到 lumen-cli.exe（已查 PATH 与设置中的路径）';
    mockInvokeCommand('probe_lumen_cmd', { available: false, version: null, error });
    const { user } = setup({ lumenCliPath: 'C:/nope/lumen-cli.exe' });

    await user.click(await testButton());

    await waitFor(() => expect(screen.getByText(error)).toBeInTheDocument());
  });

  it('探测命令抛错时展示「测试失败」，不吞错', async () => {
    mockInvokeError('probe_lumen_cmd', new Error('command probe_lumen_cmd not found'));
    const { user } = setup();

    await user.click(await testButton());

    await waitFor(() =>
      expect(screen.getByText(/测试失败/)).toHaveTextContent('command probe_lumen_cmd not found'),
    );
  });

  it('探测的是输入框里**尚未保存**的路径', async () => {
    mockInvokeCommand('probe_lumen_cmd', { available: false, version: null, error: 'nope' });
    const { user } = setup({ lumenCliPath: '' });

    const input = await lumenPathInput();
    await user.type(input, 'D:/unsaved/lumen-cli.exe');
    await user.click(await testButton());

    await waitFor(() =>
      expect(lastInvokeArgs('probe_lumen_cmd')).toMatchObject({
        cliPath: 'D:/unsaved/lumen-cli.exe',
      }),
    );
  });
});

describe('probeLumen —— 返回值缺省容错', () => {
  it('后端返回空对象时归一为 false/null/null（不泄漏 undefined）', async () => {
    mockInvokeCommand('probe_lumen_cmd', {});
    await expect(probeLumen('C:/x')).resolves.toEqual({
      available: false,
      version: null,
      error: null,
    });
  });

  it('后端返回 null 时同样安全降级', async () => {
    mockInvokeCommand('probe_lumen_cmd', null);
    await expect(probeLumen('C:/x')).resolves.toEqual({
      available: false,
      version: null,
      error: null,
    });
  });

  it('正常返回原样透传', async () => {
    mockInvokeCommand('probe_lumen_cmd', { available: true, version: '1.6.0', error: null });
    await expect(probeLumen('C:/x')).resolves.toEqual({
      available: true,
      version: '1.6.0',
      error: null,
    });
  });
});
