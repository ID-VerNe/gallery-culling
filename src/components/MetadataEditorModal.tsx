import React, { useState, useEffect, useId } from 'react';
import { Sliders, CheckCircle2, Sparkles } from 'lucide-react';
import { PhotoGroupInfo } from '../types';
import { api } from '../services/api';
import { Modal } from './Modal';

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
  const [syncScope, setSyncScope] = useState<'current' | 'filtered' | 'all'>('all');
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);

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

  const handleApplyPreset = (preset: {
    name: string;
    focal: string;
    aperture: string;
  }) => {
    setLensModel(preset.name);
    setFocalLength(preset.focal);
    setAperture(preset.aperture);
  };

  const handleSave = async () => {
    if (targetGroups.length === 0) {
      onError?.('没有可更新的目标照片，请先扫描文件夹。');
      return;
    }
    if (
      !lensModel.trim() &&
      !focalLength.trim() &&
      !aperture.trim()
    ) {
      onError?.('请至少填写一项镜头信息：镜头型号、焦段或光圈值。');
      return;
    }

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

      setSaveResult(`已写入 ${updatedCount} 张照片的 XMP 侧边栏。`);
    } catch (err) {
      onError?.(`同步元数据失败：${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="手动镜头元数据编辑与批量同步"
      maxWidth="max-w-lg"
      icon={<Sliders className="w-4 h-4" aria-hidden="true" />}
      footer={
        <>
          <span className="mr-auto text-white/70 text-[11px]">
            将更新{' '}
            <strong className="text-white font-mono tabular-nums">
              {targetGroups.length}
            </strong>{' '}
            张照片
          </span>
          <button
            onClick={onClose}
            className="focus-ring px-4 py-2 text-xs font-medium text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || targetGroups.length === 0}
            className="focus-ring px-5 py-2 text-xs font-medium bg-white hover:bg-white/90 text-black active:scale-95 disabled:opacity-50 disabled:pointer-events-none rounded-lg transition-transform shadow-md"
          >
            {isSaving ? '正在写入 XMP…' : '确认并批量同步'}
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
              className="focus-ring px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/15 text-white/80 hover:text-white rounded-md text-[11px] transition-colors text-left"
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
            镜头型号 (Lens Model)
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
              焦段 / 焦距 (Focal Length)
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
              光圈值 (Aperture / F-Number)
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
              { value: 'all' as const, label: '全部扫描照片', count: allGroups.length },
            ] satisfies Array<{
              value: 'current' | 'filtered' | 'all';
              label: string;
              count: number;
            }>
          ).map((option) => {
            const checked = syncScope === option.value;
            return (
              <label
                key={option.value}
                className={`focus-ring flex flex-col items-center justify-center gap-1 p-2.5 rounded-xl border text-center cursor-pointer transition-colors ${
                  checked
                    ? 'border-white/60 bg-white/15 text-white font-medium'
                    : 'border-white/10 bg-white/5 text-white/70 hover:text-white hover:bg-white/10'
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
  );
};
