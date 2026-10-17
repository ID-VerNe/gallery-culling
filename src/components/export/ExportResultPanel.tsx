/**
 * 导出结果条 —— **纯呈现**。
 *
 * 文案由 `exportMessages.buildOutcomeMessage` 产出，这里只决定用哪种视觉：
 *  - `failed` → 琥珀色 + AlertTriangle + `role="alert"`（打断式，必须立即知晓）
 *  - 否则 → 绿色 + CheckCircle2 + `role="status"`（温和播报）
 *
 * 为什么两种角色必须分开：读屏对 `alert` 是断言式播报、对 `status` 是礼貌播报。
 * 部分失败被当成 status 念出来，是数据安全层面的失误，不是样式偏好。
 *
 * 两个出口：
 *  - `details` 展开全部失败原因（正文只放前 3 条，超出的不能没有下文）；
 *  - 「打开目录」——导出完成后的下一个动作几乎 100% 是去看文件，
 *    桌面上这是标准动作，不该让用户自己去地址栏拼路径。
 */
import React from 'react';
import { CheckCircle2, AlertTriangle, FolderOpen } from 'lucide-react';
import type { ExportFailure } from '../../types';
import { EXPORT_MANIFEST_NAME, FAILURE_DETAIL_LIMIT } from './exportMessages';

export interface ExportResultView {
  message: string;
  failed: boolean;
  /** 全量失败明细；正文只放前 3 条，这里给展开区用。 */
  failures: ExportFailure[];
  /** 本次实际写入的目录 —— 「打开目录」的目标。 */
  folder: string;
}

interface ExportResultPanelProps {
  /** `null` 表示还没有结果（或输入已变更、上次结果作废）。 */
  result: ExportResultView | null;
  /** 打开结果所在目录；不传则不渲染按钮。 */
  onOpenFolder?: (folder: string) => void;
}

/** 失败明细的展开区：只在正文被截断时出现（3 条以内正文已经说全）。 */
const FailureDetails: React.FC<{ failures: ExportFailure[] }> = ({ failures }) => {
  if (failures.length <= FAILURE_DETAIL_LIMIT) return null;
  return (
    <details className="group">
      <summary className="focus-ring cursor-pointer text-[11px] text-amber-200/90 hover:text-amber-100 select-none">
        查看全部 {failures.length} 条失败原因
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1 max-h-40 overflow-y-auto pr-1">
        {failures.map((f, i) => (
          <li
            key={`${i}-${f.path}`}
            className="text-[11px] font-mono break-all text-amber-200/80"
          >
            {f.path}（{f.reason}）
          </li>
        ))}
      </ul>
      {/* 清单是持久对账记录，含 skipped / cancelled，正文与展开区都不覆盖它 */}
      <p className="mt-1.5 text-[11px] text-amber-200/60">
        完整清单（含跳过与取消项）：目标目录下的 {EXPORT_MANIFEST_NAME}
      </p>
    </details>
  );
};

export const ExportResultPanel: React.FC<ExportResultPanelProps> = ({
  result,
  onOpenFolder,
}) => {
  if (!result) return null;

  const openButton = onOpenFolder ? (
    <button
      type="button"
      onClick={() => onOpenFolder(result.folder)}
      className="focus-ring shrink-0 self-center flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 hover:bg-white/15 active:scale-[0.96] text-white/80 transition-colors text-[11px]"
    >
      <FolderOpen className="w-3 h-3" aria-hidden="true" />
      <span>打开目录</span>
    </button>
  ) : null;

  if (result.failed) {
    return (
      <div
        className="p-3 bg-amber-950/40 border border-amber-800/50 rounded flex items-start gap-2 text-amber-200 select-text"
        role="alert"
      >
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <span>{result.message}</span>
          <FailureDetails failures={result.failures} />
        </div>
        {openButton}
      </div>
    );
  }

  return (
    <div
      className="p-3 bg-emerald-950/40 border border-emerald-800/50 rounded flex items-center gap-2 text-emerald-300 select-text"
      role="status"
    >
      <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-0">{result.message}</span>
      {openButton}
    </div>
  );
};
