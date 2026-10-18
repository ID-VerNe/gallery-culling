/**
 * `resolveViewportImage` 的口径护栏（三视口图片解析的单一真值，C2/M-02）。
 *
 * 这个纯函数被 PreviewViewport / SplitCompareViewport / BeforeAfterViewport
 * 共用，任何一处口径漂移都会同时破坏三个视图，所以在这里钉死：
 *  - JPG 优先（选片心智：有 JPG 绝不解码 RAW）；
 *  - RAW-only 分组只认 LUMEN 真实解码 —— 引擎没顶上时 src 必须是 null，
 *    而不是回落 .NEF 资产 URL（C2：浏览器解不了 .NEF，会永久破图）；
 *  - `lumenActive` 只在预览 URL 有效且未 latched 失败时为真（调用方据此
 *    决定是否叠加 CSS 调色滤镜 —— LUMEN 已 develop 过一次，再套会两次）。
 */
import { describe, it, expect } from 'vitest';
import { resolveViewportImage } from './viewportImage';
import type { PhotoGroupInfo } from '../types';

function jpgOnly(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    jpg: { name: `${id}.jpg`, extension: 'jpg', path: `D:/shoot/${id}.jpg`, size: 1, mtime: 0 },
    status: 'JPG_ONLY',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
  };
}

function rawPlusJpg(id: string): PhotoGroupInfo {
  return {
    ...jpgOnly(id),
    raw: { name: `${id}.NEF`, extension: 'NEF', path: `D:/shoot/${id}.NEF`, size: 1, mtime: 0 },
    status: 'COMPLETE',
  };
}

function rawOnly(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    raw: { name: `${id}.NEF`, extension: 'NEF', path: `D:/shoot/${id}.NEF`, size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
  };
}

const NO_LUMEN = { url: null };

describe('resolveViewportImage', () => {
  it('JPG 分组走 jpg 资产 URL', () => {
    const r = resolveViewportImage(jpgOnly('a'), NO_LUMEN, false);
    expect(r.src).toBe('asset://localhost/D:/shoot/a.jpg');
    expect(r.rawOnly).toBe(false);
    expect(r.lumenActive).toBe(false);
  });

  it('RAW+JPG 分组仍然 JPG 优先（选片心智不变）', () => {
    const r = resolveViewportImage(rawPlusJpg('a'), { url: 'asset://localhost/a.preview' }, false);
    expect(r.src).toBe('asset://localhost/D:/shoot/a.jpg');
    expect(r.rawOnly).toBe(false);
  });

  it('RAW-only + LUMEN 预览命中 → 走预览 URL（M-02）', () => {
    const r = resolveViewportImage(rawOnly('a'), { url: 'asset://localhost/a.NEF.preview' }, false);
    expect(r.src).toBe('asset://localhost/a.NEF.preview');
    expect(r.rawOnly).toBe(true);
    expect(r.lumenActive).toBe(true);
  });

  it('RAW-only + LUMEN 未命中 → src 为 null，而不是回落 .NEF（C2 破图修复）', () => {
    const r = resolveViewportImage(rawOnly('a'), NO_LUMEN, false);
    expect(r.src).toBeNull();
    expect(r.rawOnly).toBe(true);
    expect(r.lumenActive).toBe(false);
  });

  it('RAW-only + 预览曾渲染成功但随后加载失败（latch）→ src 为 null（C2）', () => {
    // 陈旧/损坏的缓存预览触发 <img onError> 后 latch：不能回落到 .NEF。
    const r = resolveViewportImage(rawOnly('a'), { url: 'asset://localhost/a.NEF.preview' }, true);
    expect(r.src).toBeNull();
    expect(r.rawOnly).toBe(true);
    // latch 只掐断 src，rawOnly 仍为真 —— 调用方据此渲染「需启用引擎」占位。
    expect(r.lumenActive).toBe(false);
  });

  it('没有分组 → src 为 null 且不是 rawOnly', () => {
    const r = resolveViewportImage(undefined, NO_LUMEN, false);
    expect(r.src).toBeNull();
    expect(r.rawOnly).toBe(false);
    expect(r.lumenActive).toBe(false);
  });

  it('有 JPG 时即使 lumen url 非空也不改 src（JPG 优先于一切）', () => {
    // useLumenPreview 有 JPG 时根本不发请求，url 恒为 null；这里防御性钉住
    // 纯函数口径：legacySrc 的优先级高于 lumen。
    const r = resolveViewportImage(rawPlusJpg('a'), { url: 'asset://localhost/a.preview' }, false);
    expect(r.src).toBe('asset://localhost/D:/shoot/a.jpg');
  });
});
