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
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Move focus into the dialog on open; give it back on close.
  useEffect(() => {
    if (!isOpen) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

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
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
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
  }, [isOpen, onClose]);

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
        className={`relative bg-background-panel border border-border-default rounded-xl w-full ${maxWidth} shadow-2xl flex flex-col overflow-hidden text-white text-xs outline-none`}
      >
        {/* Header */}
        <div className="h-12 border-b border-white/10 px-4 flex items-center justify-between bg-background-header shrink-0">
          <div className="flex items-center gap-2 font-semibold text-sm text-white min-w-0">
            {icon}
            <h2 id={titleId} className="truncate">
              {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="focus-ring text-white/60 hover:text-white p-1 rounded hover:bg-white/5 active:scale-[0.96] transition-transform shrink-0"
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

        {/* Body */}
        <div className="p-4 flex flex-col gap-4 overflow-y-auto">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="border-t border-white/10 px-4 py-3 flex items-center justify-end gap-2 bg-background-header shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
