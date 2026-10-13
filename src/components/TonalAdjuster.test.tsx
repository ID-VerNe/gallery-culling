/**
 * 调色面板的 LUMEN RAW 分支。
 *
 * 关注点是**能力可见性**与**统一保存**：预设来自 sidecar 自己的 command table
 *（不硬编码），GPU flavor 缺失时必须说人话而不是假装能用；保存是一条命令
 * 同时写 XMP 与 LUMEN RAW，引擎不可用时静默只写 XMP。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TonalAdjuster } from './TonalAdjuster';
import { DEFAULT_TONE } from '../utils/autoTone';
import type { ToneAdjustments } from '../types';

const tone: ToneAdjustments = {
  exposure: 0.65,
  highlights: -12,
  shadows: 34,
  temperature: -20,
  tint: 8,
  contrast: 15,
};

type Props = React.ComponentProps<typeof TonalAdjuster>;

function renderAdjuster(overrides: Partial<Props> = {}) {
  const props: Props = {
    tone,
    onChange: vi.fn(),
    onSave: vi.fn(async () => {}),
    onClose: vi.fn(),
    ...overrides,
  };
  const user = userEvent.setup();
  render(<TonalAdjuster {...props} />);
  return { props, user };
}

const saveBtn = () => screen.getByRole('button', { name: '保存调色' });

describe('TonalAdjuster —— 统一保存（XMP + LUMEN RAW）', () => {
  it('保存按钮始终存在（引擎是否可用不再影响按钮有无）', () => {
    renderAdjuster();
    expect(saveBtn()).toBeInTheDocument();
    expect(saveBtn()).toHaveTextContent('保存调色');
  });

  it('点保存调用 onSave 一次，且不重复触发', async () => {
    const onSave = vi.fn(async () => {});
    const { user } = renderAdjuster({ onSave });

    await user.click(saveBtn());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith();
  });

  it('保存成功后反馈「已保存」', async () => {
    const { user } = renderAdjuster({ onSave: vi.fn(async () => {}) });

    await user.click(saveBtn());

    await waitFor(() => expect(saveBtn()).toHaveTextContent('已保存'));
  });

  /**
   * 展示契约（**不是**重入契约）：
   * 重入保证由 owner 经 `isSaving` 驱动 —— 端到端证明在 `App.toneSave.test.tsx`
   * （App 在写入挂起期间传 `isSaving=true` 并短路 `handleSaveTone`）。
   * 组件自身**刻意不持有**本地 saving 状态：那会制造"同一事实多份真值"，并可能在
   * owner 仍在飞行时提前解禁 —— 正是 H-02 修掉的"双击重复落盘"。
   * 本用例只证明「prop → 渲染 + 禁用确实在 DOM 层挡住点击」这条展示契约，
   * 因此它不再自称在测重入，也就不是假护栏。
   */
  it('isSaving 为真时按钮禁用、文案切「保存中…」，且点击不会触发 onSave', () => {
    const onSave = vi.fn(async () => {});
    renderAdjuster({ isSaving: true, onSave });

    const btn = saveBtn();
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('保存中…');

    // 2d 实证结论：本仓 jsdom 环境下 `fireEvent.click` 落到 disabled 的 button 上
    // **不会**触发 onClick（jsdom 遵循「disabled 表单控件不产生 click 事件」）。
    // 这正是 App.toneSave.test.tsx 里「双击只发 1 次」能成立的前提之一。
    fireEvent.click(btn);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('TonalAdjuster —— 两侧调色分歧', () => {
  const DIVERGENT_TEXT = 'XMP 与 LUMEN RAW 的调色不一致';

  it('divergent=false 时不提示', () => {
    renderAdjuster({ divergent: false });
    expect(screen.queryByText(new RegExp(DIVERGENT_TEXT))).toBeNull();
  });

  it('divergent=true 时明确告知，并声明保存会以滑杆为准', () => {
    renderAdjuster({ divergent: true });

    const alert = screen.getByText(new RegExp(DIVERGENT_TEXT));
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(alert).toHaveAttribute('role', 'status');
    expect(alert.textContent).toContain('以当前滑杆为准');
  });
});

describe('TonalAdjuster —— LUMEN RAW 预设', () => {
  const presets = ['Neutral', 'Clarity Boost', 'Portra Warm'];

  it('lumenPresets 为空数组时不渲染下拉', () => {
    renderAdjuster({ lumenPresets: [], onApplyPreset: vi.fn() });
    expect(screen.queryByLabelText('LUMEN RAW 预设')).toBeNull();
  });

  it('未传 lumenPresets（默认空）时不渲染下拉', () => {
    renderAdjuster({ onApplyPreset: vi.fn() });
    expect(screen.queryByLabelText('LUMEN RAW 预设')).toBeNull();
  });

  it('没有 onApplyPreset 时即便有预设也不渲染下拉', () => {
    renderAdjuster({ lumenPresets: presets });
    expect(screen.queryByLabelText('LUMEN RAW 预设')).toBeNull();
  });

  it('有预设时渲染下拉，选项完全来自 props（含占位项）', () => {
    renderAdjuster({ lumenPresets: presets, onApplyPreset: vi.fn() });

    const select = screen.getByLabelText('LUMEN RAW 预设');
    expect(select.tagName).toBe('SELECT');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '选择预设…',
      ...presets,
    ]);
  });

  it('选择预设调用 onApplyPreset(名称)，且下拉复位到占位项', async () => {
    const onApplyPreset = vi.fn();
    const { user } = renderAdjuster({ lumenPresets: presets, onApplyPreset });

    await user.selectOptions(screen.getByLabelText('LUMEN RAW 预设'), 'Clarity Boost');
    // C4：写工程前有二次确认（下拉已复位到占位项）
    expect(screen.getByLabelText('LUMEN RAW 预设')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: '套用并保存' }));

    expect(onApplyPreset).toHaveBeenCalledTimes(1);
    expect(onApplyPreset).toHaveBeenCalledWith('Clarity Boost');
    expect(screen.getByLabelText('LUMEN RAW 预设')).toHaveValue('');
  });

  it('aiAvailable=false 时说明需要 GPU 版本', () => {
    renderAdjuster({ lumenPresets: presets, onApplyPreset: vi.fn(), aiAvailable: false });

    expect(screen.getByText(/需要带 GPU 推理的 LUMEN RAW 版本/)).toBeInTheDocument();
    expect(screen.getByText(/暂不可用/)).toBeInTheDocument();
  });

  it('aiAvailable=true 时不显示该说明', () => {
    renderAdjuster({ lumenPresets: presets, onApplyPreset: vi.fn(), aiAvailable: true });

    expect(screen.queryByText(/需要带 GPU 推理的 LUMEN RAW 版本/)).toBeNull();
    expect(screen.queryByText(/暂不可用/)).toBeNull();
    // 下拉本身仍在
    expect(screen.getByLabelText('LUMEN RAW 预设')).toBeInTheDocument();
  });

  it('aiAvailable 缺省为 false（未显式传也走降级说明）', () => {
    renderAdjuster({ lumenPresets: presets, onApplyPreset: vi.fn() });

    expect(screen.getByText(/需要带 GPU 推理的 LUMEN RAW 版本/)).toBeInTheDocument();
  });
});

describe('TonalAdjuster —— 滑杆与工具按钮', () => {
  it('六个滑杆都在，包括 tint（类型里有、computeAutoTone 会产出）', () => {
    renderAdjuster();

    for (const label of ['曝光', '阴影', '高光', '色温', '色调', '对比度']) {
      expect(screen.getByRole('slider', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('滑杆读数反映当前值', () => {
    renderAdjuster({ tone: { ...DEFAULT_TONE, exposure: 1.25, contrast: -30 } });

    expect(screen.getByRole('slider', { name: /曝光/ })).toHaveValue('1.25');
    expect(screen.getByRole('slider', { name: /对比度/ })).toHaveValue('-30');
  });

  it('滑杆变化把新值交给 onChange（保留其余字段）', () => {
    const onChange = vi.fn();
    renderAdjuster({ onChange, tone: { ...DEFAULT_TONE, shadows: 12 } });

    const exposure = screen.getByRole('slider', { name: /曝光/ });
    fireEvent.change(exposure, { target: { value: '0.65' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ exposure: 0.65, shadows: 12 }),
    );
  });

  it('重置按钮先弹二次确认，确认后才回落到 DEFAULT_TONE（T-03）', async () => {
    const onChange = vi.fn();
    const { user } = renderAdjuster({ onChange });

    await user.click(screen.getByRole('button', { name: '重置调色滑块' }));

    // 确认前不得有任何写入
    expect(onChange).not.toHaveBeenCalled();
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent(/重置调色参数/);

    await user.click(within(dlg).getByRole('button', { name: '重置' }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_TONE });
  });

  it('重置确认框可取消，取消后不写入', async () => {
    const onChange = vi.fn();
    const { user } = renderAdjuster({ onChange });

    await user.click(screen.getByRole('button', { name: '重置调色滑块' }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: '取消' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('有 onReset 时优先走 onReset（同样需确认）', async () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const { user } = renderAdjuster({ onChange, onReset });

    await user.click(screen.getByRole('button', { name: '重置调色滑块' }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: '重置' }));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('自动按钮优先走新的 onAuto', async () => {
    const onAuto = vi.fn();
    const onAutoTone = vi.fn();
    const { user } = renderAdjuster({ onAuto, onAutoTone });

    await user.click(screen.getByRole('button', { name: '智能自动调色' }));

    expect(onAuto).toHaveBeenCalledTimes(1);
    expect(onAutoTone).not.toHaveBeenCalled();
  });

  it('没有 onAuto 时回落旧的 onAutoTone', async () => {
    const onAutoTone = vi.fn();
    const { user } = renderAdjuster({ onAutoTone });

    await user.click(screen.getByRole('button', { name: '智能自动调色' }));

    expect(onAutoTone).toHaveBeenCalledTimes(1);
  });

  it('面板本体吞掉点击（避免误触外层关闭），只有关闭按钮能关', async () => {
    const onClose = vi.fn();
    const { user } = renderAdjuster({ onClose });

    await user.click(screen.getByRole('region', { name: '快速调色控制面板' }));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '关闭面板' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
