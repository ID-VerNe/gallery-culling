import React, { createContext, useContext } from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { useToastQueue } from '../hooks/useToastQueue';
import { ToastRegion } from './ToastViewport';

export type ToastVariant = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  /** 同一条消息在去重窗口内被重复入队的次数（首次为 1）。 */
  count: number;
  /** 最近一次入队/合并的时间戳（用于去重窗口判定）。 */
  at: number;
}

export interface ToastApi {
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
export const DISMISS_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  error: 0,
};

/** 同 variant + 同文案在该窗口内重复入队 → 合并计数，而不是新增条目。 */
export const DEDUPE_WINDOW_MS = 3000;
/**
 * 通知级（success/info）同屏上限。被挤掉的**只会是通知级** —— 错误存在
 * 独立的错误区，不会被通知挤掉（这是 L-02/L-03 的核心诉求）。
 */
export const NOTICE_CAP = 3;
/** 错误同屏上限。错误不参与通知级上限，这里只做一个防无限堆积的兜底。 */
export const ERROR_CAP = 5;

export const VARIANT_STYLES: Record<
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
    // E5：原 `border-white/15` + `#141414/95` 与背景 #0A0A0A 仅约 1.48:1 / 1.07:1，
    // 面板几乎与页面同色。提升边框到 white/35（≈3.1:1）并略提亮面板底色，
    // 使通知边界可辨；error/success 的既有视觉保持不变。
    wrap: 'border-white/35 bg-[#1c1c1c]/95 text-white',
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
  // FE-04：队列（状态/去重/截断/定时器）抽到 useToastQueue，渲染抽到
  // ToastRegion。Provider 现在只做胶水 —— 不持有任何队列状态，
  // toastsRef 那套影子 state 也随之变成 hook 的私事。
  const { toasts, dismiss, api } = useToastQueue();

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
