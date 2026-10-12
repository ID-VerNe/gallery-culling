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
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      maxWidth="max-w-md"
      icon={icon}
      footer={
        <>
          <button
            onClick={onClose}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-white/5 hover:bg-white/10 active:scale-[0.96] text-white/80 transition-transform"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`focus-ring px-3.5 py-1.5 rounded-md active:scale-[0.96] font-medium transition-transform shadow-sm ${
              destructive
                ? 'bg-rose-500 hover:bg-rose-400 text-white'
                : 'bg-white hover:bg-white/90 text-black'
            }`}
          >
            {confirmLabel}
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
