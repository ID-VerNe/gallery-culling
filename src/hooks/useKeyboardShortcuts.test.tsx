/**
 * 全局快捷键守卫的作用域契约（H-01 / M-09 / L-12 / N-05）。
 *
 * 这个 hook 的全部风险在于「本不该触发的单键快捷键仍然触发」——焦点在
 * `<select>` / `<input type=range>` / 按钮 / 模态上时，误按数字键或字母键会
 * 直接改写评级/旗标并写盘 XMP。因此断言以「回调调用次数」为主。
 *
 * 事件派发方式：把目标元素 append 到 body 并 `focus()`，再把按键派发到**该元素**。
 * 这样浏览器传播链（元素 → … → window）与真实场景一致，window 上的冒泡监听器
 * 拿到的 `e.target` 就是该控件；若直接派发到 `window`，`e.target` 会退化成
 * window 本身，守卫形同虚设（测不到真实行为）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

/** 手动挂到 body 的元素，测试结束统一移除（cleanup 不会管它们）。 */
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

function setup() {
  const handlers = {
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onRate: vi.fn(),
    onFlag: vi.fn(),
    onOpenExternal: vi.fn(),
    onToggleCompare: vi.fn(),
    onPinRight: vi.fn(),
    onTogglePinCurrent: vi.fn(),
    onHoldOriginalStart: vi.fn(),
    onHoldOriginalEnd: vi.fn(),
    onFocusSearch: vi.fn(),
    onNotify: vi.fn(),
    onLabel: vi.fn(),
  };
  renderHook(() => useKeyboardShortcuts(handlers));
  return handlers;
}

describe('useKeyboardShortcuts 守卫作用域', () => {
  it('select 聚焦时数字/字母快捷键不触发全局动作', () => {
    const h = setup();
    const select = mount(document.createElement('select'));

    fireEvent.keyDown(select, { key: '1' });
    fireEvent.keyDown(select, { key: 'x' });
    fireEvent.keyDown(select, { key: 'p' });

    expect(h.onRate).not.toHaveBeenCalled();
    expect(h.onFlag).not.toHaveBeenCalled();

    // 焦点不在任何控件上时，评星等单手快捷键必须照常可用（保持选片效率）。
    fireEvent.keyDown(document.body, { key: '1' });
    expect(h.onRate).toHaveBeenCalledTimes(1);
    expect(h.onRate).toHaveBeenCalledWith(1);
  });

  /**
   * SH-03（issue #32）：空格必须「不吞键」——点击底栏按钮后焦点留在按钮上，
   * 此时按空格过去会静默 return（不触发、不阻止默认、无反馈）。现在必须
   * 照常设为基准、阻止原生重复激活，并给一条可感知反馈。
   */
  it('按钮聚焦时空格仍触发「设为基准」，并阻止默认、给出反馈', () => {
    const h = setup();
    const button = mount(document.createElement('button'));

    const notPrevented = fireEvent.keyDown(button, { key: ' ' });

    expect(h.onTogglePinCurrent).toHaveBeenCalledTimes(1);
    // fireEvent 返回 false = preventDefault 已调用。
    expect(notPrevented).toBe(false);
    expect(h.onNotify).toHaveBeenCalledTimes(1);
    expect(h.onNotify).toHaveBeenCalledWith('已切换对比基准。');
  });

  it('链接聚焦时空格同样不吞键（设为基准 + 阻止默认）', () => {
    const h = setup();
    const link = mount(document.createElement('a'));
    link.href = '#';
    link.textContent = '示例链接';

    const notPrevented = fireEvent.keyDown(link, { key: ' ' });

    expect(h.onTogglePinCurrent).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
    expect(h.onNotify).toHaveBeenCalledTimes(1);
  });

  it('role=option 聚焦时空格同样不吞键（宫格外层 listbox 之外的选项语义）', () => {
    const h = setup();
    const option = mount(document.createElement('div'));
    option.setAttribute('role', 'option');
    option.tabIndex = 0;
    option.focus();

    const notPrevented = fireEvent.keyDown(option, { key: ' ' });

    expect(h.onTogglePinCurrent).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
    expect(h.onNotify).toHaveBeenCalledTimes(1);
  });

  it('宫格 listbox 内空格仍为设为基准（listbox 不进守卫）', () => {
    const h = setup();
    const grid = mount(document.createElement('div'));
    grid.setAttribute('role', 'listbox');
    grid.tabIndex = 0;
    grid.focus();

    fireEvent.keyDown(grid, { key: ' ' });

    expect(h.onTogglePinCurrent).toHaveBeenCalledTimes(1);
  });

  it('range 滑杆聚焦时方向键不被劫持，也不阻止默认', () => {
    const h = setup();
    const range = document.createElement('input');
    range.type = 'range';
    mount(range);

    const leftNotPrevented = fireEvent.keyDown(range, { key: 'ArrowLeft' });
    const rightNotPrevented = fireEvent.keyDown(range, { key: 'ArrowRight' });

    expect(h.onPrev).not.toHaveBeenCalled();
    expect(h.onNext).not.toHaveBeenCalled();
    // 让位给滑杆的原生键盘调整。
    expect(leftNotPrevented).toBe(true);
    expect(rightNotPrevented).toBe(true);
  });

  it('模态打开时全部单键失效', () => {
    const h = setup();
    const dialog = mount(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    fireEvent.keyDown(dialog, { key: '1' });

    expect(h.onRate).not.toHaveBeenCalled();
  });

  it('range 上按 `\\` 生效、松手复位（keyup 早于通用守卫）', () => {
    const h = setup();
    const range = document.createElement('input');
    range.type = 'range';
    mount(range);

    fireEvent.keyDown(range, { key: '\\' });
    expect(h.onHoldOriginalStart).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(range, { key: '\\' });
    expect(h.onHoldOriginalEnd).toHaveBeenCalledTimes(1);
  });

  it('文本输入框内 `\\` 让位，不触发查看原片', () => {
    const h = setup();
    const input = document.createElement('input');
    input.type = 'text';
    mount(input);

    const notPrevented = fireEvent.keyDown(input, { key: '\\' });

    expect(h.onHoldOriginalStart).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it('窗口失焦时复位按住状态，且不重复复位', () => {
    const h = setup();

    fireEvent.keyDown(document.body, { key: '\\' });
    expect(h.onHoldOriginalStart).toHaveBeenCalledTimes(1);

    fireEvent.blur(window);
    expect(h.onHoldOriginalEnd).toHaveBeenCalledTimes(1);

    // 未处于按住态时再次失焦不应误复位。
    fireEvent.blur(window);
    expect(h.onHoldOriginalEnd).toHaveBeenCalledTimes(1);
  });

  it('组合键让路：Ctrl+X 不改旗标，Ctrl+F 仍聚焦搜索', () => {
    const h = setup();

    fireEvent.keyDown(document.body, { key: 'x', ctrlKey: true });
    expect(h.onFlag).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    expect(h.onFocusSearch).toHaveBeenCalledTimes(1);
  });
});

/**
 * SH-01（issue #32）：色标的鼠标入口不能改变既有键盘路径。
 *
 * 6/7/8/9 仍是红/黄/绿/蓝，Shift+6 仍按 `e.code === 'Digit6'` 判紫色 ——
 * 美式布局下 `Shift+6` 的 `e.key` 是 `^`，所以这里刻意用 `key: '^'`。
 */
describe('useKeyboardShortcuts —— 色标键位不受鼠标入口影响', () => {
  it.each([
    ['6', 'Red'],
    ['7', 'Yellow'],
    ['8', 'Green'],
    ['9', 'Blue'],
  ] as const)('按 %s 触发 %s 色标并阻止默认', (key, expected) => {
    const h = setup();
    const notPrevented = fireEvent.keyDown(document.body, { key });
    expect(h.onLabel).toHaveBeenCalledTimes(1);
    expect(h.onLabel).toHaveBeenCalledWith(expected);
    expect(notPrevented).toBe(false);
  });

  it('Shift+6 仍为紫色（按物理键位 Digit6 判定，不依赖 e.key）', () => {
    const h = setup();
    const notPrevented = fireEvent.keyDown(document.body, {
      key: '^',
      code: 'Digit6',
      shiftKey: true,
    });
    expect(h.onLabel).toHaveBeenCalledTimes(1);
    expect(h.onLabel).toHaveBeenCalledWith('Purple');
    expect(notPrevented).toBe(false);
  });
});

/**
 * issue #35（PR #33 的后续）：空格反馈必须与「pin 是否真的生效」绑定。
 *
 * `useComparePin` 在没有 currentGroup 时是 no-op；过去 hook 仍然播报
 * 「已切换对比基准。」，属于误导性反馈。现在通过回调返回值传递唯一真值：
 * 返回 `false` = 没生效、不播报；`true` 或历史的 `void` = 播报。
 */
describe('useKeyboardShortcuts —— 空格反馈只在真正生效时播报（#35）', () => {
  function setupPin(pin: () => boolean | void) {
    const onTogglePinCurrent = vi.fn(pin);
    const onNotify = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        onPrev: vi.fn(),
        onNext: vi.fn(),
        onRate: vi.fn(),
        onFlag: vi.fn(),
        onOpenExternal: vi.fn(),
        onToggleCompare: vi.fn(),
        onTogglePinCurrent,
        onNotify,
      }),
    );
    return { onTogglePinCurrent, onNotify };
  }

  it('pin 为 no-op（返回 false）时不播报「已切换对比基准」', () => {
    const h = setupPin(() => false);

    fireEvent.keyDown(document.body, { key: ' ' });

    expect(h.onTogglePinCurrent).toHaveBeenCalledTimes(1);
    expect(h.onNotify).not.toHaveBeenCalled();
  });

  it('pin 成功（返回 true）时仍播报，防止把 SH-03 的反馈修没', () => {
    const h = setupPin(() => true);

    fireEvent.keyDown(document.body, { key: ' ' });

    expect(h.onTogglePinCurrent).toHaveBeenCalledTimes(1);
    expect(h.onNotify).toHaveBeenCalledTimes(1);
    expect(h.onNotify).toHaveBeenCalledWith('已切换对比基准。');
  });

  it('旧调用方返回 void 时保持播报（独立使用本 hook 的向后兼容）', () => {
    const h = setupPin(() => undefined);

    fireEvent.keyDown(document.body, { key: ' ' });

    expect(h.onNotify).toHaveBeenCalledTimes(1);
  });
});

/**
 * FR-05：`Z` = 1:1 细节开关。
 *
 * 这条键位与 `Ctrl+Z`（撤销）只差一个修饰键，所以最需要锁死的是
 * 「撤销不被抢走」与「重做不被抢走」——两条都已经在更早的分支 return，
 * 但如果有人把 `case 'z'` 提到组合键判断之前，这里会立刻红。
 */
describe('useKeyboardShortcuts —— Z 键 1:1', () => {
  function setupOneToOne() {
    const handlers = {
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onRate: vi.fn(),
      onFlag: vi.fn(),
      onOpenExternal: vi.fn(),
      onToggleCompare: vi.fn(),
      onToggleOneToOne: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
    };
    renderHook(() => useKeyboardShortcuts(handlers));
    return handlers;
  }

  it('无修饰键的 Z 触发 1:1，并阻止默认', () => {
    const h = setupOneToOne();
    const notPrevented = fireEvent.keyDown(document.body, { key: 'z' });
    expect(h.onToggleOneToOne).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false); // fireEvent 返回 false = preventDefault 已调用
  });

  it('大写 Z 同样触发（CapsLock / Shift 之外的输入法状态）', () => {
    const h = setupOneToOne();
    fireEvent.keyDown(document.body, { key: 'Z' });
    expect(h.onToggleOneToOne).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z 仍是撤销，不触发 1:1', () => {
    const h = setupOneToOne();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(h.onUndo).toHaveBeenCalledTimes(1);
    expect(h.onToggleOneToOne).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+Z 仍是重做，不触发 1:1', () => {
    const h = setupOneToOne();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(h.onRedo).toHaveBeenCalledTimes(1);
    expect(h.onToggleOneToOne).not.toHaveBeenCalled();
  });

  it('文本输入框里按 z 不触发（留给原生输入）', () => {
    const h = setupOneToOne();
    const input = mount(document.createElement('input'));
    fireEvent.keyDown(input, { key: 'z' });
    expect(h.onToggleOneToOne).not.toHaveBeenCalled();
  });

  it('模态打开时按 z 不触发', () => {
    const h = setupOneToOne();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    mounted.push(dialog);

    fireEvent.keyDown(document.body, { key: 'z' });
    expect(h.onToggleOneToOne).not.toHaveBeenCalled();
  });
});
