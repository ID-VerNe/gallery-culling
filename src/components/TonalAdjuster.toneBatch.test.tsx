/**
 * FR-07 面板入口：按钮只在「有可套用的目标」时出现，且把写盘选项原样交出去。
 *
 * 这里刻意用 props 驱动，不经过 App —— 按钮的显示条件（≥2 张）与选项透传
 * 是组件的契约，App 只负责把选中数量喂进来。
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TonalAdjuster } from './TonalAdjuster';
import { DEFAULT_TONE } from '../utils/autoTone';

function renderPanel(overrides: {
  selectedCount?: number;
  onApplyToSelected?: (opts: { writeLumen: boolean }) => void;
  applying?: boolean;
} = {}) {
  const onApplyToSelected = overrides.onApplyToSelected ?? vi.fn();
  render(
    <TonalAdjuster
      tone={{ ...DEFAULT_TONE }}
      onChange={() => {}}
      onSave={async () => {}}
      onClose={() => {}}
      selectedCount={overrides.selectedCount}
      onApplyToSelected={onApplyToSelected}
      applying={overrides.applying}
    />,
  );
  return { onApplyToSelected };
}

describe('TonalAdjuster —— 套用到选中', () => {
  it('只有 1 张选中（就是当前照片）时不显示按钮：套给自己没有意义', () => {
    renderPanel({ selectedCount: 1 });
    expect(screen.queryByRole('button', { name: /套用到选中/ })).toBeNull();
  });

  it('未传 selectedCount 时同样不显示', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /套用到选中/ })).toBeNull();
  });

  it('≥2 张时显示，数量写进按钮文案', () => {
    renderPanel({ selectedCount: 2 });
    expect(screen.getByRole('button', { name: /套用到选中 2 张/ })).toBeInTheDocument();
  });

  it('默认只写 XMP：不勾「同时写入 LUMEN 工程」', () => {
    const { onApplyToSelected } = renderPanel({ selectedCount: 3 });
    fireEvent.click(screen.getByRole('button', { name: /套用到选中 3 张/ }));
    expect(onApplyToSelected).toHaveBeenCalledWith({ writeLumen: false });
  });

  it('勾选后 writeLumen=true', () => {
    const { onApplyToSelected } = renderPanel({ selectedCount: 3 });
    fireEvent.click(screen.getByRole('checkbox', { name: /同时写入 LUMEN 工程/ }));
    fireEvent.click(screen.getByRole('button', { name: /套用到选中 3 张/ }));
    expect(onApplyToSelected).toHaveBeenCalledWith({ writeLumen: true });
  });

  it('进行中禁用按钮并改写文案，防止连点开第二批', () => {
    renderPanel({ selectedCount: 3, applying: true });
    const btn = screen.getByRole('button', { name: /套用中/ });
    expect(btn).toBeDisabled();
  });

  it('复选框有常驻说明：关闭时 LUMEN 预览可能仍是旧调色', () => {
    renderPanel({ selectedCount: 2 });
    expect(screen.getByText(/LUMEN 预览可能仍显示旧调色/)).toBeInTheDocument();
  });
});
