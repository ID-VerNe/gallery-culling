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

  it('文本输入框内数字键不触发评星（issue #65 的 toggle 也不得穿透）', () => {
    const h = setup();
    const input = document.createElement('input');
    input.type = 'text';
    mount(input);

    const notPrevented = fireEvent.keyDown(input, { key: '1' });

    expect(h.onRate).not.toHaveBeenCalled();
    // 让位给输入框原生输入，不得 preventDefault。
    expect(notPrevented).toBe(true);
  });

  it('宫格 listbox 聚焦时按住 `V` 生效、松手复位（keyup 早于通用守卫）', () => {
    const h = setup();
    const listbox = document.createElement('div');
    listbox.setAttribute('role', 'listbox');
    mount(listbox);

    fireEvent.keyDown(listbox, { key: 'v' });
    expect(h.onHoldOriginalStart).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(listbox, { key: 'v' });
    expect(h.onHoldOriginalEnd).toHaveBeenCalledTimes(1);
  });

  it('文本输入框内 `V` 让位，不触发查看原片', () => {
    const h = setup();
    const input = document.createElement('input');
    input.type = 'text';
    mount(input);

    const notPrevented = fireEvent.keyDown(input, { key: 'v' });

    expect(h.onHoldOriginalStart).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it('窗口失焦时复位按住状态，且不重复复位', () => {
    const h = setup();

    fireEvent.keyDown(document.body, { key: 'v' });
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
 * issue #61：右手数字键 6/7/8/9 与 Shift+6 已从入口删除。
 *
 * 用户右手不离鼠标，右手数字区不是可接受入口；这里锁住「按下不再触发、
 * 也不再阻止默认」，防止后续为了兼容又把它们加回来。
 */
describe('useKeyboardShortcuts —— 右手色标键已删除（issue #61）', () => {
  it.each(['6', '7', '8', '9'] as const)('按 %s 不触发色标、也不阻止默认', (key) => {
    const h = setup();
    const notPrevented = fireEvent.keyDown(document.body, { key });
    expect(h.onLabel).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it('Shift+6（物理键位 Digit6）不再触发紫色', () => {
    const h = setup();
    const notPrevented = fireEvent.keyDown(document.body, {
      key: '^',
      code: 'Digit6',
      shiftKey: true,
    });
    expect(h.onLabel).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
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

/**
 * issue #80（SH-08）：`E` / `Ctrl+E` 同字母双语义。
 *
 * 裸 `E` 只开调色面板，`Ctrl/Cmd + E` 只开批量导出，两者都不写盘。过去
 * 这一对**没有任何用例**：只要有人把 `case 'e'` 提到 `Ctrl+E` 分支之前，
 * `Ctrl+E` 就会静默退化成「开调色面板」，而全量门禁仍是绿的。
 *
 * 与 `Z` / `Ctrl+Z` 的用例对称：锁住「修饰键分流」与「表单/模态让位」。
 */
describe('useKeyboardShortcuts —— E 与 Ctrl+E 双语义（issue #80）', () => {
  function setupTonalAndExport() {
    const handlers = {
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onRate: vi.fn(),
      onFlag: vi.fn(),
      onOpenExternal: vi.fn(),
      onToggleCompare: vi.fn(),
      onOpenExport: vi.fn(),
      onToggleTonalPanel: vi.fn(),
    };
    renderHook(() => useKeyboardShortcuts(handlers));
    return handlers;
  }

  it('裸 E 只开调色面板，不打开导出，并阻止默认', () => {
    const h = setupTonalAndExport();
    const notPrevented = fireEvent.keyDown(document.body, { key: 'e' });

    expect(h.onToggleTonalPanel).toHaveBeenCalledTimes(1);
    expect(h.onOpenExport).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false); // fireEvent 返回 false = preventDefault 已调用
  });

  it('大写 E 同样只开调色面板', () => {
    const h = setupTonalAndExport();
    fireEvent.keyDown(document.body, { key: 'E' });

    expect(h.onToggleTonalPanel).toHaveBeenCalledTimes(1);
    expect(h.onOpenExport).not.toHaveBeenCalled();
  });

  it('Ctrl+E 只开导出，不触发调色面板', () => {
    const h = setupTonalAndExport();
    const notPrevented = fireEvent.keyDown(document.body, { key: 'e', ctrlKey: true });

    expect(h.onOpenExport).toHaveBeenCalledTimes(1);
    expect(h.onToggleTonalPanel).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false);
  });

  it('文本输入框里 E / Ctrl+E 都让位（不吞表单输入）', () => {
    const h = setupTonalAndExport();
    const input = document.createElement('input');
    input.type = 'text';
    mount(input);

    fireEvent.keyDown(input, { key: 'e', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'e' });

    expect(h.onOpenExport).not.toHaveBeenCalled();
    expect(h.onToggleTonalPanel).not.toHaveBeenCalled();
  });

  it('模态打开时 E 不触发调色面板', () => {
    const h = setupTonalAndExport();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    mounted.push(dialog);

    fireEvent.keyDown(document.body, { key: 'e' });

    expect(h.onToggleTonalPanel).not.toHaveBeenCalled();
  });
});

/**
 * issue #61：右手键全部删除，每个动作只留左手单键/左半区入口。
 *
 * 判据是「左手放 A 键锚点、手掌不横移就能按到」。这里锁四件事：
 * 1. 新左手键可用；2. 旧右手键按下后完全无动作、也不阻止默认；
 * 3. 组合键（`Ctrl+F` / `Ctrl+Y` 等）与文本控件/模态仍让位。
 */
describe('useKeyboardShortcuts —— 左手单键（issue #61）', () => {
  function setupAliases() {
    const handlers = {
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onRate: vi.fn(),
      onFlag: vi.fn(),
      onClear: vi.fn(),
      onLabel: vi.fn(),
      onToggleBeforeAfter: vi.fn(),
      onHoldOriginalStart: vi.fn(),
      onHoldOriginalEnd: vi.fn(),
      onFocusSearch: vi.fn(),
      onOpenShortcutHelp: vi.fn(),
      onOpenExternal: vi.fn(),
      onToggleCompare: vi.fn(),
      onSwapCompare: vi.fn(),
      onTogglePinReference: vi.fn(),
      onPinLeft: vi.fn(),
      onPinRight: vi.fn(),
      onTogglePinCurrent: vi.fn(),
      onOpenMetadataModal: vi.fn(),
      onToggleTonalPanel: vi.fn(),
      onToggleOneToOne: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
    };
    renderHook(() => useKeyboardShortcuts(handlers));
    return handlers;
  }

  it('F 保留；P 已删除不再触发', () => {
    const h = setupAliases();

    expect(fireEvent.keyDown(document.body, { key: 'f' })).toBe(false);
    fireEvent.keyDown(document.body, { key: 'F' });
    fireEvent.keyDown(document.body, { key: 'p' });
    fireEvent.keyDown(document.body, { key: 'P' });

    expect(h.onFlag).toHaveBeenCalledTimes(2);
    for (const call of h.onFlag.mock.calls) expect(call).toEqual(['pick']);
  });

  it('R 清除；0 / U 已删除', () => {
    const h = setupAliases();

    expect(fireEvent.keyDown(document.body, { key: 'r' })).toBe(false);
    fireEvent.keyDown(document.body, { key: 'R' });
    fireEvent.keyDown(document.body, { key: '0' });
    fireEvent.keyDown(document.body, { key: 'u' });
    fireEvent.keyDown(document.body, { key: 'U' });

    expect(h.onClear).toHaveBeenCalledTimes(2);
    // 有 onClear 时不得再退回旧的双回调（避免两次写盘）。
    expect(h.onRate).not.toHaveBeenCalled();
    expect(h.onFlag).not.toHaveBeenCalled();
  });

  it('R 在未接线 onClear 时退回 onRate(0) + onFlag(none)', () => {
    const onRate = vi.fn();
    const onFlag = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        onPrev: vi.fn(),
        onNext: vi.fn(),
        onRate,
        onFlag,
        onOpenExternal: vi.fn(),
        onToggleCompare: vi.fn(),
      }),
    );

    fireEvent.keyDown(document.body, { key: 'r' });

    expect(onRate).toHaveBeenCalledWith(0);
    expect(onFlag).toHaveBeenCalledWith('none');
  });

  /**
   * 紫色色标曾经只能 `Shift+6`（左 Shift + 右 6）。左手别名走物理键位
   * `e.code`：美式布局下 `Shift+1…5` 的 `e.key` 是 `! @ # $ %`，按字符匹配
   * 永远落空。
   */
  it.each([
    ['!', 'Digit1', 'Red'],
    ['@', 'Digit2', 'Yellow'],
    ['#', 'Digit3', 'Green'],
    ['$', 'Digit4', 'Blue'],
    ['%', 'Digit5', 'Purple'],
  ] as const)('Shift+%s（%s）触发 %s 色标，不误触星级', (key, code, expected) => {
    const h = setupAliases();

    const notPrevented = fireEvent.keyDown(document.body, {
      key,
      code,
      shiftKey: true,
    });

    expect(h.onLabel).toHaveBeenCalledTimes(1);
    expect(h.onLabel).toHaveBeenCalledWith(expected);
    expect(h.onRate).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false);
  });

  it('右手旧色标键 6–9 / Shift+6 已删除，按下不触发任何色标', () => {
    const h = setupAliases();

    for (const key of ['6', '7', '8', '9']) {
      fireEvent.keyDown(document.body, { key });
    }
    fireEvent.keyDown(document.body, { key: '^', code: 'Digit6', shiftKey: true });

    expect(h.onLabel).not.toHaveBeenCalled();
    expect(h.onRate).not.toHaveBeenCalled();
  });

  it('T 前后对照；Y 已删除不再触发', () => {
    const h = setupAliases();

    expect(fireEvent.keyDown(document.body, { key: 't' })).toBe(false);
    fireEvent.keyDown(document.body, { key: 'T' });
    fireEvent.keyDown(document.body, { key: 'y' });
    fireEvent.keyDown(document.body, { key: 'Y' });

    expect(h.onToggleBeforeAfter).toHaveBeenCalledTimes(2);
  });

  it('按住 V 查看原片；反斜杠已删除', () => {
    const h = setupAliases();

    expect(fireEvent.keyDown(document.body, { key: 'v' })).toBe(false);
    expect(h.onHoldOriginalStart).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(document.body, { key: 'v' });
    expect(h.onHoldOriginalEnd).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.body, { key: '\\' });
    fireEvent.keyUp(document.body, { key: '\\' });
    expect(h.onHoldOriginalStart).toHaveBeenCalledTimes(1);
    expect(h.onHoldOriginalEnd).toHaveBeenCalledTimes(1);
  });

  it('W 打开外部程序（替代右手 O）', () => {
    const h = setupAliases();

    expect(fireEvent.keyDown(document.body, { key: 'w' })).toBe(false);

    expect(h.onOpenExternal).toHaveBeenCalledTimes(1);
  });

  it('G 打开镜头元数据（替代右手 M）', () => {
    const h = setupAliases();

    expect(fireEvent.keyDown(document.body, { key: 'g' })).toBe(false);

    expect(h.onOpenMetadataModal).toHaveBeenCalledTimes(1);
  });

  it('Q 钉左图、Shift+Q 钉右图（替代 [ / ]）', () => {
    const h = setupAliases();

    expect(fireEvent.keyDown(document.body, { key: 'q', code: 'KeyQ' })).toBe(false);
    expect(fireEvent.keyDown(document.body, { key: 'Q', code: 'KeyQ', shiftKey: true })).toBe(
      false,
    );

    expect(h.onPinLeft).toHaveBeenCalledTimes(1);
    expect(h.onPinRight).toHaveBeenCalledTimes(1);
  });

  it('F1 打开帮助（替代右手 ?）', () => {
    const h = setupAliases();

    expect(fireEvent.keyDown(document.body, { key: 'F1' })).toBe(false);

    expect(h.onOpenShortcutHelp).toHaveBeenCalledTimes(1);
  });

  /**
   * 右手键全景：按下后不得触发任何回调，也不得阻止默认。
   * 这份清单就是「右手不离开鼠标」时的禁区，删键必须整组守住。
   */
  it.each([
    'ArrowLeft',
    'ArrowRight',
    '/',
    '?',
    '0',
    'u',
    'U',
    'p',
    'P',
    'y',
    'Y',
    'o',
    'O',
    'm',
    'M',
    '[',
    ']',
    '\\',
    '6',
    '7',
    '8',
    '9',
  ] as const)('右手键 %s 不触发任何动作', (key) => {
    const h = setupAliases();
    const notPrevented = fireEvent.keyDown(document.body, { key });

    expect(notPrevented).toBe(true);
    expect(h.onPrev).not.toHaveBeenCalled();
    expect(h.onNext).not.toHaveBeenCalled();
    expect(h.onClear).not.toHaveBeenCalled();
    expect(h.onFlag).not.toHaveBeenCalled();
    expect(h.onLabel).not.toHaveBeenCalled();
    expect(h.onToggleBeforeAfter).not.toHaveBeenCalled();
    expect(h.onOpenExternal).not.toHaveBeenCalled();
    expect(h.onOpenMetadataModal).not.toHaveBeenCalled();
    expect(h.onPinLeft).not.toHaveBeenCalled();
    expect(h.onPinRight).not.toHaveBeenCalled();
    expect(h.onOpenShortcutHelp).not.toHaveBeenCalled();
    expect(h.onHoldOriginalStart).not.toHaveBeenCalled();
  });

  it('Ctrl+Y 不再重做（Y 在右半区）', () => {
    const h = setupAliases();
    const notPrevented = fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });

    expect(h.onRedo).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  /**
   * 冲突检查：别名不得抢走既有的修饰键路径。
   *
   * `Alt+F` 是 `:234` 组合键让路里唯一的字母例外（为了放过 Ctrl/Cmd+F），
   * 一旦新增 `case 'f'` 而不补 `altKey` 守卫，Alt+F 会误触「保留」。
   */
  it('Ctrl+F 仍只聚焦搜索、Alt+F 不触发保留', () => {
    const h = setupAliases();

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'f', altKey: true });

    expect(h.onFocusSearch).toHaveBeenCalledTimes(1);
    expect(h.onFlag).not.toHaveBeenCalled();
  });

  it('调用方未接线 onFocusSearch 时，Ctrl+F 也不得回落成保留', () => {
    const onFlag = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        onPrev: vi.fn(),
        onNext: vi.fn(),
        onRate: vi.fn(),
        onFlag,
        onOpenExternal: vi.fn(),
        onToggleCompare: vi.fn(),
      }),
    );

    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

    expect(onFlag).not.toHaveBeenCalled();
  });

  it('Ctrl/Alt + 别名不触发（既有组合键让路不失效）', () => {
    const h = setupAliases();

    fireEvent.keyDown(document.body, { key: 'r', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'r', altKey: true });
    fireEvent.keyDown(document.body, { key: 't', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 't', altKey: true });
    fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'v', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: '!', code: 'Digit1', shiftKey: true, ctrlKey: true });

    expect(h.onClear).not.toHaveBeenCalled();
    expect(h.onToggleBeforeAfter).not.toHaveBeenCalled();
    expect(h.onHoldOriginalStart).not.toHaveBeenCalled();
    expect(h.onLabel).not.toHaveBeenCalled();
  });

  it('文本输入框内左手键全部让位（不吞表单输入）', () => {
    const h = setupAliases();
    const input = document.createElement('input');
    input.type = 'text';
    mount(input);

    fireEvent.keyDown(input, { key: 'f' });
    fireEvent.keyDown(input, { key: 'r' });
    fireEvent.keyDown(input, { key: 't' });
    fireEvent.keyDown(input, { key: 'v' });
    fireEvent.keyDown(input, { key: 'w' });
    fireEvent.keyDown(input, { key: 'g' });
    fireEvent.keyDown(input, { key: 'q', code: 'KeyQ' });
    fireEvent.keyDown(input, { key: 'F1' });
    fireEvent.keyDown(input, { key: '!', code: 'Digit1', shiftKey: true });

    expect(h.onFlag).not.toHaveBeenCalled();
    expect(h.onClear).not.toHaveBeenCalled();
    expect(h.onToggleBeforeAfter).not.toHaveBeenCalled();
    expect(h.onHoldOriginalStart).not.toHaveBeenCalled();
    expect(h.onLabel).not.toHaveBeenCalled();
    expect(h.onOpenExternal).not.toHaveBeenCalled();
    expect(h.onOpenMetadataModal).not.toHaveBeenCalled();
    expect(h.onPinLeft).not.toHaveBeenCalled();
    expect(h.onPinRight).not.toHaveBeenCalled();
    expect(h.onOpenShortcutHelp).not.toHaveBeenCalled();
  });

  it('模态打开时左手键全部失效', () => {
    const h = setupAliases();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    mounted.push(dialog);

    fireEvent.keyDown(document.body, { key: 'f' });
    fireEvent.keyDown(document.body, { key: 'r' });
    fireEvent.keyDown(document.body, { key: 't' });
    fireEvent.keyDown(document.body, { key: 'v' });
    fireEvent.keyDown(document.body, { key: 'w' });
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'q', code: 'KeyQ' });
    fireEvent.keyDown(document.body, { key: 'F1' });
    fireEvent.keyDown(document.body, { key: '!', code: 'Digit1', shiftKey: true });

    expect(h.onFlag).not.toHaveBeenCalled();
    expect(h.onClear).not.toHaveBeenCalled();
    expect(h.onToggleBeforeAfter).not.toHaveBeenCalled();
    expect(h.onHoldOriginalStart).not.toHaveBeenCalled();
    expect(h.onLabel).not.toHaveBeenCalled();
    expect(h.onOpenExternal).not.toHaveBeenCalled();
    expect(h.onOpenMetadataModal).not.toHaveBeenCalled();
    expect(h.onPinLeft).not.toHaveBeenCalled();
    expect(h.onPinRight).not.toHaveBeenCalled();
    expect(h.onOpenShortcutHelp).not.toHaveBeenCalled();
  });
});

/**
 * issue #95 · PA：基准键缺 `e.repeat` 守卫。
 *
 * 三个基准键（`B` / `Q` / `Shift+Q`）都是**切换语义**（`useComparePin.ts`），
 * 系统键盘重复会按重复率反复「钉 → 取消」，松手时机决定最终状态。这里锁住
 * 「长按只响应首次 keydown」；同时把 `A` / `D` 的连按能力一起锁住 ——
 * issue 明确要求**不连带**给翻页键加守卫，否则会删掉一个正常用法。
 */
describe('useKeyboardShortcuts —— 基准键 repeat 守卫（issue #95）', () => {
  function setupRepeat() {
    const handlers = {
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onRate: vi.fn(),
      onFlag: vi.fn(),
      onOpenExternal: vi.fn(),
      onToggleCompare: vi.fn(),
      onTogglePinReference: vi.fn(),
      onPinLeft: vi.fn(),
      onPinRight: vi.fn(),
      onTogglePinCurrent: vi.fn(),
      onHoldOriginalStart: vi.fn(),
      onHoldOriginalEnd: vi.fn(),
    };
    renderHook(() => useKeyboardShortcuts(handlers));
    return handlers;
  }

  it('长按 B 只切换一次（重复事件不得反复钉/取消）', () => {
    const h = setupRepeat();

    expect(fireEvent.keyDown(document.body, { key: 'b' })).toBe(false);
    // 系统重复率派发的事件：必须整段忽略，也不该再 preventDefault。
    for (let i = 0; i < 3; i += 1) {
      expect(fireEvent.keyDown(document.body, { key: 'b', repeat: true })).toBe(true);
    }

    expect(h.onTogglePinReference).toHaveBeenCalledTimes(1);
  });

  it('长按 Q / Shift+Q 各只钉一次', () => {
    const h = setupRepeat();

    fireEvent.keyDown(document.body, { key: 'q', code: 'KeyQ' });
    fireEvent.keyDown(document.body, { key: 'q', code: 'KeyQ', repeat: true });

    fireEvent.keyDown(document.body, { key: 'Q', code: 'KeyQ', shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'Q', code: 'KeyQ', shiftKey: true, repeat: true });

    expect(h.onPinLeft).toHaveBeenCalledTimes(1);
    expect(h.onPinRight).toHaveBeenCalledTimes(1);
  });

  it('A / D 的 repeat 仍连续翻页（issue 明确不连带）', () => {
    const h = setupRepeat();

    fireEvent.keyDown(document.body, { key: 'a' });
    fireEvent.keyDown(document.body, { key: 'a', repeat: true });
    fireEvent.keyDown(document.body, { key: 'd' });
    fireEvent.keyDown(document.body, { key: 'd', repeat: true });

    expect(h.onPrev).toHaveBeenCalledTimes(2);
    expect(h.onNext).toHaveBeenCalledTimes(2);
  });

  it('按住 V 看原片未被改坏：repeat 不重复 start，keyup 只 end 一次', () => {
    const h = setupRepeat();

    fireEvent.keyDown(document.body, { key: 'v' });
    fireEvent.keyDown(document.body, { key: 'v', repeat: true });
    fireEvent.keyUp(document.body, { key: 'v' });

    expect(h.onHoldOriginalStart).toHaveBeenCalledTimes(1);
    expect(h.onHoldOriginalEnd).toHaveBeenCalledTimes(1);
  });
});

/**
 * issue #95 · PB-2：焦点落在宫格 listbox 内时，三个基准键让路。
 *
 * 宫格只画 `pinnedId` 角标，不展示对比结果；此时改基准用户看不见效果，
 * 松手再切回单图/对比就发现基准被静默钉住了。判定读真实焦点
 * （`document.activeElement` 的 listbox 祖先），不是「宫格是否可见」。
 * 三键在宫格内不得 `preventDefault` —— 事件要原样留给宫格的键盘导航。
 */
describe('useKeyboardShortcuts —— 宫格焦点让路（issue #95 · PB-2）', () => {
  function setupGrid() {
    const listbox = document.createElement('div');
    listbox.setAttribute('role', 'listbox');
    listbox.tabIndex = 0;
    const option = document.createElement('div');
    option.setAttribute('role', 'option');
    option.tabIndex = 0;
    listbox.appendChild(option);
    document.body.appendChild(listbox);

    const handlers = {
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onRate: vi.fn(),
      onFlag: vi.fn(),
      onOpenExternal: vi.fn(),
      onToggleCompare: vi.fn(),
      onTogglePinReference: vi.fn(),
      onPinLeft: vi.fn(),
      onPinRight: vi.fn(),
      onTogglePinCurrent: vi.fn(),
    };
    renderHook(() => useKeyboardShortcuts(handlers));
    return { listbox, option, handlers };
  }

  /** 每个用例独立挂载再清理，避免上一个用例的 listbox 残留影响焦点判定。 */
  const mounted: HTMLElement[] = [];
  function mountGrid() {
    const ctx = setupGrid();
    mounted.push(ctx.listbox);
    return ctx;
  }

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.remove();
  });

  it('焦点在宫格 option 内：B / Q / Shift+Q 不响应，也不吞事件', () => {
    const { option, handlers } = mountGrid();
    option.focus();
    expect(document.activeElement).toBe(option);

    // fireEvent 返回 false 表示 handler 调了 preventDefault；宫格内应为 true。
    expect(fireEvent.keyDown(option, { key: 'b' })).toBe(true);
    expect(fireEvent.keyDown(option, { key: 'q', code: 'KeyQ' })).toBe(true);
    expect(fireEvent.keyDown(option, { key: 'Q', code: 'KeyQ', shiftKey: true })).toBe(true);

    // `pinnedId` 的唯一写入口是 useComparePin 的切换函数，回调 0 次即角标不变。
    expect(handlers.onTogglePinReference).not.toHaveBeenCalled();
    expect(handlers.onPinLeft).not.toHaveBeenCalled();
    expect(handlers.onPinRight).not.toHaveBeenCalled();
  });

  it('焦点停在 listbox 容器本身（初始落点）时同样让路', () => {
    const { listbox, handlers } = mountGrid();
    listbox.focus();
    expect(document.activeElement).toBe(listbox);

    fireEvent.keyDown(listbox, { key: 'b' });
    fireEvent.keyDown(listbox, { key: 'q', code: 'KeyQ' });
    fireEvent.keyDown(listbox, { key: 'Q', code: 'KeyQ', shiftKey: true });

    expect(handlers.onTogglePinReference).not.toHaveBeenCalled();
    expect(handlers.onPinLeft).not.toHaveBeenCalled();
    expect(handlers.onPinRight).not.toHaveBeenCalled();
  });

  it('焦点在宫格内时 F / X 等非基准键行为不变', () => {
    const { option, handlers } = mountGrid();
    option.focus();

    expect(fireEvent.keyDown(option, { key: 'f' })).toBe(false);
    expect(fireEvent.keyDown(option, { key: 'x' })).toBe(false);

    expect(handlers.onFlag).toHaveBeenNthCalledWith(1, 'pick');
    expect(handlers.onFlag).toHaveBeenNthCalledWith(2, 'reject');
  });

  it('焦点离开宫格后，B / Q / Shift+Q 立即恢复', () => {
    const { option, handlers } = mountGrid();
    option.focus();
    option.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: 'b' });
    fireEvent.keyDown(document.body, { key: 'q', code: 'KeyQ' });
    fireEvent.keyDown(document.body, { key: 'Q', code: 'KeyQ', shiftKey: true });

    expect(handlers.onTogglePinReference).toHaveBeenCalledTimes(1);
    expect(handlers.onPinLeft).toHaveBeenCalledTimes(1);
    expect(handlers.onPinRight).toHaveBeenCalledTimes(1);
  });
});
