/**
 * 成片水印设置 —— **纯呈现**。
 *
 * 只在 render 模式挂载（容器已按 JPEG 过滤，所以这里不再判断格式）。
 * 折叠是刻意的：水印是可选项，不该让每次导出都先读一大段；关着也能看见
 * 「有水印这个东西」，展开才需要做选择。
 *
 * 与质量的关系：水印要在导出的 JPEG 上重编码一次，所以**沿用同一质量**，
 * 不偷偷提质量。这句话写在这里而不再复述「二次压缩」警告 —— 那条挂在
 * 质量输入上，讲的是同一个代价。
 */
import React, { useId } from 'react';
import {
  WATERMARK_PRESETS,
  WATERMARK_SIZE_MAX,
  WATERMARK_SIZE_MIN,
} from './exportConfig';
import type { WatermarkPresetName } from '../../types';

interface WatermarkOptionsProps {
  enabled: boolean;
  preset: WatermarkPresetName;
  size: number;
  onChangeEnabled: (v: boolean) => void;
  onChangePreset: (v: WatermarkPresetName) => void;
  onChangeSize: (v: number) => void;
  disabled?: boolean;
}

export const WatermarkOptions: React.FC<WatermarkOptionsProps> = ({
  enabled,
  preset,
  size,
  onChangeEnabled,
  onChangePreset,
  onChangeSize,
  disabled = false,
}) => {
  const hintId = useId();

  return (
    <details className="rounded border border-default bg-background-base">
      <summary className="focus-ring flex items-center gap-2 cursor-pointer select-none rounded px-2.5 py-1.5 text-white/80 font-medium hover:bg-background-surface-hover transition-colors">
        <span>底边水印</span>
        <span className="text-white/40 text-[11px] font-normal">（可选）</span>
      </summary>

      <div className="flex flex-col gap-2.5 px-2.5 pb-2.5 pt-1">
        <label
          htmlFor="export-watermark-enabled"
          className="focus-ring flex items-center gap-2 cursor-pointer rounded p-1 hover:bg-background-surface-hover transition-colors"
        >
          <input
            id="export-watermark-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChangeEnabled(e.target.checked)}
            disabled={disabled}
            className="accent-white"
          />
          <span className="text-white/80">给成片加底边水印</span>
        </label>

        {/*
          展开勾选后才出现具体选项 —— 没勾时展示两个用不了的控件只是噪音。
          两条说明都写给将要勾的人看，所以挂在勾选框上而不是各自的控件上。
        */}
        {enabled && (
          <>
            <p id={hintId} className="text-[11px] text-white/50 leading-relaxed">
              文案取拍摄参数（快门 · ISO · 机型），读配对 JPG 的 EXIF；没有参数的
              原片不会加水印，清单里逐项注明。贴字要重编码一次 JPEG，质量沿用左侧
              设置，不额外提质量。
            </p>

            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                <label
                  htmlFor="export-watermark-preset"
                  className="text-white/70 text-[11px]"
                >
                  配色
                </label>
                <select
                  id="export-watermark-preset"
                  value={preset}
                  onChange={(e) =>
                    onChangePreset(e.target.value as WatermarkPresetName)
                  }
                  disabled={disabled}
                  className="focus-ring w-full bg-background-base border border-border-default rounded-md px-2 py-1.5 text-white outline-none focus:border-white/40 disabled:opacity-50"
                >
                  {WATERMARK_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5 w-full sm:w-40 shrink-0">
                <label
                  htmlFor="export-watermark-size"
                  className="text-white/70 text-[11px] flex items-center justify-between gap-2"
                >
                  <span>底边高度</span>
                  <span className="font-mono tabular-nums text-white/60">
                    {size}%
                  </span>
                </label>
                <input
                  id="export-watermark-size"
                  type="range"
                  min={WATERMARK_SIZE_MIN}
                  max={WATERMARK_SIZE_MAX}
                  step={1}
                  value={size}
                  onChange={(e) => onChangeSize(Number(e.target.value))}
                  disabled={disabled}
                  className="focus-ring w-full accent-white"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </details>
  );
};
