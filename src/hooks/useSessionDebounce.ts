/**
 * `useSessionDebounce` —— 会话进度的**防抖写入 + 多路径 flush**（M-17 前端侧）。
 *
 * 背景（方案 §M-17 复核结论）：`App.tsx` 原先在 `useEffect([selectedIndex, …])`
 * 里**每次选中变化**就写一次 session（1 IPC + 1 次 SQLite UPSERT）。连续翻页
 * （10 张/秒）时是"每翻一页一次磁盘写"，只有最后一次索引有价值。
 *
 * 为什么必须放前端：后端拿不到"还在防抖窗口内、尚未发送"的那个索引，靠后端
 * 合并写解决不了丢写（方案 §M-17 已裁决）。
 *
 * 防抖必然带来"最后一次写入可能丢失"，因此补 **3 个 flush 点** + 1 个目录切换
 * flush（方案点名的硬约束）：
 *  1. **组件卸载**：cleanup 里 flush 最新值；
 *  2. **目录切换**：`jpgFolder` 变化时**先 flush 旧目录**的值，再为新目录起定时器
 *     （只 clearTimeout 会把旧目录的最后一次进度直接丢掉）；
 *  3. **窗口隐藏 / 关闭**：`visibilitychange`(hidden) + `beforeunload` 尽力而为；
 *  4. **Tauri 关闭请求**：`getCurrentWindow().onCloseRequested` → `preventDefault`
 *     → flush → `destroy`（带兜底超时，避免 IPC 挂死导致窗口关不掉）。
 *
 * 接入是"一行"：
 * ```tsx
 * useSessionDebounce({ jpgFolder, rawFolder, lastIndex: selectedIndex, sortOrder });
 * ```
 * 返回的 `flush()` 也可由调用方在自定义时机手动调用。
 */
import { useCallback, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from '../services/api';
import { useToast } from '../components/Toast';

/** 需要持久化的会话快照。字段名对齐 `api.saveSession` 的四元组。 */
export interface SessionSnapshot {
  jpgFolder: string;
  rawFolder: string;
  /** 选中索引；< 0 视为无效、不写。 */
  lastIndex: number;
  sortOrder: string;
}

export interface UseSessionDebounceOptions {
  /** 防抖窗口（毫秒）。默认 500ms（方案 §M-17 取值）。 */
  delayMs?: number;
  /** 是否接管「窗口关闭前 flush」。默认 true；单测可关掉以免依赖窗口。 */
  flushOnClose?: boolean;
  /** 关闭前 flush 的兜底超时（毫秒），避免 IPC 挂死导致窗口关不掉。 */
  closeFlushTimeoutMs?: number;
}

export interface UseSessionDebounceResult {
  /** 立刻把最新会话写盘（会取消挂起的防抖定时器）。 */
  flush: () => Promise<void>;
}

export const useSessionDebounce = (
  snapshot: SessionSnapshot,
  options: UseSessionDebounceOptions = {},
): UseSessionDebounceResult => {
  const {
    delayMs = 500,
    flushOnClose = true,
    closeFlushTimeoutMs = 1500,
  } = options;

  // 用 ref 持有最新值：定时器回调/卸载 cleanup 都会在"未来"执行，读 state 会拿到陈旧闭包。
  const sessionRef = useRef(snapshot);
  sessionRef.current = snapshot;

  const toast = useToast();
  /**
   * E9：会话写盘失败此前只 `console.error`，对用户完全静默。这里首次失败给一次性
   * 提示（节流），避免每次 flush 都刷屏；写盘恢复成功后允许再次提醒。
   */
  const saveErrorNotifiedRef = useRef(false);

  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flush = useCallback(
    async (s: SessionSnapshot = sessionRef.current) => {
      clearTimer();
      if (!s.jpgFolder || s.lastIndex < 0) return;
      try {
        await api.saveSession(s.jpgFolder, s.rawFolder, s.lastIndex, s.sortOrder);
        // 写盘恢复成功 → 允许下一次失败再次提醒（而非整个会话只提醒一次）。
        saveErrorNotifiedRef.current = false;
      } catch (e) {
        console.error('Failed to save session:', e);
        // E9：首次失败给一次性提示；后续失败静默，避免刷屏。
        if (!saveErrorNotifiedRef.current) {
          saveErrorNotifiedRef.current = true;
          toast.info('会话进度保存失败，稍后会自动重试');
        }
      }
    },
    [clearTimer, toast],
  );

  // 防抖写入 + 目录切换 flush。
  const prevRef = useRef<SessionSnapshot | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = snapshot;

    // flush 点（目录切换）：旧目录的最后进度必须先落地 —— clearTimeout 会直接丢掉它。
    if (prev && prev.jpgFolder && prev.jpgFolder !== snapshot.jpgFolder) {
      void flush(prev);
    }

    clearTimer();
    if (!snapshot.jpgFolder) return;
    timerRef.current = window.setTimeout(() => {
      void flush();
    }, delayMs);

    return clearTimer;
    // 依赖用四个原始值：`snapshot` 对象每次渲染都是新引用，不能进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    snapshot.jpgFolder,
    snapshot.rawFolder,
    snapshot.lastIndex,
    snapshot.sortOrder,
    delayMs,
    flush,
    clearTimer,
  ]);

  // flush 点 1：组件卸载（flush 稳定，故 cleanup 实际只在卸载时跑到）。
  useEffect(() => () => {
    void flush();
  }, [flush]);

  // flush 点 2：窗口隐藏 / 关闭（浏览器语义，尽力而为）。
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const onUnload = () => {
      void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [flush]);

  // flush 点 3：Tauri 关闭请求。preventDefault → flush → destroy。
  useEffect(() => {
    if (!flushOnClose) return;

    let win: ReturnType<typeof getCurrentWindow> | null = null;
    try {
      win = getCurrentWindow();
    } catch (e) {
      // 非 Tauri 环境（例如纯 jsdom）没有窗口 API —— 静默降级，其余 flush 点仍生效。
      console.warn('注册关闭前 flush 失败（非 Tauri 环境？）:', e);
      return;
    }

    let unlisten: (() => void) | undefined;
    let disposed = false;

    win
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          // 给 flush 一个上限：宁可丢最后一次写，也不能让窗口关不掉。
          await Promise.race([
            flush(),
            new Promise<void>((resolve) =>
              window.setTimeout(resolve, closeFlushTimeoutMs),
            ),
          ]);
        } finally {
          try {
            await win?.destroy();
          } catch (e) {
            console.error('窗口销毁失败:', e);
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.warn('注册关闭前 flush 失败:', e));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flush, flushOnClose, closeFlushTimeoutMs]);

  return { flush };
};
