import type { ColorLabel } from '../types';

/**
 * 五色色标的展示与快捷键映射 —— 唯一真值。
 *
 * 缩略图色点、筛选下拉、快捷键帮助、底栏提示都从这里取，避免「UI 上有紫色、
 * 快捷键却打不出来」这类漂移。色名必须与 XMP 里写出的字符串完全一致
 * （Lightroom 只认这五个英文名）。
 */
export const COLOR_LABELS: readonly ColorLabel[] = [
  'Red',
  'Yellow',
  'Green',
  'Blue',
  'Purple',
];

/** 中文名（用于无障碍标签与筛选下拉）。 */
export const LABEL_NAMES: Record<ColorLabel, string> = {
  Red: '红',
  Yellow: '黄',
  Green: '绿',
  Blue: '蓝',
  Purple: '紫',
};

/** 色点的 Tailwind 背景色。紫色刻意偏亮，避免在深色底上看不见。 */
export const LABEL_DOT_CLASS: Record<ColorLabel, string> = {
  Red: 'bg-rose-500',
  Yellow: 'bg-amber-400',
  Green: 'bg-emerald-500',
  Blue: 'bg-sky-500',
  Purple: 'bg-violet-400',
};

/**
 * 快捷键：`Shift+1…5` 依次对应红/黄/绿/蓝/紫（issue #61）。
 *
 * 右手 `6`–`9` / `Shift+6` 已删除，色点的 title 只能宣传左手键，
 * 否则会继续把用户往右手引导。
 */
export const LABEL_SHORTCUTS: Record<ColorLabel, string> = {
  Red: 'Shift+1',
  Yellow: 'Shift+2',
  Green: 'Shift+3',
  Blue: 'Shift+4',
  Purple: 'Shift+5',
};

/** 运行时收窄：后端字段是字符串，只有这五个值才当色标处理。 */
export function isColorLabel(value: string | undefined | null): value is ColorLabel {
  return !!value && (COLOR_LABELS as readonly string[]).includes(value);
}

/** 色标的可读文案；无色标时返回空串（调用方自己决定要不要显示）。 */
export function labelName(value: string | undefined): string {
  return isColorLabel(value) ? LABEL_NAMES[value] : '';
}
