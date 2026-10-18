/**
 * 选片集 → 集合的边界（FR-10）。
 *
 * 这些用例盯的是「打开之后界面会不会说谎」：
 * - 配对 JPG 丢了却仍当 COMPLETE → LUMEN 关掉时整屏黑框；
 * - 同名文件来自不同目录却合成一组 → 一张照片的评级写到另一张上；
 * - 缺失项被悄悄丢掉 → 用户不知道少了哪几张；
 * - 调色基线丢了 → 面板显示全 0，用户点保存就把真实调色覆盖成 0。
 */
import { describe, it, expect } from 'vitest';
import { toAlbumGroups, toAlbumItems, sortAlbumGroups } from './albumGroups';
import type { AlbumOpenResult, AlbumResolvedDoc, PhotoGroupInfo } from '../types';

function doc(over: Partial<AlbumResolvedDoc> = {}): AlbumResolvedDoc {
  return {
    source: 'a.ARW',
    path: 'D:/shoot/raw/a.ARW',
    exists: true,
    isRaw: true,
    size: 100,
    mtime: 1000,
    jpgPath: null,
    jpgExists: false,
    jpgSize: 0,
    jpgMtime: 0,
    hasXmp: false,
    tone: null,
    rating: 0,
    flag: 'none',
    label: '',
    ...over,
  };
}

function result(entries: AlbumResolvedDoc[], missing = 0): AlbumOpenResult {
  return { path: 'D:/shoot/pick.galleryalbum', entries, missing };
}

describe('toAlbumGroups —— 分组重建', () => {
  it('RAW + 配对 JPG 重建为 COMPLETE，两条路径都保留', () => {
    const load = toAlbumGroups(
      result([
        doc({
          path: 'D:/shoot/raw/a.ARW',
          jpgPath: 'D:/shoot/jpg/a.JPG',
          jpgExists: true,
          jpgSize: 50,
          jpgMtime: 900,
        }),
      ]),
    );
    expect(load.groups).toHaveLength(1);
    const g = load.groups[0];
    expect(g.status).toBe('COMPLETE');
    expect(g.raw?.path).toBe('D:/shoot/raw/a.ARW');
    expect(g.jpg?.path).toBe('D:/shoot/jpg/a.JPG');
    expect(g.jpg?.size).toBe(50);
    expect(g.jpg?.extension).toBe('jpg');
    expect(g.baseName).toBe('a');
  });

  it('没有配对 JPG 的 RAW 是 RAW_ONLY，且不许造一个假的 jpg', () => {
    const load = toAlbumGroups(result([doc()]));
    expect(load.groups[0].status).toBe('RAW_ONLY');
    expect(load.groups[0].jpg).toBeUndefined();
  });

  it('主路径是 JPG 时进 jpg 槽位，状态是 JPG_ONLY', () => {
    const load = toAlbumGroups(
      result([doc({ path: 'D:/shoot/a.JPG', isRaw: false, source: 'a.JPG' })]),
    );
    expect(load.groups[0].status).toBe('JPG_ONLY');
    expect(load.groups[0].raw).toBeUndefined();
    expect(load.groups[0].jpg?.path).toBe('D:/shoot/a.JPG');
  });

  it('缺失项进 missing、不进 groups（没文件就渲染不出来）', () => {
    const load = toAlbumGroups(
      result([doc(), doc({ path: 'D:/shoot/gone.ARW', exists: false, source: 'gone.ARW' })], 1),
    );
    expect(load.groups).toHaveLength(1);
    expect(load.missing).toHaveLength(1);
    expect(load.missing[0].source).toBe('gone.ARW');
  });

  it('配对 JPG 被删了只算缺配对，主文件仍在就还能看', () => {
    const load = toAlbumGroups(result([doc({ jpgPath: null, jpgExists: false })]));
    expect(load.groups[0].status).toBe('RAW_ONLY');
    expect(load.groups[0].jpg).toBeUndefined();

    // 后端把「记着但不在」的路径吞掉了，这里再兜一层：哪怕传了路径，
    // jpgExists=false 也不能当成有 JPG（否则视口拿不存在的文件去渲染）。
    const load2 = toAlbumGroups(
      result([doc({ jpgPath: 'D:/shoot/jpg/a.JPG', jpgExists: false })]),
    );
    expect(load2.groups[0].status).toBe('RAW_ONLY');
    expect(load2.groups[0].jpg).toBeUndefined();
  });

  it('不同目录的同名文件不能合成一组（id 用路径，不用文件名）', () => {
    const load = toAlbumGroups(
      result([
        doc({ path: 'D:/cardA/DSC1.ARW', source: 'D:/cardA/DSC1.ARW' }),
        doc({ path: 'E:/cardB/DSC1.ARW', source: 'E:/cardB/DSC1.ARW' }),
      ]),
    );
    expect(load.groups).toHaveLength(2);
    expect(load.groups[0].id).not.toBe(load.groups[1].id);
    expect(load.groups[0].baseName).toBe(load.groups[1].baseName);
  });

  it('调色基线按 id 进 tones（面板不能显示全 0）', () => {
    const tone = {
      exposure: 0.65,
      highlights: -20,
      shadows: 0,
      temperature: 0,
      tint: 0,
      contrast: 15,
    };
    const load = toAlbumGroups(result([doc({ tone })]));
    expect(load.tones[load.groups[0].id]).toEqual(tone);
    expect(load.groups[0].tone).toEqual(tone);
  });

  it('旗标归一化：认不出来的一律 none', () => {
    const load = toAlbumGroups(result([doc({ flag: 'weird' })]));
    expect(load.groups[0].flag).toBe('none');
  });

  it('hasXmp 原样带出（宫格角标与导出文件计数都靠它）', () => {
    const load = toAlbumGroups(result([doc({ hasXmp: true })]));
    expect(load.groups[0].hasXmp).toBe(true);
  });

  it('exif 透传（后端已按配对 JPG 优先读过，转换层不再判断）', () => {
    const exif = { iso: '800', aperture: 'f/2.8', shutterSpeed: '1/500' };
    const load = toAlbumGroups(result([doc({ exif })]));
    expect(load.groups[0].exif).toEqual(exif);
  });

  it('没有 exif 的组保持 undefined，不编一个空对象', () => {
    // 空对象会让 `g.exif` 为真，App 里「缺几张」的计数就永远算不到它。
    const load = toAlbumGroups(result([doc({ exif: null })]));
    expect(load.groups[0].exif).toBeUndefined();
  });
});

describe('toAlbumItems —— 保存时取哪些路径', () => {
  const group = (over: Partial<PhotoGroupInfo>): PhotoGroupInfo => ({
    id: 'x',
    baseName: 'a',
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: false,
    ...over,
  });

  it('RAW 优先，配对 JPG 单独给一条', () => {
    const items = toAlbumItems([
      group({
        status: 'COMPLETE',
        raw: { name: 'a.ARW', extension: 'arw', path: 'D:/r/a.ARW', size: 1, mtime: 1 },
        jpg: { name: 'a.JPG', extension: 'jpg', path: 'D:/j/a.JPG', size: 1, mtime: 1 },
        rating: 4,
        flag: 'pick',
        label: 'Red',
      }),
    ]);
    expect(items).toEqual([
      { path: 'D:/r/a.ARW', jpgPath: 'D:/j/a.JPG', rating: 4, flag: 'pick', label: 'Red' },
    ]);
  });

  it('JPG-only 的组不给自己当配对（jpgPath 为 null）', () => {
    const items = toAlbumItems([
      group({
        status: 'JPG_ONLY',
        jpg: { name: 'b.JPG', extension: 'jpg', path: 'D:/j/b.JPG', size: 1, mtime: 1 },
      }),
    ]);
    expect(items[0]).toMatchObject({ path: 'D:/j/b.JPG', jpgPath: null });
  });

  it('没有任何文件路径的组被跳过（不该产生空 source）', () => {
    expect(toAlbumItems([group({})])).toEqual([]);
  });
});

describe('sortAlbumGroups —— 选片集视图本地排序', () => {
  const g = (baseName: string, rating: number, mtime: number): PhotoGroupInfo => ({
    id: baseName,
    baseName,
    status: 'RAW_ONLY',
    rating,
    flag: 'none',
    label: '',
    hasXmp: false,
    raw: { name: `${baseName}.ARW`, extension: 'arw', path: `/x/${baseName}.ARW`, size: 1, mtime },
  });

  it('按文件名', () => {
    const out = sortAlbumGroups([g('b', 1, 2), g('a', 5, 9)], 'filename');
    expect(out.map((x) => x.baseName)).toEqual(['a', 'b']);
  });

  it('按星级降序，同分按文件名', () => {
    const out = sortAlbumGroups([g('a', 1, 0), g('c', 5, 0), g('b', 5, 0)], 'rating');
    expect(out.map((x) => x.baseName)).toEqual(['b', 'c', 'a']);
  });

  it('按时间升序，同一时刻按文件名（选片集没有 EXIF，用 mtime 近似）', () => {
    const out = sortAlbumGroups([g('b', 0, 300), g('a', 0, 100), g('c', 0, 100)], 'time_filename');
    expect(out.map((x) => x.baseName)).toEqual(['a', 'c', 'b']);
  });

  it('不改原数组（集合是 React state，就地排序会让 memo 失效）', () => {
    const input = [g('b', 0, 2), g('a', 0, 1)];
    sortAlbumGroups(input, 'filename');
    expect(input.map((x) => x.baseName)).toEqual(['b', 'a']);
  });
});
