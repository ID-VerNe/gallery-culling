/**
 * `prefers-reduced-motion` 单一真值（issue #119）。
 *
 * 原先 `Modal.tsx:42-45` 与 `ToastViewport.tsx:28-31` 各写一份逐字相同的
 * 4 行判定（`diff` identical）。语义必须逐字一致：用户关动效时，presence
 * 直接跳过进场/退场窗口，不挂空等——CSS 已把过渡压到 0.01ms，
 * 再加 150ms timers 只会让键盘体感变迟。
 */
export const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
