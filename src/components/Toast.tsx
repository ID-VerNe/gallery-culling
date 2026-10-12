import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type ToastVariant = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({
  success: () => {},
  error: () => {},
  info: () => {},
});

const DISMISS_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  error: 7000,
};

const VARIANT_STYLES: Record<
  ToastVariant,
  { wrap: string; icon: React.ReactNode; label: string }
> = {
  success: {
    wrap: 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100',
    icon: <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />,
    label: '成功',
  },
  error: {
    wrap: 'border-rose-500/40 bg-rose-950/90 text-rose-100',
    icon: <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />,
    label: '错误',
  },
  info: {
    wrap: 'border-white/15 bg-[#141414]/95 text-white',
    icon: <Info className="w-4 h-4 shrink-0 text-white/70" />,
    label: '提示',
  },
};

/**
 * Non-blocking status reporting (replaces `alert()`).
 *
 * `alert()` blocks the whole app, cannot be copied from, and gives the user no
 * way to read the message at their own pace — the message text is also the
 * problem statement with no cause or fix (F-14).
 *
 * The region is always mounted so screen readers register the live area
 * before the first message arrives (F-21).
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message: string, variant: ToastVariant) => {
      const id = nextId.current++;
      // Cap the stack so a burst of failures can't cover the app.
      setToasts((prev) => [...prev.slice(-2), { id, message, variant }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), DISMISS_MS[variant]),
      );
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message: string) => push(message, 'success'),
      error: (message: string) => push(message, 'error'),
      info: (message: string) => push(message, 'info'),
    }),
    [push],
  );

  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current.clear();
    },
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none px-4 w-full max-w-md"
      >
        {toasts.map((toast) => {
          const style = VARIANT_STYLES[toast.variant];
          return (
            <div
              key={toast.id}
              className={`pointer-events-auto w-full flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 shadow-2xl backdrop-blur-md transition-opacity duration-200 ${style.wrap}`}
            >
              {style.icon}
              <span className="sr-only">{style.label}：</span>
              <p className="text-xs leading-relaxed flex-1 whitespace-pre-line">
                {toast.message}
              </p>
              <button
                onClick={() => dismiss(toast.id)}
                className="focus-ring -mr-1 -mt-0.5 p-1 rounded opacity-60 hover:opacity-100 transition-opacity shrink-0"
                aria-label="关闭此提示"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
