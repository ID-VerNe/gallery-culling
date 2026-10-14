/**
 * `useTaskProgress` —— 长任务（扫描 / 批量导出）的进度订阅 + 取消（M-05 前端）。
 *
 * 设计目标：让 `App.tsx` **一行接入**（team-lead 独占 App.tsx，本 hook 必须自洽）：
 *
 * ```tsx
 * const scanTask = useTaskProgress('scan');
 * ```
 *
 * 事件是**全局**的（没有 task_id），且同一时刻只允许一个扫描 / 一次导出，所以
 * 采用「挂载即订阅、只在 `isRunning` 时消费事件」的策略：
 *  - 订阅放在 mount effect 里（而非 `start()` 内异步注册），避免"先把命令发出去、
 *    监听还没注册好"导致漏掉最初几条进度；
 *  - 订阅就绪前到达的事件会先缓冲、就绪后回放（E11），进一步减少早期丢失；
 *  - 不属于本次任务的事件（任务没在跑时到达的）一律丢弃，不会污染 UI。
 *
 * 取消是**协作式**的：`cancel()` 只向后端置一个取消标志，任务本身仍在飞行中
 * （`isRunning` 保持 true），直到它的 invoke 返回。后端走「临时目录 + 原子搬迁」
 * （Q4 all-or-nothing），所以取消结果是"目标目录零污染"，前端据此书写文案。
 *
 * E2：为「后端卡住"加看门狗 —— `cancel()` 后启动 `CANCEL_WATCHDOG_MS` 计时，
 * 若期间既无 `finish()` 也无新进度，置 `cancelStalled=true`，让 UI 能提示
 * 「取消请求无响应」并提供「强制结束」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelTask,
  subscribeTaskProgress,
  type UnlistenFn,
} from '../services/taskApi';
import type {
  ExportProgressPayload,
  ScanProgressPayload,
  TaskKind,
  TaskProgress,
} from '../types';

/**
 * 取消看门狗超时（毫秒）：置取消标志后，后端若在此时间内既未 `finish()` 也无
 * 新进度事件，判定为「取消请求无响应」（E2）。
 */
const CANCEL_WATCHDOG_MS = 10_000;

/** 把两种事件的负载归一成统一的 `TaskProgress`。 */
function normalize(
  kind: TaskKind,
  payload: ScanProgressPayload | ExportProgressPayload,
): TaskProgress {
  if (kind === 'scan') {
    const p = payload as ScanProgressPayload;
    return { processed: p.processed, total: p.total, phase: p.phase };
  }
  const p = payload as ExportProgressPayload;
  return { processed: p.processed, total: p.total, current: p.current };
}

export interface UseTaskProgressResult {
  /** 最近一次进度事件；任务未开始 / 尚无事件时为 null。 */
  progress: TaskProgress | null;
  /** 任务是否进行中（`start()` 置 true，`finish()` 置 false）。 */
  isRunning: boolean;
  /** 是否已请求取消（供 UI 把取消按钮切到「取消中…」并禁用）。 */
  cancelRequested: boolean;
  /**
   * 取消请求已超时且未被后端响应（E2）。`finish()`、收到新进度或重新 `start()`
   * 时清零；为 true 时 UI 可提示并提供「强制结束」。
   */
  cancelStalled: boolean;
  /** 开始任务：清空旧进度、置进行中。**同步**生效。 */
  start: () => void;
  /** 结束任务：置非进行中并清空进度（结果呈现由调用方负责）。 */
  finish: () => void;
  /** 请求取消。任务未进行中时为 no-op（不发 invoke）。失败时 rethrow，由调用方提示。 */
  cancel: () => Promise<void>;
  /**
   * 用 ref 读取「是否已请求取消」——异步回调（如 `catch` 分支）里 `cancelRequested`
   * 状态是陈旧的闭包值，必须走这个 getter 才拿得到最新值。
   */
  isCancelRequested: () => boolean;
}

export const useTaskProgress = (kind: TaskKind): UseTaskProgressResult => {
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelStalled, setCancelStalled] = useState(false);

  // 同步真值：事件回调与异步 catch 都要读它，不能用 state（闭包会陈旧）。
  const runningRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const cancelStalledRef = useRef(false);

  // 看门狗计时器句柄；「订阅是否就绪」与就绪前到达事件的缓冲（E11）。
  const watchdogRef = useRef<number | null>(null);
  const subscribedRef = useRef(false);
  const earlyBufferRef = useRef<Array<ScanProgressPayload | ExportProgressPayload>>([]);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const clearStalled = useCallback(() => {
    if (!cancelStalledRef.current) return;
    cancelStalledRef.current = false;
    setCancelStalled(false);
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let active = true;
    subscribedRef.current = false;
    earlyBufferRef.current = [];

    subscribeTaskProgress(kind, (payload) => {
      // 事件是全局的：任务没在跑时到达的事件属于上一次任务的残留，丢弃。
      if (!runningRef.current) return;
      // E11：订阅 promise 就绪前到达的事件先缓冲，就绪后统一回放，避免最早几条丢失。
      if (!subscribedRef.current) {
        earlyBufferRef.current.push(payload);
        return;
      }
      // 收到新进度 = 后端仍在响应 → 看门狗与「取消无响应」不再成立（E2）。
      clearWatchdog();
      clearStalled();
      setProgress(normalize(kind, payload));
    }).then((fn) => {
      // 订阅到达时组件已卸载 → 立刻退订，避免监听器泄漏，且不再回放缓冲。
      if (!active) {
        fn();
        return;
      }
      unlisten = fn;
      subscribedRef.current = true;
      // 回放就绪前缓冲的事件：进度是覆盖语义，只取最后一条即可。
      const buffered = earlyBufferRef.current;
      earlyBufferRef.current = [];
      if (buffered.length > 0 && runningRef.current) {
        clearWatchdog();
        clearStalled();
        setProgress(normalize(kind, buffered[buffered.length - 1]));
      }
    });

    return () => {
      active = false;
      subscribedRef.current = false;
      earlyBufferRef.current = [];
      unlisten?.();
      clearWatchdog();
    };
  }, [kind, clearWatchdog, clearStalled]);

  const start = useCallback(() => {
    clearWatchdog();
    cancelStalledRef.current = false;
    setCancelStalled(false);
    runningRef.current = true;
    cancelRequestedRef.current = false;
    setCancelRequested(false);
    setProgress(null);
    setIsRunning(true);
  }, [clearWatchdog]);

  const finish = useCallback(() => {
    clearWatchdog();
    cancelStalledRef.current = false;
    setCancelStalled(false);
    runningRef.current = false;
    cancelRequestedRef.current = false;
    setCancelRequested(false);
    setIsRunning(false);
    setProgress(null);
  }, [clearWatchdog]);

  const cancel = useCallback(async () => {
    // 任务没在跑就别发取消命令（避免误导后端/产生无意义 IPC）。
    if (!runningRef.current) return;
    cancelRequestedRef.current = true;
    setCancelRequested(true);
    try {
      await cancelTask(kind);
    } catch (e) {
      // 取消命令失败 = 任务仍在跑，回滚"已请求取消"让用户可以再试一次。
      cancelRequestedRef.current = false;
      setCancelRequested(false);
      throw e;
    }
    // E2：看门狗 —— 若后端在 CANCEL_WATCHDOG_MS 内既未 finish 也无新进度，
    // 判定「取消请求无响应」，置 cancelStalled 供 UI 提示并提供「强制结束」。
    clearWatchdog();
    watchdogRef.current = window.setTimeout(() => {
      watchdogRef.current = null;
      if (!runningRef.current) return;
      cancelStalledRef.current = true;
      setCancelStalled(true);
    }, CANCEL_WATCHDOG_MS);
  }, [kind, clearWatchdog]);

  const isCancelRequested = useCallback(() => cancelRequestedRef.current, []);

  return {
    progress,
    isRunning,
    cancelRequested,
    cancelStalled,
    start,
    finish,
    cancel,
    isCancelRequested,
  };
};