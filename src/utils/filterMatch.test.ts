/**
 * 筛选谓词与每档计数（M-14）。
 *
 * 核心不变量：**计数与过滤必须来自同一份谓词**。所以这里既逐档断言谓词口径，
 * 又用「对同一数组跑一遍 filter 的长度」交叉验证 `countByFilter`，并额外断言
 * `counts.all === groups.length` 与「star 档单调不增」这类结构性不变量 ——
 * 三者联动，任何一处谓词写歪都会被抓住。
 */
import { describe, expect, it } from 'vitest';
import { ALL_FILTER_MODES, countByFilter, matchesFilter } from './filterMatch';
import type { CullFlag, FilterMode, PhotoGroupInfo } from '../types';

function group(id: string, flag: CullFlag, rating: number): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    status: 'JPG_ONLY',
    rating,
    flag,
    hasXmp: false,
  };
}

/** 覆盖每个档位边界：保留/淘汰/未标记、0★/1★/3★/4★/5★。 */
const FIXTURE: PhotoGroupInfo[] = [
  group('a', 'pick', 3),
  group('b', 'reject', 0),
  group('c', 'none', 0), // 未标记
  group('d', 'none', 5), // 5 星精选
  group('e', 'pick', 1),
  group('f', 'none', 3),
  group('g', 'none', 4), // 4 星：用于区分 star4 与 star5 的口径
];

const EXPECTED: Record<FilterMode, number> = {
  all: 7,
  pick: 2, // a, e
  reject: 1, // b
  unmarked: 1, // c
  star1: 5, // a, d, e, f, g
  star2: 4, // a, d, f, g
  star3: 4, // a, d, f, g
  star4: 2, // d, g
  star5: 1, // d
};

describe('matchesFilter —— 逐档口径', () => {
  it('all 恒真', () => {
    for (const g of FIXTURE) expect(matchesFilter(g, 'all')).toBe(true);
  });

  it('pick / reject 只看旗标', () => {
    expect(FIXTURE.filter((g) => matchesFilter(g, 'pick')).map((g) => g.id)).toEqual(['a', 'e']);
    expect(FIXTURE.filter((g) => matchesFilter(g, 'reject')).map((g) => g.id)).toEqual(['b']);
  });

  it('unmarked = 既无旗标也无星级', () => {
    expect(FIXTURE.filter((g) => matchesFilter(g, 'unmarked')).map((g) => g.id)).toEqual(['c']);
    // 淘汰但 0 星不算「未标记」（它已被标记）
    expect(matchesFilter(group('x', 'reject', 0), 'unmarked')).toBe(false);
  });

  it('star3 = rating>=3（含 4/5 星），star5 = rating===5', () => {
    expect(FIXTURE.filter((g) => matchesFilter(g, 'star3')).map((g) => g.id)).toEqual([
      'a',
      'd',
      'f',
      'g',
    ]);
    expect(FIXTURE.filter((g) => matchesFilter(g, 'star5')).map((g) => g.id)).toEqual(['d']);
    // 3 星 / 4 星都不算 5 星精选
    expect(matchesFilter(group('y', 'none', 3), 'star5')).toBe(false);
    expect(matchesFilter(group('z', 'none', 4), 'star5')).toBe(false);
  });
});

describe('countByFilter —— 计数与谓词一致', () => {
  it('每个档位都等于对同一数组跑 matchesFilter 的长度', () => {
    const counts = countByFilter(FIXTURE);
    for (const mode of ALL_FILTER_MODES) {
      const viaFilter = FIXTURE.filter((g) => matchesFilter(g, mode)).length;
      expect(counts[mode], `档位 ${mode}`).toBe(viaFilter);
    }
  });

  it('命中固定期望值（防止谓词与用例一起被写歪）', () => {
    expect(countByFilter(FIXTURE)).toEqual(EXPECTED);
  });

  it('不变量：all 计数 === 分组总数', () => {
    expect(countByFilter(FIXTURE).all).toBe(FIXTURE.length);
    expect(countByFilter([]).all).toBe(0);
  });

  it('不变量：星级档单调不增（star1 ≥ star2 ≥ … ≥ star5）', () => {
    const c = countByFilter(FIXTURE);
    expect(c.star1).toBeGreaterThanOrEqual(c.star2);
    expect(c.star2).toBeGreaterThanOrEqual(c.star3);
    expect(c.star3).toBeGreaterThanOrEqual(c.star4);
    expect(c.star4).toBeGreaterThanOrEqual(c.star5);
  });

  it('不变量：pick + reject + 已打星但未标记 … 覆盖不重不漏的一个抽样', () => {
    // 每张照片恰好落入「pick / reject / unmarked」之一或另有旗标+星级的组合，
    // 这里只断言一个可验证的守恒式：pick + reject + unmarked 覆盖所有互斥的显式状态。
    const c = countByFilter(FIXTURE);
    const explicit = FIXTURE.filter(
      (g) => g.flag === 'pick' || g.flag === 'reject' || (g.flag === 'none' && g.rating === 0),
    ).length;
    expect(c.pick + c.reject + c.unmarked).toBe(explicit);
  });

  it('空数组时所有档位为 0（不是 undefined）', () => {
    const counts = countByFilter([]);
    for (const mode of ALL_FILTER_MODES) expect(counts[mode]).toBe(0);
  });
});
