import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { VARIANT_STYLES } from './Toast';
import type { Toast } from './Toast';
import { prefersReducedMotion } from '../utils/reducedMotion';

/**
 * 纯展示层（FE-04）：两个 live region + 单条 toast 的渲染。
 *
 * 不含任何队列逻辑 —— 通知与错误的分区在这里**只做一次**
 * （此前同一个「通知 vs 错误」规则在 push 的截断逻辑和渲染的 filter 里
 * 各写一遍，改一处忘另一处就会出现视觉与 live region 不一致）。
 *
 * 退场 presence（issue #41 · PB-11）：队列（`useToastQueue`）仍然是**同 tick
 * 移除**——去重、截断、错误不自动消失这些不变量都建立在「数组即真值」上。
 * 离场窗口因此只能放在这一层：把「刚消失的条目」留 `TOAST_EXIT_MS`，
 * 期间标 `data-exiting="true"` + `opacity-0`，到点再从本地列表删掉。
 *
 * 为什么用有界 `setTimeout` 而不是 `onTransitionEnd`：reduced-motion 下过渡只有
 * 0.01ms、元素被立刻隐藏时 `transitionend` 会丢事件，元素就会永久留在 DOM 里
 * ——「出场必须不可阻塞」是硬约束，不能把卸载挂在可能不来的事件上。
 * 定时器口径与 B7 的 `useSidebarCrossFade.ts` 一致。
 */

/** 退场淡出窗口（ms）。与 CSS `duration-150` 配对。 */
export const TOAST_EXIT_MS = 150;

const ToastRow: React.FC<{
  toast: Toast;
  onDismiss: (id: number) => void;
  /** 正在退场：淡出 + 位移，且不再是可操作目标。 */
  exiting?: boolean;
}> = ({ toast, onDismiss, exiting = false }) => {
  const style = VARIANT_STYLES[toast.variant];
  return (
    /* 该行的过渡现在是活的：`opacity-0/100` + `-translate-y-1` 就是它自己的变体
       （PB-11 曾把这里挂着的死 `transition-opacity` 删掉，issue #41 把它复活成
       真正参与退场淡出的属性对）。 */
    <div
      key={toast.id}
      className={`w-full flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 shadow-2xl backdrop-blur-md transition-[opacity,transform] duration-150 ease-out ${exiting ? 'opacity-0 -translate-y-1 pointer-events-none' : 'opacity-100 translate-y-0 pointer-events-auto'} ${style.wrap}`}
      data-exiting={exiting ? 'true' : undefined}
      // 退场中的条目已从队列移除，读屏不该再把它当新内容播报
      aria-hidden={exiting ? 'true' : undefined}
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
        tabIndex={exiting ? -1 : undefined}
      >
        <X className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
};

export const ToastRegion: React.FC<{
  toasts: Toast[];
  onDismiss: (id: number) => void;
}> = ({ toasts, onDismiss }) => {
  /**
   * 正在退场、但还没到点的条目。来源只有一个：`toasts` 里**消失**的那些。
   * 用本地 state 而不是改 `Toast` 类型 —— `Toast` 的形状是队列的公共契约
   * （`Toast.tsx` 的 `push/dismiss` 全靠它），presence 属于渲染层私事。
   */
  const [exiting, setExiting] = useState<Toast[]>([]);
  const prevRef = useRef<Toast[]>(toasts);
  const timers = useRef(new Map<number, number>());

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = toasts;

    const removed = prev.filter((p) => !toasts.some((t) => t.id === p.id));
    if (removed.length === 0) return;

    const clearOne = (id: number) => {
      const timer = timers.current.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.current.delete(id);
      }
    };

    // 降级：不进退场列表，直接跟随队列消失
    if (prefersReducedMotion()) {
      removed.forEach((r) => clearOne(r.id));
      return;
    }

    // 同一个 id 只保留一个退场副本：连点关闭 / 重复移除不会叠加出多行
    setExiting((cur) => [...cur.filter((c) => !removed.some((r) => r.id === c.id)), ...removed]);
    removed.forEach((r) => {
      clearOne(r.id);
      timers.current.set(
        r.id,
        window.setTimeout(() => {
          setExiting((cur) => cur.filter((c) => c.id !== r.id));
          timers.current.delete(r.id);
        }, TOAST_EXIT_MS),
      );
    });
  }, [toasts]);

  // 卸载 / Provider 重挂时把退场定时器一并清掉，不留悬空回调
  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current.clear();
    },
    [],
  );

  /** 某一区的行：在队列里的 + 退场中的，按原始先后排列（退场行不跳位）。 */
  const rows = (isError: boolean) => {
    const pick = (list: Toast[]) => list.filter((t) => (isError ? t.variant === 'error' : t.variant !== 'error'));
    const fadingIds = new Set(exiting.map((t) => t.id));
    // `at` 是入队时间、单调递增；按它排就能让退场行留在原来的槽位，
    // 而不是被append 到末尾「跳一下」（跳位比淡出本身更扎眼）。
    return [...pick(toasts), ...pick(exiting)]
      .sort((a, b) => a.at - b.at || a.id - b.id)
      .map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} exiting={fadingIds.has(t.id)} />
      ));
  };

  return (
    <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none px-4 w-full max-w-md">
      {/* 通知区：polite，可自动消失。常驻（空数组时也在 DOM 里）。
          E10：显式 aria-atomic="false" —— 否则隐式 atomic=true，任一通知更新会整区重播。 */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="w-full flex flex-col items-center gap-2"
      >
        {rows(false)}
      </div>
      {/* 错误区：assertive，不自动消失。独立常驻，永不被通知挤掉。 */}
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="false"
        className="w-full flex flex-col items-center gap-2"
      >
        {rows(true)}
      </div>
    </div>
  );
};
