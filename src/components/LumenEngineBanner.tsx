/**
 * 引擎包下载横幅（issue #75）。
 *
 * 纯呈现：只把 `LumenEngineStatus` 翻译成一句话 + 一个重试入口。
 * - `downloading` / `verifying` → `role="status"`（温和播报）；
 * - `failed` → `role="alert"`，并常驻画出「重试」与手动指定路径的退路。
 *
 * 「手动指定路径」不做成按钮：设置里有现成的路径输入，这里只负责把这句话
 * **常驻画在屏幕上**（禁用按钮不可聚焦，title 对键盘/读屏都拿不到）。
 */
import React from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { LumenEngineStatus } from '../types';

interface LumenEngineBannerProps {
  status: LumenEngineStatus | null;
  retrying?: boolean;
  onRetry?: () => void;
}

export const LumenEngineBanner: React.FC<LumenEngineBannerProps> = ({
  status,
  retrying = false,
  onRetry,
}) => {
  if (!status || status.phase === 'ready' || status.phase === 'missing') return null;

  if (status.phase === 'failed') {
    return (
      <div
        role="alert"
        data-engine-banner="failed"
        className="px-4 py-2 border-b border-amber-800/50 bg-amber-950/40 flex items-start gap-2 text-amber-200 shrink-0"
      >
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <span className="break-words">LUMEN RAW 引擎下载失败：{status.detail}</span>
          <div className="flex items-center gap-3">
            {onRetry && (
              <button
                onClick={onRetry}
                disabled={retrying}
                className="focus-ring flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-900/40 hover:bg-amber-900/60 active:scale-[0.96] text-amber-100 press disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RefreshCw
                  className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>{retrying ? '正在重试…' : '重试'}</span>
              </button>
            )}
            <span className="text-amber-200/70">
              也可以在「设置」里手动指定 lumen-cli.exe 路径
            </span>
          </div>
        </div>
      </div>
    );
  }

  const percent =
    status.totalBytes > 0
      ? Math.min(100, Math.round((status.downloadedBytes / status.totalBytes) * 100))
      : null;

  return (
    <div
      role="status"
      data-engine-banner={status.phase}
      className="px-4 py-2 border-b border-border-default bg-background-header flex items-center gap-2 text-white/70 shrink-0"
    >
      <Loader2 className="w-4 h-4 shrink-0 animate-spin" aria-hidden="true" />
      <span className="flex-1 min-w-0 truncate">{status.detail}</span>
      {percent !== null && <span className="tabular-nums text-white/50">{percent}%</span>}
    </div>
  );
};
