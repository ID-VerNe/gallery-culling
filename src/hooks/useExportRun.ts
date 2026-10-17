/**
 * 导出的**执行器**：跑一次导出、把结果翻译成句子、管理进度与取消。
 *
 * 边界：
 *  - 不校验（`useExportForm().validation` 的职责）；
 *  - 不渲染（容器的事）；
 *  - 不拼句子（`exportMessages` 的事）。
 *
 * 它只接受一个 `invoke`：调用方决定这次是复制原片还是渲染成片。
 * 这样两种模式共用同一条执行路径 —— 进度、取消、结果呈现、Toast 分发
 * 都只有一份实现，不可能出现「复制模式正确处理了取消、成片模式忘了」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTaskProgress } from './useTaskProgress';
import { buildOutcomeMessage } from '../components/export/exportMessages';
import type { ExportResultView } from '../components/export/ExportResultPanel';
import type { ExportMode, ExportOutcome, TaskProgress } from '../types';

/**
 * 取消后后端可能以 `Err` 返回（而不是带 `cancelled` 的 Ok）。
 * 用这个常量构造「已取消」的结果，避免各处手写空 outcome 漏字段。
 */
const CANCELLED_OUTCOME: ExportOutcome = {
  exported: 0,
  skipped: 0,
  failed: [],
  cancelled: true,
};

export interface UseExportRunOptions {
  mode: ExportMode;
  /** 表单输入每变化一次自增 —— 用来作废上一次结果。 */
  resetSignal: number;
  /**
   * 失败提示的出口（部分失败、抛错、取消失败都走这里）。
   *
   * 刻意**没有** `onSuccess`：成功时结果条就在弹窗里、和用户视线同一屏，
   * 再弹一条同义 Toast 是纯噪音。失败才需要 Toast —— 它是唯一能在用户
   * 关掉弹窗之后仍然留存的那条提示。
   */
  onError?: (message: string) => void;
}

export interface ExportRun {
  isRunning: boolean;
  progress: TaskProgress | null;
  cancelRequested: boolean;
  /** 结果条内容；`null` 表示无结果或已被输入变更作废。 */
  result: ExportResultView | null;
  /**
   * 执行一次导出。
   *
   * `invoke` 由调用方提供（复制走 `api.batchExport`，成片走 `api.batchRenderExport`），
   * 返回统一的 `ExportOutcome`。抛错时按「是否已请求取消」分流：
   * 取消 → 中性陈述；其他 → 错误提示，绝不伪装成成功。
   */
  run: (args: {
    invoke: () => Promise<ExportOutcome>;
    targetFolder: string;
  }) => Promise<void>;
  /** 请求取消。命令失败会提示但不抛给调用方。 */
  cancel: () => Promise<void>;
}

export function useExportRun({
  mode,
  resetSignal,
  onError,
}: UseExportRunOptions): ExportRun {
  const [result, setResult] = useState<ExportResultView | null>(null);
  const {
    progress,
    isRunning,
    cancelRequested,
    start,
    finish,
    cancel: cancelTask,
    isCancelRequested,
  } = useTaskProgress('export');

  // 父组件常传内联箭头函数：放 ref 里，避免它们每次 render 都让 `run` 重建。
  const callbacks = useRef({ onError });
  useEffect(() => {
    callbacks.current = { onError };
  }, [onError]);

  // 输入一变，上次结果立即作废 —— 否则用户改了选项还看着旧结论。
  useEffect(() => {
    setResult(null);
  }, [resetSignal]);

  const run = useCallback(
    async ({ invoke, targetFolder }: { invoke: () => Promise<ExportOutcome>; targetFolder: string }) => {
      start();
      setResult(null);
      try {
        const outcome = await invoke();
        const built = buildOutcomeMessage({ mode, outcome, targetFolder });
        setResult({
          message: built.message,
          failed: built.failed,
          failures: built.failures,
          folder: built.folder,
        });
        // 取消时 `toast` 为 null：结果条已经把话说全，不再弹一次。
        if (built.toast?.kind === 'error') callbacks.current.onError?.(built.toast.text);
      } catch (err) {
        // 用 getter 读最新值：这里读 `cancelRequested` 状态会是陈旧闭包。
        if (isCancelRequested()) {
          const built = buildOutcomeMessage({
            mode,
            outcome: CANCELLED_OUTCOME,
            targetFolder,
          });
          setResult({
            message: built.message,
            failed: built.failed,
            failures: built.failures,
            folder: built.folder,
          });
        } else {
          callbacks.current.onError?.(`导出出错：${String(err)}`);
        }
      } finally {
        finish();
      }
    },
    [mode, start, finish, isCancelRequested],
  );

  const cancel = useCallback(async () => {
    try {
      await cancelTask();
    } catch (err) {
      callbacks.current.onError?.(`取消导出失败：${String(err)}`);
    }
  }, [cancelTask]);

  return { isRunning, progress, cancelRequested, result, run, cancel };
}
