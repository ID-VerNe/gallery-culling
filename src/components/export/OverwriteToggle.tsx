/**
 * 「覆盖同名文件」开关 —— 两种模式共用的**修饰项**。
 *
 * 它不决定「导出什么」，只决定「目标已有同名文件时怎么办」，所以放在
 * 模式专属选项之后、进度之前，不占一个 fieldset 的位置。
 *
 * 默认关：不覆盖是保护用户已有文件的正确默认。但这个开关必须存在 ——
 * 没有它，「调色 → 导出 → 再调 → 再导出」的第二次会全部 skipped，
 * 用户拿到的仍是上一版，且界面没有任何办法让他覆盖。
 */
import React from 'react';

interface OverwriteToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

export const OverwriteToggle: React.FC<OverwriteToggleProps> = ({
  checked,
  onChange,
  disabled = false,
}) => (
  <label
    htmlFor="export-overwrite"
    className={`focus-ring flex items-start gap-2 rounded p-1 transition-colors ${
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-background-surface-hover'
    }`}
  >
    <input
      id="export-overwrite"
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="accent-white mt-0.5"
    />
    <span className="flex flex-col gap-0.5 min-w-0">
      <span className="text-white/80">覆盖目标目录中的同名文件</span>
      <span
        className={`text-[11px] leading-tight ${
          checked ? 'text-amber-200/80' : 'text-white/50'
        }`}
      >
        {checked
          ? '同名文件会被本次结果替换，且无法撤销'
          : '关闭时同名文件一律跳过，目标目录里的旧文件原地保留'}
      </span>
    </span>
  </label>
);
