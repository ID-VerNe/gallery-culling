/**
 * 底栏速查文案契约（issue #51）。
 *
 * 底栏只有 36px 高、`md` 以上才显示，横向预算紧张：速查行只保留最高频的
 * 打分 / 旗标 / 色标 / 前后 / 按住看原片，其余交给帮助弹窗。本用例锁住
 * 「文案来自键位目录」与「不再出现旧键独有写法」，防止以后又各写一份。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BottomBar } from './BottomBar';
import { BAR_SHORTCUT_IDS, findShortcut } from '../utils/shortcutCatalog';

function renderBar(onOpenShortcutHelp = vi.fn()) {
  render(
    <BottomBar
      currentIndex={0}
      totalCount={10}
      onOpenExternal={vi.fn()}
      onOpenShortcutHelp={onOpenShortcutHelp}
    />,
  );
  return onOpenShortcutHelp;
}

function barKeyCaps(): string[] {
  const group = screen.getByRole('group', { name: '常用快捷键提示' });
  return Array.from(group.querySelectorAll('[data-shortcut-keys]')).map(
    (el) => el.getAttribute('data-shortcut-keys') ?? '',
  );
}

describe('底栏速查（issue #51）', () => {
  it('键帽文案逐条来自键位目录，不各写一份', () => {
    renderBar();
    expect(barKeyCaps()).toEqual(
      BAR_SHORTCUT_IDS.map((id) => findShortcut(id)!.keys),
    );
  });

  it('左手单手可读：F、Shift + 1 ~ 5、T、V（按住）都在，旧右手键不回流', () => {
    renderBar();
    const keys = barKeyCaps();
    expect(keys).toContain('F');
    expect(keys).toContain('Shift + 1 ~ 5');
    expect(keys).toContain('T');
    expect(keys).toContain('V（按住）');
  });

  it('不再出现旧右手键写法（P / Y / 0 / U / 反斜杠）', () => {
    renderBar();
    const keys = barKeyCaps();
    for (const legacy of ['P', 'Y', '0', 'U', '\\']) {
      expect(keys).not.toContain(legacy);
    }
  });

  it('只保留最高频 6 项，其余交给帮助弹窗（防撑破 36px 底栏）', () => {
    renderBar();
    const keys = barKeyCaps();
    expect(keys).toHaveLength(6);
    // 视口内有独立箭头按钮，工具栏有可见按钮，这三条不再占底栏横向预算。
    for (const moved of ['A / D', 'C', 'E']) {
      expect(keys).not.toContain(moved);
    }
  });

  it('「全部快捷键」入口仍可用，且键帽来自 catalog（F1）', () => {
    const onOpenShortcutHelp = renderBar();
    const [entry] = screen.getAllByRole('button', { name: '查看全部快捷键' });
    expect(entry).toHaveAttribute('title', '查看全部快捷键（F1）');
    fireEvent.click(entry);
    expect(onOpenShortcutHelp).toHaveBeenCalledTimes(1);
  });
});
