import React, { useRef, useState } from 'react';
import {
  Wand2,
  RotateCcw,
  Save,
  Sliders,
  CloudSun,
  Copy,
  X,
} from 'lucide-react';
import { ToneAdjustments } from '../types';
import { DEFAULT_TONE } from '../utils/autoTone';
import { usePanelInitialFocus } from '../hooks/usePanelInitialFocus';
import { useAppliedPreset } from '../hooks/useAppliedPreset';
import { useAiMask } from '../hooks/useAiMask';
import { useToneBatchEntry } from '../hooks/useToneBatchEntry';
import { ConfirmDialog } from './ConfirmDialog';
import { ToneSliders } from './ToneSliders';

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
  /** UX-12：auto-tone 计算中（RAW-only 要等 LUMEN 预览渲染，可达数秒）。 */
  autoTonePending?: boolean;
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
  /**
   * 当前正在编辑的照片标识。换照片时重置「已套用预设」的下拉显示 ——
   * 预设是逐张写进各自 .lumen 的，名字不能从上一张照片残留过来
   * （箭头键切图时本面板不卸载，仅靠挂载/卸载兜不住）。
   */
  photoId?: string;
  /**
   * 套用预设。**成功必须 resolve `true`，失败 resolve `false`** ——
   * 下拉框只在拿到 `true` 后才把名字标记为「已套用」，绝不先于事实显示。
   */
  onApplyPreset?: (name: string) => Promise<boolean> | boolean;
  /** 套用 AI 蒙版（GPU 版实测约 4s，UI 负责进度反馈） */
  onApplyMask?: (region: string, dehaze: number) => Promise<void>;
  /** 工程里现有的 AI 蒙版（读回，用于显示已套用） */
  masks?: Array<{ index?: number; name?: string; kind?: string }>;
  /** C3：当前编辑值相对磁盘基线是否有未保存改动（未保存会打标记 + 离开确认）。 */
  dirty?: boolean;
  /**
   * issue #67：调色自动保存是否开启。开启时滑杆改动停止 400ms 后自动写盘，
   * 面板头部显示保存状态；关闭时保留原「未保存」徽标与手动保存。
   */
  autoSaveEnabled?: boolean;
  /** 自动保存状态：保存中 / 已保存 / 失败。 */
  autoSaveStatus?: 'idle' | 'saving' | 'saved' | 'error';
  /** 自动保存失败原因（常驻面板，不随 toast 消失）。 */
  autoSaveError?: string | null;
  /**
   * FR-07：当前选中照片数。`>= 2` 时才出现「套用到选中」入口 ——
   * 只有当前这一张时，套用等于什么都没做。
   */
  selectedCount?: number;
  /** FR-07：把当前面板值套用到其余选中照片。 */
  onApplyToSelected?: (opts: { writeLumen: boolean }) => void;
  /** FR-07：批量套用进行中（按钮禁用，避免开出第二批）。 */
  applying?: boolean;
}

export const TonalAdjuster: React.FC<TonalAdjusterProps> = ({
  tone,
  onChange,
  onAutoTone,
  autoTonePending = false,
  onAuto,
  onReset,
  onSave,
  onClose,
  divergent = false,
  lumenPresets = [],
  aiAvailable = false,
  photoId,
  onApplyPreset,
  onApplyMask,
  masks = [],
  isSaving = false,
  dirty = false,
  autoSaveEnabled = false,
  autoSaveStatus = 'idle',
  autoSaveError = null,
  selectedCount = 0,
  onApplyToSelected,
  applying = false,
}) => {
  const [saveFeedback, setSaveFeedback] = useState(false);
  /** 保存失败提示（统一命令的 rejection 出口） */
  const [saveError, setSaveError] = useState<string | null>(null);
  // C4：预设与 AI 蒙版都会"点一下即刻写 LUMEN 工程"，属不可逆落盘操作。
  // 先弹二次确认，确认后才真正下发，避免误点直接改到磁盘上。
  // 预设待确认名 / 已套用名 / 序号仲裁在 useAppliedPreset 成组；
  // 蒙版待确认在 useAiMask 成组；这里只留重置确认（T-03）与保存反馈。
  /** T-03：重置调色需二次确认（与预设/蒙版一致）。 */
  const [pendingReset, setPendingReset] = useState(false);

  // issue #115：四工作流成组抽 hook —— 预设（seq 仲裁 + 同帧清零）、蒙版
  //（isMasking 与 useActivity('ai') 同处）、批量入口分别收进各自 hook，
  // 本组件只负责组合渲染与保存/重置（400ms 自动保存链路（Refs #67）不动）。
  const {
    appliedPreset,
    pendingPreset,
    requestPreset,
    cancelPendingPreset,
    confirmPreset,
  } = useAppliedPreset({ photoId, onApplyPreset });
  const {
    maskRegion,
    setMaskRegion,
    maskDehaze,
    setMaskDehaze,
    isMasking,
    maskError,
    pendingMask,
    setPendingMask,
    aiBlockedReason,
    handleApplyMaskClick,
  } = useAiMask({ onApplyMask });
  const { applyWriteLumen, setApplyWriteLumen, applyBlockedReason } =
    useToneBatchEntry();

  // 面板互换时（E 键 / 触发按钮）旧 DOM 被整棵卸载，焦点会退回 body。
  // 挂载时若焦点无主，就把焦点移入本面板容器，让读屏播报 region 名；
  // 有意不聚焦第一个滑杆——滑杆拿到焦点后方向键会被占用，妨碍用户先浏览。
  const rootRef = useRef<HTMLDivElement>(null);
  usePanelInitialFocus(rootRef, true);

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
      className="bg-background-base border-l border-border-default h-full w-full p-5 text-xs flex flex-col gap-4 overflow-y-auto"
      role="region"
      aria-label="快速调色控制面板"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-default pb-3">
        <div className="flex items-center gap-2 font-medium text-white">
          <Sliders className="w-4 h-4 text-white/60" aria-hidden="true" />
          <span>调色</span>
          {/* issue #67：自动保存开启时，头部常驻「保存中 / 已保存 / 失败」，
              而不是只在 400ms 窗口内闪一下 dirty 徽标。 */}
          {autoSaveEnabled && autoSaveStatus === 'saving' && (
            <span
              role="status"
              aria-live="polite"
              className="text-[10px] font-normal text-white/70 bg-white/5 border border-white/15 rounded px-1.5 py-0.5"
            >
              自动保存中…
            </span>
          )}
          {autoSaveEnabled && autoSaveStatus === 'saved' && (
            <span
              role="status"
              aria-live="polite"
              className="text-[10px] font-normal text-emerald-200 bg-emerald-400/10 border border-emerald-300/30 rounded px-1.5 py-0.5"
            >
              已自动保存
            </span>
          )}
          {autoSaveEnabled && autoSaveStatus === 'error' && (
            <span
              role="alert"
              className="text-[10px] font-normal text-red-200 bg-red-400/10 border border-red-300/30 rounded px-1.5 py-0.5"
            >
              自动保存失败
            </span>
          )}
          {(!autoSaveEnabled || autoSaveStatus === 'idle') && dirty && (
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

      {/* Sliders Container —— 纯展示子组件（issue #115 · PA），只传 tone/onChange */}
      <ToneSliders tone={tone} onChange={onChange} />

      {/* 分歧提示：两侧真值不一致，明确告知而不是静默取一个 */}
      {divergent && (
        <p
          role="status"
          aria-live="polite"
          className="text-[10px] leading-[1.5] text-amber-200/80 rounded-md border border-amber-200/25 px-2 py-1.5"
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
              // 受控：显示「已成功套用」的预设名（没套过 = 占位项）。
              // 选择新预设只开二次确认框、不改这里 —— 确认前下拉保持原值，
              // 成功后才切换（见 useAppliedPreset.confirmPreset）。
              value={appliedPreset ?? ''}
              onChange={(e) => {
                // C4：先记下要套用的预设，弹二次确认后再真正下发。
                if (e.target.value) requestPreset(e.target.value);
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
          <p className="text-[10px] leading-[1.5] text-white/60">
            预设直接改 LUMEN RAW 的编辑状态，套用后滑杆会读回真实数值。
          </p>
          {!aiAvailable && (
            <p className="text-[10px] leading-[1.5] text-amber-200/70">
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
              disabled={isMasking || !!aiBlockedReason}
              className="focus-ring shrink-0 px-2.5 py-1.5 bg-background-surface-hover hover:bg-white/10 active:scale-[0.98] text-white rounded-md text-xs press disabled:opacity-40"
              title={aiBlockedReason ?? '用 AI 检测该区域并只对它应用去薄雾'}
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
          <p className="text-[10px] leading-[1.5] text-white/60">
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
          {/* FR-09：被其它长任务挡住时常驻说明（AI 蒙版要占 LUMEN 编辑态）。 */}
          {aiBlockedReason && (
            <p role="status" className="text-[10px] text-amber-200/90">
              {aiBlockedReason}
            </p>
          )}
        </div>
      )}

      {/* FR-07：套用到其余选中照片。只在 ≥2 张时出现 —— 只有当前这一张时，
          套用等于什么都没做。默认只写 XMP：200 张逐张落 .lumen 工程可能几分钟。 */}
      {selectedCount >= 2 && onApplyToSelected && (
        <div className="pt-3 mt-3 border-t border-border-default">
          <button
            onClick={() => onApplyToSelected({ writeLumen: applyWriteLumen })}
            disabled={applying || !!applyBlockedReason}
            className="focus-ring w-full flex items-center justify-center gap-1.5 py-2 px-2 bg-background-surface-hover hover:bg-white/10 text-white font-medium rounded-lg text-xs active:scale-[0.98] press disabled:opacity-60 disabled:cursor-not-allowed"
            title={applyBlockedReason ?? '把当前面板里的 6 个调色参数套用到其余选中照片；星级/旗标/色标不受影响'}
          >
            <Copy className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
            <span>{applying ? '套用中…' : `套用到选中 ${selectedCount} 张`}</span>
          </button>
          {applyBlockedReason && (
            <p role="status" className="mt-1 text-[10px] text-amber-200/90">
              {applyBlockedReason}
            </p>
          )}
          <label className="mt-1.5 flex items-start gap-1.5 text-[10px] text-white/60 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={applyWriteLumen}
              onChange={(e) => setApplyWriteLumen(e.target.checked)}
              disabled={applying}
              className="mt-0.5 accent-white"
            />
            <span>同时写入 LUMEN 工程（慢）</span>
          </label>
          <p className="mt-1 text-[10px] leading-[1.5] text-white/45">
            只复制曝光/高光/阴影/色温/色调/对比度 6 个参数，不动星级、旗标与色标。
            关闭时只写 XMP，LUMEN 预览可能仍显示旧调色。
          </p>
        </div>
      )}

      {/* Action Buttons: Auto, Reset, Save to XMP */}
      <div className="flex items-center gap-2 pt-3 mt-auto border-t border-border-default">
        {/* Auto Button */}
        <button
          onClick={triggerAutoTone}
          disabled={autoTonePending}
          className="focus-ring flex-1 flex items-center justify-center gap-1.5 py-2 px-2 bg-background-surface-hover hover:bg-white/10 text-white font-medium rounded-lg text-xs active:scale-[0.98] press disabled:opacity-60 disabled:cursor-not-allowed"
          title="基于直方图智能自适应计算"
          aria-label="智能自动调色"
          aria-busy={autoTonePending || undefined}
        >
          <Wand2 className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
          {/* UX-12：RAW-only 时要先渲染 LUMEN 预览才能采样，全程可达数秒。
              原先按钮毫无变化，用户无从判断是没生效还是还在算。 */}
          <span>{autoTonePending ? '计算中…' : '自动'}</span>
        </button>

        {/* Reset Button */}
        <button
          onClick={handleReset}
          className="focus-ring p-2 text-white/60 hover:text-white bg-background-surface-hover hover:bg-white/10 rounded-lg active:scale-[0.98] press"
          title="重置所有参数"
          aria-label="重置调色滑块"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
        </button>

        {/* 统一保存：XMP + LUMEN RAW（引擎可用时）一次写入 */}
        <button
          onClick={handleSaveClick}
          disabled={isSaving}
          className={`focus-ring flex-1 flex items-center justify-center gap-1.5 py-2 px-2 font-medium rounded-lg text-xs active:scale-[0.98] press ${
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

      {/* 自动保存失败同样必须有出口：不能只靠会消失的 toast（issue #67） */}
      {autoSaveEnabled && autoSaveError && (
        <p
          role="alert"
          className="text-[10px] leading-[1.5] text-red-300/90 rounded-md border border-red-400/25 px-2 py-1.5"
        >
          自动保存失败：{autoSaveError}。改动仍在内存中，可点「保存调色」重试。
        </p>
      )}

      {/* 保存失败必须有出口，否则统一命令的 rejection 会静默 */}
      {saveError && (
        <p
          role="alert"
          className="text-[10px] leading-[1.5] text-red-300/90 rounded-md border border-red-400/25 px-2 py-1.5"
        >
          保存调色失败：{saveError}
        </p>
      )}

      {/* C4：预设与 AI 蒙版落盘前二次确认（不可在本应用内撤销） */}
      <ConfirmDialog
        isOpen={pendingPreset !== null}
        onClose={cancelPendingPreset}
        onConfirm={() => {
          void confirmPreset();
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
