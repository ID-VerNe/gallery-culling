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

/**
 * 五色色标（Lightroom 的 `xmp:Label` 约定）。
 *
 * 只认这五个英文色名：它们是 Lightroom / Bridge / Capture One 互认的取值，
 * 写别的字符串等于把标记藏进没人认识的角落。空串表示无色标。
 */
export type ColorLabel = 'Red' | 'Yellow' | 'Green' | 'Blue' | 'Purple';
export type ViewMode = 'single' | 'split' | 'before_after';
export type SortOrder = 'time_filename' | 'filename' | 'rating';
export type FilterMode =
  | 'all'
  | 'pick'
  | 'reject'
  | 'unmarked'
  | 'star1'
  | 'star2'
  | 'star3'
  | 'star4'
  | 'star5'
  | 'label-red'
  | 'label-yellow'
  | 'label-green'
  | 'label-blue'
  | 'label-purple';

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
  /** 色标：`''` 表示无色标。唯一真值是 XMP 的 `xmp:Label`。 */
  label: string;
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

/** lumen_detail_cmd 返回：detailPath = null 表示引擎不可用（前端退回 1600 预览） */
export interface LumenDetailResult {
  detailPath: string | null;
  /** 本次是否命中磁盘缓存（true = 没花那 6–8 秒） */
  cached: boolean;
  elapsedMs: number;
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

/**
 * 导出内容模式。
 *
 * - `copy`：现有行为，复制 RAW / JPG 原文件；
 * - `render`：由 LUMEN RAW 按每张照片的 `.lumen` 工程渲染成片。
 */
export type ExportMode = 'copy' | 'render';

/** 成片输出格式（对应 LUMEN `photo.export` 支持的扩展名子集）。 */
export type RenderFormat = 'jpg' | 'tif' | 'dng';

/**
 * 水印配色预设名。
 *
 * 与后端 `watermark::PRESET_NAMES` 逐字对齐 —— 后端对未知名整批拒绝
 * （「未知的水印配色」），前端写死这四个名就不会撞上那条错误路径。
 */
export type WatermarkPresetName = 'gallery' | 'noir' | 'travel' | 'sage';

/**
 * `batch_render_export_cmd` 的水印参数（第九个，与格式/长边/质量并列）。
 *
 * 后端只对 JPEG 生效：宿主水印要在 JPEG 上重编码一次贴字，TIFF / DNG 是
 * 渲染器直出，没有这一步。选中它们时前端不展示水印区，但传了也会被安全忽略。
 */
export interface WatermarkOptions {
  enabled: boolean;
  preset: WatermarkPresetName;
  /** 底边高度占短边的百分比，后端夹到 8–35。 */
  size: number;
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
  /**
   * 本次导出是否被用户取消（M-05）。
   *
   * 可选字段：后端契约在批次 C **增量**加入，前端必须能在后端尚未落地时照常
   * 编译与运行，故用可选 + 默认 `false` 处理（`outcome.cancelled === true` 才算取消）。
   * Q4 已拍板「临时目录 + 原子搬迁」= all-or-nothing：取消即目标目录零污染。
   */
  cancelled?: boolean;
}

/**
 * `scan-progress` 事件的负载（M-05）。
 * 与 Rust 侧 `emit("scan-progress", ...)` 对齐。扫描阶段实际只有：
 * 枚举 → 逐组(EXIF + XMP + 精修探测) → 排序。
 */
export interface ScanProgressPayload {
  /** 当前阶段标识，如 "enumerate" | "exif" | "xmp" | "sort" */
  phase: string;
  processed: number;
  total: number;
}

/**
 * `export-progress` 事件的负载（M-05）。
 * `current` 是正在复制的文件名/路径，用于让用户看到"卡在哪一张"。
 */
export interface ExportProgressPayload {
  processed: number;
  total: number;
  current: string;
}

/** 任务类型：扫描或批量导出。用于选择取消命令与进度事件名。 */
export type TaskKind = 'scan' | 'export';

/** 归一化后的进度（两种事件负载的统一形状，供 hook 与进度条消费）。 */
export interface TaskProgress {
  processed: number;
  total: number;
  /** 扫描阶段（仅 scan-progress 提供） */
  phase?: string;
  /** 当前处理项（仅 export-progress 提供） */
  current?: string;
}

export interface FolderScanResult {
  groups: PhotoGroupInfo[];
  totalCount: number;
  jpgFolder: string;
  rawFolder: string;
  isViewerMode: boolean;
}

/* -------------------------------------------------------------------------- */
/* FR-08：XMP 增量导入与冲突裁决                                                */
/* -------------------------------------------------------------------------- */

/** 一张照片的三项标记状态（与 Rust `CullState` 逐字对齐）。 */
export interface CullStateSnapshot {
  rating: number;
  /** `pick` | `reject` | `none` */
  flag: string;
  /** `''` 表示无色标 */
  label: string;
}

/** 刷新结果里「已采用外部值」的一张。 */
export interface XmpRefreshItem {
  path: string;
  state: CullStateSnapshot;
  /** 侧边栏在磁盘上已不存在（外部删除）—— 界面值被清空，值得单独提示一句。 */
  sidecarRemoved: boolean;
}

/**
 * 待裁决的一张：本地有未落盘的意图，外部也改了。
 *
 * `local` 是那个还没写进磁盘的意图，`external` 是磁盘现值。两者都要摆给用户看，
 * 绝不替用户选。
 */
export interface XmpRefreshConflict {
  path: string;
  local: CullStateSnapshot;
  external: CullStateSnapshot;
}

/** 一次增量刷新的汇总。 */
export interface XmpRefreshReport {
  /** 参与检查的目标数（去重后） */
  checked: number;
  /** 无事发生：mtime 一致 / 内容一致 / 从未见过且文件不存在 */
  unchanged: number;
  /** 首次见到并建立基线（不产生更新） */
  baselined: number;
  adopted: XmpRefreshItem[];
  conflicts: XmpRefreshConflict[];
  /** 读失败的路径 */
  failed: string[];
}

/** 冲突裁决动作。字符串值即后端 `ConflictAction` 的 serde 表示。 */
export type XmpConflictAction = 'keep-local' | 'use-external';

export interface XmpConflictChoice {
  path: string;
  action: XmpConflictAction;
  /** `use-external` 时回传弹窗里显示的外部值（后端据此推进游标，不重读磁盘）。 */
  external?: CullStateSnapshot;
}

/**
 * 一张裁决失败。`path` 单独给出（不是拼进文案）：弹窗要按路径把失败的那几条
 * **留在列表里**让用户再选一次。拼成 `"path: msg"` 后 Windows 路径里的 `:`
 * 会让解析变成猜。
 */
export interface XmpResolveFailure {
  path: string;
  message: string;
}

export interface XmpResolveReport {
  applied: XmpRefreshItem[];
  failed: XmpResolveFailure[];
}

/* -------------------------------------------------------------------------- */
/* FR-10：选片集（`.galleryalbum`）                                             */
/* -------------------------------------------------------------------------- */

/**
 * 打开选片集后的一条（与 Rust `album::ResolvedDoc` 逐字对齐）。
 *
 * `exists=false` 的条目**也在列表里**：选片集的验收标准是「缺失文件列出」，
 * 从结果里删掉就等于什么都没说。
 */
export interface AlbumResolvedDoc {
  /** 文件里记的原始值（相对或绝对）—— 缺失时只有它能给用户线索。 */
  source: string;
  /** 解析后的绝对路径（不保证存在）。 */
  path: string;
  exists: boolean;
  /** 主路径是不是 RAW。判错会让视口拿 `.ARW` 去当 `<img src>`（C2 破图）。 */
  isRaw: boolean;
  size: number;
  /** 秒级 mtime（与扫描结果同口径）。 */
  mtime: number;
  /** 配对 JPG 的绝对路径；`null` = 保存时就没有，或文件已不在。 */
  jpgPath: string | null;
  jpgExists: boolean;
  /** 配对 JPG 的体积 / 秒级 mtime（不在时为 0）。 */
  jpgSize: number;
  jpgMtime: number;
  hasXmp: boolean;
  /** XMP 里的调色基线（调色面板靠它，缺了会把真实调色覆盖成 0）。 */
  tone?: ToneAdjustments | null;
  /**
   * 相机参数。后端**配对 JPG 优先**读（JPG 0.14 ms/张 vs RAW 11.1 ms/张），
   * 没有配对 JPG 时才读主路径；两条都读不出才是 `null`。
   */
  exif?: ExifData | null;
  rating: number;
  flag: string;
  label: string;
}

export interface AlbumOpenResult {
  path: string;
  entries: AlbumResolvedDoc[];
  /** 主文件找不到的条目数（`entries` 里仍然保留）。 */
  missing: number;
}

export interface AlbumSaveResult {
  path: string;
  saved: number;
}

/** 保存时的一条：绝对路径 + 当前状态。 */
export interface AlbumItemInput {
  /** 主路径（RAW 优先，与 `groupPath` 同序）。 */
  path: string;
  /** 配对 JPG；主路径本身就是 JPG 时为 `null`。 */
  jpgPath?: string | null;
  rating: number;
  flag: string;
  label: string;
}

/* -------------------------------------------------------------------------- */
/* FR-11：Lightroom 目录（`.lrcat`）导入                                        */
/* -------------------------------------------------------------------------- */

/**
 * LR 目录里的一张照片（与 Rust `lrcat::LrcatPhoto` 对齐）。
 *
 * `rating` 已经把 LR 的 `-1`（淘汰）归一到 0，淘汰只由 `flag` 表达。
 */
export interface LrcatPhoto {
  /** 拼好的绝对路径（平台分隔符，可能是 UNC `\\server\share\...`）。 */
  path: string;
  rating: number;
  flag: string;
  label: string;
}

export interface LrcatReadResult {
  /** 选中的 `.lrcat` 绝对路径。 */
  catalog: string;
  /** 落在当前集合目录里的照片（`folders` 过滤后）。 */
  photos: LrcatPhoto[];
  /** 跳过的虚拟副本数（同一底片的另一份调色，路径与主图相同）。 */
  skippedVirtual: number;
  /** 库内总条目数（含虚拟副本），用于报告「库里有什么」。 */
  total: number;
  /** 原地读失败、走了复制副本（LR 正在运行）。 */
  copied: boolean;
}
