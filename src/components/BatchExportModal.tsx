import React, { useState, useEffect } from 'react';
import { FolderOpen, Download, CheckCircle2 } from 'lucide-react';
import { ExportItem, PhotoGroupInfo } from '../types';
import { api } from '../services/api';
import { Modal } from './Modal';

interface BatchExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  groups: PhotoGroupInfo[];
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

const FILTERS = [
  {
    value: 'pick_or_rated' as const,
    label: '已保留或已打星',
    test: (g: PhotoGroupInfo) =>
      g.flag !== 'reject' && (g.flag === 'pick' || g.rating > 0),
  },
  {
    value: 'pick_only' as const,
    label: '仅标记保留 Pick',
    test: (g: PhotoGroupInfo) => g.flag === 'pick',
  },
  {
    value: 'star3_plus' as const,
    label: '★ 3 星以上',
    test: (g: PhotoGroupInfo) => g.rating >= 3,
  },
  {
    value: 'all' as const,
    label: '全部非淘汰照片',
    test: (g: PhotoGroupInfo) => g.flag !== 'reject',
  },
];

export const BatchExportModal: React.FC<BatchExportModalProps> = ({
  isOpen,
  onClose,
  groups,
  onError,
  onSuccess,
}) => {
  const [targetFolder, setTargetFolder] = useState('');
  const [includeRaw, setIncludeRaw] = useState(true);
  const [includeJpg, setIncludeJpg] = useState(true);
  const [exportFilter, setExportFilter] =
    useState<(typeof FILTERS)[number]['value']>('pick_or_rated');
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);

  // Reset per-open state so a second export does not inherit the last result,
  // and clear the confirmation as soon as the user changes any input.
  useEffect(() => {
    if (isOpen) setExportResult(null);
  }, [isOpen]);

  useEffect(() => {
    setExportResult(null);
  }, [targetFolder, exportFilter, includeRaw, includeJpg]);

  const activeFilter =
    FILTERS.find((f) => f.value === exportFilter) ?? FILTERS[0];
  const exportCandidates = groups.filter(activeFilter.test);

  const handleBrowseTarget = async () => {
    const selected = await api.selectFolderDialog(targetFolder);
    if (selected) setTargetFolder(selected);
  };

  const handleExport = async () => {
    if (!targetFolder.trim()) {
      onError?.('请先选择导出目标文件夹。');
      return;
    }
    if (exportCandidates.length === 0) {
      onError?.('当前导出范围内没有照片，请先给照片打星或标记保留。');
      return;
    }
    if (!includeRaw && !includeJpg) {
      onError?.('请至少勾选一种要复制的文件类型。');
      return;
    }

    setIsExporting(true);
    setExportResult(null);

    const items: ExportItem[] = exportCandidates.map((g) => ({
      baseName: g.baseName,
      jpgPath: g.jpg?.path,
      rawPath: g.raw?.path,
    }));

    try {
      const count = await api.batchExport(
        items,
        targetFolder,
        includeRaw,
        includeJpg,
      );
      const message = `已导出 ${count} 个文件至 ${targetFolder}`;
      setExportResult(`成功导出 ${count} 个文件至目标文件夹。`);
      onSuccess?.(message);
    } catch (err) {
      onError?.(`导出出错：${String(err)}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="批量挑选导出 (Culling Export)"
      maxWidth="max-w-lg"
      icon={<Download className="w-4 h-4" aria-hidden="true" />}
      footer={
        <>
          <span className="mr-auto text-white/70 text-[11px]">
            预计导出:{' '}
            <b className="text-white font-mono tabular-nums">
              {exportCandidates.length}
            </b>{' '}
            组照片
          </span>
          <button
            onClick={onClose}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 active:scale-[0.96] text-white/80 transition-colors"
          >
            关闭
          </button>
          <button
            onClick={handleExport}
            disabled={
              isExporting ||
              exportCandidates.length === 0 ||
              !targetFolder.trim() ||
              (!includeRaw && !includeJpg)
            }
            className="focus-ring flex items-center gap-1.5 px-3.5 py-1.5 bg-white hover:bg-white/90 text-black active:scale-[0.96] disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium transition-transform shadow-sm"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{isExporting ? '导出中…' : '开始导出'}</span>
          </button>
        </>
      }
    >
      {/* Target Folder */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="export-target-folder"
          className="text-white/80 font-medium cursor-pointer"
        >
          目标导出目录
        </label>
        <div className="flex items-center gap-2">
          <input
            id="export-target-folder"
            type="text"
            value={targetFolder}
            onChange={(e) => setTargetFolder(e.target.value)}
            placeholder="请选择或粘贴保存挑选照片的文件夹…"
            className="focus-ring flex-1 min-w-0 bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-[11px] focus:border-white/40"
          />
          <button
            onClick={handleBrowseTarget}
            className="focus-ring px-3.5 py-1.5 bg-white/5 hover:bg-white/10 active:scale-[0.96] text-white rounded-md flex items-center gap-1.5 transition-colors shrink-0"
          >
            <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
            <span>浏览</span>
          </button>
        </div>
      </div>

      {/* Filter Range */}
      <fieldset>
        <legend className="text-white/80 font-medium mb-1.5">导出范围</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-background-base p-2.5 rounded border border-white/10">
          {FILTERS.map((filter) => {
            const count = groups.filter(filter.test).length;
            return (
              <label
                key={filter.value}
                className="focus-ring flex items-center gap-2 cursor-pointer rounded p-1 hover:bg-white/5 transition-colors"
              >
                <input
                  type="radio"
                  name="export_filter"
                  value={filter.value}
                  checked={exportFilter === filter.value}
                  onChange={() => setExportFilter(filter.value)}
                  className="accent-white"
                />
                <span className="text-white/80">
                  {filter.label}{' '}
                  <span className="text-white/60 font-mono tabular-nums">
                    ({count})
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Options */}
      <fieldset>
        <legend className="text-white/80 font-medium mb-1.5">
          包含文件类型
        </legend>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-background-base p-2.5 rounded border border-white/10">
          <label className="focus-ring flex items-center gap-2 cursor-pointer rounded p-1 hover:bg-white/5 transition-colors">
            <input
              type="checkbox"
              checked={includeRaw}
              onChange={(e) => setIncludeRaw(e.target.checked)}
              className="accent-white"
            />
            <span className="text-white/80">复制 RAW 原片及 XMP 侧边栏</span>
          </label>

          <label className="focus-ring flex items-center gap-2 cursor-pointer rounded p-1 hover:bg-white/5 transition-colors">
            <input
              type="checkbox"
              checked={includeJpg}
              onChange={(e) => setIncludeJpg(e.target.checked)}
              className="accent-white"
            />
            <span className="text-white/80">复制对应 JPG 预览</span>
          </label>
        </div>
      </fieldset>

      {/* Success Message */}
      {exportResult && (
        <div
          className="p-3 bg-emerald-950/40 border border-emerald-800/50 rounded flex items-center gap-2 text-emerald-300 select-text"
          role="status"
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{exportResult}</span>
        </div>
      )}
    </Modal>
  );
};
