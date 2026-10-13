import React from 'react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  /** Body copy. Supports simple line breaks. */
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  icon?: React.ReactNode;
  destructive?: boolean;
  /**
   * 进行中（如正在下载更新）：两个按钮都禁用，主按钮改用 `busyLabel` 文案。
   * 配合 `closeOnConfirm={false}` 使用，让弹窗在任务结束前保持可见。
   */
  busy?: boolean;
  busyLabel?: string;
  /**
   * 点确认后是否自动关闭。默认 true（一次性确认）。
   * 长任务（下载/安装更新）传 false，由调用方在结束/失败时自行关闭。
   */
  closeOnConfirm?: boolean;
}

/**
 * In-app confirmation, replacing `window.confirm`.
 *
 * The system dialog cannot be themed, blocks the whole app and gives no
 * structure to the release notes it is asked to display (considered in
 * UX-AUDIT §4).
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  icon,
  destructive = false,
  busy = false,
  busyLabel,
  closeOnConfirm = true,
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={busy ? () => {} : onClose}
      title={title}
      maxWidth="max-w-md"
      icon={icon}
      disableClose={busy}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 active:scale-[0.96] text-white/80 transition-transform disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => {
              onConfirm();
              if (closeOnConfirm) onClose();
            }}
            disabled={busy}
            className={`focus-ring px-3.5 py-1.5 rounded-md active:scale-[0.96] font-medium transition-transform shadow-sm disabled:opacity-60 disabled:cursor-not-allowed ${
              destructive
                ? 'bg-rose-500 hover:bg-rose-400 text-white'
                : 'bg-white hover:bg-white/90 text-black'
            }`}
          >
            {busy ? busyLabel ?? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-xs leading-relaxed text-white/80 whitespace-pre-line">
        {message}
      </div>
    </Modal>
  );
};
