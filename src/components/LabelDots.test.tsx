/**
 * SH-01（issue #32）：色标的鼠标入口。
 *
 * 色标此前只有 6/7/8/9 与 Shift+6 两条键盘路径（issue #61 后只剩左手
 * `Shift+1…5`），组件层 `git grep "onLabel:"` 无任何命中
 * （mouse-only 用户无法设置色标）。本用例锁住共享色点组件：
 * 点击色点 = 把该色标交给宿主（切换/取消的语义由宿主实现），且当前色标
 * 必须通过 `aria-pressed` 可感知。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LabelDots } from './LabelDots';

describe('LabelDots —— 色点鼠标入口（SH-01）', () => {
  it('渲染五个色点，点击红点把 Red 交给宿主', () => {
    const onSelect = vi.fn();
    render(<LabelDots label="" onSelect={onSelect} />);

    // 五个色点一个都不能少（紫色同样要有鼠标入口，不能只靠 Shift+5）。
    expect(screen.getAllByRole('button')).toHaveLength(5);

    fireEvent.click(screen.getByRole('button', { name: '红色标（快捷 Shift+1）' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('Red');
  });

  it('当前色标通过 aria-pressed 暴露，其余为 false', () => {
    render(<LabelDots label="Green" onSelect={vi.fn()} />);

    expect(screen.getByRole('button', { name: '绿色标（快捷 Shift+3）' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '红色标（快捷 Shift+1）' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('紫色色点的提示带上 Shift+5，避免「有紫色但不知道怎么按」', () => {
    render(<LabelDots label="" onSelect={vi.fn()} />);

    const purple = screen.getByRole('button', { name: '紫色标（快捷 Shift+5）' });
    expect(purple.getAttribute('title')).toBe('紫色标（快捷 Shift+5）');
  });

  it('多窗格场景用 scopeName 区分按钮的可访问名（双图左右各有一组）', () => {
    const onSelect = vi.fn();
    render(<LabelDots label="" onSelect={onSelect} scopeName="g1" />);

    fireEvent.click(screen.getByRole('button', { name: 'g1：蓝色标（快捷 Shift+4）' }));

    expect(onSelect).toHaveBeenCalledWith('Blue');
  });

  it('当前色标为空或后端未知值时，没有任何色点处于按下态', () => {
    render(<LabelDots label="None" onSelect={vi.fn()} />);

    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
  });
});
