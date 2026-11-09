import type { CullFlag } from '../types';

/**
 * 后端回传的旗标是字符串（serde 不做枚举校验）。落到 UI 前收一次口 ——
 * 认不出来就当没有，别让类型外的值带偏筛选。
 *
 * 唯一真值（issue #118，DRY #8）：`albumGroups` 与 `useXmpRefresh` 共用此函数。
 */
export function toCullFlag(flag: string): CullFlag {
  return flag === 'pick' || flag === 'reject' ? flag : 'none';
}
