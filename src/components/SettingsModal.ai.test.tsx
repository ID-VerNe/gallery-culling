/**
 * 设置页的 GPU/AI 引擎期望与实际构建不匹配时的警告。
 *
 * 这是本轮的一个真实教训的落点：AI 版与 CPU 版的命令表**逐字节相同**，所以不能靠
 * 命令判断，只能按磁盘事实探测。设置页要在用户勾选"我指向 GPU 版"、但实际探测不到
 * 模型时立刻说出来，而不是等到保存调色时才失败。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from './SettingsModal';
import { mockInvokeCommand } from '../test/setup';
import type { AppSettings, LumenCapabilities } from '../types';

const base: AppSettings = {
  defaultJpgFolder: '',
  defaultRawFolder: '',
  photoshopPath: '',
  thumbnailWidth: 200,
  sortOrder: 'time_filename',
  lumenEnabled: true,
  lumenCliPath: 'C:/lumen/lumen-cli.exe',
  lumenGridThumbnails: false,
  lumenExpectAi: false,
};

const caps = (aiMasks: boolean): LumenCapabilities => ({
  commands: ['edit.apply', 'render.preview'],
  presets: ['自然风光'],
  aiMasks,
  aiEnhance: aiMasks,
  version: '1.6.0',
});

async function openSettings(props: Partial<React.ComponentProps<typeof SettingsModal>> = {}) {
  const saved: AppSettings[] = [];
  mockInvokeCommand('get_settings_cmd', base);
  mockInvokeCommand('save_settings_cmd', true);
  render(
    <SettingsModal
      isOpen
      onClose={() => undefined}
      onSettingsSaved={(s) => saved.push(s)}
      lumenStatus={{ available: true, enabled: true, foundVersion: '1.6.0', pinnedVersion: '1.6.0', detail: '' }}
      {...props}
    />,
  );
  // 等设置载入完成
  await screen.findByLabelText(/我指向的是 GPU/);
  return saved;
}

describe('SettingsModal —— GPU/AI 版期望与实际构建', () => {
  it('未勾选时不显示不匹配警告', async () => {
    await openSettings({ capabilities: caps(false) });
    expect(screen.queryByText(/探测不到 AI 模型与 onnxruntime/)).toBeNull();
  });

  it('勾选 GPU 版但探测不到模型 → 立刻明确警告', async () => {
    const saved = await openSettings({ capabilities: caps(false) });

    await userEvent.click(screen.getByLabelText(/我指向的是 GPU/));

    const alert = await screen.findByText(/探测不到 AI 模型与 onnxruntime/);
    expect(alert).toBeInTheDocument();
    // 警告里必须说清后果与出路
    expect(alert.textContent).toContain('AI 蒙版');
    expect(alert.textContent).toContain('lumen-cli 路径');
    expect(saved).toHaveLength(0);
  });

  it('勾选 GPU 版且探测到模型 → 无警告', async () => {
    await openSettings({ capabilities: caps(true) });
    await userEvent.click(screen.getByLabelText(/我指向的是 GPU/));
    expect(screen.queryByText(/探测不到 AI 模型与 onnxruntime/)).toBeNull();
  });

  it('引擎未启用时该开关不可用（避免配置一个不会生效的期望）', async () => {
    mockInvokeCommand('get_settings_cmd', { ...base, lumenEnabled: false });
    render(
      <SettingsModal
        isOpen
        onClose={() => undefined}
        onSettingsSaved={() => undefined}
        lumenStatus={{ available: false, enabled: false, foundVersion: null, pinnedVersion: '1.6.0', detail: '未启用' }}
        capabilities={caps(true)}
      />,
    );
    await screen.findByLabelText(/我指向的是 GPU/);
    expect(screen.getByLabelText(/我指向的是 GPU/)).toBeDisabled();
  });

  it('保存时把 lumenExpectAi 一并上报', async () => {
    const saved = await openSettings({ capabilities: caps(true) });

    await userEvent.click(screen.getByLabelText(/我指向的是 GPU/));
    await userEvent.click(screen.getByRole('button', { name: /保存/ }));

    expect(saved).toHaveLength(1);
    expect(saved[0].lumenExpectAi).toBe(true);
    expect(saved[0].lumenEnabled).toBe(true);
  });

  it('能力尚未探测出来时不误报不匹配', async () => {
    await openSettings({ capabilities: null });
    await userEvent.click(screen.getByLabelText(/我指向的是 GPU/));
    // capabilities 未就绪 → 无法判定，宁可不说，也不要误报
    expect(screen.queryByText(/探测不到 AI 模型与 onnxruntime/)).toBeNull();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('status')?.textContent ?? '').not.toContain(
      '探测不到',
    );
  });
});