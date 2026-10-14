import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DISMISS_MS, DEDUPE_WINDOW_MS, NOTICE_CAP, ERROR_CAP } from '../components/Toast';
import type { Toast, ToastApi, ToastVariant } from '../components/Toast';

/**
 * 队列逻辑（FE-04）：toast 的状态、去重、截断、自动消失定时器。
 *
 * 从 ToastProvider 里抽出来单独成 hook 的理由不是"行数好看"，而是
 * **可测**：这套规则（DEDUPE_WINDOW_MS 去重合并、NOTICE_CAP/ERROR_CAP 分区间
 * 截断、错误不自动消失、错误永不被通知挤掉）是最容易在改动中悄悄坏掉的
 * 一组不变量，而它们此前只能通过渲染整个 App 来间接验证。
 *
 * `toastsRef` 影子 state 也因此合理了：它是**这个 hook 的私事**，
 * 不会泄漏到组件的 props/state 形状上。
 */

export const useToastQueue = () => {
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


  return { toasts, dismiss, push, api };
};
