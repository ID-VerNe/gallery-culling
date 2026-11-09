/**
 * fileNameOf —— 取路径末段（issue #122）。
 *
 * 默认保留扩展名（展示位用），`stripExtension: true` 时剥扩展名（LR 匹配用）。
 * 墓碑：反斜杠一例钉住 Windows 原生路径，改回只切正斜杠 `/[\/]/` 必红。
 */
import { describe, expect, it } from 'vitest';
import { fileNameOf } from './pathNormalize';

describe('fileNameOf（默认保留扩展名）', () => {
  it('反斜杠 Windows 路径取末段（#122）', () => {
    expect(fileNameOf('D:\\shoot\\album.galleryalbum')).toBe('album.galleryalbum');
    expect(fileNameOf('D:\\shoot\\DSC04339.ARW')).toBe('DSC04339.ARW');
  });

  it('正斜杠路径取末段', () => {
    expect(fileNameOf('D:/shoot/album.galleryalbum')).toBe('album.galleryalbum');
    expect(fileNameOf('D:/shoot/DSC04339.ARW')).toBe('DSC04339.ARW');
  });

  it('混合分隔符取末段', () => {
    expect(fileNameOf('D:/shoot\\album.galleryalbum')).toBe('album.galleryalbum');
  });

  it('无扩展名原样返回末段', () => {
    expect(fileNameOf('D:/shoot/noext')).toBe('noext');
    expect(fileNameOf('D:\\shoot\\noext')).toBe('noext');
    expect(fileNameOf('album')).toBe('album');
  });

  it('无目录时返回整串', () => {
    expect(fileNameOf('album.galleryalbum')).toBe('album.galleryalbum');
  });

  it('空串返回空串', () => {
    expect(fileNameOf('')).toBe('');
  });
});

describe('fileNameOf（剥扩展名）', () => {
  it('剥扩展名', () => {
    expect(fileNameOf('D:\\shoot\\DSC04339.ARW', { stripExtension: true })).toBe('DSC04339');
    expect(fileNameOf('D:/shoot/a.b.cr3', { stripExtension: true })).toBe('a.b');
  });

  it('无扩展名原样返回', () => {
    expect(fileNameOf('D:/shoot/noext', { stripExtension: true })).toBe('noext');
  });

  it('空串返回空串', () => {
    expect(fileNameOf('', { stripExtension: true })).toBe('');
  });

  it('dot 在 0 处不剥（隐藏文件名）', () => {
    expect(fileNameOf('D:/shoot/.gallery', { stripExtension: true })).toBe('.gallery');
  });
});
