import React from 'react';
import { X } from 'lucide-react';

/**
 * 长任务进度条（M-05 前端）——**受控组件**。
 *
 * 只负责"呈现"：进度值、是否进行中、取消回调都由调用方传入，不假设调用方是谁
 * （扫描在 `App.tsx`、导出在 `BatchExportModal.tsx`）。进度值的来源是
 * `useTaskProgress`，但本组件对它无依赖，方便单独测试与复用。
 *
 * 无障碍：
 *  - 外层 `aria-live="polite"`（§6 验收点"有 aria-live 进度"）——进度推进会被
 *    礼貌播报，且不打断用户当前操作；
 *  - 内层 `role="progressbar"` + `aria-valuenow/max/valuetext` 表达"确定性进度"；
 *    `total <= 0`（尚未收到首条事件）时退化为不确定进度（不写 valuenow）。
 */
export interface TaskProgressBarProps {
  /** 任务是否进行中；false 时本组件不渲染任何内容。 */
  isRunning: boolean;
  /** 已处理数量。 */
  processed: number;
  /** 总数量；<= 0 表示总量未知（不确定进度）。 */
  total: number;
  /** 可读的任务名，用于文案与 `aria-label`，如「正在扫描照片」。 */
  label?: string;
  /** 当前处理项（导出时的文件名）；可选，会截断显示。 */
  current?: string;
  /** 取消回调；**提供时才渲染取消按钮**（扫描/导出都传）。 */
  onCancel?: () => void;
  /** 已请求取消：按钮禁用并改文案，避免重复下发。 */
  cancelRequested?: boolean;
  className?: string;
}

export const TaskProgressBar: React.FC<TaskProgressBarProps> = ({
  isRunning,
  processed,
  total,
  label,
  current,
  onCancel,
  cancelRequested = false,
  className,
}) => {
  if (!isRunning) return null;

  const labelText = label ?? '任务进行中';
  const known = total > 0;
  // 夹取到 [0,100]，防止后端偶发的 processed > total 把进度条画爆。
  const pct = known ? Math.min(100, Math.max(0, Math.round((processed / total) * 100))) : 0;
  const countText = known ? `${processed} / ${total}（${pct}%）` : `已处理 ${processed} 项`;

  return (
    <div
      className={`flex flex-col gap-1.5 ${className ?? ''}`}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-white/70">
        <span>{labelText}</span>
        <span className="font-mono tabular-nums">{countText}</span>
      </div>

      <div
        role="progressbar"
        aria-label={labelText}
        aria-valuemin={0}
        aria-valuemax={known ? total : undefined}
        aria-valuenow={known ? processed : undefined}
        aria-valuetext={`${labelText}：${countText}`}
        className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden"
      >
        <div
          className={`h-full bg-white/70 transition-[width] duration-200 ${
            known ? '' : 'animate-pulse'
          }`}
          // 不确定进度给一个固定宽度 + 脉冲动画；确定进度按百分比。
          style={{ width: known ? `${pct}%` : '30%' }}
        />
      </div>

      {current && (
        <p className="text-[11px] text-white/50 font-mono truncate" title={current}>
          {current}
        </p>
      )}

      {onCancel && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelRequested}
            className="focus-ring flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 active:scale-[0.96] text-white/80 disabled:bg-white/5 disabled:text-white/40 disabled:cursor-not-allowed transition-colors"
          >
            <X className="w-3 h-3" aria-hidden="true" />
            <span>{cancelRequested ? '取消中…' : '取消'}</span>
          </button>
        </div>
      )}
    </div>
  );
};
