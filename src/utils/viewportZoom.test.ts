/**
 * 三视口共用的缩放几何 —— 1:1 比例这一档。
 *
 * `scale` 的语义是「相对适应窗口的倍数」：scale=1 = 适应，不是 1:1。
 * 真 1:1（一个图片像素 = 一个屏幕像素）的倍数是 `naturalWidth / 显示宽度`，
 * 取决于原图尺寸与窗口大小，只能算、不能写死。
 */
import { describe, expect, it } from 'vitest';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampScale,
  oneToOneScale,
  scaleLabel,
} from './viewportZoom';

describe('oneToOneScale', () => {
  it('6024px 原图显示在 1200px 宽：5.02×', () => {
    expect(oneToOneScale(6024, 1200)).toBeCloseTo(5.02, 2);
  });

  it('小图（1600）显示在 800px：2×', () => {
    expect(oneToOneScale(1600, 800)).toBe(2);
  });

  it('显示宽度为 0 / NaN / 负数 → null（不能除零，也不能给出 Infinity）', () => {
    expect(oneToOneScale(6024, 0)).toBeNull();
    expect(oneToOneScale(6024, Number.NaN)).toBeNull();
    expect(oneToOneScale(6024, -10)).toBeNull();
    expect(oneToOneScale(0, 1200)).toBeNull();
    expect(oneToOneScale(Number.NaN, 1200)).toBeNull();
  });

  it('结果夹到量程内：窗口极小时取 ZOOM_MAX，而不是返回一个用不了的比例', () => {
    expect(oneToOneScale(100_000, 100)).toBe(ZOOM_MAX);
  });

  it('量程必须容得下 24MP 在窄窗口下的 1:1（否则 1:1 永远到不了）', () => {
    // 6024 / 600 ≈ 10.04 —— 旧的 ZOOM_MAX=10 会把它夹成 10，差 0.4% 但
    // 意味着「1:1」标签在窄窗口下是假的。这里把容量作为不变量锁死。
    const narrow = oneToOneScale(6024, 600);
    expect(narrow).not.toBeNull();
    expect(narrow as number).toBeGreaterThan(10);
    expect(narrow as number).toBeLessThanOrEqual(ZOOM_MAX);
  });
});

describe('scaleLabel 与 1:1 读数', () => {
  it('scale=1 说「适应」，不说 100%（C6）', () => {
    expect(scaleLabel(1)).toBe('适应');
  });

  it('5.02 说 502%', () => {
    expect(scaleLabel(5.02)).toBe('502%');
  });
});

describe('clampScale 与 1:1 的边界', () => {
  it('1:1 比例落在量程内时不被改动', () => {
    expect(clampScale(5.02)).toBe(5.02);
  });

  it('量程下界仍由 ZOOM_MIN 守住', () => {
    expect(clampScale(0.01)).toBe(ZOOM_MIN);
  });
});
