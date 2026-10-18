import type { CullFlag } from '../types';
import { labelName } from './labels';

/**
 * 一张照片的「选片三轴」状态：星级 / 旗标 / 色标。
 *
 * 三者必须一起进撤销快照，理由各不相同：
 * - 星级与旗标互相影响（打星会解除淘汰），只存一个会让撤销把另一个留在新值。
 * - 色标存在 `xmp:Label`，与旗标是两个维度；按 `6` 再撤销若不回填，会留下红标。
 */
export interface MetaState {
  rating: number;
  flag: CullFlag;
  label: string;
}

/** 一条命令里的单张照片：改之前与改之后。 */
export interface CullItem {
  id: string;
  /** 写盘用的文件路径（RAW 优先，与 `groupPath` 一致）。 */
  path: string;
  before: MetaState;
  after: MetaState;
}

/**
 * 一次可撤销的选片操作。
 *
 * **批量操作是一整条命令**，`items` 带多张；单张操作是只带一个条目的命令。
 * 撤销栈只认命令，不认条目 —— 所以「撤销」永远回退到操作之前，而不是退一张。
 */
export interface CullCommand {
  /** 底栏与 toast 的可读描述，如「淘汰 3 张」「设为 4 星」。 */
  summary: string;
  items: CullItem[];
}

/** 旗标的中文叫法（宫格、底栏、撤销 toast 共用，避免三处各写一份）。 */
export const FLAG_NAMES: Record<CullFlag, string> = {
  pick: '保留',
  reject: '淘汰',
  none: '未标记',
};

export function summarizeRating(rating: number): string {
  return rating === 0 ? '清除星级' : `设为 ${rating} 星`;
}

export function summarizeFlag(flag: CullFlag): string {
  return `标记为${FLAG_NAMES[flag]}`;
}

export function summarizeLabel(label: string): string {
  return label ? `色标设为${labelName(label)}` : '清除色标';
}

export function summarizeClear(): string {
  return '清除星级与标记';
}
