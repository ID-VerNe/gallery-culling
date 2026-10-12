export interface PhotoFileInfo {
  name: string;
  extension: string;
  path: string;
  size: number;
  mtime: number;
}

export interface ExifData {
  shutterSpeed?: string;
  aperture?: string;
  iso?: string;
  focalLength?: string;
  dateTime?: string;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  orientation?: number;
}

export type CullFlag = 'none' | 'pick' | 'reject';
export type ViewMode = 'single' | 'split' | 'before_after';
export type SortOrder = 'time_filename' | 'filename' | 'rating';
export type FilterMode = 'all' | 'pick' | 'reject' | 'unmarked' | 'star1' | 'star2' | 'star3' | 'star4' | 'star5';

export interface ToneAdjustments {
  exposure: number;     // 曝光补偿 -5.00 .. +5.00 EV
  highlights: number;   // 高光 -100 .. +100
  shadows: number;      // 阴影 -100 .. +100
  temperature: number;  // 色温冷暖 -100 .. +100
  tint: number;         // 色调 (绿/洋红) -100 .. +100
  contrast: number;     // 对比度 -100 .. +100
}

export interface PhotoGroupInfo {
  id: string;
  baseName: string;
  jpg?: PhotoFileInfo;
  raw?: PhotoFileInfo;
  edited?: PhotoFileInfo;
  tone?: ToneAdjustments;
  status: 'COMPLETE' | 'JPG_ONLY' | 'RAW_ONLY';
  rating: number; // 0..5
  flag: CullFlag;
  hasXmp: boolean;
  exif?: ExifData;
  thumbnailPath?: string;
}

export interface AppSettings {
  defaultJpgFolder: string;
  defaultRawFolder: string;
  photoshopPath: string;
  thumbnailWidth: number;
  sortOrder: SortOrder;
  /** 是否启用 LUMEN RAW 引擎集成（默认 false，零迁移风险） */
  lumenEnabled: boolean;
  /** lumen-cli.exe 路径（空 = 自动查找） */
  lumenCliPath: string;
}

/** lumen_preview_cmd 返回：previewPath = null 表示引擎不可用（前端静默降级） */
export interface LumenPreviewResult {
  previewPath: string | null;
  width: number;
  original: boolean;
  cached: boolean;
}

/** LUMEN RAW 侧调色 recipe（宿主调色面板的初始态） */
export interface LumenRecipe {
  available: boolean;
  tone: ToneAdjustments;
  monochrome: boolean;
}

/** LUMEN RAW 集成握手状态 */
export interface LumenStatus {
  available: boolean;
  enabled: boolean;
  pinnedVersion: string;
  foundVersion: string | null;
  detail: string;
}

export interface ExportItem {
  baseName: string;
  jpgPath?: string;
  rawPath?: string;
}

export interface FolderScanResult {
  groups: PhotoGroupInfo[];
  totalCount: number;
  jpgFolder: string;
  rawFolder: string;
  isViewerMode: boolean;
}
