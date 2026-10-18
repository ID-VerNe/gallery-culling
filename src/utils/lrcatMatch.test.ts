import { describe, expect, it } from 'vitest';
import {
  baseNameOf,
  isBlankGroup,
  planLrcatImport,
  selectLrcatWrites,
} from './lrcatMatch';
import type { LrcatPhoto, PhotoGroupInfo } from '../types';

function group(over: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  const base = over.baseName ?? 'DSC1';
  const dir = over.id ? over.id.slice(0, over.id.lastIndexOf('/')) : 'D:/shoot';
  return {
    id: `${dir}/${base}`,
    baseName: base,
    raw: { name: `${base}.ARW`, extension: 'ARW', path: `${dir}/${base}.ARW`, size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: false,
    ...over,
  } as PhotoGroupInfo;
}

function photo(over: Partial<LrcatPhoto> = {}): LrcatPhoto {
  return { path: 'D:/shoot/DSC1.ARW', rating: 0, flag: 'none', label: '', ...over };
}

describe('planLrcatImport：路径优先，其次同目录同名', () => {
  it('绝对路径相同就命中（RAW）', () => {
    const g = group();
    const plan = planLrcatImport([g], [photo({ rating: 5 })]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].by).toBe('path');
    expect(plan.items[0].photo.rating).toBe(5);
    expect(plan.byPath).toBe(1);
    expect(plan.byName).toBe(0);
  });

  it('LR 里记的是配对 JPG 也能按路径命中', () => {
    const g = group({
      jpg: { name: 'DSC1.JPG', extension: 'JPG', path: 'D:/jpg/DSC1.JPG', size: 1, mtime: 0 },
      status: 'COMPLETE',
    });
    const plan = planLrcatImport([g], [photo({ path: 'D:/jpg/DSC1.JPG', rating: 4 })]);
    expect(plan.items[0].by).toBe('path');
    expect(plan.items[0].group.id).toBe(g.id);
  });

  it('同目录同 baseName 命中（LR 是 JPG、当前只有 RAW）', () => {
    const g = group();
    const plan = planLrcatImport([g], [photo({ path: 'D:/shoot/DSC1.JPG', rating: 3 })]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].by).toBe('name');
    expect(plan.byName).toBe(1);
  });

  it('跨目录同名**不**命中（套错评级比不导更糟）', () => {
    const g = group({ id: 'D:/shootA/DSC1' });
    const plan = planLrcatImport([g], [photo({ path: 'D:/shootB/DSC1.ARW', rating: 5 })]);
    expect(plan.items).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(1);
    expect(plan.missingInLr).toBe(1);
  });

  it('大小写与分隔符不同仍算同一路径', () => {
    const g = group({ id: 'D:/shoot/DSC1' });
    const plan = planLrcatImport([g], [photo({ path: 'd:\\SHOOT\\dsc1.arw', rating: 2 })]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].by).toBe('path');
  });

  it('LR 有、当前集合没有的进 unmatched，不静默丢弃', () => {
    const plan = planLrcatImport([group()], [
      photo({ path: 'D:/shoot/GONE.ARW', rating: 1 }),
      photo({ path: 'D:/shoot/DSC1.ARW', rating: 2 }),
    ]);
    expect(plan.items).toHaveLength(1);
    expect(plan.unmatched.map((p) => p.path)).toEqual(['D:/shoot/GONE.ARW']);
  });

  it('同一组只认领一条（LR 里 RAW+JPG 是两条记录）', () => {
    const g = group({
      jpg: { name: 'DSC1.JPG', extension: 'JPG', path: 'D:/shoot/DSC1.JPG', size: 1, mtime: 0 },
      status: 'COMPLETE',
    });
    const plan = planLrcatImport([g], [
      photo({ path: 'D:/shoot/DSC1.ARW', rating: 5, flag: 'pick' }),
      photo({ path: 'D:/shoot/DSC1.JPG', rating: 5, flag: 'pick' }),
    ]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].photo.path).toBe('D:/shoot/DSC1.ARW');
    // 第二条是「重复认领」而非「未匹配」—— 报告里不该说 LR 多了张照片。
    expect(plan.unmatched).toHaveLength(0);
  });

  it('missingInLr 只数没被认领的组', () => {
    const a = group({ baseName: 'A', id: 'D:/shoot/A' });
    const b = group({ baseName: 'B', id: 'D:/shoot/B' });
    const plan = planLrcatImport([a, b], [photo({ path: 'D:/shoot/A.ARW', rating: 1 })]);
    expect(plan.items).toHaveLength(1);
    expect(plan.missingInLr).toBe(1);
  });

  it('空输入不炸', () => {
    expect(planLrcatImport([], []).items).toHaveLength(0);
    expect(planLrcatImport([], [photo()]).unmatched).toHaveLength(1);
    expect(planLrcatImport([group()], []).missingInLr).toBe(1);
  });
});

describe('baseNameOf', () => {
  it('去掉目录与扩展名，兼容反斜杠', () => {
    expect(baseNameOf('D:\\shoot\\DSC04339.ARW')).toBe('DSC04339');
    expect(baseNameOf('D:/shoot/a.b.cr3')).toBe('a.b');
    expect(baseNameOf('D:/shoot/noext')).toBe('noext');
  });
});

describe('isBlankGroup：三轴一起判', () => {
  it('全空才算空白', () => {
    expect(isBlankGroup(group())).toBe(true);
  });
  it('任一轴有值就不算空白', () => {
    expect(isBlankGroup(group({ rating: 3 }))).toBe(false);
    expect(isBlankGroup(group({ flag: 'pick' }))).toBe(false);
    expect(isBlankGroup(group({ label: 'Red' }))).toBe(false);
  });
});

describe('selectLrcatWrites：默认只填空白', () => {
  const blank = group({ baseName: 'A', id: 'D:/shoot/A' });
  const rated = group({ baseName: 'B', id: 'D:/shoot/B', rating: 3 });
  const items = planLrcatImport(
    [blank, rated],
    [
      photo({ path: 'D:/shoot/A.ARW', rating: 5, flag: 'pick' }),
      photo({ path: 'D:/shoot/B.ARW', rating: 5 }),
    ],
  ).items;

  it('不覆盖时只写空白组，已有值的计入 skipped', () => {
    const { writes, skipped } = selectLrcatWrites(items, false);
    expect(writes.map((w) => w.group.baseName)).toEqual(['A']);
    expect(skipped).toBe(1);
  });

  it('勾了覆盖就全写', () => {
    const { writes, skipped } = selectLrcatWrites(items, true);
    expect(writes.map((w) => w.group.baseName)).toEqual(['A', 'B']);
    expect(skipped).toBe(0);
  });

  it('LR 里也是空值时不写（无意义写盘）', () => {
    const plan = planLrcatImport([blank], [photo({ path: 'D:/shoot/A.ARW' })]);
    const { writes, skipped } = selectLrcatWrites(plan.items, true);
    expect(writes).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('值已经一模一样时不写', () => {
    const same = group({ baseName: 'C', id: 'D:/shoot/C', rating: 4, flag: 'pick', label: 'Red' });
    const plan = planLrcatImport(
      [same],
      [photo({ path: 'D:/shoot/C.ARW', rating: 4, flag: 'pick', label: 'Red' })],
    );
    const { writes, skipped } = selectLrcatWrites(plan.items, true);
    expect(writes).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});
