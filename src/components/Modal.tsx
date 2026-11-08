import React, { useEffect, useId, useRef, useState } from 'react';
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
 * 退场窗口（ms，issue #41 · PB-12）。与 CSS `duration-150` 配对。
 *
 * 为什么用有界 `setTimeout` 而不是 `onTransitionEnd`：`transitionend` 在
 * reduced-motion（0.01ms）或元素被立刻隐藏时会丢事件，面板就会永远留在 DOM 上
 * ——「出场必须不可阻塞」是硬约束。定时器口径与 `useSidebarCrossFade.ts` 一致。
 *
 * 关窗语义不变：`isOpen` 一变 false，弹窗栈 / 滚动锁 / 焦点还原 / Esc 监听
 * 全部**立刻**撤销（下面几个 effect 都以 `isOpen` 为开关），退场只是把面板
 * 多留 150ms 做淡出，不阻塞任何一次 Esc 或连续点击。
 */
export const MODAL_EXIT_MS = 150;

/** 进场从「挂载帧」切到「在场帧」的延迟：0ms 只为让浏览器先画一帧 opacity-0。 */
const ENTER_TICK_MS = 0;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * D1：模块级弹窗栈 —— 按挂载顺序记录当前打开的 Modal 实例。
 *
 * 只有栈顶实例处理 keydown / Escape / Tab 陷阱。嵌套确认弹窗是主 Modal 的
 * 兄弟节点、与其同时挂 capture 级监听时，在确认层按 Esc 只会关掉最上层，
 * 不会连带把下面的主编辑器一起关掉（那会丢失整份表单）。
 */
const modalStack: symbol[] = [];

/**
 * scroll lock 状态。见下方 Modal 内的 effect 注释（为什么必须是计数而非存旧值）。
 * `original` 只在**第一层**打开时捕获一次，避免最后一层关闭时把中间层的
 * 'hidden' 当成原值写回去。
 */
let scrollLockDepth = 0;
let scrollLockOriginal = '';

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

  // issue #41 · PB-12 presence：`isOpen` 变 false 后，面板先淡出 MODAL_EXIT_MS 再卸载。
  const [mounted, setMounted] = useState(isOpen);
  /** 「在场帧」开关：进场先画一帧 opacity-0 / scale-95，再切到 100，CSS 过渡才有起点。 */
  const [shown, setShown] = useState(false);
  const [exiting, setExiting] = useState(false);
  const enterTimer = useRef<number | null>(null);
  const exitTimer = useRef<number | null>(null);
  /** 只有打开过的实例才可能进入退场；`isOpen` 初始为 false 时挂载不该「退场」。 */
  const everOpened = useRef(isOpen);

  useEffect(() => {
    if (isOpen) {
      everOpened.current = true;
      // 退场中快速重开：取消退场计时，面板不出 DOM（否则会闪一下再出现）
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
      setMounted(true);
      setExiting(false);

      if (prefersReducedMotion()) {
        setShown(true);
        return;
      }
      enterTimer.current = window.setTimeout(() => {
        setShown(true);
        enterTimer.current = null;
      }, ENTER_TICK_MS);
      return () => {
        if (enterTimer.current !== null) {
          window.clearTimeout(enterTimer.current);
          enterTimer.current = null;
        }
      };
    }

    if (!everOpened.current) return;

    setShown(false);
    setExiting(true);

    if (prefersReducedMotion()) {
      // 降级：跳过退场窗口，直接卸载（不挂 150ms 空等）
      setMounted(false);
      setExiting(false);
      return;
    }
    exitTimer.current = window.setTimeout(() => {
      setMounted(false);
      setExiting(false);
      exitTimer.current = null;
    }, MODAL_EXIT_MS);
    return () => {
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
    };
  }, [isOpen]);

  // UX-17：弹窗打开时锁掉页面滚动。
  // 此前完全依赖 App 根节点的 overflow-hidden 兜底 —— 那是 flex 布局约束，
  // 不是模态期滚动锁；一旦布局改版或弹窗从别的容器渲染，背景就会跟着滚，
  // 遮罩却不动，用户看到的是「遮罩钉住、内容滑走」的错位。
  // 用**引用计数**而非「保存原值再恢复」：React 的 effect 执行顺序是子先父后，
  // 嵌套模态里内层先捕获到原始值、外层后捕获到 'hidden'；内层先卸载就会把
  // 原始值写回去，外层仍在开着却已经解锁。计数保证只有最后一层关闭才还原。
  useEffect(() => {
    if (!isOpen) return;
    const root = document.documentElement;
    if (scrollLockDepth === 0) scrollLockOriginal = root.style.overflow;
    scrollLockDepth += 1;
    root.style.overflow = 'hidden';
    return () => {
      scrollLockDepth -= 1;
      if (scrollLockDepth === 0) {
        root.style.overflow = scrollLockOriginal;
        scrollLockOriginal = '';
      }
    };
  }, [isOpen]);

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

  if (!mounted) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ease-out ${shown ? 'opacity-100' : 'opacity-0'}`}
    >
      {/* Scrim. Non-interactive: dismissal is Escape / Cancel / X only, so a
          stray click never discards a half-filled form. */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        /* issue #41 · PB-12：退场窗口内仍挂载（淡出 + 缩小），但**不再是模态**
           —— 摘掉 `role` / `aria-modal` 有两个原因：
           1) 全局快捷键守卫（`useKeyboardShortcuts.ts:135`、
              `useToneEditing.ts:596`）都以 `[role="dialog"][aria-modal="true"]`
              判定「模态开着」。留着它 = 关窗后 150ms 内单键快捷键失灵，
              那是实打实的「卡手感」，不能为了动画牺牲「关完立刻能用」。
           2) 焦点在关闭瞬间已还回调用方，退场中的面板只是一张残影，
              不该再进无障碍树（`aria-hidden` 兜住读屏）。
           顺序上 `data-modal-panel` 是给用例的稳定锚点（退场时 role 已摘掉）。*/
        data-modal-panel="true"
        role={exiting ? undefined : 'dialog'}
        aria-modal={exiting ? undefined : 'true'}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-exiting={exiting ? 'true' : undefined}
        aria-hidden={exiting ? 'true' : undefined}
        // D4：限制面板高度，使 body 内部滚动生效、footer 主按钮始终可达。
        className={`relative bg-background-panel border border-border-default rounded-xl w-full ${maxWidth} max-h-[calc(100vh-2rem)] shadow-2xl flex flex-col overflow-hidden text-white text-xs outline-none transition-transform duration-200 ease-out ${shown ? 'scale-100' : 'scale-95'}`}
      >
        {/* Header */}
        <div className="h-12 border-b border-border-default px-4 flex items-center justify-between bg-background-header shrink-0">
          <div className="flex items-center gap-2 font-semibold text-sm text-white min-w-0">
            {icon}
            <h2 id={titleId} className="truncate">
              {title}
            </h2>
          </div>
          <button
            onClick={() => {
              // issue #41 · PB-12：退场窗口内按钮还在淡出，手快的第二下不能再触发 onClose
              if (!exiting) onClose();
            }}
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
          <div className="border-t border-border-default px-4 py-3 flex items-center justify-end gap-2 bg-background-header shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};