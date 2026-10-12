/**
 * 长任务（扫描 / 批量导出）的**薄封装**：取消命令 + 进度事件订阅。
 *
 * 为什么不写进 `src/services/api.ts`：`api.ts` 是 team-lead 的独占文件；本文件
 * 只服务批次 C 的 M-05，且刻意保持"薄"——不做任何状态、不做节流，交给
 * `useTaskProgress` 组合。这样后端契约（命令名/事件名）只有这一处真值。
 *
 * 后端契约（另一位同事在 `src-tauri/` 实现，本文件严格按此写）：
 *  - 取消命令：`cancel_scan_cmd` / `cancel_export_cmd`（无参数，`Result<(), String>`）
 *  - 进度事件：`scan-progress`{ phase, processed, total }
 *              `export-progress`{ processed, total, current }
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ExportProgressPayload,
  ScanProgressPayload,
  TaskKind,
} from '../types';

/** 取消命令名（TaskKind → 命令）。 */
export const TASK_CANCEL_COMMAND: Record<TaskKind, string> = {
  scan: 'cancel_scan_cmd',
  export: 'cancel_export_cmd',
};

/** 进度事件名（TaskKind → 事件）。 */
export const TASK_PROGRESS_EVENT: Record<TaskKind, string> = {
  scan: 'scan-progress',
  export: 'export-progress',
};

/** 退订函数。与 `@tauri-apps/api/event` 的 `UnlistenFn` 同形，但不直接依赖其类型导出。 */
export type UnlistenFn = () => void;

/**
 * 取消哨兵文案 —— 必须与 `src-tauri/src/models.rs` 的 `TASK_CANCELLED` 逐字一致。
 *
 * 扫描被取消时 `scan_folders_cmd` 以 `Err("任务已取消")` 返回，前端据此把
 * 「取消」与「失败」分开呈现。
 *
 * 为什么按文案判断、而不是按「用户点过取消按钮」判断：后者会把**与取消同时
 * 发生的真实错误**误报成取消（用户点了取消，但同一瞬间扫描因权限失败——
 * 此时应该报失败）。哨兵只在真正走到取消检查点时产生，是精确信号。
 */
export const TASK_CANCELLED_SENTINEL = '任务已取消';

/** 判断一个 invoke 错误是否为「用户取消」。 */
export function isTaskCancelled(err: unknown): boolean {
  return String(err) === TASK_CANCELLED_SENTINEL;
}

/** 请求后端取消某个任务。命令只置一个 AtomicBool，正常情况下不会失败。 */
export async function cancelTask(kind: TaskKind): Promise<void> {
  await invoke(TASK_CANCEL_COMMAND[kind]);
}

/**
 * 订阅某个任务的进度事件。
 *
 * 返回的 Promise 在监听注册就绪后 resolve —— 调用方若要"不漏掉最早的事件"，
 * 应当先 await 本函数再触发任务。`listen` 本身是异步的，这是 Tauri v2 的形状。
 */
export function subscribeTaskProgress(
  kind: TaskKind,
  handler: (payload: ScanProgressPayload | ExportProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<ScanProgressPayload | ExportProgressPayload>(
    TASK_PROGRESS_EVENT[kind],
    (event) => handler(event.payload),
  );
}
