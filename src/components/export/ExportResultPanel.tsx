/**
 * 导出结果条 —— **纯呈现**。
 *
 * 文案由 `exportMessages.buildOutcomeMessage` 产出，这里只决定用哪种视觉：
 *  - `failed` → 琥珀色 + AlertTriangle + `role="alert"`（打断式，必须立即知晓）
 *  - 否则 → 绿色 + CheckCircle2 + `role="status"`（温和播报）
 *
 * 为什么两种角色必须分开：读屏对 `alert` 是断言式播报、对 `status` 是礼貌播报。
 * 部分失败被当成 status 念出来，是数据安全层面的失误，不是样式偏好。
 */
import React from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';

export interface ExportResultView {
  message: string;
  failed: boolean;
}

interface ExportResultPanelProps {
  /** `null` 表示还没有结果（或输入已变更、上次结果作废）。 */
  result: ExportResultView | null;
}

export const ExportResultPanel: React.FC<ExportResultPanelProps> = ({ result }) => {
  if (!result) return null;

  if (result.failed) {
    return (
      <div
        className="p-3 bg-amber-950/40 border border-amber-800/50 rounded flex items-start gap-2 text-amber-200 select-text"
        role="alert"
      >
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{result.message}</span>
      </div>
    );
  }

  return (
    <div
      className="p-3 bg-emerald-950/40 border border-emerald-800/50 rounded flex items-center gap-2 text-emerald-300 select-text"
      role="status"
    >
      <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{result.message}</span>
    </div>
  );
};
