/**
 * 原片复制的类型勾选 —— **纯呈现**。
 *
 * 只在 `mode === 'copy'` 时挂载，所以文案里的「复制」二字不需要按模式分支。
 * 不知道自己属于哪种模式，是刻意的：一旦它开始判断模式，模式差异就有了第二个来源。
 */
import React from 'react';

interface CopyOptionsProps {
  includeRaw: boolean;
  includeJpg: boolean;
  onChangeRaw: (v: boolean) => void;
  onChangeJpg: (v: boolean) => void;
  disabled?: boolean;
}

export const CopyOptions: React.FC<CopyOptionsProps> = ({
  includeRaw,
  includeJpg,
  onChangeRaw,
  onChangeJpg,
  disabled = false,
}) => (
  <fieldset>
    <legend className="text-white/80 font-medium mb-1.5">包含文件类型</legend>
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-background-base p-2.5 rounded border border-default">
      <label
        htmlFor="export-include-raw"
        className="focus-ring flex items-center gap-2 cursor-pointer rounded p-1 hover:bg-background-surface-hover transition-colors"
      >
        <input
          id="export-include-raw"
          type="checkbox"
          checked={includeRaw}
          onChange={(e) => onChangeRaw(e.target.checked)}
          disabled={disabled}
          className="accent-white"
        />
        <span className="text-white/80">复制 RAW 原片及 XMP 侧边栏</span>
      </label>

      <label
        htmlFor="export-include-jpg"
        className="focus-ring flex items-center gap-2 cursor-pointer rounded p-1 hover:bg-background-surface-hover transition-colors"
      >
        <input
          id="export-include-jpg"
          type="checkbox"
          checked={includeJpg}
          onChange={(e) => onChangeJpg(e.target.checked)}
          disabled={disabled}
          className="accent-white"
        />
        <span className="text-white/80">复制对应 JPG 预览</span>
      </label>
    </div>
  </fieldset>
);
