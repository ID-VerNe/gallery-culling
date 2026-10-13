import React from 'react';
import { Aperture, FolderOpen, RefreshCw, Settings } from 'lucide-react';

/**
 * Row 1 — 照片从哪来 + 系统入口。
 *
 * 与 `ToolbarRow` 的边界是语义性的而非任意的：本行只回答"扫哪里"，
 * 另一行只回答"看什么 / 做什么"。两者之间不共享任何局部变量。
 *
 * 注意：扫描按钮在本行，**不在** ToolbarRow —— 旧计划文档把扫描按钮
 * 记在 ToolbarRow 是错的，会把 UX-14（扫描进度文案）的接线落到错误的一行。
 */
export interface SourceRowProps {
  jpgFolder: string;
  rawFolder: string;
  onJpgFolderChange: (val: string) => void;
  onRawFolderChange: (val: string) => void;
  onBrowseJpg: () => void;
  onBrowseRaw: () => void;
  onScan: () => void;
  isLoading: boolean;
  /** UX-14：扫描进度。缺省时按钮只显示「扫描中…」，有值时显示「已发现 N 张」。 */
  scanProgress?: { processed: number; total: number };
  /** UX-15：扫描失败的错误文案。缺省表示没有失败。 */
  scanError?: string | null;
  onDismissScanError?: () => void;
  onOpenSettingsModal: () => void;
}

/** 一个「标签 + 路径输入 + 浏览按钮」的文件夹选择器。 */
const FolderInput: React.FC<{
  id: string;
  label: string;
  value: string;
  placeholder: string;
  ariaLabel: string;
  browseTitle: string;
  browseAriaLabel: string;
  onChange: (val: string) => void;
  onBrowse: () => void;
}> = ({
  id,
  label,
  value,
  placeholder,
  ariaLabel,
  browseTitle,
  browseAriaLabel,
  onChange,
  onBrowse,
}) => (
  <div className="flex items-center gap-1.5 flex-1 min-w-0 bg-background-surface-hover rounded-md px-2.5 py-1 focus-within:bg-white/10 transition-colors">
    <label htmlFor={id} className="text-white/60 font-semibold whitespace-nowrap cursor-pointer">
      {label}
    </label>
    <input
      id={id}
      type="text"
      className="bg-transparent border-none outline-none text-white w-full min-w-0 font-mono text-[11px]"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
    <button
      onClick={onBrowse}
      className="focus-ring text-white/60 hover:text-white p-1 rounded hover:bg-white/10 active:scale-[0.96] transition-transform shrink-0"
      title={browseTitle}
      aria-label={browseAriaLabel}
    >
      <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
    </button>
  </div>
);

export const SourceRow: React.FC<SourceRowProps> = ({
  jpgFolder,
  rawFolder,
  onJpgFolderChange,
  onRawFolderChange,
  onBrowseJpg,
  onBrowseRaw,
  onScan,
  isLoading,
  scanProgress,
  scanError,
  onDismissScanError,
  onOpenSettingsModal,
}) => {
  // UX-15：失败态优先于一切 —— 禁用扫描按钮并把原因说清楚，
  // 否则用户只看到按钮转圈结束却不知道出了什么事。
  const hasError = !!scanError;
  const scanned = scanProgress ? scanProgress.processed : 0;
  const total = scanProgress ? scanProgress.total : 0;

  return (
    <div className="flex items-center gap-2 min-w-0">
      {/* 应用标识（A11）：截图 / 切窗时能一眼答出"这是什么应用"。
          图标常显，应用名在窄窗口下让位给路径输入框。 */}
      <div
        role="img"
        aria-label="Gallery Culling — 摄影选片工具"
        className="flex items-center gap-1.5 pl-1 pr-0.5 shrink-0 select-none"
        title="Gallery Culling — 摄影选片工具"
      >
        <Aperture className="w-4 h-4 text-white/80" aria-hidden="true" />
        <span className="text-[11px] font-semibold text-white/90 whitespace-nowrap hidden xl:inline">
          Gallery Culling
        </span>
      </div>

      <FolderInput
        id="topbar-jpg-input"
        label="JPG:"
        value={jpgFolder}
        placeholder="选择或输入 JPG 文件夹路径…"
        ariaLabel="JPG 照片文件夹路径"
        browseTitle="浏览 JPG 文件夹"
        browseAriaLabel="浏览选择 JPG 文件夹"
        onChange={onJpgFolderChange}
        onBrowse={onBrowseJpg}
      />

      <FolderInput
        id="topbar-raw-input"
        label="RAW:"
        value={rawFolder}
        placeholder="可选：RAW 文件夹路径…"
        ariaLabel="RAW 原片文件夹路径（可选）"
        browseTitle="浏览 RAW 文件夹"
        browseAriaLabel="浏览选择 RAW 文件夹"
        onChange={onRawFolderChange}
        onBrowse={onBrowseRaw}
      />

      {/* Scan / Refresh */}
      <button
        onClick={onScan}
        disabled={isLoading || hasError || !jpgFolder.trim()}
        className="focus-ring flex items-center gap-1.5 px-3.5 py-1 bg-white hover:bg-white/90 text-black active:scale-[0.96] disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium transition-transform shadow-sm shrink-0 whitespace-nowrap"
        aria-label={isLoading ? '正在扫描照片目录' : '扫描照片目录'}
        aria-live="polite"
        title={
          hasError
            ? scanError!
            : isLoading
              ? '正在扫描照片目录…'
              : !jpgFolder.trim()
                ? '请先选择或输入 JPG 文件夹'
                : '扫描照片目录'
        }
      >
        <RefreshCw
          className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`}
          aria-hidden="true"
        />
        {/* UX-14：扫描中给出实时的「已发现 N 张」，而不是一个不动的转圈。 */}
        <span className="pb-[1px]">
          {isLoading
            ? total > 0
              ? `已发现 ${scanned} 张…`
              : '扫描中…'
            : '扫描照片'}
        </span>
      </button>

      {/* UX-15：失败原因用 role=alert 说出来，并给出关闭入口（否则用户只能靠猜）。 */}
      {hasError && (
        <div
          role="alert"
          data-testid="topbar-scan-error"
          className="flex items-center gap-1.5 text-[11px] text-red-300 min-w-0 truncate"
        >
          <span className="truncate" title={scanError!}>
            {scanError}
          </span>
          {onDismissScanError && (
            <button
              onClick={onDismissScanError}
              className="focus-ring text-red-300/70 hover:text-red-200 shrink-0 underline"
              title="忽略此错误"
              aria-label="忽略扫描错误"
            >
              忽略
            </button>
          )}
        </div>
      )}

      <div className="ml-auto" />

      {/* Settings */}
      <button
        onClick={onOpenSettingsModal}
        className="focus-ring p-1.5 text-white/60 hover:text-white hover:bg-background-surface-hover rounded-md active:scale-[0.96] transition-transform shrink-0"
        title="设置"
        aria-label="设置"
      >
        <Settings className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
};