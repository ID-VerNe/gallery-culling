import React, { useState, useEffect } from 'react';
import { FolderOpen, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
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

/**
 * 目标目录不能是源照片所在目录：`fs::copy(src, src)` 会截断原片（不可逆）。
 * 这是前端即时护栏；后端也会强制拒绝，前端只负责让用户当场看到并禁用按钮。
 * 归一化：统一分隔符、去掉尾部分隔符、统一小写（Windows 下大小写不敏感）。
 * 不追求与 Rust `canonicalize` 完全等价，但「同一目录」必须被判定为相同。
 */
const normalizeDir = (p: string): string =>
  p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

/** 取文件的父目录（同步归一化前的形态由调用方再 normalizeDir）。 */
const parentDirOf = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : normalized;
};

const TARGET_IS_SOURCE_MESSAGE =
  '导出目标不能是源照片所在目录，请另选一个目标文件夹';

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
  /** 导出结果提示；`failed` 决定用警示态还是成功态呈现。 */
  const [exportResult, setExportResult] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);

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

  // 源照片所在目录集合（从每个候选的 jpg/raw 父目录取；可能跨多个目录）。
  const sourceDirs = new Set<string>();
  for (const g of exportCandidates) {
    for (const p of [g.jpg?.path, g.raw?.path]) {
      if (p) sourceDirs.add(normalizeDir(parentDirOf(p)));
    }
  }
  // 命中「目标 = 源目录」即拦截：不能只靠后端报错。
  const targetIsSourceDir =
    targetFolder.trim() !== '' && sourceDirs.has(normalizeDir(targetFolder));

  const handleBrowseTarget = async () => {
    const selected = await api.selectFolderDialog(targetFolder);
    if (selected) setTargetFolder(selected);
  };

  const handleExport = async () => {
    if (!targetFolder.trim()) {
      onError?.('请先选择导出目标文件夹。');
      return;
    }
    if (targetIsSourceDir) {
      onError?.(TARGET_IS_SOURCE_MESSAGE);
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
      const outcome = await api.batchExport(
        items,
        targetFolder,
        includeRaw,
        includeJpg,
      );
      // 如实呈现三个计数：成功 / 跳过（目标已存在同名文件）/ 失败。
      // 部分失败绝不能走「成功」呈现 —— 导出是本轮最高危的数据写入路径。
      const failedCount = outcome.failed.length;
      const summaryParts: string[] = [];
      // 失败数放最前，让用户第一眼看到这次没完全成功。
      if (failedCount > 0) summaryParts.push(`失败 ${failedCount} 个`);
      summaryParts.push(`已导出 ${outcome.exported} 个`);
      if (outcome.skipped > 0) {
        summaryParts.push(`跳过 ${outcome.skipped} 个（目标已存在同名文件）`);
      }
      const summary = summaryParts.join(' · ');
      const failureDetail =
        failedCount > 0
          ? ` 失败原因：${outcome.failed
              .slice(0, 3)
              .map((f) => `${f.path}（${f.reason}）`)
              .join('；')}${failedCount > 3 ? ' 等' : ''}`
          : '';
      setExportResult({
        message: `${
          failedCount > 0 ? '导出未完全成功' : '导出完成'
        }：${summary}。${failureDetail}（目标：${targetFolder}）`,
        failed: failedCount > 0,
      });
      if (failedCount > 0) {
        // 不是全盘失败：措辞只否定「完全」二字，别让用户以为一张都没导出。
        onError?.(`导出未完全成功：失败 ${failedCount} 个，成功 ${outcome.exported} 个`);
      } else {
        onSuccess?.(`${summary}，目标：${targetFolder}`);
      }
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
              targetIsSourceDir ||
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
        {targetIsSourceDir && (
          <p role="alert" className="text-[11px] text-red-300/90">
            {TARGET_IS_SOURCE_MESSAGE}
          </p>
        )}
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

      {/* Result Message：成功走绿色 status，部分失败走琥珀色 alert（必须立即知晓） */}
      {exportResult &&
        (exportResult.failed ? (
          <div
            className="p-3 bg-amber-950/40 border border-amber-800/50 rounded flex items-start gap-2 text-amber-200 select-text"
            role="alert"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{exportResult.message}</span>
          </div>
        ) : (
          <div
            className="p-3 bg-emerald-950/40 border border-emerald-800/50 rounded flex items-center gap-2 text-emerald-300 select-text"
            role="status"
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{exportResult.message}</span>
          </div>
        ))}
    </Modal>
  );
};
