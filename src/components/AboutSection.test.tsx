/**
 * 设置「关于」段的更新入口与撤销入口（issue #43-PB）。
 *
 * 跳过不是死胡同：这里锁住「跳过态仍能主动检查」与「能恢复提示该版本」。
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AboutSection, type UpdateCheckState } from './SettingsSections';
import { SettingsModal } from './SettingsModal';
import { mockInvokeCommand } from '../test/setup';

const idle: UpdateCheckState = { status: 'idle' };

describe('AboutSection —— 版本与主动检查', () => {
  it('显示当前版本，并提供「检查更新」入口', async () => {
    const onCheck = vi.fn();
    render(
      <AboutSection
        currentVersion="2.0.4"
        checkState={idle}
        skippedVersion={null}
        onCheck={onCheck}
      />,
    );
    expect(screen.getByText(/当前版本 v2\.0\.4/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it('检查中：按钮禁用，原因常驻屏幕（不是 title）', () => {
    render(
      <AboutSection
        currentVersion="2.0.4"
        checkState={{ status: 'checking' }}
        skippedVersion={null}
        onCheck={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '检查中…' })).toBeDisabled();
    expect(screen.getByText('正在检查更新…')).toBeVisible();
  });

  it('已是最新 / 发现新版本：文案直接给下一步', () => {
    const { rerender } = render(
      <AboutSection
        currentVersion="2.0.4"
        checkState={{ status: 'latest', version: '2.0.4' }}
        skippedVersion={null}
        onCheck={vi.fn()}
      />,
    );
    expect(screen.getByText(/已是最新版本 v2\.0\.4/)).toBeInTheDocument();

    rerender(
      <AboutSection
        currentVersion="2.0.4"
        checkState={{ status: 'found', version: '2.0.6' }}
        skippedVersion={null}
        onCheck={vi.fn()}
      />,
    );
    expect(screen.getByText(/发现 v2\.0\.6，点「下载并安装」开始更新/)).toBeInTheDocument();
  });

  it('检查失败：role=alert 并说明怎么办', () => {
    render(
      <AboutSection
        currentVersion="2.0.4"
        checkState={{ status: 'error', error: 'offline' }}
        skippedVersion={null}
        onCheck={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/请检查网络后重试/);
  });
});

describe('AboutSection —— 撤销跳过', () => {
  it('跳过态显示记录并提供「恢复提示」按钮', async () => {
    const onRestoreSkipped = vi.fn();
    render(
      <AboutSection
        currentVersion="2.0.4"
        checkState={{ status: 'skipped', version: '2.0.6' }}
        skippedVersion="2.0.6"
        onCheck={vi.fn()}
        onRestoreSkipped={onRestoreSkipped}
      />,
    );
    expect(screen.getByText(/已跳过 v2\.0\.6/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '恢复提示 v2.0.6' }));
    expect(onRestoreSkipped).toHaveBeenCalledTimes(1);
  });

  it('即使本次没检查，只要有跳过记录就显示撤销入口', async () => {
    const onRestoreSkipped = vi.fn(() => {});
    render(
      <AboutSection
        currentVersion="2.0.4"
        checkState={idle}
        skippedVersion="2.0.6"
        onCheck={vi.fn()}
        onRestoreSkipped={onRestoreSkipped}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '恢复提示 v2.0.6' }));
    expect(onRestoreSkipped).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsModal —— 接线', () => {
  it('设置弹窗里能看到「关于」段的检查更新入口', async () => {
    mockInvokeCommand('get_settings_cmd', {
      defaultJpgFolder: 'D:/shoot/JPG',
      defaultRawFolder: 'D:/shoot/RAW',
      photoshopPath: '',
      thumbnailWidth: 200,
      sortOrder: 'time_filename',
      lumenEnabled: false,
      lumenCliPath: '',
      lumenGridThumbnails: false,
      lumenExpectAi: false,
    });
    render(
      <SettingsModal
        isOpen
        onClose={vi.fn()}
        onSettingsSaved={vi.fn()}
        currentVersion="2.0.4"
        updateCheckState={idle}
        skippedVersion={null}
        onCheckUpdate={vi.fn()}
        onRestoreSkipped={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/当前版本 v2\.0\.4/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '检查更新' })).toBeInTheDocument();
  });
});
