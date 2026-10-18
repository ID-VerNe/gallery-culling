/**
 * FR-09 任务互斥的运行时：Provider 持有活跃集合，任何组件都能问「现在能不能开始」。
 *
 * 为什么用 Context 而不是把 running 状态层层传 props：
 * 导出运行态在 `BatchExportModal` 内部、AI 蒙版在 `TonalAdjuster` 内部、扫描在
 * `useFolderScan` 里 —— 要汇总到 App 得加至少三条回调链，且每加一个任务就再改
 * 一次 App。Context 让「谁在跑」和「谁想知道」直接对接。
 *
 * 占用按**计数**而不是布尔：同一活动可能有两个合法 token（例如两次独立的
 * `begin('export')`），释放一个不应解除另一个。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  canStart as canStartWith,
  blockReason as blockReasonWith,
  type TaskActivity,
} from '../utils/taskMutex';

export interface TaskMutexApi {
  /**
   * 声明「我开始做 activity 了」，返回释放函数。
   *
   * **释放函数幂等**，调用方必须在 `finally` 里调 —— 任务抛错没释放会让按钮
   * 永久变灰（死锁）。同步任务优先用 `useActivity`，它绑定组件生命周期。
   */
  begin: (activity: TaskActivity) => () => void;
  canStart: (activity: TaskActivity) => boolean;
  blockReason: (activity: TaskActivity) => string | null;
  /** 当前活跃的活动（按表顺序），供调试与全局状态区使用。 */
  active: TaskActivity[];
}

const TaskMutexContext = createContext<TaskMutexApi | null>(null);

export function TaskMutexProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Partial<Record<TaskActivity, number>>>({});

  const begin = useCallback((activity: TaskActivity) => {
    let released = false;
    setCounts((prev) => ({ ...prev, [activity]: (prev[activity] ?? 0) + 1 }));
    return () => {
      // 幂等：第二次调用直接返回，否则会把另一个 token 的占用一起清掉。
      if (released) return;
      released = true;
      setCounts((prev) => {
        const next = { ...prev };
        const n = (next[activity] ?? 0) - 1;
        if (n <= 0) delete next[activity];
        else next[activity] = n;
        return next;
      });
    };
  }, []);

  const active = useMemo(
    () =>
      (Object.keys(counts) as TaskActivity[]).filter(
        (a) => (counts[a] ?? 0) > 0,
      ),
    [counts],
  );

  const api = useMemo<TaskMutexApi>(
    () => ({
      begin,
      canStart: (a) => canStartWith(a, active),
      blockReason: (a) => blockReasonWith(a, active),
      active,
    }),
    [begin, active],
  );

  return (
    <TaskMutexContext.Provider value={api}>{children}</TaskMutexContext.Provider>
  );
}

export function useTaskMutex(): TaskMutexApi {
  const ctx = useContext(TaskMutexContext);
  if (!ctx) {
    throw new Error('useTaskMutex 必须在 <TaskMutexProvider> 内使用');
  }
  return ctx;
}

/**
 * 把一个已有的 `running` 布尔值接进互斥表。
 *
 * `running` 为 true 时占用，变 false 或组件卸载时释放。effect 依赖只有
 * `[activity, running, begin]`，重复渲染不会重复占用。
 */
export function useActivity(activity: TaskActivity, running: boolean): void {
  const { begin } = useTaskMutex();
  useEffect(() => {
    if (!running) return;
    return begin(activity);
  }, [activity, running, begin]);
}
