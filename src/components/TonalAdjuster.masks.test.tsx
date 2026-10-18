import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TonalAdjuster } from './TonalAdjuster';
import { TaskMutexProvider } from '../hooks/useTaskMutex';
import { DEFAULT_TONE } from '../utils/autoTone';

function renderAdjuster(props: Partial<React.ComponentProps<typeof TonalAdjuster>> = {}) {
  return render(
    <TaskMutexProvider>
      <TonalAdjuster
        tone={DEFAULT_TONE}
        onChange={() => undefined}
        onReset={() => undefined}
        onSave={async () => undefined}
        onClose={() => undefined}
        {...props}
      />
    </TaskMutexProvider>,
  );
}

// 按钮的 aria-label 恒为「保存调色」，状态只体现在可见文案里。
const saveButtonText = () =>
  screen.getByRole('button', { name: '保存调色' }).textContent ?? '';

// 不依赖 node 的 process 类型声明（tsconfig 只配了 DOM lib）
const proc = () =>
  (globalThis as unknown as {
    process: {
      on: (e: string, f: (r: unknown) => void) => void;
      off: (e: string, f: (r: unknown) => void) => void;
    };
  }).process;

describe('TonalAdjuster —— 保存失败必须有出口', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('onSave reject 时不产生未处理 rejection，并显示失败提示', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    proc().on('unhandledRejection', unhandled);

    // 统一命令（XMP + LUMEN RAW）任一环节失败都会 reject
    renderAdjuster({
      onSave: async () => {
        throw new Error('LUMEN RAW 未响应');
      },
    });

    await userEvent.click(screen.getByRole('button', { name: '保存调色' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('LUMEN RAW 未响应');
    });
    // 关键回归：不能亮绿灯假装成功
    expect(screen.queryByText('已保存')).toBeNull();
    expect(saveButtonText()).toContain('保存失败');

    proc().off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('失败后可重试，成功才变「已保存」（旧错误必须被清掉）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    renderAdjuster({
      onSave: async () => {
        calls += 1;
        if (calls === 1) throw new Error('磁盘只读');
      },
    });

    await userEvent.click(screen.getByRole('button', { name: '保存调色' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(saveButtonText()).toContain('保存失败');

    await userEvent.click(screen.getByRole('button', { name: '保存调色' }));
    await waitFor(() => expect(saveButtonText()).toContain('已保存'));
    expect(calls).toBe(2);
  });
});

describe('TonalAdjuster —— AI 蒙版（GPU 版）', () => {
  const maskProps = {
    onApplyMask: async () => undefined,
    aiAvailable: true,
  };

  it('有 onApplyMask 时渲染区域下拉与强度滑杆', () => {
    renderAdjuster(maskProps);
    expect(screen.getByLabelText(/AI 局部蒙版/)).toBeInTheDocument();
    expect(screen.getByLabelText('蒙版去薄雾强度')).toBeInTheDocument();
  });

  it('没有 onApplyMask（CPU 版）时完全不渲染蒙版控件', () => {
    renderAdjuster({ aiAvailable: false });
    expect(screen.queryByLabelText(/AI 局部蒙版/)).toBeNull();
  });

  it('套用时把选中的区域与强度传给 onApplyMask', async () => {
    const onApplyMask = vi.fn().mockResolvedValue(undefined);
    renderAdjuster({ ...maskProps, onApplyMask });

    await userEvent.selectOptions(screen.getByLabelText(/AI 局部蒙版/), 'person');
    await userEvent.click(screen.getByRole('button', { name: '套用' }));
    // C4：落盘前有二次确认
    await userEvent.click(screen.getByRole('button', { name: '检测并应用' }));

    await waitFor(() => {
      expect(onApplyMask).toHaveBeenCalledWith('person', 60);
    });
  });

  it('检测中禁用重复点击并显示进度文案', async () => {
    let release: (() => void) | undefined;
    const onApplyMask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderAdjuster({ ...maskProps, onApplyMask });

    await userEvent.click(screen.getByRole('button', { name: '套用' }));
    await userEvent.click(screen.getByRole('button', { name: '检测并应用' }));
    const button = await screen.findByRole('button', { name: '检测中…' });

    expect(button).toBeDisabled();
    expect(screen.getByText(/AI 正在检测区域并应用/)).toBeInTheDocument();

    release?.();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '套用' })).toBeEnabled(),
    );
  });

  it('失败时显示错误且按钮复位', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onApplyMask = vi.fn().mockRejectedValue(new Error('未检测到该区域'));
    renderAdjuster({ ...maskProps, onApplyMask });

    await userEvent.click(screen.getByRole('button', { name: '套用' }));
    await userEvent.click(screen.getByRole('button', { name: '检测并应用' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('未检测到该区域');
    });
    expect(screen.getByRole('button', { name: '套用' })).toBeEnabled();
  });

  it('列出工程里已套用的蒙版', () => {
    renderAdjuster({
      ...maskProps,
      masks: [{ name: '天空（自然语言）', kind: 'sky' }],
    });
    expect(screen.getByText(/已套用：天空（自然语言）/)).toBeInTheDocument();
  });
});