import React, { useState, useId } from 'react';
import { Sparkles, Pencil, Trash2, RotateCcw } from 'lucide-react';
import { useLensPresets } from '../hooks/useLensPresets';
import {
  EMPTY_LENS_PRESET_DRAFT,
  validateLensPresetDraft,
  type LensPresetDraft,
} from '../utils/lensPresets';
import type { LensPreset } from '../types';

interface LensPresetPanelProps {
  isOpen: boolean;
  onError?: (message: string) => void;
  onApply: (preset: LensPreset) => void;
}

/**
 * 镜头快捷预设（ADR-013）：chips 首屏 + 可展开的编辑面板。
 * 只负责预设 CRUD；「套用预设」通过 `onApply` 回调把值填回父级表单，
 * 不读写父级的镜头型号 / 焦段 / 光圈 state。
 */
export const LensPresetPanel: React.FC<LensPresetPanelProps> = ({
  isOpen,
  onError,
  onApply,
}) => {
  /** 预设编辑面板（ADR-013）：默认收起，弹窗首屏只留 chips。 */
  const [isPresetPanelOpen, setIsPresetPanelOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState<LensPresetDraft>({
    ...EMPTY_LENS_PRESET_DRAFT,
  });
  /** null = 新增；否则是正在编辑的那条的下标。 */
  const [editingPresetIndex, setEditingPresetIndex] = useState<number | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  /**
   * 「恢复默认」的两步确认。
   * 刻意不用嵌套 ConfirmDialog：那会在已经打开的 Modal 里再叠一层焦点陷阱，
   * 而这里只是一个不可撤销的覆盖动作，行内二次点击足够，也更好撤回。
   */
  const [isRestorePending, setIsRestorePending] = useState(false);

  const presetPanelId = useId();
  const presetNameId = useId();
  const presetFocalId = useId();
  const presetApertureId = useId();

  const {
    presets,
    isSaving: isPresetSaving,
    addPreset,
    updatePreset,
    removePreset,
    restoreDefaults,
  } = useLensPresets(isOpen, onError);

  const resetPresetForm = () => {
    setPresetDraft({ ...EMPTY_LENS_PRESET_DRAFT });
    setEditingPresetIndex(null);
    setPresetError(null);
  };

  const handlePresetSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const result = validateLensPresetDraft(presetDraft, presets, editingPresetIndex);
    if (!result.ok) {
      setPresetError(result.message);
      return;
    }

    setPresetError(null);
    const saved =
      editingPresetIndex === null
        ? await addPreset(result.preset)
        : await updatePreset(editingPresetIndex, result.preset);

    // 写盘失败时**不清空表单**：用户刚打的字还在，可以直接重试。
    if (saved) resetPresetForm();
  };

  const handlePresetEdit = (index: number) => {
    const target = presets[index];
    if (!target) return;
    setPresetDraft({
      name: target.name,
      focal: target.focal,
      aperture: target.aperture,
    });
    setEditingPresetIndex(index);
    setPresetError(null);
    setIsRestorePending(false);
  };

  const handlePresetDelete = async (index: number) => {
    const removed = await removePreset(index);
    if (!removed) return;

    // 下标在删除后会整体前移：正在编辑的那条被删就退出编辑态，
    // 否则把编辑目标跟着往前挪一格 —— 不然「保存修改」会写到隔壁那条上。
    if (editingPresetIndex === null) return;
    if (editingPresetIndex === index) resetPresetForm();
    else if (editingPresetIndex > index) setEditingPresetIndex(editingPresetIndex - 1);
  };

  const handleRestoreDefaults = async () => {
    if (!isRestorePending) {
      setIsRestorePending(true);
      return;
    }
    const restored = await restoreDefaults();
    setIsRestorePending(false);
    if (restored) resetPresetForm();
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span
          className="text-white/80 font-medium flex items-center gap-1.5"
          id="common-manual-lenses-label"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
          <span>镜头快捷预设</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setIsPresetPanelOpen((open) => !open);
            setIsRestorePending(false);
            // 收起面板 = 放弃这次没提交的编辑，避免下次展开时残留半截表单。
            if (isPresetPanelOpen) resetPresetForm();
          }}
          aria-expanded={isPresetPanelOpen}
          aria-controls={presetPanelId}
          className="focus-ring flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-white/70 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
        >
          <Pencil className="w-3 h-3" aria-hidden="true" />
          {isPresetPanelOpen ? '收起编辑' : '编辑预设'}
        </button>
      </div>

      {presets.length === 0 ? (
        <p className="text-[11px] text-white/50 leading-snug">
          还没有预设。点「编辑预设」把你手上的镜头存进来，下次一键填好型号、焦段和光圈。
        </p>
      ) : (
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-labelledby="common-manual-lenses-label"
        >
          {presets.map((preset, index) => (
            <button
              key={`${preset.name}-${index}`}
              type="button"
              onClick={() => onApply(preset)}
              className="focus-ring px-2.5 py-1 bg-background-surface-hover hover:bg-white/10 border border-white/15 text-white/80 hover:text-white rounded-md text-[11px] transition-colors text-left"
              aria-label={`套用预设 ${[preset.name, preset.focal, preset.aperture]
                .filter(Boolean)
                .join('，')}`}
            >
              {preset.name}
            </button>
          ))}
        </div>
      )}

      {isPresetPanelOpen && (
        <div
          id={presetPanelId}
          role="group"
          aria-label="预设编辑"
          className="mt-2 rounded-xl border border-white/10 bg-background-header p-3"
        >
          <p className="text-[10px] text-white/50 leading-[1.5] mb-2">
            预设只存在本机的 <span className="font-mono">gallery_culling.db</span> 里，不写进照片。
          </p>

          {presets.length > 0 && (
            <ul className="space-y-1 mb-2.5">
              {presets.map((preset, index) => (
                <li
                  key={`row-${preset.name}-${index}`}
                  className="flex items-center gap-2 rounded-lg bg-white/5 px-2 py-1"
                >
                  <span
                    className="flex-1 min-w-0 truncate font-mono text-[11px] text-white/80"
                    title={preset.name}
                  >
                    {preset.name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-white/45 tabular-nums">
                    {[preset.focal, preset.aperture].filter(Boolean).join(' · ') || '—'}
                  </span>
                  <button
                    type="button"
                    onClick={() => handlePresetEdit(index)}
                    aria-label={`编辑预设 ${preset.name}`}
                    className="focus-ring p-1 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <Pencil className="w-3 h-3" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handlePresetDelete(index)}
                    disabled={isPresetSaving}
                    aria-label={`删除预设 ${preset.name}`}
                    className="focus-ring p-1 rounded text-white/60 hover:text-rose-300 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3 h-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={handlePresetSubmit} className="space-y-2">
            <div>
              <label
                htmlFor={presetNameId}
                className="block text-[11px] text-white/70 mb-1"
              >
                镜头型号
              </label>
              <input
                id={presetNameId}
                type="text"
                value={presetDraft.name}
                onChange={(e) =>
                  setPresetDraft((draft) => ({ ...draft, name: e.target.value }))
                }
                placeholder="例如: Voigtlander VM 21mm F3.5"
                className="focus-ring w-full bg-background-input border border-white/15 rounded-lg px-3 py-1.5 text-white font-mono placeholder-gray-500 focus:border-white/40 text-[11px]"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label
                  htmlFor={presetFocalId}
                  className="block text-[11px] text-white/70 mb-1"
                >
                  焦段
                </label>
                <input
                  id={presetFocalId}
                  type="text"
                  value={presetDraft.focal}
                  onChange={(e) =>
                    setPresetDraft((draft) => ({ ...draft, focal: e.target.value }))
                  }
                  placeholder="例如: 21mm"
                  className="focus-ring w-full bg-background-input border border-white/15 rounded-lg px-3 py-1.5 text-white font-mono placeholder-gray-500 focus:border-white/40 text-[11px]"
                />
              </div>
              <div>
                <label
                  htmlFor={presetApertureId}
                  className="block text-[11px] text-white/70 mb-1"
                >
                  光圈
                </label>
                <input
                  id={presetApertureId}
                  type="text"
                  value={presetDraft.aperture}
                  onChange={(e) =>
                    setPresetDraft((draft) => ({ ...draft, aperture: e.target.value }))
                  }
                  placeholder="例如: f/3.5"
                  className="focus-ring w-full bg-background-input border border-white/15 rounded-lg px-3 py-1.5 text-white font-mono placeholder-gray-500 focus:border-white/40 text-[11px]"
                />
              </div>
            </div>

            {presetError && (
              <p role="alert" className="text-[11px] text-rose-300 leading-snug">
                {presetError}
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={isPresetSaving}
                className="focus-ring px-3 py-1.5 text-[11px] font-medium bg-white hover:bg-white/90 text-black rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                {editingPresetIndex === null ? '添加预设' : '保存修改'}
              </button>
              {editingPresetIndex !== null && (
                <button
                  type="button"
                  onClick={resetPresetForm}
                  className="focus-ring px-3 py-1.5 text-[11px] text-white/70 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-colors"
                >
                  取消
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleRestoreDefaults()}
                disabled={isPresetSaving}
                className={`focus-ring ml-auto flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  isRestorePending
                    ? 'text-amber-200 border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20'
                    : 'text-white/60 hover:text-white border-white/10 bg-white/5 hover:bg-white/10'
                }`}
              >
                <RotateCcw className="w-3 h-3" aria-hidden="true" />
                {isRestorePending ? '再点一次确认' : '恢复默认'}
              </button>
            </div>

            {isRestorePending && (
              <p className="text-[10px] text-amber-300/90 leading-[1.5]">
                恢复会把你现在的 {presets.length} 条预设整个换成出厂 6 条，不可撤销。
              </p>
            )}
          </form>
        </div>
      )}
    </div>
  );
};
