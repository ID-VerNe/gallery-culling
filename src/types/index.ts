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
  /** 宫格缩略图是否走 LUMEN RAW 渲染（默认 false = EXIF 内嵌缩略图） */
  lumenGridThumbnails: boolean;
  /** 用户是否期待 AI 能力（GPU 版）。为 true 但指向 CPU 版时设置页会明确警告。 */
  lumenExpectAi: boolean;
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

/** AI 蒙版内的局部调色（lumen masks[].adjustments 子集） */
export interface MaskAdjustments {
  exposure: number;
  highlights: number;
  shadows: number;
  dehaze: number;
  clarity: number;
  saturation: number;
  temperature: number;
}

/** 工程里的一个 AI 蒙版（读回结构，随 lumen 版本可能变宽） */
export interface LumenMask {
  index?: number;
  name?: string;
  kind?: string;
  enabled?: boolean;
  adjustments?: Record<string, number>;
}

/** 应用 AI 蒙版的结果 */
export interface LumenMaskResult {
  /** lumen 回显的变更描述 */
  applied: unknown;
  masks: LumenMask[];
  /** 实测耗时（蒙版检测约 4s，UI 需要进度反馈） */
  elapsedMs: number;
}

/** 统一调色写入的结果：一条命令、两个落点各自成功与否 */
export interface ToneWriteReport {
  /** XMP 侧边栏是否写成功（互操作底线） */
  xmpWritten: boolean;
  /** LUMEN RAW 编辑态是否应用成功 */
  lumenApplied: boolean;
  /** 落盘的 .lumen 工程路径 */
  projectPath: string | null;
  /** 非致命问题（引擎失败原因等） */
  warnings: string[];
}

/** 统一调色读取：XMP（互操作真值）+ lumen 工程（渲染真值） */
export interface ToneState {
  /** 当前生效的调色（引擎可用时优先 lumen） */
  tone: ToneAdjustments;
  xmpTone: ToneAdjustments;
  lumenTone: ToneAdjustments | null;
  /** 两侧不一致 —— UI 必须提示，绝不静默取舍 */
  divergent: boolean;
  lumenAvailable: boolean;
}

/** 评级同步结果：写回了什么、跳过什么、哪里冲突（冲突绝不自动覆盖） */
export interface LumenRatingConflict {
  path: string;
  hostRating: number;
  hostFlag: string;
  lumenRating: number;
  lumenFlag: string;
}

export interface LumenRatingSyncResult {
  updated: string[];
  skipped: number;
  conflicts: LumenRatingConflict[];
}

/** LUMEN RAW sidecar 的真实能力（由 commands.list 解析，不靠猜） */
export interface LumenCapabilities {
  commands: string[];
  presets: string[];
  /** AI 蒙版（需要 GPU flavor） */
  aiMasks: boolean;
  /** AI 增强：去噪/超分（需要 GPU flavor） */
  aiEnhance: boolean;
  version: string;
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

/** 导出中单个失败项（batch_export_cmd 的错误累计，不再静默吞掉 Err） */
export interface ExportFailure {
  path: string;
  reason: string;
}

/**
 * batch_export_cmd 的返回：成功 / 跳过（目标已存在同名文件）/ 失败明细。
 * 与 Rust 侧 `ExportOutcome` 对齐（serde camelCase，字段均为单词故同名）。
 */
export interface ExportOutcome {
  exported: number;
  skipped: number;
  failed: ExportFailure[];
}

export interface FolderScanResult {
  groups: PhotoGroupInfo[];
  totalCount: number;
  jpgFolder: string;
  rawFolder: string;
  isViewerMode: boolean;
}
