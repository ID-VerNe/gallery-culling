/**
 * issue #115 · PA：滑杆区的纯展示子组件。
 *
 * 只接 `tone` / `onChange`，不持有任何状态、不读互斥表、不碰确认框；
 * SLIDERS 描述符（原 TonalAdjuster:97-168）与 handleSlider（:238-243）
 * 一并搬到这里，渲染分支（:380-410）逐字保留，保证 aria / format / 间距层级不变。
 */
import React from 'react';
import {
  SunMedium,
  Contrast,
  Thermometer,
  CloudSun,
  Droplets,
} from 'lucide-react';
import type { ToneAdjustments } from '../types';

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

export interface ToneSlidersProps {
  tone: ToneAdjustments;
  onChange: (tone: ToneAdjustments) => void;
}

export const ToneSliders: React.FC<ToneSlidersProps> = ({ tone, onChange }) => {
  const handleSlider = (field: keyof ToneAdjustments, value: number) => {
    onChange({
      ...tone,
      [field]: value,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {SLIDERS.map((s) => {
        const value = tone[s.field] as number;
        return (
          <div className="flex flex-col gap-1.5" key={s.field}>
            <div className="flex justify-between items-center text-white/80 gap-2">
              <span className="flex items-center gap-1 min-w-0">
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
  );
};
