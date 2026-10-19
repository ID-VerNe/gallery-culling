/**
 * 导出域的**唯一配置源**。
 *
 * 为什么集中在这里：复制 / 成片两种模式的标签、按钮、进度、单位、结果动词
 * 全部查表，组件与文案函数里不再出现 `mode === 'render' ? … : …` 的散落分支。
 * 新增第三种模式时只改本文件。
 */
import type { ExportMode, RenderFormat, WatermarkPresetName } from '../../types';

export interface ExportModeSpec {
  /** 模式主标签。 */
  label: string;
  /** 一行说明，用于扫读。 */
  description: string;
  /** 主按钮文案。 */
  action: string;
  /** 进行中的主按钮文案。 */
  running: string;
  /** 进度条 label。 */
  progressLabel: string;
  /**
   * 计数单位。
   *
   * copy 用「个」而非「组」是刻意的：既有结果文案已被测试逐字锁死
   * （`失败 1 个 · 已导出 2 个`），重构阶段保持零行为变更；
   * 想改口径应当作独立的文案优化提交，别混在结构重构里。
   */
  unit: '个' | '张';
  /** 结果句里的动词短语，如「已导出」「已生成」。 */
  exportedVerb: string;
  /** 全部成功时的标题。 */
  successTitle: string;
  /** 有失败时的标题（绝不把部分失败说成成功）。 */
  partialTitle: string;
  /** 跳过项的括号说明。 */
  skipNote: string;
  /** 取消句的宾语，接在「目标目录未产生」之后。 */
  cancelObject: string;
  /** footer 预计量前缀。 */
  estimateVerb: string;
  /** footer 预计量单位（含名词，避免再拼一次「照片」）。 */
  estimateUnit: string;
}

export const EXPORT_MODES: Record<ExportMode, ExportModeSpec> = {
  copy: {
    label: '原片复制',
    description: '复制 RAW / JPG 原文件',
    action: '开始导出',
    running: '导出中…',
    progressLabel: '正在导出照片',
    unit: '个',
    exportedVerb: '已导出',
    successTitle: '导出完成',
    partialTitle: '导出未完全成功',
    skipNote: '目标已存在同名文件',
    cancelObject: '任何文件',
    estimateVerb: '预计导出',
    estimateUnit: '组照片',
  },
  render: {
    label: '调色成片',
    description: '按 .lumen 调色渲染成片',
    action: '开始生成成片',
    running: '成片生成中…',
    progressLabel: '正在生成成片',
    unit: '张',
    exportedVerb: '已生成',
    successTitle: '成片生成完成',
    partialTitle: '成片生成未完全成功',
    skipNote: '目标已存在同名成片',
    cancelObject: '任何成片',
    estimateVerb: '预计生成',
    estimateUnit: '张成片',
  },
};

/** 成片格式。只暴露摄影出片用得到的三种，PNG 不进入 UI。 */
export const RENDER_FORMATS: ReadonlyArray<{ value: RenderFormat; label: string }> = [
  { value: 'jpg', label: 'JPEG' },
  { value: 'tif', label: 'TIFF' },
  { value: 'dng', label: 'DNG' },
];

/** 长边档位。0 = 原始尺寸（不缩放）。 */
export const RENDER_LONG_EDGES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: '原始' },
  { value: 4096, label: '4096 px' },
  { value: 2560, label: '2560 px' },
  { value: 1600, label: '1600 px' },
];

export const DEFAULT_RENDER_QUALITY = 92;
export const RENDER_QUALITY_MIN = 50;
export const RENDER_QUALITY_MAX = 100;

/** 质量夹取：空值 / NaN 回落到默认值，越界夹到 50–100。 */
export function clampQuality(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RENDER_QUALITY;
  return Math.min(RENDER_QUALITY_MAX, Math.max(RENDER_QUALITY_MIN, Math.round(value)));
}

/** 成片格式是否支持 JPEG 质量参数（TIFF / DNG 无此概念）。 */
export function formatUsesQuality(format: RenderFormat): boolean {
  return format === 'jpg';
}

/**
 * 水印配色预设。`value` 与后端 `watermark::PRESET_NAMES` 逐字一致 ——
 * 后端对未知名是**整批拒绝**而不是静默回落，所以这里多一个名就意味着
 * 一种必然失败的导出。新增配色要先改后端。
 */
export const WATERMARK_PRESETS: ReadonlyArray<{
  value: WatermarkPresetName;
  label: string;
}> = [
  { value: 'gallery', label: '画廊白' },
  { value: 'noir', label: '暗夜黑' },
  { value: 'travel', label: '暖旅卡其' },
  { value: 'sage', label: '鼠尾草绿' },
];

/**
 * 底边高度占短边的百分比范围。
 *
 * 与后端 `watermark::SIZE_MIN/MAX` 一致。前端滑杆本身就限定在这个区间，
 * 后端再夹一次是防线：命令可以被脚本直接调用，不走 UI。
 */
export const WATERMARK_SIZE_MIN = 8;
export const WATERMARK_SIZE_MAX = 35;
export const DEFAULT_WATERMARK_SIZE = 14;

/**
 * 成片格式是否支持水印。
 *
 * 只有 JPEG：宿主水印是在导出的 JPEG 上「扩画布 + 贴字 + 重编码」一步，
 * TIFF / DNG 是渲染器直出，没有这一步。与质量参数同一判断，但刻意分开
 * 两个函数 —— 它们未来可能不再一致（例如 TIFF 支持无损贴字时）。
 */
export function formatUsesWatermark(format: RenderFormat): boolean {
  return format === 'jpg';
}
