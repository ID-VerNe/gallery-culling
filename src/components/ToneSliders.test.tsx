/**
 * issue #115 · PA 滑杆纯展示。
 *
 * 只证两条契约：六个滑杆经受控 tone 渲染；onChange 把新值与旧字段合并。
 * 布局/间距的断言由 TonalAdjuster.test.tsx 的「间距层级」用例钉住，
 * 这里不重复锁 className。
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToneSliders } from './ToneSliders';
import { DEFAULT_TONE } from '../utils/autoTone';

describe('ToneSliders —— 纯展示', () => {
  it('六个滑杆都在且读数反映当前值', () => {
    render(
      <ToneSliders tone={{ ...DEFAULT_TONE, exposure: 1.25 }} onChange={() => {}} />,
    );
    for (const label of ['曝光', '阴影', '高光', '色温', '色调', '对比度']) {
      expect(screen.getByRole('slider', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByRole('slider', { name: /曝光/ })).toHaveValue('1.25');
  });

  it('滑杆变化把新值交给 onChange（保留其余字段）', () => {
    const onChange = vi.fn();
    render(
      <ToneSliders tone={{ ...DEFAULT_TONE, shadows: 12 }} onChange={onChange} />,
    );
    fireEvent.change(screen.getByRole('slider', { name: /曝光/ }), {
      target: { value: '0.65' },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ exposure: 0.65, shadows: 12 }),
    );
  });
});
