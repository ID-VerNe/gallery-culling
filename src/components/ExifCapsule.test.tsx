/**
 * ExifCapsule 材质可读性结构不变量（issue #18 · PC-2）。
 *
 * jsdom 测不了「胶囊在照片上读着对不对」,只能钉结构不变量:
 *  - 外层胶囊的底色是 `bg-background-base/85`(不是 /75),
 *    虚化是 `backdrop-blur-lg`(不是 -md),
 *    默认正文色是 `text-white/85`(不是 /80)。
 *
 * 这些是 PC-2 的「令牌类有产出规则」锚点:只要这几条 className 在,
 * `scripts/check-theme-alpha.mjs` 就能保证 Tailwind 产物里有对应规则,
 * 不会重演 issue #15 的「/NN 静默丢弃」。视觉是否真的读得清,待真机回签。
 */
import { describe, it, expect } from 'vitest';
import capsuleSource from './ExifCapsule.tsx?raw';
import { render } from '@testing-library/react';
import { ExifCapsule } from './ExifCapsule';
import type { ExifData } from '../types';

const exif: ExifData = {
  cameraModel: 'Canon EOS R5',
  lensModel: 'RF 24-70mm F2.8',
  focalLength: '50mm',
  aperture: 'f/2.8',
  shutterSpeed: '1/200',
  iso: '400',
  dateTime: '2024:01:01 12:00:00',
};

describe('ExifCapsule —— 材质可读性（issue #18 · PC-2）', () => {
  it('外层胶囊底色用 bg-background-base/85,不再用 /75', () => {
    const { container } = render(<ExifCapsule exif={exif} />);
    const capsule = container.firstElementChild as HTMLElement;
    expect(capsule).not.toBeNull();
    expect(capsule.className).toContain('bg-background-base/85');
    expect(capsule.className).not.toContain('bg-background-base/75');
  });

  it('外层胶囊虚化用 backdrop-blur-lg,不再用 backdrop-blur-md', () => {
    const { container } = render(<ExifCapsule exif={exif} />);
    const capsule = container.firstElementChild as HTMLElement;
    expect(capsule.className).toContain('backdrop-blur-lg');
    expect(capsule.className).not.toContain('backdrop-blur-md');
  });

  it('外层默认正文色提为 text-white/85（不再用 /80）', () => {
    const { container } = render(<ExifCapsule exif={exif} />);
    const capsule = container.firstElementChild as HTMLElement;
    expect(capsule.className).toContain('text-white/85');
    expect(capsule.className).not.toMatch(/text-white\/80\b/);
  });
});

/**
 * 浮层胶囊圆角定档（issue #40 · PA-7）。
 *
 * jsdom 目视不了 6px 与 8px 的差别，这里钉的是**档位**：浮层胶囊是叠在照片上的
 * 小信息条，统一 `rounded-md`（6px）；面板（`Modal.tsx` 的 `rounded-xl` / 12px）
 * 是另一个层级，两者刻意不拍平成一档。
 *
 * 断言瞄的是源文件里胶囊 className 的圆角子串——有人把 `rounded-md` 写回
 * `rounded-lg`（8px）时这条会红，这就是本 issue 的墓碑。
 */
describe('ExifCapsule —— 浮层胶囊圆角定档（issue #40）', () => {
  it('胶囊外层圆角是 rounded-md，不是 rounded-lg', () => {
    // 用「底色 + 虚化 + 内边距」锁定外层胶囊那一行，再取其圆角类。
    const capsule = capsuleSource.match(
      /absolute top-3 right-3 bg-background-base\/85 backdrop-blur-lg px-3\.5 py-2\.5 (rounded-\S+)/,
    );
    expect(capsule).not.toBeNull();
    expect(capsule?.[1]).toBe('rounded-md');
  });
});
