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
 *  - 不属于本次任务的事件（任务没在跑时到达的）一律丢弃，不会污染 UI。
 *
 * 取消是**协作式**的：`cancel()` 只向后端置一个取消标志，任务本身仍在飞行中
 * （`isRunning` 保持 true），直到它的 invoke 返回。后端走「临时目录 + 原子搬迁」
 * （Q4 all-or-nothing），所以取消结果是"目标目录零污染"，前端据此书写文案。
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

  // 同步真值：事件回调与异步 catch 都要读它，不能用 state（闭包会陈旧）。
  const runningRef = useRef(false);
  const cancelRequestedRef = useRef(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let active = true;

    subscribeTaskProgress(kind, (payload) => {
      // 事件是全局的：任务没在跑时到达的事件属于上一次任务的残留，丢弃。
      if (!runningRef.current) return;
      setProgress(normalize(kind, payload));
    }).then((fn) => {
      // 订阅到达时组件已卸载 → 立刻退订，避免监听器泄漏。
      if (active) unlisten = fn;
      else fn();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [kind]);

  const start = useCallback(() => {
    runningRef.current = true;
    cancelRequestedRef.current = false;
    setCancelRequested(false);
    setProgress(null);
    setIsRunning(true);
  }, []);

  const finish = useCallback(() => {
    runningRef.current = false;
    cancelRequestedRef.current = false;
    setCancelRequested(false);
    setIsRunning(false);
    setProgress(null);
  }, []);

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
  }, [kind]);

  const isCancelRequested = useCallback(() => cancelRequestedRef.current, []);

  return {
    progress,
    isRunning,
    cancelRequested,
    start,
    finish,
    cancel,
    isCancelRequested,
  };
};
