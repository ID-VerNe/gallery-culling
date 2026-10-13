/**
 * 浮动 EXIF 胶囊（右上角）。
 *
 * 三个视口共用同一份呈现：相机/镜头/光圈快门 ISO/拍摄时间。原先只有
 * PreviewViewport 有，Split 与 BeforeAfter 完全没有 —— 用户切换视口时 EXIF
 * 时有时无，无法横向比较同一张照片在不同视口下的元数据。
 *
 * 纯展示，不含业务逻辑；文本可选中（`select-text`），方便直接复制参数。
 */
import React from 'react';
import type { ExifData } from '../types';

export const ExifCapsule: React.FC<{ exif: ExifData | undefined }> = ({ exif }) => {
  if (!exif) return null;

  return (
    <div className="absolute top-3 right-3 bg-background-base/75 backdrop-blur-md px-3.5 py-2.5 rounded-lg text-xs text-white/80 flex flex-col gap-1 border border-default pointer-events-auto select-text max-w-[16rem]">
      <div className="font-semibold text-white truncate">
        {exif.cameraModel || exif.cameraMake || '未知相机'}
      </div>
      {exif.lensModel && (
        <div className="text-[11px] text-white/70 truncate">{exif.lensModel}</div>
      )}
      <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums text-white/80 mt-0.5 flex-wrap">
        {exif.focalLength && <span>{exif.focalLength}</span>}
        {exif.aperture && <span>{exif.aperture}</span>}
        {exif.shutterSpeed && <span>{exif.shutterSpeed}</span>}
        {exif.iso && <span>ISO{exif.iso}</span>}
      </div>
      {exif.dateTime && (
        <div className="text-[10px] text-white/70 font-mono tabular-nums mt-0.5">
          {exif.dateTime}
        </div>
      )}
    </div>
  );
};
