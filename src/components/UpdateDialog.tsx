/**
 * 更新弹窗（issue #43-PB）。
 *
 * 为什么不复用 `ConfirmDialog`：后者是「两按钮一次性确认」，塞进复选框、终态与
 * 失败态之后它会同时承担两种语义；这里复用 `Modal` 外壳，单独承载更新域。
 *
 * 三条硬约定（都有用例锁着）：
 * - **X / Esc 只等于「本次暂不更新」**：组件只回调 `onClose`，绝不触碰存储；
 *   写持久标记只发生在「本次暂不更新」且用户勾了复选框时（由 hook 决定）。
 * - **初始焦点在「本次暂不更新」**：否则 `Modal` 会聚焦 body 里第一个可聚焦元素
 *   （复选框），回车/Space 就误勾了「永久跳过」。
 * - **进度独占 live region**：正文里的进度行是全局唯一的 `aria-live="polite"`；
 *   禁用按钮的解释常驻屏幕（静态文本），不靠 `title`/`tooltip`。
 */
import React, { useRef } from 'react';
import { Download } from 'lucide-react';
import { Modal } from './Modal';

export type UpdatePhase = 'idle' | 'downloading' | 'installing' | 'failed';

/** 进度行与终态文案（由 hook 提供，组件不自己拼百分比）。 */
export interface UpdateDialogProps {
  isOpen: boolean;
  version: string;
  body: string;
  phase: UpdatePhase;
  /** 下载进度 / 终态说明；只在 downloading / installing 时挂进 live region。 */
  progressText: string;
  /** 0-100；null 表示总大小未知（不画进度条）。 */
  progressPercent?: number | null;
  error: string | null;
  skipChecked: boolean;
  onSkipCheckedChange: (checked: boolean) => void;
  onInstall: () => void;
  /** 「本次暂不更新」：符合条件时由 hook 写入持久标记。 */
  onLater: () => void;
  /** X / Esc：只关闭本次提示。 */
  onClose: () => void;
  onRetry: () => void;
  onOpenReleasePage: () => void;
}

export const UpdateDialog: React.FC<UpdateDialogProps> = ({
  isOpen,
  version,
  body,
  phase,
  progressText,
  progressPercent = null,
  error,
  skipChecked,
  onSkipCheckedChange,
  onInstall,
  onLater,
  onClose,
  onRetry,
  onOpenReleasePage,
}) => {
  /** D5：初始焦点指向次按钮，避免回车落在复选框上。 */
  const laterRef = useRef<HTMLButtonElement>(null);
  const busy = phase === 'downloading' || phase === 'installing';
  const failed = phase === 'failed';
  const showProgress = phase === 'downloading' || phase === 'installing';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`发现新版本 ${version}`}
      maxWidth="max-w-md"
      icon={<Download className="w-4 h-4" aria-hidden="true" />}
      initialFocusRef={laterRef}
      disableClose={busy}
      footer={
        <>
          {failed && (
            <button
              type="button"
              onClick={onOpenReleasePage}
              className="focus-ring mr-auto px-2 py-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 active:scale-[0.96] transition-transform"
            >
              打开发布页
            </button>
          )}
          <button
            ref={laterRef}
            type="button"
            onClick={onLater}
            disabled={busy}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white/80 transition-transform disabled:opacity-40 disabled:cursor-not-allowed"
          >
            本次暂不更新
          </button>
          <button
            type="button"
            onClick={failed ? onRetry : onInstall}
            disabled={busy}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-white hover:bg-white/90 text-black active:scale-[0.96] font-medium transition-transform shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {failed ? '重试下载' : '下载并安装'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs leading-relaxed text-white/80">
        <p className="whitespace-pre-line">{body}</p>

        {/* 复选框自己带失效规则，不依赖 hover 提示。 */}
        <label className="flex items-start gap-2 cursor-pointer select-none py-1 min-h-[32px]">
          <input
            type="checkbox"
            checked={skipChecked}
            disabled={busy}
            onChange={(e) => onSkipCheckedChange(e.target.checked)}
            className="mt-0.5 accent-white disabled:cursor-not-allowed"
          />
          <span>{`不再提示 v${version}（有新版本发布时会再次提醒）`}</span>
        </label>

        {/* 常驻解释：禁用期间也画在屏幕上（导出域同一口径）。 */}
        <p className="text-[11px] text-white/60">
          安装完成后会自动启动；若没有自动启动，请从开始菜单手动打开。
        </p>

        {showProgress && (
          <div className="flex flex-col gap-1.5">
            <p role="status" aria-live="polite" className="text-white/80">
              {progressText}
            </p>
            {phase === 'downloading' && progressPercent !== null && (
              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
                <div
                  className="h-full bg-white/80 transition-[width]"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {failed && error && (
          <p
            role="alert"
            className="rounded-lg border border-rose-800/50 bg-rose-950/30 p-2.5 text-rose-200/90"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
};
