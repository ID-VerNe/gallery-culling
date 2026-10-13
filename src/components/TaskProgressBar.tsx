import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

/**
 * 长任务进度条（M-05 前端）——**受控组件**。
 *
 * 只负责"呈现"：进度值、是否进行中、取消回调都由调用方传入，不假设调用方是谁
 * （扫描在 `App.tsx`、导出在 `BatchExportModal.tsx`）。进度值的来源是
 * `useTaskProgress`，但本组件对它无依赖，方便单独测试与复用。
 *
 * 无障碍：
 *  - 进度值由内层 `role="progressbar"` + `aria-valuenow/max/valuetext` 表达；
 *    `total <= 0`（尚未收到首条事件）时退化为不确定进度（不写 valuenow）；
 *  - **播报节流（E1）**：扫描/导出每张照片都会触发一次进度事件，若把实时读数放进
 *    `aria-live`，polite 队列会逐条播报把读屏用户淹没。因此 live region 只承载一个
 *    sr-only 的"档位播报"，仅当进度跨过 10% 时才更新，其余变化只改视觉数字；
 *  - **取消无响应（E2）**：`cancelStalled` 为 true 时展示提示，并在提供
 *    `onForceFinish` 时渲染「强制结束」按钮。
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
  /**
   * 取消请求已超时且未被后端响应（E2）；为 true 时展示「取消请求无响应」提示。
   * 由 `useTaskProgress().cancelStalled` 驱动（接线由宿主负责）。
   */
  cancelStalled?: boolean;
  /** 点击「强制结束」时触发（仅在 `cancelStalled` 为 true 时渲染按钮）。 */
  onForceFinish?: () => void;
  className?: string;
}

/** 播报节流档位：每跨过 10% 更新一次 sr-only 播报（E1）。 */
const ANNOUNCE_STEP = 10;

export const TaskProgressBar: React.FC<TaskProgressBarProps> = ({
  isRunning,
  processed,
  total,
  label,
  current,
  onCancel,
  cancelRequested = false,
  cancelStalled = false,
  onForceFinish,
  className,
}) => {
  const labelText = label ?? '任务进行中';
  const known = total > 0;
  // 夹取到 [0,100]，防止后端偶发的 processed > total 把进度条画爆。
  const pct = known ? Math.min(100, Math.max(0, Math.round((processed / total) * 100))) : 0;
  const countText = known ? `${processed} / ${total}（${pct}%）` : `已处理 ${processed} 项`;

  // E1：节流播报 —— 只在 10% 档位变化时更新 live region，避免逐条淹没读屏。
  const milestone = known ? Math.floor(pct / ANNOUNCE_STEP) : -1;
  const [announcement, setAnnouncement] = useState('');
  const lastMilestoneRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isRunning) {
      lastMilestoneRef.current = null;
      return;
    }
    if (lastMilestoneRef.current === milestone) return;
    lastMilestoneRef.current = milestone;
    setAnnouncement(milestone < 0 ? `${labelText}，处理中…` : `${labelText}：${countText}`);
  }, [isRunning, milestone, labelText, countText]);

  if (!isRunning) return null;

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-white/70">
        <span>{labelText}</span>
        <span className="font-mono tabular-nums">{known ? countText : '处理中…'}</span>
      </div>

      {/* live region 只承载节流后的 sr-only 播报文本；进度条本体保持 progressbar 语义。 */}
      <div aria-live="polite" aria-atomic="true">
        <div
          role="progressbar"
          aria-label={labelText}
          aria-valuemin={0}
          aria-valuemax={known ? total : undefined}
          aria-valuenow={known ? processed : undefined}
          aria-valuetext={`${labelText}：${countText}`}
          className="h-1.5 w-full rounded-full bg-white/20 overflow-hidden"
        >
          <div
            className={`h-full transition-[width] duration-200 ${
              known ? 'bg-white/70' : 'bg-white/70 animate-pulse progress-indeterminate'
            }`}
            // 不确定进度给一个固定宽度 + 脉冲动画；确定进度按百分比。
            // E4：reduced-motion 下由 .progress-indeterminate 提供静态斜纹区分。
            style={{ width: known ? `${pct}%` : '30%' }}
          />
        </div>
        <span className="sr-only">{announcement}</span>
      </div>

      {current && (
        <p className="text-[11px] text-white/70 font-mono truncate" title={current}>
          {current}
        </p>
      )}

      {cancelStalled && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-amber-300/90">
            取消请求无响应，任务可能仍在后台运行。
          </span>
          {onForceFinish && (
            <button
              type="button"
              onClick={onForceFinish}
              className="focus-ring shrink-0 px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/15 active:scale-[0.96] text-white/90 transition-colors"
            >
              强制结束
            </button>
          )}
        </div>
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