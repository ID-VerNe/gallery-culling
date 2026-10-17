/**
 * LUMEN 引擎的三态提示 —— **纯呈现**，只读 props。
 *
 * 它不判断引擎可用性（那是 `useLumenStatus` 的职责），也不决定能否导出
 * （那是 `useExportForm().canRun` 的职责）。它只把状态翻译成一句话。
 *
 * 角色选择（不会与结果条打架）：
 *  - `unavailable` → `role="alert"`：此时成片按钮必然禁用、零 invoke，
 *    结果条不可能出现，所以这个 alert 是页面上唯一的断言式播报；
 *  - `probing` → `role="status"`：温和播报，且它只挂在成片模式下，
 *    复制模式根本不渲染，不会污染复制模式「成功态必须是 status」的判定。
 *
 * 刻意**不声明** `aria-live`：进度条用 `aria-live="polite"` 播报「已处理 N / M」，
 * 若这里也挂一个 live region，`querySelector('[aria-live="polite"]')` 这类定位
 * 会命中错误元素，读屏也会同时播两条互不相关的进度。
 */
import React from 'react';
import { AlertTriangle, Loader2, Settings2 } from 'lucide-react';

export type LumenGateStatus = 'probing' | 'unavailable' | 'available';

interface LumenGateNoticeProps {
  status: LumenGateStatus;
  /** 不可用时的具体原因（来自引擎探测），为空则用兜底句。 */
  detail?: string;
  /** 「去设置」入口；不传则不渲染按钮。 */
  onOpenSettings?: () => void;
  disabled?: boolean;
}

export const LumenGateNotice: React.FC<LumenGateNoticeProps> = ({
  status,
  detail,
  onOpenSettings,
  disabled = false,
}) => {
  if (status === 'available') return null;

  if (status === 'probing') {
    return (
      <div
        role="status"
        className="p-2.5 bg-background-base border border-default rounded flex items-center gap-2 text-white/60"
      >
        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden="true" />
        <span>正在检测 LUMEN RAW 引擎…</span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="p-2.5 bg-amber-950/40 border border-amber-800/50 rounded flex items-start gap-2 text-amber-200"
    >
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <span className="break-words">
          LUMEN RAW 引擎不可用，暂时无法生成成片：
          {detail?.trim() || '未检测到可用的 lumen-cli'}
        </span>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            disabled={disabled}
            className="focus-ring self-start flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-900/40 hover:bg-amber-900/60 active:scale-[0.96] text-amber-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Settings2 className="w-3 h-3" aria-hidden="true" />
            <span>去设置</span>
          </button>
        )}
      </div>
    </div>
  );
};
