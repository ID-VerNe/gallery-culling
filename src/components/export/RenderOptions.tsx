/**
 * 成片输出设置 —— **纯呈现**。
 *
 * 只在 `mode === 'render'` 时挂载。三件事：格式、长边、质量。
 *
 * 质量用 `string` 而非 `number` 受控：受控 number input 若直接绑数字，
 * 用户清空输入框的瞬间值会变成 0，光标行为也会跳。让组件保留用户敲的原文，
 * 由 `useExportForm` 派生出夹取后的真实值 —— 组件不做校验，只显示 `error`。
 */
import React, { useId } from 'react';
import {
  RENDER_FORMATS,
  RENDER_LONG_EDGES,
  RENDER_QUALITY_MIN,
  RENDER_QUALITY_MAX,
  formatUsesQuality,
} from './exportConfig';
import { buildJpegSourceWarning } from './exportMessages';
import type { RenderFormat } from '../../types';

interface RenderOptionsProps {
  format: RenderFormat;
  longEdge: number;
  /** 输入框原始文本（可能为空或越界），真实值由上层夹取。 */
  qualityText: string;
  onChangeFormat: (f: RenderFormat) => void;
  onChangeLongEdge: (n: number) => void;
  onChangeQuality: (v: string) => void;
  /** 失焦时把文本规整为夹取后的值；不传则不规整。 */
  onCommitQuality?: () => void;
  /**
   * 候选里仅含 JPG 的组数。>0 且输出 JPEG 时提示二次压缩 ——
   * 只在 JPEG 有质量参数时才有意义，所以由本组件按格式决定是否展示。
   */
  jpgOnlyCount?: number;
  /**
   * 质量被规整时的说明（输入 200 失焦后变 100）。`null` 表示本次没有规整。
   * 静默改写输入框会让用户以为程序乱改，必须说出来。
   */
  qualityNotice?: string | null;
  disabled?: boolean;
}

export const RenderOptions: React.FC<RenderOptionsProps> = ({
  format,
  longEdge,
  qualityText,
  onChangeFormat,
  onChangeLongEdge,
  onChangeQuality,
  onCommitQuality,
  jpgOnlyCount = 0,
  qualityNotice = null,
  disabled = false,
}) => {
  /** 质量参数只对 JPEG 有意义，提示同理：TIFF/DNG 不存在二次压缩问题。 */
  const usesQuality = formatUsesQuality(format);
  const warning = usesQuality ? buildJpegSourceWarning(jpgOnlyCount) : null;
  const notice = usesQuality ? qualityNotice : null;
  const warningId = useId();
  const noticeId = useId();
  /** 两个说明都挂在质量输入上，读屏聚焦时能一次读到。 */
  const describedBy =
    [warning ? warningId : null, notice ? noticeId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <fieldset>
      <legend className="text-white/80 font-medium mb-1.5">成片设置</legend>
      <div className="flex flex-col gap-2.5 bg-background-base p-2.5 rounded border border-default">
        {/* 格式：三种足够覆盖摄影出片，PNG 不进入 UI */}
        <div className="flex flex-col gap-1.5">
          <span className="text-white/70 text-[11px]">输出格式</span>
          <div className="flex flex-wrap items-center gap-3">
            {RENDER_FORMATS.map((f) => (
              <label
                key={f.value}
                htmlFor={`export-format-${f.value}`}
                className="focus-ring flex items-center gap-2 cursor-pointer rounded p-1 hover:bg-background-surface-hover transition-colors"
              >
                <input
                  id={`export-format-${f.value}`}
                  type="radio"
                  name="export_format"
                  value={f.value}
                  checked={format === f.value}
                  onChange={() => onChangeFormat(f.value)}
                  disabled={disabled}
                  className="accent-white"
                />
                <span className="text-white/80">{f.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2.5">
          {/* 长边：0 = 原始尺寸，不缩放 */}
          <div className="flex flex-col gap-1.5 flex-1 min-w-0">
            <label htmlFor="export-long-edge" className="text-white/70 text-[11px]">
              长边尺寸
            </label>
            <select
              id="export-long-edge"
              value={longEdge}
              onChange={(e) => onChangeLongEdge(Number(e.target.value))}
              disabled={disabled}
              className="focus-ring w-full bg-background-base border border-border-default rounded-md px-2 py-1.5 text-white outline-none focus:border-white/40 disabled:opacity-50"
            >
              {RENDER_LONG_EDGES.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>

          {/* 质量：仅 JPEG 有意义，TIFF / DNG 无此概念，直接不显示 */}
          {usesQuality && (
            <div className="flex flex-col gap-1.5 w-full sm:w-28 shrink-0">
              <label htmlFor="export-quality" className="text-white/70 text-[11px]">
                JPEG 质量
              </label>
              <input
                id="export-quality"
                type="number"
                inputMode="numeric"
                min={RENDER_QUALITY_MIN}
                max={RENDER_QUALITY_MAX}
                step={1}
                value={qualityText}
                onChange={(e) => onChangeQuality(e.target.value)}
                onBlur={onCommitQuality}
                disabled={disabled}
                aria-describedby={describedBy}
                className="focus-ring w-full bg-background-base border border-border-default rounded-md px-2 py-1.5 text-white outline-none font-mono tabular-nums focus:border-white/40 disabled:opacity-50"
              />
            </div>
          )}
        </div>

        {/*
          提示而不是拦截：JPG 能渲，只是再压一次有损失。
          刻意不用 role=alert / status / aria-live —— 结果条与进度条各自
          占着一个 live region，这里只是静态说明，靠 aria-describedby 挂在
          质量输入上，读屏聚焦输入时自然会读到。
        */}
        {(warning || notice) && (
          <div className="flex flex-col gap-1">
            {warning && (
              <p id={warningId} className="text-[11px] text-amber-200/80 leading-relaxed">
                {warning}
              </p>
            )}
            {notice && (
              <p id={noticeId} className="text-[11px] text-amber-200/80 leading-relaxed">
                {notice}
              </p>
            )}
          </div>
        )}
      </div>
    </fieldset>
  );
};
