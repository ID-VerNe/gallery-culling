/**
 * FR-11：把 Lightroom 目录读出来的条目，对齐到当前集合。
 *
 * 匹配规则只有两条，**都不猜**：
 *   1. 绝对路径相同（归一化后）—— 最可靠，LR 与本项目指向同一个文件；
 *   2. 同目录 + 同 baseName —— LR 里记的是 `DSC1.JPG`、当前集合只有
 *      `DSC1.ARW`（或反过来）时仍能对上，但**必须同目录**。
 *
 * 为什么不做全局同名匹配：`DSC0001.ARW` 在几十个目录里都存在，按文件名套评级
 * 会把别的拍摄的星级搬过来 —— 错误数据比没有数据更糟，而且用户很难发现。
 *
 * 一个 group 只认领一条 LR 记录：LR 里 RAW 与 JPG 是两条 `Adobe_images`，
 * 都指向同一组时取**先出现的那条**（LR 的导出顺序），避免来回覆盖。
 */
import { normalizeDir, normalizeFilePath, parentDirOf } from './pathNormalize';
import type { LrcatPhoto, PhotoGroupInfo } from '../types';

/** 命中的方式，报告里要分开说：路径命中是确定的，同名命中是推断。 */
export type LrcatMatchBy = 'path' | 'name';

export interface LrcatMatchItem {
  group: PhotoGroupInfo;
  photo: LrcatPhoto;
  by: LrcatMatchBy;
}

export interface LrcatPlan {
  /** 能对上的（每个 group 最多一条）。 */
  items: LrcatMatchItem[];
  /** LR 里有、当前集合里找不到的 —— 列出来，不猜。 */
  unmatched: LrcatPhoto[];
  /** 当前集合里 LR 没有记录的组数（只计数：LR 目录不含全部照片是常态）。 */
  missingInLr: number;
  /** 命中方式分项计数。 */
  byPath: number;
  byName: number;
}

/** 同目录同名的键。 */
const nameKey = (dir: string, baseName: string): string =>
  `${normalizeDir(dir)}|${baseName.toLowerCase()}`;

/** 一个 group 可能有两个可匹配的路径（RAW 与配对 JPG）。 */
function groupPaths(group: PhotoGroupInfo): string[] {
  const out: string[] = [];
  if (group.raw?.path) out.push(group.raw.path);
  if (group.jpg?.path) out.push(group.jpg.path);
  if (group.edited?.path) out.push(group.edited.path);
  return out;
}

export function planLrcatImport(
  groups: PhotoGroupInfo[],
  photos: LrcatPhoto[],
): LrcatPlan {
  const byPath = new Map<string, PhotoGroupInfo>();
  const byName = new Map<string, PhotoGroupInfo>();
  for (const g of groups) {
    for (const p of groupPaths(g)) {
      byPath.set(normalizeFilePath(p), g);
      byName.set(nameKey(parentDirOf(p), g.baseName), g);
    }
  }

  const claimed = new Set<string>();
  const items: LrcatMatchItem[] = [];
  const unmatched: LrcatPhoto[] = [];
  let hitPath = 0;
  let hitName = 0;

  for (const photo of photos) {
    let group = byPath.get(normalizeFilePath(photo.path));
    let by: LrcatMatchBy = 'path';
    if (!group) {
      group = byName.get(nameKey(parentDirOf(photo.path), baseNameOf(photo.path)));
      by = 'name';
    }
    if (!group || claimed.has(group.id)) {
      // 没对上，或这一组已经被更靠前的 LR 记录认领（RAW/JPG 两条）——
      // 后者不算「未匹配」，只是不重复写。
      if (!group) unmatched.push(photo);
      continue;
    }
    claimed.add(group.id);
    items.push({ group, photo, by });
    if (by === 'path') hitPath += 1;
    else hitName += 1;
  }

  return {
    items,
    unmatched,
    missingInLr: groups.length - claimed.size,
    byPath: hitPath,
    byName: hitName,
  };
}

/** 从路径取文件名（不含扩展名），与 `PhotoGroupInfo.baseName` 同口径。 */
export function baseNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const file = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * 当前这一组算不算「空白」—— 只有空白才在默认（不覆盖）模式下被写入。
 *
 * 三轴一起判：只看评级会在「3 星 + 无旗标」的组上补一个 pick，做出半新半旧的
 * 状态，比整组跳过更难解释。用户要合并就勾「覆盖」。
 */
export const isBlankGroup = (group: PhotoGroupInfo): boolean =>
  group.rating === 0 && group.flag === 'none' && group.label === '';

export interface LrcatWrite {
  group: PhotoGroupInfo;
  photo: LrcatPhoto;
}

export interface LrcatWritePlan {
  writes: LrcatWrite[];
  /** 因为已有值且未勾「覆盖」而跳过的数量。 */
  skipped: number;
}

/**
 * 决定实际要写哪些。
 *
 * `overwrite=false`（默认）只填空白组；`true` 则按 LR 的值覆盖。
 * **只写有意义的条目**：LR 里那一张也是 0 星 / 无旗标 / 无色标时，写它等于
 * 无意义写盘（还会把 `pending_xmp` 弄脏），直接跳过。
 */
export function selectLrcatWrites(
  items: LrcatMatchItem[],
  overwrite: boolean,
): LrcatWritePlan {
  const writes: LrcatWrite[] = [];
  let skipped = 0;
  for (const item of items) {
    const { group, photo } = item;
    const hasValue = photo.rating > 0 || photo.flag !== 'none' || photo.label !== '';
    if (!hasValue) {
      skipped += 1;
      continue;
    }
    if (!overwrite && !isBlankGroup(group)) {
      skipped += 1;
      continue;
    }
    // 已经一模一样：不写。
    if (
      group.rating === photo.rating &&
      group.flag === photo.flag &&
      group.label === photo.label
    ) {
      skipped += 1;
      continue;
    }
    writes.push({ group, photo });
  }
  return { writes, skipped };
}
