import React, { useRef, useState } from 'react';
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
import { usePanelInitialFocus } from '../hooks/usePanelInitialFocus';
import { ConfirmDialog } from './ConfirmDialog';

/** AI 蒙版可选区域（中文展示，英文 id 落进 .lumen 工程）。 */
const MASK_REGIONS: Array<{ id: string; label: string }> = [
  { id: 'sky', label: '天空' },
  { id: 'subject', label: '主体' },
  { id: 'person', label: '人像' },
  { id: 'background', label: '背景' },
  { id: 'foreground', label: '前景' },
  { id: 'top', label: '顶部' },
  { id: 'bottom', label: '底部' },
  { id: 'edges', label: '边缘' },
];

interface TonalAdjusterProps {
  tone: ToneAdjustments;
  onChange: (tone: ToneAdjustments) => void;
  onAutoTone?: () => void;
  onAuto?: () => void;
  onReset?: () => void;
  /** 统一保存：一条命令同时写 XMP 与 LUMEN RAW（引擎可用时）。 */
  onSave: () => Promise<void>;
  onClose: () => void;
  isSaving?: boolean;
  /**
   * XMP 与 LUMEN RAW 工程两侧调色不一致 —— 必须提示，绝不静默取舍。
   * 常见成因：在另一处（Lightroom / LUMEN RAW）改了调色，或换了引擎。
   */
  divergent?: boolean;
  /** LUMEN RAW 内置预设（来自 commands.list，非硬编码） */
  lumenPresets?: string[];
  /** AI 蒙版是否可用（GPU flavor 才有）。false 时显示说明而不是假装能用。 */
  aiAvailable?: boolean;
  onApplyPreset?: (name: string) => void;
  /** 套用 AI 蒙版（GPU 版实测约 4s，UI 负责进度反馈） */
  onApplyMask?: (region: string, dehaze: number) => Promise<void>;
  /** 工程里现有的 AI 蒙版（读回，用于显示已套用） */
  masks?: Array<{ index?: number; name?: string; kind?: string }>;
  /** C3：当前编辑值相对磁盘基线是否有未保存改动（未保存会打标记 + 离开确认）。 */
  dirty?: boolean;
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
  onSave,
  onClose,
  divergent = false,
  lumenPresets = [],
  aiAvailable = false,
  onApplyPreset,
  onApplyMask,
  masks = [],
  isSaving = false,
  dirty = false,
}) => {
  const [saveFeedback, setSaveFeedback] = useState(false);
  /** 保存失败提示（统一命令的 rejection 出口） */
  const [saveError, setSaveError] = useState<string | null>(null);
  const [maskRegion, setMaskRegion] = useState('sky');
  const [maskDehaze, setMaskDehaze] = useState(60);
  const [isMasking, setIsMasking] = useState(false);
  const [maskError, setMaskError] = useState<string | null>(null);
  // C4：预设与 AI 蒙版都会"点一下即刻写 LUMEN 工程"，属不可逆落盘操作。
  // 先弹二次确认，确认后才真正下发，避免误点直接改到磁盘上。
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  const [pendingMask, setPendingMask] = useState(false);
  /** T-03：重置调色需二次确认（与预设/蒙版一致）。 */
  const [pendingReset, setPendingReset] = useState(false);

  // 面板互换时（E 键 / 触发按钮）旧 DOM 被整棵卸载，焦点会退回 body。
  // 挂载时若焦点无主，就把焦点移入本面板容器，让读屏播报 region 名；
  // 有意不聚焦第一个滑杆——滑杆拿到焦点后方向键会被占用，妨碍用户先浏览。
  const rootRef = useRef<HTMLDivElement>(null);
  usePanelInitialFocus(rootRef, true);

  const handleSlider = (field: keyof ToneAdjustments, value: number) => {
    onChange({
      ...tone,
      [field]: value,
    });
  };

  const handleReset = () => {
    // T-03：重置会一键抹掉 6 个调色值，且无 undo 栈可回退。同一面板里
    // 「套用预设」「套用蒙版」都有 ConfirmDialog 保护，唯独重置没有 ——
    // 一次误点就把刚调好的曝光/高光/阴影/色温/色调/对比度全部归零。
    // 这里走二次确认，与预设/蒙版保持一致。
    setPendingReset(true);
  };

  const confirmReset = () => {
    if (onReset) {
      onReset();
    } else {
      onChange({ ...DEFAULT_TONE });
    }
    setPendingReset(false);
  };

  const triggerAutoTone = () => {
    if (onAuto) onAuto();
    else if (onAutoTone) onAutoTone();
  };

  const handleApplyMaskClick = async () => {
    if (!onApplyMask) return;
    setIsMasking(true);
    setMaskError(null);
    try {
      await onApplyMask(maskRegion, maskDehaze);
      // 任务成功才关对话框（closeOnConfirm={false} 已阻止乐观关闭）。
      setPendingMask(false);
    } catch (err) {
      console.error('AI 蒙版失败:', err);
      setMaskError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsMasking(false);
    }
  };

  const handleSaveClick = async () => {
    // 必须兜住 rejection：onSave 现在是一条统一命令（XMP + LUMEN RAW），
    // 任一环节 reject 都会变成未处理的 Promise rejection，用户看不到任何反馈，
    // 按钮也不会复位。失败时明确回报，绝不假装成功。
    try {
      await onSave();
      // 成功时清掉上一次的错误：否则按钮文案会一直卡在「保存失败」，
      // 即使用户已经重试成功（错误优先级高于成功反馈）。
      setSaveError(null);
      setSaveFeedback(true);
      setTimeout(() => setSaveFeedback(false), 2000);
    } catch (err) {
      console.error('保存调色失败:', err);
      setSaveFeedback(false);
      setSaveError(err instanceof Error ? err.message : String(err));
      setTimeout(() => setSaveError(null), 5000);
    }
  };

  return (
    <div
      ref={rootRef}
      id="tonal-adjuster-panel"
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      className="bg-background-base border-l border-default h-full w-full p-5 text-xs flex flex-col gap-4 overflow-y-auto"
      role="region"
      aria-label="快速调色控制面板"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-default pb-3">
        <div className="flex items-center gap-2 font-medium text-white">
          <Sliders className="w-4 h-4 text-white/60" aria-hidden="true" />
          <span>调色</span>
          {dirty && (
            <span
              role="status"
              aria-live="polite"
              className="text-[10px] font-normal text-amber-200 bg-amber-400/10 border border-amber-300/30 rounded px-1.5 py-0.5"
            >
              未保存
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="focus-ring text-white/60 hover:text-white p-1 rounded-md hover:bg-background-surface-hover transition-colors"
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

      {/* 分歧提示：两侧真值不一致，明确告知而不是静默取一个 */}
      {divergent && (
        <p
          role="status"
          aria-live="polite"
          className="text-[10px] leading-relaxed text-amber-200/80 rounded-md border border-amber-200/25 px-2 py-1.5"
        >
          XMP 与 LUMEN RAW 的调色不一致（可能在本应用之外改过）。保存会以当前滑杆为准
          同时覆盖两边。
        </p>
      )}

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
                // C4：先记下要套用的预设，弹二次确认后再真正下发。
                if (e.target.value) setPendingPreset(e.target.value);
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

      {/* AI 蒙版：只有 GPU 版可用。CPU 版时上面已给出说明，这里不出现死控件。 */}
      {onApplyMask && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="tonal-mask-region"
            className="text-white/70 font-medium"
          >
            AI 局部蒙版
          </label>
          {/* 行 1：区域 + 套用。滑杆挪到独立一行，避免与控件抢宽度。 */}
          <div className="flex items-center gap-1.5">
            <select
              id="tonal-mask-region"
              value={maskRegion}
              onChange={(e) => setMaskRegion(e.target.value)}
              className="focus-ring flex-1 min-w-0 bg-background-base border border-border-default rounded-md px-2 py-1.5 text-white outline-none text-xs focus:border-white/40"
            >
              {MASK_REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => setPendingMask(true)}
              disabled={isMasking}
              className="focus-ring shrink-0 px-2.5 py-1.5 bg-background-surface-hover hover:bg-white/10 active:scale-[0.98] text-white rounded-md text-xs transition-colors disabled:opacity-50"
              title="用 AI 检测该区域并只对它应用去薄雾"
            >
              {isMasking ? '检测中…' : '套用'}
            </button>
          </div>
          {/* 行 2：与上方 6 根调色滑杆同构 —— 复用 .tone-slider 与数值读数。 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between items-center text-white/80 gap-2">
              <span className="flex items-center gap-1.5 min-w-0">
                <CloudSun className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
                <span className="truncate">去薄雾</span>
              </span>
              <span className="font-mono text-[11px] tabular-nums text-white/70 shrink-0">
                {maskDehaze}%
              </span>
            </div>
            <input
              id="tonal-mask-dehaze"
              type="range"
              min={0}
              max={100}
              step={5}
              value={maskDehaze}
              onChange={(e) => setMaskDehaze(Number(e.target.value))}
              className="tone-slider"
              aria-label="蒙版去薄雾强度"
              aria-valuetext={`${maskDehaze}%`}
            />
          </div>
          <p className="text-[10px] leading-relaxed text-white/60">
            {isMasking
              ? 'AI 正在检测区域并应用（实测约 4 秒）。'
              : 'AI 本地检测区域，只对天空/主体等局部生效；不影响其它区域。'}
          </p>
          {masks.length > 0 && (
            <p className="text-[10px] text-white/60">
              已套用：{masks.map((m) => m.name ?? m.kind).join('、')}
            </p>
          )}
          {maskError && (
            <p role="alert" className="text-[10px] text-red-300/90">
              {maskError}
            </p>
          )}
        </div>
      )}

      {/* Action Buttons: Auto, Reset, Save to XMP */}
      <div className="flex items-center gap-2 pt-3 mt-auto border-t border-default">
        {/* Auto Button */}
        <button
          onClick={triggerAutoTone}
          className="focus-ring flex-1 flex items-center justify-center gap-1.5 py-2 px-2 bg-background-surface-hover hover:bg-white/10 text-white font-medium rounded-lg text-xs active:scale-[0.98] transition-colors"
          title="基于直方图智能自适应计算"
          aria-label="智能自动调色"
        >
          <Wand2 className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
          <span>自动</span>
        </button>

        {/* Reset Button */}
        <button
          onClick={handleReset}
          className="focus-ring p-2 text-white/60 hover:text-white bg-background-surface-hover hover:bg-white/10 rounded-lg active:scale-[0.98] transition-colors"
          title="重置所有参数"
          aria-label="重置调色滑块"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
        </button>

        {/* 统一保存：XMP + LUMEN RAW（引擎可用时）一次写入 */}
        <button
          onClick={handleSaveClick}
          disabled={isSaving}
          className={`focus-ring flex-1 flex items-center justify-center gap-1.5 py-2 px-2 font-medium rounded-lg text-xs active:scale-[0.98] transition-colors ${
            saveFeedback
              ? 'bg-emerald-600/40 text-emerald-200'
              : 'bg-white hover:bg-white/90 text-black shadow-sm'
          }`}
          title="同时写入 XMP 侧边栏与 LUMEN RAW 调色（引擎可用时）"
          aria-label="保存调色"
        >
          <Save className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="pb-[1px]">
            {saveError
              ? '保存失败'
              : saveFeedback
                ? '已保存'
                : isSaving
                  ? '保存中…'
                  : '保存调色'}
          </span>
        </button>
      </div>

      {/* 保存失败必须有出口，否则统一命令的 rejection 会静默 */}
      {saveError && (
        <p
          role="alert"
          className="text-[10px] leading-relaxed text-red-300/90 rounded-md border border-red-400/25 px-2 py-1.5"
        >
          保存调色失败：{saveError}
        </p>
      )}

      {/* C4：预设与 AI 蒙版落盘前二次确认（不可在本应用内撤销） */}
      <ConfirmDialog
        isOpen={pendingPreset !== null}
        onClose={() => setPendingPreset(null)}
        onConfirm={() => {
          if (pendingPreset) onApplyPreset?.(pendingPreset);
        }}
        title="套用 LUMEN RAW 预设"
        message={`将把「${pendingPreset ?? ''}」写入该照片的 LUMEN RAW 工程并保存。\n这会覆盖工程里当前的调色，且无法在本应用内撤销。`}
        confirmLabel="套用并保存"
      />
      <ConfirmDialog
        isOpen={pendingMask}
        onClose={() => setPendingMask(false)}
        onConfirm={() => {
          void handleApplyMaskClick();
        }}
        title="套用 AI 局部蒙版"
        message={`AI 将在本地检测「${MASK_REGIONS.find((r) => r.id === maskRegion)?.label ?? maskRegion}」并应用去薄雾，结果会立即写入 LUMEN RAW 工程（约 4 秒），且无法在本应用内撤销。${
          // 失败后对话框不再自动关闭（closeOnConfirm={false}），若不把原因搬进
          // 对话框，用户会盯着一个「什么都没发生」的弹窗 —— 真实错误信息在它
          // 背后的面板里，被遮罩挡住看不见。
          maskError ? `\n\n失败原因：${maskError}` : ''
        }`}
        confirmLabel="检测并应用"
        // T-05：默认 closeOnConfirm=true 会「点确认即关」，而检测要跑约 4s ——
        // 于是对话框消失、面板回到待命态，4s 后 toast 才突然出现，中间是一段
        // 反馈真空，用户无法判断到底有没有生效。
        // closeOnConfirm={false} 让对话框留在原地并显示「处理中」，任务结束后再自行关闭。
        closeOnConfirm={false}
        busy={isMasking}
      />

      {/* T-03：重置会抹掉 6 个调色值且无 undo 可回退，故要二次确认。 */}
      <ConfirmDialog
        isOpen={pendingReset}
        onClose={() => setPendingReset(false)}
        onConfirm={confirmReset}
        title="重置调色参数？"
        message="曝光、高光、阴影、色温、色调、对比度将全部恢复默认值。此操作会覆盖当前已调好的效果，且无法在本应用内撤销。"
        confirmLabel="重置"
        destructive
      />
    </div>
  );
};
