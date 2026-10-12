import { useEffect } from 'react';

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

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isDialogOpen()) return;

      // Ignore shortcut if user is focusing an input or textarea
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      // Hold Backslash (\) for momentary Before/Original preview
      if (e.key === '\\') {
        if (!e.repeat && onHoldOriginalStart) {
          e.preventDefault();
          onHoldOriginalStart();
        }
        return;
      }

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

      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === '\\' && onHoldOriginalEnd) {
        e.preventDefault();
        onHoldOriginalEnd();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
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
