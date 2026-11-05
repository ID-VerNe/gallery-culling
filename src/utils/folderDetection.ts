import type { FolderProbe } from '../types';

/**
 * #66：单目录识别结果的统一文案。
 *
 * 顶栏常驻标记与 toast 都从这里取，避免「仅 JPG」这类说法在两处各写一份后漂移。
 */
export function folderProbeSummary(probe: FolderProbe): string {
  switch (probe.mode) {
    case 'mixed':
      return `JPG + RAW 混合 · JPG ${probe.jpgCount} / RAW ${probe.rawCount}`;
    case 'jpg_only':
      return `仅 JPG · ${probe.jpgCount} 张`;
    case 'raw_only':
      return `仅 RAW · ${probe.rawCount} 张`;
    default:
      // 空目录不改动已有路径；文案必须说明这一点，否则会被读成「当前配置为空」。
      return '所选文件夹为空（路径未改动）';
  }
}

/** 取路径最后一段用于提示文案；空路径回落为「该文件夹」。 */
export function folderDisplayName(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return name || '该文件夹';
}
