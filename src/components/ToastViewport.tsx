import React from 'react';
import { X } from 'lucide-react';
import { VARIANT_STYLES } from './Toast';
import type { Toast } from './Toast';

/**
 * 纯展示层（FE-04）：两个 live region + 单条 toast 的渲染。
 *
 * 不含任何队列逻辑 —— 通知与错误的分区在这里**只做一次**
 * （此前同一个「通知 vs 错误」规则在 push 的截断逻辑和渲染的 filter 里
 * 各写一遍，改一处忘另一处就会出现视觉与 live region 不一致）。
 */
const ToastRow: React.FC<{ toast: Toast; onDismiss: (id: number) => void }> = ({ toast, onDismiss }) => {
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
            onClick={() => onDismiss(toast.id)}
            className="focus-ring -mr-1 -mt-0.5 p-1 rounded opacity-60 hover:opacity-100 transition-opacity shrink-0"
            aria-label="关闭此提示"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      );
};

export const ToastRegion: React.FC<{
  toasts: Toast[];
  onDismiss: (id: number) => void;
}> = ({ toasts, onDismiss }) => (
  <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none px-4 w-full max-w-md">
    {/* 通知区：polite，可自动消失。常驻（空数组时也在 DOM 里）。
        E10：显式 aria-atomic="false" —— 否则隐式 atomic=true，任一通知更新会整区重播。 */}
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="w-full flex flex-col items-center gap-2"
    >
      {toasts
        .filter((t) => t.variant !== 'error')
        .map((t) => (
          <ToastRow key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
    </div>
    {/* 错误区：assertive，不自动消失。独立常驻，永不被通知挤掉。 */}
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="false"
      className="w-full flex flex-col items-center gap-2"
    >
      {toasts
        .filter((t) => t.variant === 'error')
        .map((t) => (
          <ToastRow key={t.id} toast={t} onDismiss={onDismiss} />
        ))}
    </div>
  </div>
);
