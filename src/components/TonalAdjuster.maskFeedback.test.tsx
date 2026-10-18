/**
 * 蒙版对话框的反馈真空（T-05）与错误透传（T-02）。
 *
 * 修复前：点「检测并应用」后对话框立即关闭，而检测要跑约 4s ——
 * 对话框消失、面板回到待命，4s 后 toast 才突然出现。用户无法判断是否生效，
 * 很容易重复点击或以为失败而改用别的路径。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TonalAdjuster } from './TonalAdjuster';
import { TaskMutexProvider } from '../hooks/useTaskMutex';
import { DEFAULT_TONE } from '../utils/autoTone';

const baseProps = {
  tone: DEFAULT_TONE,
  onChange: vi.fn(),
  onSave: vi.fn(),
  onClose: vi.fn(),
};

function renderAdjuster(over: Record<string, unknown> = {}) {
  return render(
    <TaskMutexProvider>
      <TonalAdjuster {...baseProps} {...(over as object)} />
    </TaskMutexProvider>,
  );
}

const MASK_LABEL = /AI 局部蒙版/;
const APPLY = '检测并应用';

describe('T-05 —— 蒙版确认框在任务期间保持可见', () => {
  it('点确认后对话框不关闭，按钮显示处理中', async () => {
    const user = userEvent.setup();
    // 永不 resolve 的 promise：模拟「检测正在跑」
    const onApplyMask = vi.fn(() => new Promise<void>(() => {}));
    renderAdjuster({ onApplyMask });

    await user.selectOptions(screen.getByLabelText(MASK_LABEL), 'person');
    await user.click(screen.getByRole('button', { name: /^套用$/ }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: APPLY }));

    // 关键：对话框仍在（修复前会立刻消失）
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 按钮进入 busy 态，给出「正在跑」的反馈
    await waitFor(() => {
      const d = within(screen.getByRole('dialog'));
      expect(d.getByRole('button', { name: /处理中/ })).toBeDisabled();
    });
    expect(screen.getByRole('dialog')).toHaveTextContent(/处理中/);
  });

  it('任务成功后对话框才关闭', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onApplyMask = vi.fn(() => new Promise<void>((res) => (release = res)));
    renderAdjuster({ onApplyMask });

    await user.selectOptions(screen.getByLabelText(MASK_LABEL), 'person');
    await user.click(screen.getByRole('button', { name: /^套用$/ }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: APPLY }));

    expect(screen.getByRole('dialog')).toBeTruthy();

    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('任务失败时对话框保留，用户能看到错误并重试', async () => {
    const user = userEvent.setup();
    const onApplyMask = vi.fn().mockRejectedValue(new Error('未检测到该区域'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderAdjuster({ onApplyMask });

      await user.selectOptions(screen.getByLabelText(MASK_LABEL), 'person');
      await user.click(screen.getByRole('button', { name: /^套用$/ }));
      const dlg = await screen.findByRole('dialog');
      await user.click(within(dlg).getByRole('button', { name: APPLY }));

      // 失败不关对话框，且错误可见 —— 用户不会在错误信息消失前失去线索
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(screen.getByRole('dialog')).toHaveTextContent(/未检测到该区域/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
