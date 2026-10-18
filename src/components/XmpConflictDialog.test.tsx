/**
 * FR-08 冲突裁决弹窗 —— 边界优先的测试。
 *
 * 这个弹窗的每一条断言都对应「用户的钱」：
 * - 默认必须是**保留本地**（不覆盖用户刚做的标记），且这个默认要**看得见**；
 * - 「逐张选择」意味着改一行不能顺手改别的行；
 * - 取消必须一个字节都不写 —— 关闭 ≠ 默认采用外部；
 * - 提交时 `use-external` 要带上弹窗里显示的那个外部值（用户裁决的是他看到的）；
 * - 部分失败后列表会变短，选中状态不能错位到别人头上。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { XmpConflictDialog } from './XmpConflictDialog';
import type { CullStateSnapshot, XmpRefreshConflict } from '../types';

const state = (rating: number, flag = 'none', label = ''): CullStateSnapshot => ({
  rating,
  flag,
  label,
});

const conflicts: XmpRefreshConflict[] = [
  { path: 'D:/shoot/RAW/A.ARW', local: state(5, 'pick'), external: state(1) },
  { path: 'D:/shoot/RAW/B.ARW', local: state(4), external: state(2, 'reject', 'Red') },
];

function setup(overrides: Partial<React.ComponentProps<typeof XmpConflictDialog>> = {}) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(
    <XmpConflictDialog
      isOpen
      conflicts={conflicts}
      onCancel={onCancel}
      onApply={onApply}
      {...overrides}
    />,
  );
  return { onApply, onCancel };
}

const radiosOf = (name: string) =>
  screen.getAllByRole('radio').filter((el) => (el.getAttribute('aria-label') ?? '').startsWith(name));

describe('XmpConflictDialog —— 默认值与可见性', () => {
  it('打开时每张都默认「保留本地」，且默认值在界面上是可见的', () => {
    setup();
    const rows = screen.getAllByRole('radiogroup');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const radios = Array.from(row.querySelectorAll('[role="radio"]'));
      expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
      expect(radios[0].textContent).toContain('保留本地');
    }
  });

  it('同时摆出本地与磁盘两侧的值，并标明哪边是未落盘的意图', () => {
    setup();
    expect(screen.getAllByText(/本地（未写盘）/)).toHaveLength(2);
    // 5 星（本地）与 1 星（磁盘）都要出现
    expect(screen.getByText('★★★★★')).toBeInTheDocument();
    expect(screen.getByText('★☆☆☆☆')).toBeInTheDocument();
    // 第二张的磁盘值带淘汰与红标
    expect(screen.getAllByText('淘汰').length).toBeGreaterThan(0);
    expect(screen.getAllByText('红标').length).toBeGreaterThan(0);
  });

  it('空列表不渲染（刷新回来的 conflicts 可能被裁决清空，弹窗不该留个空壳）', () => {
    const { container } = render(
      <XmpConflictDialog isOpen conflicts={[]} onCancel={() => {}} onApply={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('关闭状态不渲染', () => {
    const { container } = render(
      <XmpConflictDialog isOpen={false} conflicts={conflicts} onCancel={() => {}} onApply={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('XmpConflictDialog —— 逐张选择', () => {
  it('改第二张不影响第一张', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();

    await user.click(radiosOf('B.ARW')[1]);
    expect(radiosOf('B.ARW')[1]).toHaveAttribute('aria-checked', 'true');
    expect(radiosOf('A.ARW')[0]).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('button', { name: /应用/ }));
    expect(onApply).toHaveBeenCalledWith([
      { path: 'D:/shoot/RAW/A.ARW', action: 'keep-local' },
      {
        path: 'D:/shoot/RAW/B.ARW',
        action: 'use-external',
        external: { rating: 2, flag: 'reject', label: 'Red' },
      },
    ]);
  });

  it('再点一次同一个选项不取消（裁决必须有一个确定结果）', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    await user.click(radiosOf('A.ARW')[0]);
    expect(radiosOf('A.ARW')[0]).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: /应用/ }));
    expect(onApply.mock.calls[0][0][0].action).toBe('keep-local');
  });
});

describe('XmpConflictDialog —— 批量', () => {
  it('「全部采用外部」一键全选，提交时每张都带 external', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    await user.click(screen.getByRole('button', { name: '全部采用外部' }));

    for (const row of screen.getAllByRole('radiogroup')) {
      const radios = Array.from(row.querySelectorAll('[role="radio"]'));
      expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    }

    await user.click(screen.getByRole('button', { name: /应用/ }));
    const choices = onApply.mock.calls[0][0];
    expect(choices).toHaveLength(2);
    expect(choices.every((c: { action: string }) => c.action === 'use-external')).toBe(true);
    expect(choices[0].external).toEqual({ rating: 1, flag: 'none', label: '' });
  });

  it('「全部保留本地」把逐张改过的选择收回来', async () => {
    const user = userEvent.setup();
    const { onApply } = setup();
    await user.click(screen.getByRole('button', { name: '全部采用外部' }));
    await user.click(screen.getByRole('button', { name: '全部保留本地' }));

    await user.click(screen.getByRole('button', { name: /应用/ }));
    const choices = onApply.mock.calls[0][0];
    expect(choices.every((c: { action: string }) => c.action === 'keep-local')).toBe(true);
    expect(choices[0].external).toBeUndefined();
  });
});

describe('XmpConflictDialog —— 关闭与忙碌', () => {
  it('取消：只回调 onCancel，不提交任何裁决', async () => {
    const user = userEvent.setup();
    const { onApply, onCancel } = setup();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('Esc 关闭：同样不提交', async () => {
    const user = userEvent.setup();
    const { onApply, onCancel } = setup();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('提交中：按钮与关闭都禁用，避免重复写盘', async () => {
    const user = userEvent.setup();
    const { onApply } = setup({ busy: true });
    expect(screen.getByRole('button', { name: /处理中/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭弹窗' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('应用按钮写明会提交几张（避免"我改了一张却全提交了"）', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole('button', { name: '应用 2 张' })).toBeInTheDocument();
    await user.click(radiosOf('A.ARW')[1]);
    // 选择变化不改变张数，但文案要一直是总数
    expect(screen.getByRole('button', { name: '应用 2 张' })).toBeInTheDocument();
  });
});

describe('XmpConflictDialog —— 列表变化', () => {
  it('同一张的外部值变了：这一行的选择回到默认（不能拿旧选择配新值）', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const { rerender } = render(
      <XmpConflictDialog isOpen conflicts={conflicts} onCancel={() => {}} onApply={onApply} />,
    );
    await user.click(radiosOf('A.ARW')[1]);
    expect(radiosOf('A.ARW')[1]).toHaveAttribute('aria-checked', 'true');

    // 弹窗开着时又来了一次刷新，A 的磁盘值变了
    rerender(
      <XmpConflictDialog
        isOpen
        conflicts={[{ ...conflicts[0], external: state(3, 'pick') }]}
        onCancel={() => {}}
        onApply={onApply}
      />,
    );

    expect(radiosOf('A.ARW')[0]).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: '应用 1 张' }));
    expect(onApply.mock.calls[0][0][0]).toEqual({
      path: 'D:/shoot/RAW/A.ARW',
      action: 'keep-local',
    });
  });

  it('关掉再打开：回到「保留本地」默认，上次的「采用外部」不残留', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const { rerender } = render(
      <XmpConflictDialog isOpen conflicts={conflicts} onCancel={() => {}} onApply={onApply} />,
    );
    await user.click(radiosOf('A.ARW')[1]);
    expect(radiosOf('A.ARW')[1]).toHaveAttribute('aria-checked', 'true');

    rerender(
      <XmpConflictDialog
        isOpen={false}
        conflicts={conflicts}
        onCancel={() => {}}
        onApply={onApply}
      />,
    );
    rerender(
      <XmpConflictDialog isOpen conflicts={conflicts} onCancel={() => {}} onApply={onApply} />,
    );

    expect(radiosOf('A.ARW')[0]).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('button', { name: '应用 2 张' }));
    expect(onApply.mock.calls[0][0][0].action).toBe('keep-local');
  });

  it('列表变短（部分失败后）时按路径保留各自的选择，不错位', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const { rerender } = render(
      <XmpConflictDialog
        isOpen
        conflicts={conflicts}
        onCancel={() => {}}
        onApply={onApply}
      />,
    );
    // 把 A 改成「采用外部」，B 保持「保留本地」
    await user.click(radiosOf('A.ARW')[1]);

    // A 写成功被移出列表，只剩 B
    rerender(
      <XmpConflictDialog
        isOpen
        conflicts={[conflicts[1]]}
        onCancel={() => {}}
        onApply={onApply}
      />,
    );

    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    // B 之前是「保留本地」，不能被 A 的选择污染
    expect(radiosOf('B.ARW')[0]).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('button', { name: '应用 1 张' }));
    expect(onApply).toHaveBeenCalledWith([
      { path: 'D:/shoot/RAW/B.ARW', action: 'keep-local' },
    ]);
  });
});
