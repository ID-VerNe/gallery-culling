import React, { useId } from 'react';
import { FolderOpen, Download } from 'lucide-react';
import { ExportItem, FilterMode, PhotoGroupInfo } from '../types';
import { api } from '../services/api';
import { Modal } from './Modal';
import { TaskProgressBar } from './TaskProgressBar';
import { useExportForm } from '../hooks/useExportForm';
import { useExportRun } from '../hooks/useExportRun';
import { CopyOptions } from './export/CopyOptions';
import { RenderOptions } from './export/RenderOptions';
import { OverwriteToggle } from './export/OverwriteToggle';
import { ExportModeSelector } from './export/ExportModeSelector';
import { LumenGateNotice, type LumenGateStatus } from './export/LumenGateNotice';
import { ExportResultPanel } from './export/ExportResultPanel';
import { EXPORT_FILTERS } from './export/exportFilters';
import { EXPORT_MODES } from './export/exportConfig';
import type { QueryParseResult } from '../utils/queryMatch';

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
  /**
   * 宫格当前的 chips 档位与查询解析结果。
   * 供「当前筛选结果」这一档复用宫格的谓词（报告 §5.5 第 5 点）。
   */
  filterMode?: FilterMode;
  queryParse?: QueryParseResult;
}

/**
 * 导出弹窗的**容器**。
 *
 * 职责只有三件：分区顺序、Modal 壳、footer 组装。
 * 表单状态归 `useExportForm`，执行与结果归 `useExportRun`，文案归 `exportMessages`，
 * 呈现归 `export/*` 组件。这里出现第二处 `if (mode === ...)` 就说明逻辑漏了。
 *
 * **成功不弹 Toast**：结果条就在本弹窗里、与用户视线同一屏，再弹一条同义句是
 * 纯噪音。只有失败才走 `onError` —— 它是唯一能在用户关掉弹窗后仍然留存的提示。
 */
export const BatchExportModal: React.FC<BatchExportModalProps> = ({
  isOpen,
  onClose,
  groups,
  lumenStatus = 'available',
  lumenDetail,
  onOpenSettings,
  onError,
  filterMode,
  queryParse,
}) => {
  /** D8：把错误文案与输入框关联，读屏聚焦输入时也能读到。 */
  const folderErrorId = useId();
  /** 阻断原因的常驻展示位（footer 左侧）。 */
  const validationId = useId();

  // 探测中按「可用」放行（乐观）：用户此刻多半还在填目录，真不可用时后端会逐项计入 failed。
  const lumenAvailable = lumenStatus !== 'unavailable';
  const form = useExportForm({ groups, lumenAvailable, lumenDetail, filterMode, queryParse });
  const run = useExportRun({
    mode: form.mode,
    resetSignal: form.resetSignal,
    onError,
  });

  const isExporting = run.isRunning;
  const spec = EXPORT_MODES[form.mode];
  /** 复制模式下「组」与「文件」不是一回事，只有真的不等时才补一句，避免噪音。 */
  const showFileCount =
    form.mode === 'copy' && form.expectedFileCount !== form.candidates.length;

  const handleExport = async () => {
    // 按钮在 validation 非空时就是 disabled，正常路径走不到这里。
    // 保留这道闸是因为 `run` 一旦发出就是一次真实写盘 —— 宁可多挡一次。
    if (form.validation) return;

    const items: ExportItem[] = form.candidates.map((g) => ({
      baseName: g.baseName,
      jpgPath: g.jpg?.path,
      rawPath: g.raw?.path,
    }));

    // 全组件唯一的模式分叉：调不同的命令，产出同一种 outcome。
    // 之后的进度、取消、结果文案全部共用。
    await run.run({
      invoke:
        form.mode === 'copy'
          ? () =>
              api.batchExport(
                items,
                form.targetFolder,
                form.includeRaw,
                form.includeJpg,
                form.overwrite,
              )
          : () =>
              api.batchRenderExport(
                items,
                form.targetFolder,
                form.renderFormat,
                form.renderLongEdge,
                form.quality,
                form.overwrite,
              ),
      targetFolder: form.targetFolder,
    });
  };

  /**
   * 打开结果目录。
   *
   * 传的是**结果里记录的那个目录**（`run.result.folder`），不是表单当前值 ——
   * 用户可能在导出完成后改了输入框，那时该打开的是真的产生了文件的那个。
   */
  const handleOpenFolder = async (folder: string) => {
    try {
      await api.openFolder(folder);
    } catch (e) {
      onError?.(`无法打开导出目录：${String(e)}`);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="批量挑选导出"
      // E-04：范围档作用于**全部已扫描照片**，与左侧筛选/多选无关。
      // 不说清楚，用户会以为「我筛出来的那几张」就是导出范围。
      subtitle="导出范围基于全部已扫描照片，不受左侧筛选与多选影响"
      maxWidth="max-w-lg"
      // D2：导出进行中拦截关闭路径（X / Esc），配合下方禁用的「关闭」按钮，
      // 避免用户误以为「关闭 = 取消导出」。
      disableClose={isExporting}
      icon={<Download className="w-4 h-4" aria-hidden="true" />}
      footer={
        <>
          {/*
            footer 左侧是**唯一的状态说明位**，按上下文切换：
            导出中 → 关闭语义；否则 → 预计量 + 阻断原因。

            阻断原因必须常驻可见：主按钮在 `validation` 非空时就是 disabled，
            而 disabled 按钮不可聚焦，任何挂在它身上的说明（title /
            aria-describedby）键盘与读屏都拿不到。唯一可靠的办法是画在屏幕上。
          */}
          <div className="mr-auto min-w-0 flex flex-col gap-0.5 text-[11px] leading-tight">
            {isExporting ? (
              <span className="text-white/70">导出进行中，关闭不会停止导出</span>
            ) : (
              <>
                <span className="text-white/70">
                  {spec.estimateVerb}:{' '}
                  <b className="text-white font-mono tabular-nums">
                    {form.candidates.length}
                  </b>{' '}
                  {spec.estimateUnit}
                  {showFileCount && (
                    <span className="text-white/50">
                      （共{' '}
                      <b className="font-mono tabular-nums">{form.expectedFileCount}</b>{' '}
                      个文件）
                    </span>
                  )}
                </span>
                {form.validation && (
                  <span id={validationId} className="text-amber-200/90">
                    {form.validation}
                  </span>
                )}
              </>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={isExporting}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-background-surface-hover"
          >
            关闭
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting || !form.canRun}
            aria-describedby={form.validation ? validationId : undefined}
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
            title={form.targetFolder || undefined}
            aria-describedby={form.targetIsSourceDir ? folderErrorId : undefined}
            aria-invalid={form.targetIsSourceDir || undefined}
            className="focus-ring flex-1 min-w-0 bg-background-base border border-border-default rounded-md px-3 py-1.5 text-white outline-none font-mono text-xs focus:border-white/40 disabled:opacity-50 disabled:cursor-not-allowed"
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
            qualityNotice={form.qualityNotice}
            jpgOnlyCount={form.jpgOnlyCount}
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

      {/* 5. 覆盖策略：两种模式共用的修饰项 */}
      <OverwriteToggle
        checked={form.overwrite}
        onChange={form.setOverwrite}
        disabled={isExporting}
      />

      {/* 6. 进度 + 取消（M-05） */}
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

      {/* 7. 结果：成功走绿色 status，部分失败走琥珀色 alert（必须立即知晓） */}
      <ExportResultPanel result={run.result} onOpenFolder={handleOpenFolder} />
    </Modal>
  );
};
