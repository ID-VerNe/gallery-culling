/**
 * 查询式筛选（FR-06）。
 *
 * 分三层断言，避免「解析对了但匹配错了」这种半绿状态：
 * 1. **解析**：每个字段/运算符都断言结构化结果，不只看「没报错」；
 * 2. **匹配**：每类字段都给出命中与不命中两侧，取反与 AND 单独覆盖；
 * 3. **性能**：10k 组 × 3 词条 <50ms（报告 NFR 的硬指标）。
 *
 * 另有一条**产品性**不变量单独测：解析出错时宫格不能变空。用户拼错一个字段
 * 就整屏清空，比不支持语法更糟。
 */
import { describe, expect, it } from 'vitest';
import { matchesParsedQuery, matchesQuery, parseQuery } from './queryMatch';
import type { PhotoGroupInfo } from '../types';

function group(over: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id: 'x',
    baseName: 'DSC01234',
    status: 'COMPLETE',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: false,
    ...over,
  };
}

/** 一条完整的 RAW+JPG 组，用于字段级断言。 */
const RICH = group({
  id: 'rich',
  baseName: 'DSC04477',
  status: 'COMPLETE',
  rating: 4,
  flag: 'pick',
  label: 'Red',
  hasXmp: true,
  jpg: {
    name: 'DSC04477.JPG',
    extension: 'jpg',
    path: 'D:/shoot/2026惠州西湖/DSC04477.JPG',
    size: 1,
    mtime: 0,
  },
  raw: {
    name: 'DSC04477.ARW',
    extension: 'arw',
    path: 'D:/shoot/2026惠州西湖/DSC04477.ARW',
    size: 1,
    mtime: 0,
  },
  edited: {
    name: 'DSC04477.jpg',
    extension: 'jpg',
    path: 'D:/export/DSC04477.jpg',
    size: 1,
    mtime: 0,
  },
  exif: {
    iso: '6400',
    aperture: 'f/2.8',
    shutterSpeed: '1/1000',
    focalLength: '85mm',
    cameraMake: 'SONY',
    cameraModel: 'ILCE-7M4',
    lensModel: 'FE 85mm F1.4 GM',
  },
});

// ————————————————————————— 解析 —————————————————————————

describe('parseQuery：字段与运算符', () => {
  it('数值字段带比较符', () => {
    const { terms, errors } = parseQuery('rating>=3');
    expect(errors).toEqual([]);
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({
      field: 'rating',
      op: '>=',
      value: 3,
      negated: false,
    });
  });

  it('冒号对数值字段是「等于」', () => {
    expect(parseQuery('rating:3').terms[0]).toMatchObject({
      field: 'rating',
      op: '=',
      value: 3,
    });
  });

  it('四种不等号都能解析', () => {
    for (const op of ['>=', '<=', '>', '<'] as const) {
      const { terms, errors } = parseQuery(`iso${op}3200`);
      expect(errors).toEqual([]);
      expect(terms[0]).toMatchObject({ field: 'iso', op, value: 3200 });
    }
  });

  it('取反前缀', () => {
    const { terms } = parseQuery('-flag:reject');
    expect(terms[0]).toMatchObject({ field: 'flag', op: '=', value: 'reject', negated: true });
  });

  it('裸词退化为文件名子串（兼容旧搜索框）', () => {
    const { terms, errors } = parseQuery('DSC0');
    expect(errors).toEqual([]);
    expect(terms[0]).toMatchObject({ field: 'name', op: 'contains', value: 'dsc0' });
  });

  it('name: 带通配符走 glob，不带通配符仍可工作', () => {
    expect(parseQuery('name:DSC0*').terms[0]).toMatchObject({ op: 'glob', value: 'dsc0*' });
    expect(parseQuery('name:DSC04477').terms[0]).toMatchObject({ op: 'glob' });
  });

  it('枚举值大小写不敏感并归一', () => {
    expect(parseQuery('label:Red').terms[0]).toMatchObject({ value: 'red' });
    expect(parseQuery('ext:ARW').terms[0]).toMatchObject({ value: 'arw' });
  });

  it('布尔字段不需要值', () => {
    expect(parseQuery('edited').terms[0]).toMatchObject({ field: 'edited', value: true });
    expect(parseQuery('-edited').terms[0]).toMatchObject({ field: 'edited', negated: true });
  });

  it('EXIF 数值宽容解析：f/2.8、1/500、85mm', () => {
    expect(parseQuery('aperture:f/2.8').terms[0]).toMatchObject({ value: 2.8 });
    expect(parseQuery('shutter:1/500').terms[0]).toMatchObject({ value: 0.002 });
    expect(parseQuery('focal:85mm').terms[0]).toMatchObject({ value: 85 });
  });

  it('多个词条按空白切分', () => {
    const { terms } = parseQuery('  rating>=3   label:red  -flag:reject ');
    expect(terms).toHaveLength(3);
  });

  it('空串解析为空词条、无错误', () => {
    const r = parseQuery('   ');
    expect(r.terms).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual([]);
  });
});

describe('parseQuery：错误与未完成输入', () => {
  it('值还空着的词条算「未完成」，不报错也不生效', () => {
    const r = parseQuery('iso:');
    expect(r.terms).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual(['iso:']);
  });

  it('未知字段报错并给出可用字段列表', () => {
    const { errors } = parseQuery('ratng:3');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ratng');
    expect(errors[0]).toContain('rating');
  });

  it('数值字段给非数字时报错并给示例', () => {
    const { errors } = parseQuery('iso:abc');
    expect(errors[0]).toContain('iso');
    expect(errors[0]).toContain('iso>=3200');
  });

  it('枚举字段给非法值时报错并列出可选值', () => {
    const { errors } = parseQuery('flag:maybe');
    expect(errors[0]).toContain('pick');
    expect(errors[0]).toContain('reject');
    expect(errors[0]).toContain('none');
  });

  it('一个词条出错不影响其余词条生效', () => {
    const r = parseQuery('rating>=3 ratng:1');
    expect(r.terms).toHaveLength(1);
    expect(r.terms[0].field).toBe('rating');
    expect(r.errors).toHaveLength(1);
  });
});

// ————————————————————————— 匹配 —————————————————————————

describe('matchesQuery：字段求值', () => {
  const hit = (q: string, g: PhotoGroupInfo = RICH) => matchesQuery(g, parseQuery(q).terms);
  const miss = (q: string, g: PhotoGroupInfo = RICH) => !matchesQuery(g, parseQuery(q).terms);

  it('rating 的四种比较', () => {
    expect(hit('rating>=4')).toBe(true);
    expect(miss('rating>=5')).toBe(true);
    expect(hit('rating<=4')).toBe(true);
    expect(miss('rating<4')).toBe(true);
    expect(hit('rating:4')).toBe(true);
    expect(miss('rating:3')).toBe(true);
  });

  it('flag / label 精确匹配', () => {
    expect(hit('flag:pick')).toBe(true);
    expect(miss('flag:reject')).toBe(true);
    expect(hit('label:red')).toBe(true);
    expect(miss('label:blue')).toBe(true);
  });

  it('label:none 命中无色标', () => {
    expect(hit('label:none', group({ label: '' }))).toBe(true);
    expect(miss('label:none')).toBe(true);
  });

  it('name 的 glob 与子串', () => {
    expect(hit('name:DSC0*')).toBe(true);
    expect(hit('name:*4477')).toBe(true);
    expect(miss('name:DSC1*')).toBe(true);
    expect(hit('DSC044')).toBe(true); // 裸词子串
    expect(miss('DSC999')).toBe(true);
  });

  it('ext 看组内任一文件', () => {
    expect(hit('ext:arw')).toBe(true);
    expect(hit('ext:jpg')).toBe(true);
    expect(miss('ext:nef')).toBe(true);
  });

  it('folder 是路径子串', () => {
    expect(hit('folder:惠州')).toBe(true);
    expect(hit('folder:2026')).toBe(true);
    expect(miss('folder:2025')).toBe(true);
  });

  it('edited 看精修成果是否存在', () => {
    expect(hit('edited')).toBe(true);
    expect(miss('edited', group())).toBe(true);
  });

  it('iso / aperture / shutter / focal 数值比较', () => {
    expect(hit('iso>=3200')).toBe(true);
    expect(miss('iso>6400')).toBe(true);
    expect(hit('aperture<=2.8')).toBe(true);
    expect(miss('aperture<2.8')).toBe(true);
    // 1/1000 秒比 1/500 快 → 数值更小
    expect(hit('shutter<=1/500')).toBe(true);
    expect(miss('shutter>1/500')).toBe(true);
    expect(hit('focal>=85')).toBe(true);
    expect(miss('focal>85')).toBe(true);
  });

  it('camera 同时看厂商与机型', () => {
    expect(hit('camera:sony')).toBe(true);
    expect(hit('camera:7m4')).toBe(true);
    expect(miss('camera:canon')).toBe(true);
  });

  it('lens 看镜头型号', () => {
    expect(hit('lens:85mm')).toBe(true);
    expect(hit('lens:gm')).toBe(true);
    expect(miss('lens:24-70')).toBe(true);
  });

  it('缺 EXIF 时数值字段不命中，但不抛错', () => {
    const bare = group();
    expect(matchesQuery(bare, parseQuery('iso>=100').terms)).toBe(false);
    expect(matchesQuery(bare, parseQuery('camera:sony').terms)).toBe(false);
  });

  it('取反', () => {
    expect(hit('-flag:reject')).toBe(true);
    expect(miss('-flag:pick')).toBe(true);
    expect(hit('-label:blue')).toBe(true);
    expect(hit('-edited', group())).toBe(true);
  });

  it('多词条是 AND', () => {
    expect(hit('rating>=3 label:red flag:pick')).toBe(true);
    expect(miss('rating>=3 label:red flag:reject')).toBe(true);
  });

  it('空词条恒真', () => {
    expect(matchesQuery(group(), [])).toBe(true);
  });
});

describe('matchesParsedQuery：解析出错时不把宫格清空', () => {
  it('有错误时全部通过（提示而非拒绝）', () => {
    const parsed = parseQuery('ratng:3');
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(matchesParsedQuery(group(), parsed)).toBe(true);
  });

  it('没错误时按词条求值', () => {
    expect(matchesParsedQuery(RICH, parseQuery('rating>=3'))).toBe(true);
    expect(matchesParsedQuery(group(), parseQuery('rating>=3'))).toBe(false);
  });
});

// ————————————————————————— 性能 —————————————————————————

describe('性能：10k 组 × 3 词条', () => {
  it('单次求值 <50ms（报告 NFR 硬指标）', () => {
    const groups: PhotoGroupInfo[] = Array.from({ length: 10_000 }, (_, i) =>
      group({
        id: `g${i}`,
        baseName: `DSC${String(i).padStart(5, '0')}`,
        rating: i % 6,
        flag: i % 3 === 0 ? 'pick' : i % 7 === 0 ? 'reject' : 'none',
        label: ['', 'Red', 'Blue', 'Green', 'Yellow', 'Purple'][i % 6],
        exif: {
          iso: String(100 * (1 + (i % 40))),
          aperture: `f/${[1.4, 2.8, 4, 8][i % 4]}`,
          shutterSpeed: ['1/1000', '1/250', '1/60'][i % 3],
          focalLength: `${[24, 50, 85, 135][i % 4]}mm`,
          cameraMake: 'SONY',
          cameraModel: 'ILCE-7M4',
          lensModel: 'FE 85mm F1.4 GM',
        },
      }),
    );

    const parsed = parseQuery('rating>=3 iso>=3200 -flag:reject');
    expect(parsed.errors).toEqual([]);

    // 跑三轮取最快：CI 上首次调用会吃到 JIT 预热与偶发调度抖动。
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 3; round++) {
      const t0 = performance.now();
      let n = 0;
      for (const g of groups) if (matchesParsedQuery(g, parsed)) n++;
      best = Math.min(best, performance.now() - t0);
      expect(n).toBeGreaterThan(0);
    }
    expect(best).toBeLessThan(50);
  });
});
