/**
 * FR-02 色标快捷键（issue #61 后只保留左手 `Shift+1…5`）。
 *
 * 两个易错点：
 * 1. `Shift+1…5` 在美式布局下 `e.key` 是 `!` `@` `#` `$` `%`，不是数字；
 *    必须按物理键位 `e.code === 'Digit1'…'Digit5'`。
 * 2. 右手 `6/7/8/9` 与 `Shift+6`（紫色）已删除：按下必须完全无动作，
 *    也不能阻止默认（否则会吞掉浏览器/输入框行为）。
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

describe('左手色标快捷键 Shift+1…5', () => {
  it.each([
    [{ key: '!', code: 'Digit1' }, 'Red'],
    [{ key: '"', code: 'Digit2' }, 'Yellow'],
    [{ key: '#', code: 'Digit3' }, 'Green'],
    [{ key: '$', code: 'Digit4' }, 'Blue'],
    [{ key: '%', code: 'Digit5' }, 'Purple'],
  ] as const)('$code + Shift 触发对应色标', (event, expected) => {
    const h = setup();
    fireEvent.keyDown(window, { ...event, shiftKey: true });

    expect(h.onLabel).toHaveBeenCalledTimes(1);
    expect(h.onLabel).toHaveBeenCalledWith(expected);
    // 色标键不得顺带改星级
    expect(h.onRate).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+1 不抢组合键', () => {
    const h = setup();
    fireEvent.keyDown(window, { key: '!', code: 'Digit1', shiftKey: true, ctrlKey: true });
    expect(h.onLabel).not.toHaveBeenCalled();
  });

  it('焦点在下拉框时不触发色标（既有守卫对新键位同样生效）', () => {
    const h = setup();
    const select = mount(document.createElement('select'));
    fireEvent.keyDown(select, { key: '!', code: 'Digit1', shiftKey: true });
    expect(h.onLabel).not.toHaveBeenCalled();
  });

  it('未接 onLabel 时不崩（hook 可独立使用）', () => {
    setup(false);
    expect(() => fireEvent.keyDown(window, { key: '!', code: 'Digit1', shiftKey: true })).not.toThrow();
  });
});

describe('右手数字键已删除（issue #61）', () => {
  it.each(['6', '7', '8', '9'] as const)('%s 不再触发色标、也不阻止默认', (key) => {
    const h = setup();
    const notPrevented = fireEvent.keyDown(window, { key });

    expect(h.onLabel).not.toHaveBeenCalled();
    expect(h.onRate).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it('Shift+6 不再触发紫色', () => {
    const h = setup();
    const notPrevented = fireEvent.keyDown(window, { key: '^', code: 'Digit6', shiftKey: true });

    expect(h.onLabel).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it('连按 6/7/8/9 后星级、色标、旗标全部不变', () => {
    const h = setup();
    for (const key of ['6', '7', '8', '9']) {
      fireEvent.keyDown(window, { key });
    }

    expect(h.onLabel).not.toHaveBeenCalled();
    expect(h.onRate).not.toHaveBeenCalled();
    expect(h.onFlag).not.toHaveBeenCalled();
  });
});
