import React from 'react';
import type { ColorLabel } from '../types';
import {
  COLOR_LABELS,
  LABEL_DOT_CLASS,
  LABEL_NAMES,
  LABEL_SHORTCUTS,
  isColorLabel,
} from '../utils/labels';
import { STATUS_DOT_BUTTON } from './viewportBarStyles';

interface LabelDotsProps {
  /** 当前色标；后端字段是字符串，非法值按「未设置」处理。 */
  label?: string;
  /** 点击某一色点 = 把该色标交给宿主（重复点同色 = 取消，由宿主切换）。 */
  onSelect: (label: ColorLabel) => void;
  /**
   * 多窗格场景的可访问名前缀（双图对比左右各有一组，仅靠「红色标」无法区分）。
   * 单图/前后对照不需要传。
   */
  scopeName?: string;
}

/**
 * SH-01（issue #32）：五色色标的鼠标入口。
 *
 * 色标此前只有 `6`–`9` / `Shift+6` 两条键盘路径（issue #61 后只剩左手
 * `Shift+1…5`），`git grep "onLabel:" -- src/components` 无任何命中 ——
 * mouse-only / 严格单手用户根本无法设置色标。本组件把
 * `src/utils/labels.ts` 的展示真值（色名、色点 class、快捷键）复用到按钮上，
 * 三个视口共用，避免各写一份导致「有紫色但没有紫色按钮」。
 */
export const LabelDots: React.FC<LabelDotsProps> = ({ label, onSelect, scopeName }) => {
  const current = isColorLabel(label) ? label : null;

  return (
    <div
      className="flex items-center gap-1"
      role="group"
      aria-label={scopeName ? `${scopeName} 的色标` : '照片色标'}
    >
      {COLOR_LABELS.map((color) => {
        const name = LABEL_NAMES[color];
        const shortcut = LABEL_SHORTCUTS[color];
        const text = `${name}色标（快捷 ${shortcut}）`;
        const accessibleName = scopeName ? `${scopeName}：${text}` : text;
        const pressed = current === color;

        return (
          <button
            key={color}
            type="button"
            onClick={() => onSelect(color)}
            className={`${STATUS_DOT_BUTTON} ${pressed ? 'ring-2 ring-white/80' : ''}`}
            title={text}
            aria-label={accessibleName}
            aria-pressed={pressed}
          >
            <span
              className={`block w-3 h-3 rounded-full ${LABEL_DOT_CLASS[color]}`}
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
};
