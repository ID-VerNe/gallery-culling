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
  /** 同一条消息在去重窗口内被重复入队的次数（首次为 1）。 */
  count: number;
  /** 最近一次入队/合并的时间戳（用于去重窗口判定）。 */
  at: number;
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

/**
 * 自动消失时长。**错误为 0 = 不自动消失**（L-02/L-03）：
 * 错误属于"需要用户知晓并处理"的消息，必须由用户点关闭；通知级才允许自动消失。
 */
const DISMISS_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  error: 0,
};

/** 同 variant + 同文案在该窗口内重复入队 → 合并计数，而不是新增条目。 */
const DEDUPE_WINDOW_MS = 3000;
/**
 * 通知级（success/info）同屏上限。被挤掉的**只会是通知级** —— 错误存在
 * 独立的错误区，不会被通知挤掉（这是 L-02/L-03 的核心诉求）。
 */
const NOTICE_CAP = 3;
/** 错误同屏上限。错误不参与通知级上限，这里只做一个防无限堆积的兜底。 */
const ERROR_CAP = 5;

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
 * way to read the message at their own pace (F-14). The regions are always
 * mounted so screen readers register the live areas before the first message
 * arrives (F-21).
 *
 * L-02 / L-03：
 *  - **错误与通知分属两个常驻 live region**：错误用 `role="alert"` +
 *    `aria-live="assertive"`（立即播报），通知用 `role="status"` +
 *    `aria-live="polite"`（不打断）；不用"单区域动态切 assertive"是因为
 *    polite/assertive 切换会造成播报抖动，也不符"区域常驻以便注册"的原设计。
 *  - **错误不自动消失**，必须用户确认。
 *  - **同文案去重**：同源错误风暴（如 50 张批量失败）合并为一条 `×N`，
 *    不再"反复覆盖、旧的静默消失"。
 *  - **上限只挤通知级**：`NOTICE_CAP` 只作用于 success/info。
 *
 * 对外 API（`ToastProvider` / `useToast()` 的 `success/error/info`）保持**完全
 * 向后兼容**，调用方无需改动。
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());
  /**
   * 与 `toasts` 同步的真值副本。`push` 需要在**同一个 tick** 内读到最新列表来
   * 做去重与截断；只读 state 会拿到陈旧闭包，把它写进 setState updater 又会
   * 因 React 可能重复调用 updater 而产生副作用（重复调度定时器）。
   */
  const toastsRef = useRef<Toast[]>([]);

  /** 提交一份新列表到 ref + state（两者始终一致）。 */
  const commit = useCallback((next: Toast[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  /** 为通知级条目安排自动消失；错误（ms = 0）不安排。 */
  const schedule = useCallback(
    (toast: Toast) => {
      clearTimer(toast.id);
      const ms = DISMISS_MS[toast.variant];
      if (ms > 0) {
        timers.current.set(
          toast.id,
          window.setTimeout(() => {
            commit(toastsRef.current.filter((t) => t.id !== toast.id));
            timers.current.delete(toast.id);
          }, ms),
        );
      }
    },
    [clearTimer, commit],
  );

  const dismiss = useCallback(
    (id: number) => {
      commit(toastsRef.current.filter((t) => t.id !== id));
      clearTimer(id);
    },
    [clearTimer, commit],
  );

  const push = useCallback(
    (message: string, variant: ToastVariant) => {
      const now = Date.now();
      const key = `${variant}::${message}`;
      const prev = toastsRef.current;

      // 1) 去重：窗口内同 key → 合并计数、刷新时间与定时器，不新增条目。
      const existingIdx = prev.findIndex(
        (t) => `${t.variant}::${t.message}` === key && now - t.at < DEDUPE_WINDOW_MS,
      );
      if (existingIdx >= 0) {
        const merged: Toast = {
          ...prev[existingIdx],
          count: prev[existingIdx].count + 1,
          at: now,
        };
        const next = [...prev];
        next[existingIdx] = merged;
        commit(next);
        schedule(merged);
        return;
      }

      // 2) 新增条目 + 分区间截断。
      const id = nextId.current++;
      const toast: Toast = { id, message, variant, count: 1, at: now };
      const notices = prev.filter((t) => t.variant !== 'error');
      const errors = prev.filter((t) => t.variant === 'error');

      if (variant === 'error') {
        const nextErrors = [...errors, toast];
        const dropped =
          nextErrors.length > ERROR_CAP
            ? nextErrors.slice(0, nextErrors.length - ERROR_CAP)
            : [];
        dropped.forEach((d) => clearTimer(d.id));
        commit([...notices, ...nextErrors.slice(-ERROR_CAP)]);
      } else {
        const nextNotices = [...notices, toast];
        const dropped =
          nextNotices.length > NOTICE_CAP
            ? nextNotices.slice(0, nextNotices.length - NOTICE_CAP)
            : [];
        dropped.forEach((d) => clearTimer(d.id));
        // 错误永远保留（分属不同 live region，顺序只影响视觉堆叠）。
        commit([...nextNotices.slice(-NOTICE_CAP), ...errors]);
      }
      schedule(toast);
    },
    [clearTimer, commit, schedule],
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

  const errorToasts = toasts.filter((t) => t.variant === 'error');
  const noticeToasts = toasts.filter((t) => t.variant !== 'error');

  const renderToast = (toast: Toast) => {
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
        {toast.count > 1 && (
          <span
            className="shrink-0 self-start font-mono tabular-nums text-[10px] px-1.5 py-0.5 rounded bg-white/15"
            aria-label={`重复 ${toast.count} 次`}
          >
            ×{toast.count}
          </span>
        )}
        <button
          onClick={() => dismiss(toast.id)}
          className="focus-ring -mr-1 -mt-0.5 p-1 rounded opacity-60 hover:opacity-100 transition-opacity shrink-0"
          aria-label="关闭此提示"
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none px-4 w-full max-w-md">
        {/* 通知区：polite，可自动消失。常驻（空数组时也在 DOM 里）。 */}
        <div
          role="status"
          aria-live="polite"
          className="w-full flex flex-col items-center gap-2"
        >
          {noticeToasts.map(renderToast)}
        </div>
        {/* 错误区：assertive，不自动消失。独立常驻，永不被通知挤掉。 */}
        <div
          role="alert"
          aria-live="assertive"
          className="w-full flex flex-col items-center gap-2"
        >
          {errorToasts.map(renderToast)}
        </div>
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
