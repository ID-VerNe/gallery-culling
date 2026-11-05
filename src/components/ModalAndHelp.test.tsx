/**
 * UX-17 模态滚动锁 / UX-18 快捷键帮助搜索。
 */
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';
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
