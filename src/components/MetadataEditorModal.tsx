import React, { useState, useEffect, useId } from 'react';
import { Sliders, CheckCircle2, Sparkles } from 'lucide-react';
import { PhotoGroupInfo } from '../types';
import { api } from '../services/api';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';

interface MetadataEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentGroup?: PhotoGroupInfo;
  filteredGroups: PhotoGroupInfo[];
  allGroups: PhotoGroupInfo[];
  onMetadataUpdated: (
    targetIds: string[],
    lensModel: string,
    focalLength: string,
    aperture: string,
  ) => void;
  onError?: (message: string) => void;
}

const COMMON_MANUAL_LENSES = [
  { name: 'Voigtlander APO-LANTHAR 50mm F2', focal: '50mm', aperture: 'f/2.0' },
  { name: 'Voigtlander NOKTON 35mm F1.2', focal: '35mm', aperture: 'f/1.2' },
  { name: 'TTArtisan 28mm F5.6', focal: '28mm', aperture: 'f/5.6' },
  { name: '7Artisans 35mm F0.95', focal: '35mm', aperture: 'f/0.95' },
  { name: 'Leica Summicron-M 50mm f/2', focal: '50mm', aperture: 'f/2.0' },
  { name: 'Zeiss Planar T* 50mm f/1.4', focal: '50mm', aperture: 'f/1.4' },
];

/** 同步范围的「可读」名称：写进 footer、确认按钮与事后反馈，避免只显示数字。 */
const SCOPE_LABELS: Record<'current' | 'filtered' | 'all', string> = {
  current: '仅当前照片',
  filtered: '当前筛选集',
  all: '全部扫描照片',
};

export const MetadataEditorModal: React.FC<MetadataEditorModalProps> = ({
  isOpen,
  onClose,
  currentGroup,
  filteredGroups,
  allGroups,
  onMetadataUpdated,
  onError,
}) => {
  const [lensModel, setLensModel] = useState('');
  const [focalLength, setFocalLength] = useState('');
  const [aperture, setAperture] = useState('');
  // 默认只作用于「当前照片」：批量写入必须由用户显式扩大范围，
  // 否则一次误点会把当前照片的镜头信息覆盖到整个已扫描目录（H-03）。
  const [syncScope, setSyncScope] = useState<'current' | 'filtered' | 'all'>('current');
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const lensId = useId();
  const focalId = useId();
  const apertureId = useId();

  // Initialize values from current group when opened
  useEffect(() => {
    if (isOpen && currentGroup) {
      setLensModel(currentGroup.exif?.lensModel || '');
      setFocalLength(currentGroup.exif?.focalLength || '');
      setAperture(currentGroup.exif?.aperture || '');
      setSaveResult(null);
    }
  }, [isOpen, currentGroup]);

  const targetGroups =
    syncScope === 'current'
      ? currentGroup
        ? [currentGroup]
        : []
      : syncScope === 'filtered'
      ? filteredGroups
      : allGroups;

  const scopeLabel = SCOPE_LABELS[syncScope];

  const handleApplyPreset = (preset: {
    name: string;
    focal: string;
    aperture: string;
  }) => {
    setLensModel(preset.name);
    setFocalLength(preset.focal);
    setAperture(preset.aperture);
  };

  /** 真正落盘的写操作。只在「1 张」或「二次确认通过」后调用。 */
  const performSave = async () => {
    setIsSaving(true);
    setSaveResult(null);

    try {
      // Gather all file paths (prefer RAW, then JPG)
      const filePaths = targetGroups
        .map((g) => g.raw?.path || g.jpg?.path)
        .filter((p): p is string => Boolean(p));

      const updatedCount = await api.batchUpdateMetadata(
        filePaths,
        lensModel.trim() || undefined,
        focalLength.trim() || undefined,
        aperture.trim() || undefined,
      );

      // Update in parent memory
      const targetIds = targetGroups.map((g) => g.id);
      onMetadataUpdated(targetIds, lensModel.trim(), focalLength.trim(), aperture.trim());

      setSaveResult(`已写入「${scopeLabel}」的 ${updatedCount} 张照片的 XMP 侧边栏。`);
    } catch (err) {
      onError?.(`同步元数据失败：${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = () => {
    if (targetGroups.length === 0) {
      onError?.('没有可更新的目标照片，请先扫描文件夹。');
      return;
    }
    if (!lensModel.trim() && !focalLength.trim() && !aperture.trim()) {
      onError?.('请至少填写一项镜头信息：镜头型号、焦段或光圈值。');
      return;
    }

    // 只有单张才允许直接写盘；批量范围必须经二次确认，堵住「打开即误点」。
    if (targetGroups.length === 1) {
      void performSave();
      return;
    }
    setIsConfirmOpen(true);
  };

  return (
    <>
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="镜头元数据批量编辑"
      maxWidth="max-w-lg"
      // D6：写盘进行中禁用 X / Esc，避免误关后失去写入反馈。
      disableClose={isSaving}
      icon={<Sliders className="w-4 h-4" aria-hidden="true" />}
      footer={
        <>
          <span className="mr-auto text-white/70 text-[11px]">
            将更新 <strong className="text-white">「{scopeLabel}」</strong> 的{' '}
            <strong className="text-white font-mono tabular-nums">
              {targetGroups.length}
            </strong>{' '}
            张照片
          </span>
          <button
            onClick={onClose}
            disabled={isSaving}
            className="focus-ring px-4 py-2 text-xs font-medium text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/10 disabled:hover:text-white/80"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || targetGroups.length === 0}
            className="focus-ring px-5 py-2 text-xs font-medium bg-white hover:bg-white/90 text-black active:scale-95 disabled:opacity-50 disabled:pointer-events-none rounded-lg transition-transform shadow-md"
          >
            {/* D7：批量写 XMP 可能上千张，至少给出待写张数。 */}
            {isSaving
              ? `正在写入 ${targetGroups.length} 张…`
              : `确认并同步「${scopeLabel}」`}
          </button>
        </>
      }
    >
      {/* Quick presets */}
      <div>
        <span
          className="block text-white/80 font-medium mb-1.5 flex items-center gap-1.5"
          id="common-manual-lenses-label"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
          <span>常用手动镜头快捷预设</span>
        </span>
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-labelledby="common-manual-lenses-label"
        >
          {COMMON_MANUAL_LENSES.map((preset) => (
            <button
              key={preset.name}
              type="button"
              onClick={() => handleApplyPreset(preset)}
              className="focus-ring px-2.5 py-1 bg-background-surface-hover hover:bg-white/10 border border-white/15 text-white/80 hover:text-white rounded-md text-[11px] transition-colors text-left"
              aria-label={`套用预设 ${preset.name}，${preset.focal}，${preset.aperture}`}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      {/* Form fields */}
      <fieldset className="space-y-3.5 bg-background-header p-4 rounded-xl border border-border-default">
        <legend className="sr-only">镜头元数据</legend>
        <div>
          <label htmlFor={lensId} className="block text-white/80 font-medium mb-1">
            镜头型号
          </label>
          <input
            id={lensId}
            type="text"
            value={lensModel}
            onChange={(e) => setLensModel(e.target.value)}
            placeholder="例如: Voigtlander APO-LANTHAR 50mm F2"
            className="focus-ring w-full bg-background-input border border-white/15 rounded-lg px-3 py-2 text-white font-mono placeholder-gray-500 focus:border-white/40 text-xs"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor={focalId}
              className="block text-white/80 font-medium mb-1"
            >
              焦段 / 焦距
            </label>
            <input
              id={focalId}
              type="text"
              inputMode="text"
              value={focalLength}
              onChange={(e) => setFocalLength(e.target.value)}
              placeholder="例如: 50mm 或 35mm"
              className="focus-ring w-full bg-background-input border border-white/15 rounded-lg px-3 py-2 text-white font-mono placeholder-gray-500 focus:border-white/40 text-xs"
            />
          </div>
          <div>
            <label
              htmlFor={apertureId}
              className="block text-white/80 font-medium mb-1"
            >
              光圈值
            </label>
            <input
              id={apertureId}
              type="text"
              inputMode="text"
              value={aperture}
              onChange={(e) => setAperture(e.target.value)}
              placeholder="例如: f/2.0 或 f/1.4"
              className="focus-ring w-full bg-background-input border border-white/15 rounded-lg px-3 py-2 text-white font-mono placeholder-gray-500 focus:border-white/40 text-xs"
            />
          </div>
        </div>
      </fieldset>

      {/* Sync Scope Selection */}
      <fieldset>
        <legend className="block text-white/80 font-medium mb-2">
          批量同步目标范围
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {(
            [
              {
                value: 'current' as const,
                label: '仅当前选中照片',
                count: currentGroup ? 1 : 0,
              },
              {
                value: 'filtered' as const,
                label: '当前筛选集',
                count: filteredGroups.length,
              },
              {
                value: 'all' as const,
                label: '全部扫描照片',
                count: allGroups.length,
                hint: '含未被筛选显示的照片',
              },
            ] satisfies Array<{
              value: 'current' | 'filtered' | 'all';
              label: string;
              count: number;
              hint?: string;
            }>
          ).map((option) => {
            const checked = syncScope === option.value;
            return (
              <label
                key={option.value}
                className={`focus-ring flex flex-col items-center justify-center gap-1 p-2.5 rounded-xl border text-center cursor-pointer transition-colors ${
                  checked
                    ? 'border-white/60 bg-white/15 text-white font-medium'
                    : 'border-default bg-background-surface-hover text-white/70 hover:text-white hover:bg-white/10'
                }`}
              >
                <input
                  type="radio"
                  name="metadata-sync-scope"
                  value={option.value}
                  checked={checked}
                  onChange={() => setSyncScope(option.value)}
                  className="sr-only"
                />
                <span>{option.label}</span>
                <span className="text-[10px] text-white/60 font-mono tabular-nums">
                  ({option.count} 张)
                </span>
                {option.hint && (
                  <span className="text-[10px] text-amber-300/80 leading-tight">
                    {option.hint}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Info note */}
      <div className="p-3 bg-blue-950/30 border border-blue-800/40 rounded-xl text-blue-100 text-[11px] leading-relaxed">
        💡 保存后将自动为所选照片写入符合 Adobe 标准的 aux:Lens 和 exif:FocalLength
        侧边栏，保留现有星标与标记，导入 Lightroom Classic 或 Photoshop ACR
        即刻识别。
      </div>

      {/* Success Message */}
      {saveResult && (
        <div
          className="flex items-center gap-2 text-emerald-300 bg-emerald-950/40 border border-emerald-800/50 p-3 rounded-xl"
          role="status"
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="text-xs">{saveResult}</span>
        </div>
      )}
    </Modal>

    {/* 批量范围二次确认：只有单张才允许直接写盘。作为兄弟节点渲染，
        避免嵌进上一层的 dialog 面板（焦点陷阱 / Escape 语义互相污染）。 */}
    <ConfirmDialog
      isOpen={isConfirmOpen}
      onClose={() => setIsConfirmOpen(false)}
      onConfirm={() => {
        void performSave();
      }}
      destructive
      icon={<Sliders className="w-4 h-4" aria-hidden="true" />}
      title={`将覆盖 ${targetGroups.length} 张照片的镜头信息`}
      message={`这会重写 ${targetGroups.length} 个 XMP 侧边栏里的镜头型号 / 焦段 / 光圈，且无法撤销。建议改用「仅当前照片」或「当前筛选集」缩小范围。`}
      confirmLabel={`仍然覆盖 ${targetGroups.length} 张`}
      cancelLabel="返回"
    />
    </>
  );
};
