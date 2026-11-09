/**
 * `prefersReducedMotion()` 单一真值（issue #119）。
 *
 * 原先 Modal / Toast 各写一份逐字相同的 4 行判定，唯一正确落点是这里。
 * 本文件钉三件事：matches 真/假、缺 matchMedia 时不炸退回 false、
 * 必须查的是 `prefers-reduced-motion: reduce` 而不是别的 query——
 * 变异把 query 写错必须立刻红（ModalAndHelp / Toast 的 reduced 用例同理）。
 */
import { describe, expect, it } from 'vitest';
import { prefersReducedMotion } from './reducedMotion';

const stubMatchMedia = (matches: boolean) => {
  const prev = window.matchMedia;
  (window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
    // 只有「要模拟 reduce」时才按 query 判定：写错 query 时 true 用例会红（变异靶点）。
    matches: matches && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
  // 覆盖确认：避免「没覆盖上还假装绿」。
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(matches);
  return () => {
    (window as unknown as Record<string, unknown>).matchMedia = prev;
  };
};

describe('prefersReducedMotion', () => {
  it('系统偏好 reduce 时为 true', () => {
    const restore = stubMatchMedia(true);
    try {
      expect(prefersReducedMotion()).toBe(true);
    } finally {
      restore();
    }
  });

  it('系统偏好 no-preference 时为 false', () => {
    const restore = stubMatchMedia(false);
    try {
      expect(prefersReducedMotion()).toBe(false);
    } finally {
      restore();
    }
  });

  it('缺 matchMedia 时退回 false（不炸、且不误判为 reduced）', () => {
    const prev = window.matchMedia;
    (window as unknown as Record<string, unknown>).matchMedia = undefined;
    try {
      expect(prefersReducedMotion()).toBe(false);
    } finally {
      (window as unknown as Record<string, unknown>).matchMedia = prev;
    }
  });
});
