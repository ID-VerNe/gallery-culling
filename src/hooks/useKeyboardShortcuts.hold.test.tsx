/**
 * S-03：按住反斜杠期间打开弹窗，松键仍必须复位预览横幅。
 *
 * 原实现 handleKeyUp 的第一行就是 `if (isDialogOpen()) return;`，而反斜杠
 * 分支排在它下面 —— 按住后打开任何弹窗，松键就被整段吞掉，holdActiveRef
 * 永远不复位，原始照片横幅常亮。原注释还自称该分支「必须早于通用守卫」，
 * 注释与实现不符。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

function setup() {
  const onHoldOriginalEnd = vi.fn();
  const handlers = { onHoldOriginalEnd, onHoldOriginalStart: vi.fn() };
  renderHook(() => useKeyboardShortcuts(handlers as never));
  return handlers;
}

function openDialog() {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-modal', 'true');
  document.body.appendChild(d);
  return () => d.remove();
}

describe('S-03 —— hold 反斜杠与弹窗共存', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('无弹窗时松键正常复位', () => {
    const h = setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: '\\' }));
    expect(h.onHoldOriginalEnd).toHaveBeenCalledTimes(1);
  });

  it('★按住期间打开弹窗，松键仍复位（回归：修复前被守卫吞掉）', () => {
    const h = setup();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\' }));

    const close = openDialog();
    // 松键发生在弹窗打开期间
    window.dispatchEvent(new KeyboardEvent('keyup', { key: '\\' }));

    expect(h.onHoldOriginalEnd).toHaveBeenCalledTimes(1);
    close();
  });

  it('弹窗打开时其它按键仍被守卫拦下（不误触发）', () => {
    const onRate = vi.fn();
    const handlers = { onRate, onHoldOriginalEnd: vi.fn() } as never;
    renderHook(() => useKeyboardShortcuts(handlers as never));
    const close = openDialog();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' }));

    expect(onRate).not.toHaveBeenCalled();
    close();
  });
});
