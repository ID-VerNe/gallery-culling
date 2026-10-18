/**
 * FR-02 色标快捷键。
 *
 * 两个易错点：
 * 1. `Shift+6` 在美式布局下 `e.key` 是 `^`，不是 `6` —— 按字符判断永远收不到；
 *    必须按物理键位 `e.code === 'Digit6'`。
 * 2. `6..9` 与 `1..5` 是两套语义（星级 / 色标），不能互相串味。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

const mounted: HTMLElement[] = [];

function mount<T extends HTMLElement>(el: T): T {
  document.body.appendChild(el);
  mounted.push(el);
  el.focus();
  return el;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.remove();
});

function setup(withLabel = true) {
  const handlers = {
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onRate: vi.fn(),
    onFlag: vi.fn(),
    onOpenExternal: vi.fn(),
    onToggleCompare: vi.fn(),
    ...(withLabel ? { onLabel: vi.fn() } : {}),
  };
  renderHook(() => useKeyboardShortcuts(handlers));
  return handlers as typeof handlers & { onLabel?: ReturnType<typeof vi.fn> };
}

describe('色标快捷键 6/7/8/9', () => {
  it('6/7/8/9 依次对应红/黄/绿/蓝', () => {
    const h = setup();
    fireEvent.keyDown(window, { key: '6' });
    fireEvent.keyDown(window, { key: '7' });
    fireEvent.keyDown(window, { key: '8' });
    fireEvent.keyDown(window, { key: '9' });

    expect(h.onLabel!.mock.calls.map((c) => c[0])).toEqual([
      'Red',
      'Yellow',
      'Green',
      'Blue',
    ]);
    // 色标键不得顺带改星级
    expect(h.onRate).not.toHaveBeenCalled();
  });

  it('Shift+6 触发紫色（按物理键位判断，不依赖 e.key 的字符）', () => {
    const h = setup();
    // 美式布局下 Shift+6 的 key 是 '^'
    fireEvent.keyDown(window, { key: '^', code: 'Digit6', shiftKey: true });

    expect(h.onLabel).toHaveBeenCalledTimes(1);
    expect(h.onLabel).toHaveBeenCalledWith('Purple');
  });

  it('Ctrl+Shift+6 不抢组合键', () => {
    const h = setup();
    fireEvent.keyDown(window, {
      key: '^',
      code: 'Digit6',
      shiftKey: true,
      ctrlKey: true,
    });
    expect(h.onLabel).not.toHaveBeenCalled();
  });

  it('焦点在下拉框时不触发色标（既有守卫对新键位同样生效）', () => {
    const h = setup();
    const select = mount(document.createElement('select'));
    fireEvent.keyDown(select, { key: '6' });
    fireEvent.keyDown(select, { key: '^', code: 'Digit6', shiftKey: true });
    expect(h.onLabel).not.toHaveBeenCalled();
  });

  it('未接 onLabel 时不崩（hook 可独立使用）', () => {
    setup(false);
    expect(() => fireEvent.keyDown(window, { key: '6' })).not.toThrow();
  });
});
