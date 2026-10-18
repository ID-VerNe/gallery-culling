/**
 * 选片集（`.galleryalbum`）→ 集合的**唯一转换层**（FR-10）。
 *
 * 抽成纯函数（无 React、无 IPC）的理由：这里每一条规则都是「界面会不会说谎」
 * 的判定，必须能被单测逐条钉住 —— 配对 JPG、同名跨目录、缺失项、调色基线，
 * 任何一条错了都不会崩，只会安静地显示错的东西。
 *
 * 三条硬规则：
 * 1. **id 用路径，不用文件名**。选片集本来就跨目录，`D:\cardA\DSC1.ARW` 与
 *    `E:\cardB\DSC1.ARW` 是两张照片；按 baseName 当 id 会让一次评级写到
 *    另一张上（扫描路径按 baseName 合并是因为它只扫一个目录对）。
 * 2. **配对 JPG 必须在磁盘上才算数**（`jpgExists`）。记着路径但文件已删时
 *    仍当 COMPLETE，会让视口拿一个不存在的 JPG 去渲染 —— 破图比没有更糟。
 * 3. **缺失项只报告、不进集合**。没有文件就没有缩略图、没有可写路径，
 *    混进集合会让每一次批量操作都要先问「这张在不在」。
 */
import type {
  AlbumItemInput,
  AlbumOpenResult,
  AlbumResolvedDoc,
  CullFlag,
  PhotoFileInfo,
  PhotoGroupInfo,
  SortOrder,
  ToneAdjustments,
} from '../types';
import { normalizeFilePath } from './pathNormalize';

export interface AlbumLoad {
  /** 可以直接进集合的分组。 */
  groups: PhotoGroupInfo[];
  /** 主文件找不到的条目（**不进集合**，由 UI 列出来）。 */
  missing: AlbumResolvedDoc[];
  /**
   * 调色基线，键是分组 id。交给 `toneSeed` —— 少了它调色面板显示全 0，
   * 用户点一下保存就把真实调色覆盖成 0。
   */
  tones: Record<string, ToneAdjustments>;
}

/** 文件名去掉扩展名（`.ARW` / `.JPG` 都算）。 */
function stemOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function fileInfo(path: string, size: number, mtime: number): PhotoFileInfo {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return {
    name,
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
    path,
    size,
    mtime,
  };
}

/**
 * 后端回传的旗标是字符串（serde 不做枚举校验）。落到 UI 前收一次口 ——
 * 与 `useXmpRefresh` 同口径：认不出来就当没有，别让类型外的值带偏筛选。
 */
function toCullFlag(flag: string): CullFlag {
  return flag === 'pick' || flag === 'reject' ? flag : 'none';
}

export function toAlbumGroups(result: AlbumOpenResult): AlbumLoad {
  const groups: PhotoGroupInfo[] = [];
  const missing: AlbumResolvedDoc[] = [];
  const tones: Record<string, ToneAdjustments> = {};

  for (const d of result.entries ?? []) {
    if (!d.exists) {
      missing.push(d);
      continue;
    }
    const id = normalizeFilePath(d.path);
    const primary = fileInfo(d.path, d.size, d.mtime);
    // 配对 JPG 只在磁盘上才算数：`jpgPath` 与 `jpgExists` 由后端保证一致，
    // 这里再判一次是因为「多判一次」的代价为零，而判错的代价是黑框。
    const jpg =
      d.jpgPath && d.jpgExists ? fileInfo(d.jpgPath, d.jpgSize ?? 0, d.jpgMtime ?? 0) : undefined;

    const raw = d.isRaw ? primary : undefined;
    const jpgFile = d.isRaw ? jpg : primary;

    const tone = d.tone ?? undefined;
    if (tone) tones[id] = tone;

    groups.push({
      id,
      baseName: stemOf(d.path),
      jpg: jpgFile,
      raw,
      tone,
      status: raw && jpgFile ? 'COMPLETE' : raw ? 'RAW_ONLY' : 'JPG_ONLY',
      rating: d.rating,
      flag: toCullFlag(d.flag),
      label: d.label ?? '',
      hasXmp: d.hasXmp,
    });
  }

  return { groups, missing, tones };
}

/**
 * 集合 → 保存用的条目。
 *
 * 主路径走 `raw?.path ?? jpg?.path`（与 `groupPath` 同序，RAW 优先）：
 * 写 XMP、打开原片都以原片为准。配对 JPG 单独给一条 —— 分目录摆放是常态，
 * 只存主路径会让重新打开时退化成 RAW_ONLY。
 */
export function toAlbumItems(groups: PhotoGroupInfo[]): AlbumItemInput[] {
  const items: AlbumItemInput[] = [];
  for (const g of groups) {
    const primary = g.raw?.path ?? g.jpg?.path;
    if (!primary) continue;
    items.push({
      path: primary,
      // 主路径本身就是 JPG 时不重复记一遍
      jpgPath: g.raw ? (g.jpg?.path ?? null) : null,
      rating: g.rating,
      flag: g.flag,
      label: g.label,
    });
  }
  return items;
}

/** 分组的时间键：RAW 优先，其次 JPG（选片集没有 EXIF，用文件 mtime 近似拍摄时间）。 */
function timeOf(g: PhotoGroupInfo): number {
  return g.raw?.mtime ?? g.jpg?.mtime ?? 0;
}

/**
 * 选片集视图里的本地排序。
 *
 * 为什么不复用 `handleSortOrderChange`：那条会**按当前目录重扫**，在选片集
 * 视图里重扫等于把整本选片集冲掉 —— 用户只是想换个顺序。
 *
 * 与后端排序键对齐（`scanner` 的 `sort_order` 分支）：时间升序 / 星级降序 /
 * 文件名升序，同分一律按文件名兜底，避免不稳定的顺序。
 */
export function sortAlbumGroups(
  groups: PhotoGroupInfo[],
  order: SortOrder,
): PhotoGroupInfo[] {
  const byName = (a: PhotoGroupInfo, b: PhotoGroupInfo) =>
    a.baseName.toLowerCase().localeCompare(b.baseName.toLowerCase());
  const copy = [...groups];
  if (order === 'filename') return copy.sort(byName);
  if (order === 'rating') return copy.sort((a, b) => b.rating - a.rating || byName(a, b));
  return copy.sort((a, b) => timeOf(a) - timeOf(b) || byName(a, b));
}
