import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 非模态面板的初始焦点：面板每次挂载时，若当前焦点"无主"（body / 已被卸载），
 * 就把焦点移入面板容器（或首个可交互元素）。
 * - 不做 Tab 陷阱（与 Modal 的关键差异）；
 * - 不归还焦点（互换场景没有可归还的宿主）；
 * - 若挂载时已有别的元素主动聚焦（如搜索框），不抢占。
 */
export function usePanelInitialFocus(
  containerRef: RefObject<HTMLElement | null>,
  prefersContainer = true,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body) return; // 已被主动聚焦，别抢
    const target = prefersContainer
      ? container
      : container.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: true });
    // 仅挂载时执行；此处有意用空依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
