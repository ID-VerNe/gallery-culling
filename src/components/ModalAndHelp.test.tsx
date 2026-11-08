/**
 * UX-17 模态滚动锁 / UX-18 快捷键帮助搜索。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { Modal, MODAL_EXIT_MS } from './Modal';
import { ShortcutHelpModal, matchesShortcut } from './ShortcutHelpModal';
import { MOUSE_SHORTCUTS, SHORTCUT_GROUPS } from '../utils/shortcutCatalog';

describe('UX-17 —— 模态打开时锁滚动', () => {
  it('打开后 documentElement.overflow 为 hidden，关闭后恢复原值', () => {
    const { rerender } = render(
      <Modal isOpen={false} onClose={() => {}} title="t">
        body
      </Modal>,
    );
    const before = document.documentElement.style.overflow;

    rerender(
      <Modal isOpen onClose={() => {}} title="t">
        body
      </Modal>,
    );
    expect(document.documentElement.style.overflow).toBe('hidden');

    rerender(
      <Modal isOpen={false} onClose={() => {}} title="t">
        body
      </Modal>,
    );
    expect(document.documentElement.style.overflow).toBe(before);
  });

  it('嵌套模态：内层关闭后外层仍保持锁定', () => {
    function Two({ outer, inner }: { outer: boolean; inner: boolean }) {
      return (
        <>
          <Modal isOpen={outer} onClose={() => {}} title="outer">
            <Modal isOpen={inner} onClose={() => {}} title="inner">
              x
            </Modal>
          </Modal>
        </>
      );
    }
    const { rerender } = render(<Two outer inner />);
    expect(document.documentElement.style.overflow).toBe('hidden');

    rerender(<Two outer inner={false} />);
    expect(document.documentElement.style.overflow).toBe('hidden');

    rerender(<Two outer={false} inner={false} />);
    expect(document.documentElement.style.overflow).not.toBe('hidden');
  });
});

describe('UX-18 —— 快捷键帮助可搜索', () => {
  it('matchesShortcut：中文按 label、键位按 keys，大小写与空格不敏感', () => {
    expect(matchesShortcut('星级', { keys: '1 ~ 5', label: '打 1-5 星' })).toBe(false);
    expect(matchesShortcut('打', { keys: '1 ~ 5', label: '打 1-5 星' })).toBe(true);
    expect(matchesShortcut('ctrl', { keys: 'Ctrl/⌘ + Z', label: '撤销' })).toBe(true);
    expect(matchesShortcut('', { keys: 'X', label: '淘汰' })).toBe(true);
  });

  it('输入「撤销」后只显示相关条目', () => {
    render(<ShortcutHelpModal isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索快捷键'), { target: { value: '撤销' } });
    expect(screen.getByText(/撤销上一步/)).toBeTruthy();
    expect(screen.queryByText('在 Photoshop / 默认程序中打开')).toBeNull();
  });

  it('无匹配时给出明确空状态，而不是一片空白', () => {
    render(<ShortcutHelpModal isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('搜索快捷键'), {
      target: { value: 'zzzz-not-a-key' },
    });
    expect(screen.getByText(/没有匹配/)).toBeTruthy();
  });

  it('匹配数量被播报（role=status）', () => {
    render(<ShortcutHelpModal isOpen onClose={() => {}} />);
    const live = screen
      .getAllByRole('status')
      .find((el) => /共 \d+ 项|匹配 \d+ 项/.test(el.textContent ?? ''));
    expect(live).toBeTruthy();
  });
});

/**
 * issue #61：帮助清单必须与「只保留左手键」的 catalog 同源。
 *
 * 锁两件事：条目总数（从 catalog 计算，防止增删后忘改文案）与关键键位文案
 * （防止再出现「帮助写 P、实际按 F」或右手旧键回流）。
 */
describe('issue #61 —— 帮助弹窗锁住左手键文案', () => {
  it('条目总数与 catalog 一致，且只列左手路径', () => {
    render(<ShortcutHelpModal isOpen onClose={() => {}} />);

    const total =
      SHORTCUT_GROUPS.reduce((sum, group) => sum + group.items.length, 0) +
      MOUSE_SHORTCUTS.length;
    expect(screen.getByText(`共 ${total} 项`)).toBeTruthy();

    for (const keys of [
      'F', // 保留
      'R', // 清除
      'Shift + 1 ~ 5', // 色标
      'T', // 前后对照
      'V（按住）', // 按住看原片
      'W', // 外部打开
      'G', // 镜头元数据
      'Q / B', // 钉左图
      'Shift + Q', // 钉右图
      'F1', // 帮助
    ]) {
      expect(screen.getByText(keys)).toBeTruthy();
    }

    for (const legacy of [
      'F / P',
      'R / 0 / U',
      'T / Y',
      'V / \\（按住）',
      '6 / 7 / 8 / 9',
      'Shift + 6',
      '[ 或 B',
      '] 或 空格',
    ]) {
      expect(screen.queryByText(legacy)).toBeNull();
    }
  });
});

/**
 * issue #32 / SH-10：帮助必须覆盖「已实现但此前没写进文档」的三类入口。
 *
 * 判定历史：Home/End/PgUp/PgDn 的实现已随 #61 删除，故不再属于缺口；
 * 真正的缺口是宫格 `Ctrl+A`、`Esc` 与 `Ctrl/Shift+点击` 多选，以及
 * 宫格内 `↑ / ↓` 跨行。缺一条就说明帮助又落后于实现了。
 */
describe('issue #32 / SH-10 —— 帮助补齐宫格与 Esc 键位', () => {
  it('宫格全选 / Esc / 跨行 / 鼠标多选都能在帮助里查到', () => {
    render(<ShortcutHelpModal isOpen onClose={() => {}} />);

    for (const keys of [
      'Ctrl/⌘ + A', // 宫格全选
      'Esc', // 关弹窗 / 面板 / 清空宫格搜索
      '↑ / ↓', // 宫格跨行
      'Shift + ↑ / ↓', // issue #79：宫格按行连选
      'Shift + A / D', // issue #79：宫格逐张连选
      'Ctrl / Shift + 点击', // 宫格多选 / 范围选
    ]) {
      expect(screen.getByText(keys)).toBeTruthy();
    }
  });
});

/**
 * issue #18 · PB-12（本 issue #41 落地）：模态进场 / 退场 presence。
 *
 * 三态时序：`关 → 面板标 data-exiting 仍挂载 → 推进 MODAL_EXIT_MS 后卸载`。
 * 硬约束：退场窗口有界（定时器卸载、卸载即清理），且不能阻塞 Esc/关闭 ——
 * 退场期间再按 Esc 或再点 X 都不得重复触发 onClose。
 *
 * jsdom 不跑 CSS 过渡，这里只钉结构与时序；scrim + scale 的顺滑度与 Esc 体感
 * 由真机回签。
 */
describe('issue #41 —— 模态 presence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 退场时 role/aria-modal 已摘掉（否则全局快捷键守卫会继续认为模态开着），
  // 所以稳定锚点是 data-modal-panel 而不是 role。
  const panel = () => document.querySelector('[data-modal-panel="true"]') as HTMLElement | null;
  /** 全局快捷键守卫的判定口径（`useKeyboardShortcuts.ts:135` 同款选择器）。 */
  const openModalGuard = () => document.querySelector('[role="dialog"][aria-modal="true"]');

  /**
   * 临时把 `prefers-reduced-motion` 置为真。
   * `setup.ts:307` 用 `writable: true` 但没有 `configurable`，所以这里**只能赋值**
   * （`defineProperty` 会抛 Cannot redefine property），也不能用 `vi.spyOn`。
   * 赋值后再读一次确认真的生效，避免「没覆盖上还假装绿」。
   */
  const withReducedMotion = (fn: () => void) => {
    const prev = window.matchMedia;
    const stub = (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
    (window as unknown as Record<string, unknown>).matchMedia = stub;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      throw new Error('本环境无法覆盖 matchMedia，reduced-motion 用例不能假装通过');
    }
    try {
      fn();
    } finally {
      (window as unknown as Record<string, unknown>).matchMedia = prev;
    }
  };

  const renderModal = (isOpen: boolean, onClose: () => void = () => {}) => {
    const view = render(
      <Modal isOpen={isOpen} onClose={onClose} title="t">
        body
      </Modal>,
    );
    const rerenderModal = (next: boolean) =>
      view.rerender(
        <Modal isOpen={next} onClose={onClose} title="t">
          body
        </Modal>,
      );
    return { ...view, rerenderModal };
  };

  it('关闭后面板仍挂载并标 data-exiting，推进 MODAL_EXIT_MS 才卸载', () => {
    const { rerenderModal } = renderModal(true);
    expect(panel()).not.toBeNull();
    expect(panel()!.getAttribute('data-exiting')).toBeNull();
    expect(openModalGuard()).not.toBeNull();

    rerenderModal(false);

    // 同一个 tick：面板必须还在，并进入退场态
    expect(panel()).not.toBeNull();
    expect(panel()!.getAttribute('data-exiting')).toBe('true');

    // 关键：退场窗口内不能还被当成「模态开着」—— 否则关窗后 150ms 内
    // 单键快捷键会被 useKeyboardShortcuts 吞掉（App.undo / App.album 回归用例盯着）
    expect(openModalGuard()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(MODAL_EXIT_MS - 1);
    });
    expect(panel()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(panel()).toBeNull();
  });

  it('退场窗口内再按 Esc 不会重复触发 onClose（不叠加）', () => {
    const onClose = vi.fn();
    const { rerenderModal } = renderModal(true, onClose);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerenderModal(false);
    expect(panel()!.getAttribute('data-exiting')).toBe('true');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(MODAL_EXIT_MS);
    });
    expect(panel()).toBeNull();
  });

  it('退场窗口内连点关闭按钮只关一次', () => {
    const onClose = vi.fn();
    const { rerenderModal } = renderModal(true, onClose);

    fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerenderModal(false);
    // 退场期间按钮仍在 DOM（用户手快会点到第二下）
    const closeBtn = document.querySelector('[data-modal-close="true"]') as HTMLElement;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn);
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('退场中快速重开：取消退场，面板留在 DOM 且回到在场态', () => {
    const { rerenderModal } = renderModal(true);
    rerenderModal(false);
    expect(panel()!.getAttribute('data-exiting')).toBe('true');

    rerenderModal(true);
    expect(panel()!.getAttribute('data-exiting')).toBeNull();
    // 重开重新走进场帧：一格之后回到 opacity-100
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect((panel()!.parentElement as HTMLElement).className).toContain('opacity-100');

    act(() => {
      vi.advanceTimersByTime(MODAL_EXIT_MS * 2);
    });
    expect(panel()).not.toBeNull();
  });

  it('卸载时清理退场计时器：推进计时器不再有副作用', () => {
    const { rerenderModal, unmount } = renderModal(true);
    rerenderModal(false);
    // 卸载前至少挂着这一个退场计时器（跑在不同 pool 下可能另有环境自带占用，
    // 所以用「相对减少」而不是绝对值 0 来断言）
    const pendingBefore = vi.getTimerCount();
    expect(pendingBefore).toBeGreaterThan(0);
    unmount();

    expect(vi.getTimerCount()).toBe(pendingBefore - 1);
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(MODAL_EXIT_MS * 5);
      }),
    ).not.toThrow();
  });

  it('进场有过渡：首帧 opacity-0 / scale-95，下一拍切到 opacity-100 / scale-100', () => {
    renderModal(true);
    const root = panel()!.parentElement as HTMLElement;
    expect(root.className).toContain('transition-opacity');
    expect(root.className).toContain('opacity-0');
    expect(panel()!.className).toContain('scale-95');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(root.className).toContain('opacity-100');
    expect(panel()!.className).toContain('scale-100');
  });

  it('prefers-reduced-motion 下跳过进场/退场，关闭立即卸载', () => {
    withReducedMotion(() => {
      const { rerenderModal } = renderModal(true);
      rerenderModal(false);
      expect(panel()).toBeNull();
    });
  });
});
