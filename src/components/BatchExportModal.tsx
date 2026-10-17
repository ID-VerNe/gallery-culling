import React, { useEffect, useId } from 'react';
import { FolderOpen, Download } from 'lucide-react';
import { ExportItem, PhotoGroupInfo } from '../types';
import { api } from '../services/api';
import { Modal } from './Modal';
import { TaskProgressBar } from './TaskProgressBar';
import { useExportForm } from '../hooks/useExportForm';
import { useExportRun } from '../hooks/useExportRun';
import { CopyOptions } from './export/CopyOptions';
import { RenderOptions } from './export/RenderOptions';
import { ExportModeSelector } from './export/ExportModeSelector';
import { LumenGateNotice, type LumenGateStatus } from './export/LumenGateNotice';
import { ExportResultPanel } from './export/ExportResultPanel';
import { EXPORT_FILTERS } from './export/exportFilters';
import { EXPORT_MODES } from './export/exportConfig';

interface BatchExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  groups: PhotoGroupInfo[];
  /**
   * LUMEN 引擎状态。默认 `available` 让本组件在未接入探测时保持既有行为
   * （复制路径完全不依赖引擎）。
   */
  lumenStatus?: LumenGateStatus;
  /** 引擎不可用的具体原因。 */
  lumenDetail?: string;
  /** 「去设置」入口。 */
  onOpenSettings?: () => void;
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

/**
 * 导出弹窗的**容器**。
 *
 * 职责只有三件：分区顺序、Modal 壳、footer 组装。
 * 表单状态归 `useExportForm`，执行与结果归 `useExportRun`，文案归 `exportMessages`，
 * 呈现归 `export/*` 组件。这里出现第二处 `if (mode === ...)` 就说明逻辑漏了。
 */
export const BatchExportModal: React.FC<BatchExportModalProps> = ({
  isOpen,
  onClose,
  groups,
  lumenStatus = 'available',
  lumenDetail,
  onOpenSettings,
  onError,
  onSuccess,
}) => {
  /** D8：把错误文案与输入框关联，读屏聚焦输入时也能读到。 */
  const folderErrorId = useId();

  // 探测中按「可用」放行（乐观）：用户此刻多半还在填目录，真不可用时后端会逐项计入 failed。
  const lumenAvailable = lumenStatus !== 'unavailable';
  const form = useExportForm({ groups, lumenAvailable, lumenDetail });
  const run = useExportRun({
    mode: form.mode,
    resetSignal: form.resetSignal,
    onSuccess,
    onError,
  });

  const isExporting = run.isRunning;
  const spec = EXPORT_MODES[form.mode];

  // 每次打开都清掉上次结果，避免「第二次导出看到第一次的句子」。
  useEffect(() => {
    if (isOpen) run.reset();
  }, [isOpen, run.reset]);

  const handleExport = async () => {
    // 按钮的 disabled 与这里的提示同源（`form.validation`），不会出现「能点但点了报错」。
    if (form.validation) {
      onError?.(form.validation);
      return;
    }

    const items: ExportItem[] = form.candidates.map((g) => ({
      baseName: g.baseName,
      jpgPath: g.jpg?.path,
      rawPath: g.raw?.path,
    }));

    // 全组件唯一的模式分叉：调不同的命令，产出同一种 outcome。
    // 之后的进度、取消、结果文案、Toast 分发全部共用。
    await run.run({
      invoke:
        form.mode === 'copy'
          ? () =>
              api.batchExport(
                items,
                form.targetFolder,
                form.includeRaw,
                form.includeJpg,
              )
          : () =>
              api.batchRenderExport(
                items,
                form.targetFolder,
                form.renderFormat,
                form.renderLongEdge,
                form.quality,
              ),
      targetFolder: form.targetFolder,
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="批量挑选导出"
      maxWidth="max-w-lg"
      // D2：导出进行中拦截关闭路径（X / Esc），配合下方禁用的「关闭」按钮，
      // 避免用户误以为「关闭 = 取消导出」。
      disableClose={isExporting}
      icon={<Download className="w-4 h-4" aria-hidden="true" />}
      footer={
        <>
          <span className="mr-auto text-white/70 text-[11px]">
            {spec.estimateVerb}:{' '}
            <b className="text-white font-mono tabular-nums">
              {form.candidates.length}
            </b>{' '}
            {spec.estimateUnit}
          </span>
          <button
            onClick={onClose}
            disabled={isExporting}
            title={
              isExporting
                ? '导出进行中：请等待完成或点击「取消」，关闭不会停止导出'
                : undefined
            }
            className="focus-ring px-3.5 py-1.5 rounded-md bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-background-surface-hover"
          >
            关闭
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting || !form.canRun}
            className="focus-ring flex items-center gap-1.5 px-3.5 py-1.5 bg-white hover:bg-white/90 text-black active:scale-[0.96] disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium transition-transform shadow-sm"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{isExporting ? spec.running : spec.action}</span>
          </button>
        </>
      }
    >
      {/* 1. 导出方式：最上层的决策，决定下面出现哪些选项 */}
      <ExportModeSelector
        value={form.mode}
        onChange={form.setMode}
        disabled={isExporting}
      />

      {/* 2. 目标目录 */}
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
            value={form.targetFolder}
            onChange={(e) => form.setTargetFolder(e.target.value)}
            disabled={isExporting}
            placeholder="请选择或粘贴保存挑选照片的文件夹…"
            aria-describedby={form.targetIsSourceDir ? folderErrorId : undefined}
            aria-invalid={form.targetIsSourceDir || undefined}
            className="focus-ring flex-1 min-w-0 bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-[11px] focus:border-white/40 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            onClick={form.browseTarget}
            disabled={isExporting}
            className="focus-ring px-3.5 py-1.5 bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white rounded-md flex items-center gap-1.5 transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
            <span>浏览</span>
          </button>
        </div>
        {form.targetIsSourceDir && (
          <p id={folderErrorId} role="alert" className="text-[11px] text-red-300/90">
            {form.validation}
          </p>
        )}
      </div>

      {/* 3. 导出范围 */}
      <fieldset>
        <legend className="text-white/80 font-medium mb-1.5">导出范围</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-background-base p-2.5 rounded border border-default">
          {EXPORT_FILTERS.map((filter) => (
            <label
              key={filter.value}
              htmlFor={`export-filter-${filter.value}`}
              className="focus-ring flex items-center gap-2 cursor-pointer rounded p-1 hover:bg-background-surface-hover transition-colors"
            >
              <input
                id={`export-filter-${filter.value}`}
                type="radio"
                name="export_filter"
                value={filter.value}
                checked={form.filter === filter.value}
                onChange={() => form.setFilter(filter.value)}
                disabled={isExporting}
                className="accent-white"
              />
              <span className="text-white/80">
                {filter.label}{' '}
                <span className="text-white/60 font-mono tabular-nums">
                  ({form.countsByFilter[filter.value]})
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* 4. 模式专属选项：同一位置互换，用户不会看到两套并存 */}
      {form.mode === 'copy' ? (
        <CopyOptions
          includeRaw={form.includeRaw}
          includeJpg={form.includeJpg}
          onChangeRaw={form.setIncludeRaw}
          onChangeJpg={form.setIncludeJpg}
          disabled={isExporting}
        />
      ) : (
        <>
          <RenderOptions
            format={form.renderFormat}
            longEdge={form.renderLongEdge}
            qualityText={form.qualityText}
            onChangeFormat={form.setRenderFormat}
            onChangeLongEdge={form.setRenderLongEdge}
            onChangeQuality={form.setQualityText}
            onCommitQuality={form.commitQuality}
            disabled={isExporting}
          />
          {/* 引擎状态只在成片模式有意义；复制路径完全不依赖它 */}
          <LumenGateNotice
            status={lumenStatus}
            detail={lumenDetail}
            onOpenSettings={onOpenSettings}
            disabled={isExporting}
          />
        </>
      )}

      {/* 5. 进度 + 取消（M-05） */}
      <TaskProgressBar
        isRunning={isExporting}
        processed={run.progress?.processed ?? 0}
        total={run.progress?.total ?? 0}
        label={spec.progressLabel}
        current={run.progress?.current}
        onCancel={run.cancel}
        cancelRequested={run.cancelRequested}
        className="bg-background-base border border-default rounded p-2.5"
      />

      {/* 6. 结果：成功走绿色 status，部分失败走琥珀色 alert（必须立即知晓） */}
      <ExportResultPanel result={run.result} />
    </Modal>
  );
};
