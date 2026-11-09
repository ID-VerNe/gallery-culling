/**
 * `toCullFlag` 唯一归属的护栏（issue #118，DRY #8）。
 *
 * 后端回传旗标是字符串（serde 不做枚举校验），落 UI 前只认 pick/reject，
 * 认不出来一律当 none。本文件钉死这一口径：动真值（`'none'`/`'reject'`）
 * 必须让用例红。
 */
import { describe, it, expect } from 'vitest';
import { toCullFlag } from './cullFlag';

describe('toCullFlag', () => {
  it('pick 原样返回', () => {
    expect(toCullFlag('pick')).toBe('pick');
  });

  it('reject 原样返回', () => {
    expect(toCullFlag('reject')).toBe('reject');
  });

  it('none 原样返回', () => {
    expect(toCullFlag('none')).toBe('none');
  });

  it('未知字符串当 none（不带偏筛选）', () => {
    expect(toCullFlag('')).toBe('none');
    expect(toCullFlag('PICK')).toBe('none');
    expect(toCullFlag('none2')).toBe('none');
    expect(toCullFlag(' pick')).toBe('none');
  });
});
