import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Accessible name of the dialog. Rendered as the visible title. */
  title: React.ReactNode;
  /** Optional line under the title, e.g. what the dialog will do. */
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /** Sticky footer, usually the cancel/confirm pair. */
  footer?: React.ReactNode;
  maxWidth?: string;
  /** Rendered before the title in the header row. */
  icon?: React.ReactNode;
  /** 打开时优先聚焦的元素；缺省则聚焦 body 内首个可聚焦元素（跳过右上角关闭按钮）。 */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** 关闭期间（长任务进行中）禁用 X 与 Esc，避免误关丢失进度与反馈。 */
  disableClose?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * D1：模块级弹窗栈 —— 按挂载顺序记录当前打开的 Modal 实例。
 *
 * 只有栈顶实例处理 keydown / Escape / Tab 陷阱。嵌套确认弹窗是主 Modal 的
 * 兄弟节点、与其同时挂 capture 级监听时，在确认层按 Esc 只会关掉最上层，
 * 不会连带把下面的主编辑器一起关掉（那会丢失整份表单）。
 */
const modalStack: symbol[] = [];

/**
 * Shared modal shell: dialog semantics, initial focus, a Tab trap, Escape
 * to close and focus restore to the invoking element.
 *
 * The previous implementation rendered each dialog with `role="dialog"
 * aria-modal="true"` but no focus management at all, so Tab walked straight
 * out into the scrimmed background (F-10).
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  maxWidth = 'max-w-lg',
  icon,
  initialFocusRef,
  disableClose = false,
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /** 本实例在弹窗栈中的标识。 */
  const instanceRef = useRef<symbol | null>(null);

  // 注册 / 注销弹窗栈。只依赖 isOpen：`onClose` 常是每次渲染新建的函数，
  // 若列为依赖会导致本实例被反复重新入栈、错误置顶抢走 Esc。
  useEffect(() => {
    if (!isOpen) return;
    const id = Symbol('modal');
    instanceRef.current = id;
    modalStack.push(id);
    return () => {
      instanceRef.current = null;
      const idx = modalStack.indexOf(id);
      if (idx !== -1) modalStack.splice(idx, 1);
    };
  }, [isOpen]);

  // Move focus into the dialog on open; give it back on close.
  useEffect(() => {
    if (!isOpen) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    // D5：优先聚焦显式 ref；否则跳过 header 关闭按钮（DOM 序在 body 输入之前，
    // 否则打开设置/导出时焦点会落在右上角 X），聚焦 body 内首个可聚焦元素。
    const focusableIn = (root: HTMLElement | null): HTMLElement[] =>
      Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (el) => !el.hasAttribute('data-modal-close'),
      );
    const target =
      initialFocusRef?.current ??
      focusableIn(bodyRef.current)[0] ??
      focusableIn(panel)[0] ??
      panel;
    target?.focus();

    return () => {
      const restore = restoreFocusRef.current;
      // Only restore if the element is still mounted and still visible.
      if (restore && document.contains(restore)) {
        restore.focus();
      }
    };
  }, [isOpen]);

  // Escape to dismiss + Tab trap.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // D1：只有栈顶 Modal 处理键盘，嵌套场景下 Esc 只关最上层。
      const me = instanceRef.current;
      if (me === null || modalStack[modalStack.length - 1] !== me) return;

      if (e.key === 'Escape') {
        e.stopPropagation();
        if (!disableClose) onClose();
        return;
      }

      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // Capture phase so the trap wins over the app-level shortcut handler.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose, disableClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Scrim. Non-interactive: dismissal is Escape / Cancel / X only, so a
          stray click never discards a half-filled form. */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // D4：限制面板高度，使 body 内部滚动生效、footer 主按钮始终可达。
        className={`relative bg-background-panel border border-border-default rounded-xl w-full ${maxWidth} max-h-[calc(100vh-2rem)] shadow-2xl flex flex-col overflow-hidden text-white text-xs outline-none`}
      >
        {/* Header */}
        <div className="h-12 border-b border-default px-4 flex items-center justify-between bg-background-header shrink-0">
          <div className="flex items-center gap-2 font-semibold text-sm text-white min-w-0">
            {icon}
            <h2 id={titleId} className="truncate">
              {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={disableClose}
            data-modal-close="true"
            className="focus-ring text-white/60 hover:text-white p-1 rounded hover:bg-background-surface-hover active:scale-[0.96] transition-transform shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-white/60"
            aria-label="关闭弹窗"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {subtitle && (
          <p className="px-4 pt-3 text-[11px] leading-relaxed text-white/60">
            {subtitle}
          </p>
        )}

        {/* Body：min-h-0 让面板触顶 max-h 后内部滚动生效（D4）。 */}
        <div ref={bodyRef} className="p-4 flex flex-col gap-4 overflow-y-auto min-h-0">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="border-t border-default px-4 py-3 flex items-center justify-end gap-2 bg-background-header shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};