/**
 * `PhotoGroupInfo` 统一测试工厂（issue #117）。
 *
 * 各测试文件此前各自手贴 13-35 行同形字面量（`hasXmp: false` 71 处 /
 * `size: 1024` 21 处，见 issue 验收命令）。本文件是唯一真值：
 *  - 默认 `JPG_ONLY` + `D:/shoot/JPG/<baseName>.jpg` + size 1024 + mtime 0
 *    + rating 0 + flag 'none' + label '' + `hasXmp: false`；
 *  - `raw` 不自动补：需要 RAW 的组必须显式通过 `over.raw` 注入（含
 *    `status: 'COMPLETE'` 或 `'RAW_ONLY'`），避免掩盖「无 RAW」分支语义
 *    （E-07 教训：注释口径不等于测试锁住的口径）；
 *  - 传 `jpg: undefined` / `raw: undefined` 会把该键**真删除**（不是置空），
 *    保持 `g.raw ? …` 与「键不存在」判定的真实扫描形状一致。
 *
 * factories 只供 `*.test.*` 使用，不进运行时打包。
 */
import type { PhotoFileInfo, PhotoGroupInfo } from '../types';

export function makeFile(path: string, over: Partial<PhotoFileInfo> = {}): PhotoFileInfo {
  const name = path.split('/').pop() ?? path;
  const extension = (name.split('.').pop() ?? '').toLowerCase();
  return { name, extension, path, size: 1024, mtime: 0, ...over };
}

export function jpgFile(baseName: string, dir = 'D:/shoot/JPG'): PhotoFileInfo {
  return makeFile(`${dir}/${baseName}.jpg`);
}

export function rawFile(baseName: string, ext = 'ARW', dir = 'D:/shoot/RAW'): PhotoFileInfo {
  return makeFile(`${dir}/${baseName}.${ext}`, { extension: ext });
}

export function makeGroup(id: string, over: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  const baseName = over.baseName ?? id;
  const hasJpgKey = 'jpg' in over;
  const hasRawKey = 'raw' in over;
  const jpg = hasJpgKey ? over.jpg : jpgFile(baseName);
  const result: PhotoGroupInfo = {
    id: over.id ?? id,
    baseName,
    status: 'JPG_ONLY',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: false,
    // issue #200：默认「没进过 PS」。绝大多数用例与精修无关，不该被迫逐个声明。
    retouched: false,
    ...over,
  };
  // 显式传 undefined = 「键不存在」。spread 会留下 undefined 键，
  // 与真实扫描结果（`g.raw ? …` 分支）不等，必须删掉。
  if (hasJpgKey && jpg === undefined) delete result.jpg;
  else if (!hasJpgKey) result.jpg = jpg;
  if (hasRawKey && over.raw === undefined) delete result.raw;
  return result;
}
