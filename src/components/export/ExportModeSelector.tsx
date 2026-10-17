/**
 * 导出方式单选 —— **纯呈现**。
 *
 * 只认识 `ExportMode` 与配置表，不认识 LUMEN 状态：
 * 「引擎不可用所以选不了成片」是容器的判断（`canRun` + `LumenGateNotice`），
 * 不是这个组件的职责。这样它可以被 Storybook / 测试单独渲染成任意状态。
 */
import React from 'react';
import { EXPORT_MODES } from './exportConfig';
import type { ExportMode } from '../../types';

/** 展示顺序固定，不依赖对象键序（键序在不同引擎/转译下不保证稳定）。 */
const MODE_ORDER: ExportMode[] = ['copy', 'render'];

interface ExportModeSelectorProps {
  value: ExportMode;
  onChange: (mode: ExportMode) => void;
  disabled?: boolean;
}

export const ExportModeSelector: React.FC<ExportModeSelectorProps> = ({
  value,
  onChange,
  disabled = false,
}) => (
  <fieldset>
    <legend className="text-white/80 font-medium mb-1.5">导出方式</legend>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-background-base p-2.5 rounded border border-default">
      {MODE_ORDER.map((mode) => {
        const spec = EXPORT_MODES[mode];
        const inputId = `export-mode-${mode}`;
        return (
          <label
            key={mode}
            htmlFor={inputId}
            className={`focus-ring flex items-start gap-2 rounded p-1 transition-colors ${
              disabled
                ? 'cursor-not-allowed opacity-50'
                : 'cursor-pointer hover:bg-background-surface-hover'
            }`}
          >
            <input
              id={inputId}
              type="radio"
              name="export_mode"
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
              disabled={disabled}
              className="accent-white mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-white/80">{spec.label}</span>
              <span className="text-white/50 text-[11px] leading-tight">
                {spec.description}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  </fieldset>
);
