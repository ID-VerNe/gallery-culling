import React, { useState } from 'react';
import {
  Wand2,
  RotateCcw,
  Save,
  Sliders,
  SunMedium,
  Contrast,
  Thermometer,
  CloudSun,
  Droplets,
  X,
} from 'lucide-react';
import { ToneAdjustments } from '../types';
import { DEFAULT_TONE } from '../utils/autoTone';

interface TonalAdjusterProps {
  tone: ToneAdjustments;
  onChange: (tone: ToneAdjustments) => void;
  onAutoTone?: () => void;
  onAuto?: () => void;
  onReset?: () => void;
  onSaveXmp: () => void;
  onClose: () => void;
  isSaving?: boolean;
  /** LUMEN RAW 引擎可用时出现：把滑杆写入 lumen recipe（而非 XMP）。 */
  onSaveToLumen?: () => void;
  /** LUMEN RAW 内置预设（来自 commands.list，非硬编码） */
  lumenPresets?: string[];
  /** AI 蒙版是否可用（GPU flavor 才有）。false 时显示说明而不是假装能用。 */
  aiAvailable?: boolean;
  onApplyPreset?: (name: string) => void;
}

/**
 * Slider descriptors. `tint` was missing from the panel even though the type
 * defines it, `computeAutoTone` produces it and `getToneFilterString` applies
 * it — the user could not see or correct a value that was actively being
 * written into their preview (F-16).
 */
const SLIDERS: Array<{
  field: keyof ToneAdjustments;
  label: string;
  icon: React.ReactNode;
  min: number;
  max: number;
  step: number;
  /** How to format the readout. */
  format: (v: number) => string;
  describe: string;
}> = [
  {
    field: 'exposure',
    label: '曝光',
    icon: <SunMedium className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />,
    min: -3,
    max: 3,
    step: 0.05,
    format: (v) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)),
    describe: '整体明暗，单位为 EV',
  },
  {
    field: 'shadows',
    label: '阴影',
    icon: <CloudSun className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />,
    min: -100,
    max: 100,
    step: 1,
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
    describe: '暗部提亮或压暗',
  },
  {
    field: 'highlights',
    label: '高光',
    icon: <SunMedium className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />,
    min: -100,
    max: 100,
    step: 1,
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
    describe: '亮部细节恢复',
  },
  {
    field: 'temperature',
    label: '色温',
    icon: <Thermometer className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />,
    min: -100,
    max: 100,
    step: 1,
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
    describe: '冷暖偏移',
  },
  {
    field: 'tint',
    label: '色调',
    icon: <Droplets className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />,
    min: -100,
    max: 100,
    step: 1,
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
    describe: '绿 / 洋红偏移',
  },
  {
    field: 'contrast',
    label: '对比度',
    icon: <Contrast className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />,
    min: -100,
    max: 100,
    step: 1,
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`,
    describe: '明暗反差强度',
  },
];

export const TonalAdjuster: React.FC<TonalAdjusterProps> = ({
  tone,
  onChange,
  onAutoTone,
  onAuto,
  onReset,
  onSaveXmp,
  onClose,
  onSaveToLumen,
  lumenPresets = [],
  aiAvailable = false,
  onApplyPreset,
  isSaving = false,
}) => {
  const [saveFeedback, setSaveFeedback] = useState(false);
  const [lumenFeedback, setLumenFeedback] = useState(false);

  const handleSlider = (field: keyof ToneAdjustments, value: number) => {
    onChange({
      ...tone,
      [field]: value,
    });
  };

  const handleReset = () => {
    if (onReset) {
      onReset();
    } else {
      onChange({ ...DEFAULT_TONE });
    }
  };

  const triggerAutoTone = () => {
    if (onAuto) onAuto();
    else if (onAutoTone) onAutoTone();
  };

  const handleSaveClick = async () => {
    await onSaveXmp();
    setSaveFeedback(true);
    setTimeout(() => setSaveFeedback(false), 2000);
  };

  const handleSaveToLumenClick = async () => {
    if (!onSaveToLumen) return;
    await onSaveToLumen();
    setLumenFeedback(true);
    setTimeout(() => setLumenFeedback(false), 2000);
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="bg-background-base border-l border-white/10 h-full w-full p-5 text-xs flex flex-col gap-4 overflow-y-auto"
      role="region"
      aria-label="快速调色控制面板"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 pb-3">
        <div className="flex items-center gap-2 font-medium text-white">
          <Sliders className="w-4 h-4 text-white/60" aria-hidden="true" />
          <span>调色</span>
        </div>
        <button
          onClick={onClose}
          className="focus-ring text-white/60 hover:text-white p-1 rounded-md hover:bg-white/5 transition-colors"
          title="关闭面板"
          aria-label="关闭面板"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* Sliders Container */}
      <div className="flex flex-col gap-4">
        {SLIDERS.map((s) => {
          const value = tone[s.field] as number;
          return (
            <div className="flex flex-col gap-1.5" key={s.field}>
              <div className="flex justify-between items-center text-white/80 gap-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  {s.icon}
                  <span className="truncate">{s.label}</span>
                </span>
                <span className="font-mono text-[11px] tabular-nums text-white/70 shrink-0">
                  {s.format(value)}
                </span>
              </div>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={value}
                onChange={(e) =>
                  handleSlider(s.field, parseFloat(e.target.value))
                }
                className="tone-slider"
                aria-label={`${s.label}，${s.describe}`}
                aria-valuetext={s.format(value)}
              />
            </div>
          );
        })}
      </div>

      {/* LUMEN RAW presets (from the sidecar's own command table) */}
      {onApplyPreset && lumenPresets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="tonal-preset"
            className="text-white/70 font-medium"
          >
            LUMEN RAW 预设
          </label>
          <div className="flex items-center gap-1.5">
            <select
              id="tonal-preset"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) onApplyPreset(e.target.value);
                e.target.value = '';
              }}
              className="focus-ring flex-1 min-w-0 bg-background-base border border-border-default rounded-md px-2 py-1.5 text-white outline-none text-xs focus:border-white/40"
            >
              <option value="">选择预设…</option>
              {lumenPresets.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[10px] leading-relaxed text-white/60">
            预设直接改 LUMEN RAW 的编辑状态，套用后滑杆会读回真实数值。
          </p>
          {!aiAvailable && (
            <p className="text-[10px] leading-relaxed text-amber-200/70">
              AI 蒙版与降噪/超分需要带 GPU 推理的 LUMEN RAW 版本（当前 CPU 版不含），
              暂不可用。
            </p>
          )}
        </div>
      )}

      {/* Action Buttons: Auto, Reset, Save to XMP */}
      <div className="flex items-center gap-2 pt-3 mt-auto border-t border-white/10">
        {/* Auto Button */}
        <button
          onClick={triggerAutoTone}
          className="focus-ring flex-1 flex items-center justify-center gap-1.5 py-2 px-2 bg-white/5 hover:bg-white/10 text-white font-medium rounded-lg text-xs active:scale-[0.98] transition-colors"
          title="基于直方图智能自适应计算"
          aria-label="智能自动调色"
        >
          <Wand2 className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
          <span>自动</span>
        </button>

        {/* Reset Button */}
        <button
          onClick={handleReset}
          className="focus-ring p-2 text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-lg active:scale-[0.98] transition-colors"
          title="重置所有参数"
          aria-label="重置调色滑块"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
        </button>

        {/* Save to LUMEN RAW（引擎可用时） */}
        {onSaveToLumen && (
          <button
            onClick={handleSaveToLumenClick}
            disabled={isSaving}
            className={`focus-ring flex-1 flex items-center justify-center gap-1.5 py-2 px-2 font-medium rounded-lg text-xs active:scale-[0.98] transition-colors ${
              lumenFeedback
                ? 'bg-emerald-600/40 text-emerald-200'
                : 'bg-white hover:bg-white/90 text-black shadow-sm'
            }`}
            title="应用到 LUMEN RAW 的调色 recipe"
            aria-label="应用调色至 LUMEN RAW"
          >
            <Save className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="pb-[1px]">
              {lumenFeedback ? '已应用' : isSaving ? '应用中…' : '应用 RAW'}
            </span>
          </button>
        )}

        {/* Save to XMP Button */}
        <button
          onClick={handleSaveClick}
          disabled={isSaving}
          className={`focus-ring ${onSaveToLumen ? '' : 'flex-1'} flex items-center justify-center gap-1.5 py-2 px-2 font-medium rounded-lg text-xs active:scale-[0.98] transition-colors ${
            saveFeedback
              ? 'bg-emerald-600/40 text-emerald-200'
              : 'bg-white hover:bg-white/90 text-black shadow-sm'
          }`}
          title="将调色参数写入 .xmp"
          aria-label="保存调色至 XMP"
        >
          <Save className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="pb-[1px]">
            {saveFeedback ? '已写入' : isSaving ? '保存中…' : '同步 XMP'}
          </span>
        </button>
      </div>
    </div>
  );
};
