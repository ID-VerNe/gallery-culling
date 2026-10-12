import { useEffect, useRef } from 'react';

interface KeyboardShortcutsProps {
  onPrev: () => void;
  onNext: () => void;
  onRate: (rating: number) => void;
  onFlag: (flag: 'pick' | 'reject' | 'none') => void;
  onOpenExternal: () => void;
  onToggleCompare: () => void;
  onSwapCompare?: () => void;
  onTogglePinReference?: () => void;
  onPinLeft?: () => void;
  onPinRight?: () => void;
  onOpenMetadataModal?: () => void;
  onToggleBeforeAfter?: () => void;
  onToggleTonalPanel?: () => void;
  onHoldOriginalStart?: () => void;
  onHoldOriginalEnd?: () => void;
  onFocusSearch?: () => void;
  onOpenShortcutHelp?: () => void;
}

export function useKeyboardShortcuts({
  onPrev,
  onNext,
  onRate,
  onFlag,
  onOpenExternal,
  onToggleCompare,
  onSwapCompare,
  onTogglePinReference,
  onPinLeft,
  onPinRight,
  onOpenMetadataModal,
  onToggleBeforeAfter,
  onToggleTonalPanel,
  onHoldOriginalStart,
  onHoldOriginalEnd,
  onFocusSearch,
  onOpenShortcutHelp,
}: KeyboardShortcutsProps) {
  /** `\` 是否处于按住态 —— 供 blur / visibilitychange 复位兜底判断，避免误复位。 */
  const holdActiveRef = useRef(false);

  useEffect(() => {
    /**
     * True when a modal dialog owns the screen.
     *
     * Without this, the global single-handed shortcuts keep firing on the
     * photo behind the scrim while the export / settings / metadata dialog is
     * open — e.g. pressing `3` with a radio focused rates an invisible photo
     * and desyncs the modal's live count (F-05).
     */
    const isDialogOpen = () =>
      document.querySelector('[role="dialog"][aria-modal="true"]') !== null;

    /**
     * 仅「文本录入类」控件 —— **唯一用途**是 `\` 的让位判断（允许在路径/文本
     * 框里键入 Windows 路径分隔符）。刻意排除 range/checkbox/radio 等非文本
     * input：它们不以键入文本为语义，仍应触发「按住查看原片」。
     *
     * 注意：不要把这里的「按 type 过滤」语义继承到通用守卫，否则会漏掉
     * `input[type=range]`，导致调色滑杆的箭头键被全局 handler 劫持（回归）。
     */
    const isTextEntry = (el: Element | null): boolean => {
      if (!el) return false;
      if (el.tagName === 'TEXTAREA') return true;
      if ((el as HTMLElement).isContentEditable) return true;
      if (el.tagName !== 'INPUT') return false;
      const type = (el as HTMLInputElement).type;
      return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'image'].includes(
        type,
      );
    };

    /**
     * 通用守卫：**任意** INPUT（含 range/checkbox/radio，不得按 type 过滤）+
     * TEXTAREA + contentEditable + SELECT。
     *
     * 唯一命名（勿改名为 isValueOrText）。**绝不加入 `[role="listbox"]`**：项目
     * 唯一的 listbox 是缩略图宫格，其 `a/d/←/→/1..5/x/p` 依赖本全局 handler。
     */
    const isFormControlOrEditing = (el: Element | null): boolean =>
      !!el &&
      (el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        (el as HTMLElement).isContentEditable ||
        el.tagName === 'SELECT');

    /** 可被空格「激活」的元素 —— 空格必须让位，且不得 preventDefault。 */
    const isActivatable = (el: Element | null): boolean =>
      !!el &&
      (el.tagName === 'BUTTON' ||
        el.tagName === 'SUMMARY' ||
        el.tagName === 'A' ||
        (el.tagName === 'INPUT' &&
          ['checkbox', 'radio', 'button', 'submit', 'reset'].includes((el as HTMLInputElement).type)) ||
        ['button', 'radio', 'checkbox', 'switch', 'tab', 'menuitem', 'option', 'link'].includes(
          el.getAttribute('role') ?? '',
        ));

    const handleKeyDown = (e: KeyboardEvent) => {
      // 1 模态对话框独占屏幕时，任何单键快捷键都失效（防止误改背后的照片）。
      if (isDialogOpen()) return;

      // 2 中文 IME 合成期（拼音上屏）不得触发快捷键。
      if (e.isComposing || e.keyCode === 229) return;

      const el = e.target as Element | null;

      // 3 '\' 按住查看原片：**必须早于通用守卫**，否则 range/宫格聚焦时无法触发。
      //   文本录入内让位以允许键入路径分隔符。
      if (e.key === '\\') {
        if (isTextEntry(el)) return;
        if (!e.repeat && onHoldOriginalStart) {
          e.preventDefault();
          holdActiveRef.current = true;
          onHoldOriginalStart();
        }
        return;
      }

      // 4 值/文本控件（任意 INPUT / TEXTAREA / contentEditable / SELECT）不劫持单键。
      //   这是 H-01 的核心修复：SELECT 曾被漏掉，导致聚焦下拉时按键改评级并写盘。
      if (isFormControlOrEditing(el)) return;

      // 5 空格让位给可激活元素（不 preventDefault，保证原生按钮/链接能被空格激活）。
      //   宫格 `[role="listbox"]` 不在 isActivatable 内，故其空格仍 = 设为基准。
      if (e.key === ' ' && isActivatable(el)) return;

      // 6 组合键让路（Ctrl+X/Ctrl+P 等不再误触评级/旗标并写盘）；Ctrl/Cmd+F 显式豁免。
      if ((e.ctrlKey || e.metaKey || e.altKey) && e.key !== 'f') return;

      // Focus the grid search field. `/` is the convention; Ctrl/Cmd+F also
      // works because the OS find bar is useless inside a photo grid.
      if (
        (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key === 'f')) &&
        onFocusSearch
      ) {
        e.preventDefault();
        onFocusSearch();
        return;
      }

      if (e.key === '?' && onOpenShortcutHelp) {
        e.preventDefault();
        onOpenShortcutHelp();
        return;
      }

      switch (e.key) {
        // Navigation
        case 'ArrowLeft':
        case 'a':
        case 'A':
          e.preventDefault();
          onPrev();
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          e.preventDefault();
          onNext();
          break;

        // Rating: 1 to 5
        case '1':
          e.preventDefault();
          onRate(1);
          break;
        case '2':
          e.preventDefault();
          onRate(2);
          break;
        case '3':
          e.preventDefault();
          onRate(3);
          break;
        case '4':
          e.preventDefault();
          onRate(4);
          break;
        case '5':
          e.preventDefault();
          onRate(5);
          break;
        case '0':
        case 'u':
        case 'U':
          e.preventDefault();
          onRate(0);
          onFlag('none');
          break;

        // Pick / Reject
        case 'p':
        case 'P':
          e.preventDefault();
          onFlag('pick');
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          onFlag('reject');
          break;

        // Open in Photoshop / External app
        case 'o':
        case 'O':
          e.preventDefault();
          onOpenExternal();
          break;

        // View mode toggles
        case 'c':
        case 'C':
          e.preventDefault();
          onToggleCompare();
          break;

        // Compare Swap (S)
        case 's':
        case 'S':
          if (onSwapCompare) {
            e.preventDefault();
            onSwapCompare();
          }
          break;

        // Pin Reference (B - Benchmark/Base)
        case 'b':
        case 'B':
          if (onTogglePinReference) {
            e.preventDefault();
            onTogglePinReference();
          }
          break;

        // Pin Left as Baseline ([)
        case '[':
          if (onPinLeft) {
            e.preventDefault();
            onPinLeft();
          }
          break;

        // Pin Right as Baseline (]) or Space
        case ']':
          if (onPinRight) {
            e.preventDefault();
            onPinRight();
          }
          break;

        case ' ':
          if (onPinRight) {
            e.preventDefault();
            onPinRight();
          }
          break;

        // Metadata Editor (M)
        case 'm':
        case 'M':
          if (onOpenMetadataModal) {
            e.preventDefault();
            onOpenMetadataModal();
          }
          break;

        // Before / After Intra-Photo View Toggle (Y)
        case 'y':
        case 'Y':
          if (onToggleBeforeAfter) {
            e.preventDefault();
            onToggleBeforeAfter();
          }
          break;

        // Tonal Adjuster Panel Toggle (E)
        case 'e':
        case 'E':
          if (onToggleTonalPanel) {
            e.preventDefault();
            onToggleTonalPanel();
          }
          break;

        default:
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (isDialogOpen()) return;

      const el = e.target as Element | null;

      // '\' 同样必须早于通用守卫：keydown 已让 range 触发按住查看，若这里被
      // isFormControlOrEditing 拦掉，则松手无法复位 → 预览横幅常亮（M-09）。
      if (e.key === '\\') {
        if (isTextEntry(el)) return;
        e.preventDefault();
        holdActiveRef.current = false;
        onHoldOriginalEnd?.();
        return;
      }

      if (isFormControlOrEditing(el)) return;
    };

    // 复位兜底：窗口失焦 / 页面隐藏时若 `\` 仍处于按住态，强制结束预览，
    // 避免「松手事件丢失」导致横幅常亮。仅在真正按住时才调用（防误复位）。
    const resetHold = () => {
      if (!holdActiveRef.current) return;
      holdActiveRef.current = false;
      onHoldOriginalEnd?.();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', resetHold);
    document.addEventListener('visibilitychange', resetHold);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', resetHold);
      document.removeEventListener('visibilitychange', resetHold);
    };
  }, [
    onPrev,
    onNext,
    onRate,
    onFlag,
    onOpenExternal,
    onToggleCompare,
    onSwapCompare,
    onTogglePinReference,
    onPinLeft,
    onPinRight,
    onOpenMetadataModal,
    onToggleBeforeAfter,
    onToggleTonalPanel,
    onHoldOriginalStart,
    onHoldOriginalEnd,
    onFocusSearch,
    onOpenShortcutHelp,
  ]);
}
