import type { PhotoGroupInfo } from '../types';

/**
 * 分组的最优先磁盘路径：RAW 优先于 JPG。
 *
 * 调色写入、评级落盘、外部打开等所有「写/送外部」操作都必须作用在 RAW 上 ——
 * JPG 是 Luminar 之外的备份，用错了等于把参数写进成品而不是原片。
 *
 * 该表达式原先在 App.tsx 重复 12 次，抽出来是为了让「RAW 优先」这条规则
 * 只有一处真值；未来若要改成「按状态选路」（例如 RAW_ONLY 才用 raw），
 * 只需要改这一个函数。
 */
export function groupPath(group: PhotoGroupInfo | undefined): string | undefined {
  return group?.raw?.path || group?.jpg?.path;
}