/**
 * 自动调色采样失败的显式契约（问题二防再犯，2026-10-15）。
 *
 * 修复前：canvas 被污染（跨源 asset 图未带 CORS）时 getImageData 抛
 * SecurityError，catch 里 console.warn 后**静默返回全 0** —— 调用方把
 * 「失败」当「算完」写进滑杆，用户看到「点了自动没反应」。真窗口 e2e
 * 复现：断言B1=false + console.warn「The canvas has been tainted by
 * cross-origin data.」。
 *
 * 修复后：失败必须返回 null，由调用方决定回退（CORS 副本重采样）或报错，
 * 绝不静默把全 0 当结果写进滑杆。
 *
 * 注意：jsdom 无 canvas 实现（getContext 默认 null），故显式 mock。
 */
import { describe, expect, it, vi } from 'vitest';
import { computeAutoTone } from './autoTone';

function mockCtx(getImageData: () => ImageData) {
  const ctx = {
    drawImage: vi.fn(),
    getImageData: vi.fn(getImageData),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
}

describe('computeAutoTone —— 采样失败返回 null（问题二防再犯）', () => {
  it('getImageData 抛 SecurityError（canvas 被污染）→ null，不得静默返回全 0', () => {
    mockCtx(() => {
      throw new DOMException(
        'The canvas has been tainted by cross-origin data.',
        'SecurityError',
      );
    });
    expect(computeAutoTone(new Image())).toBeNull();
  });

  it('getContext 返回 null（环境无 canvas）→ null', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(computeAutoTone(new Image())).toBeNull();
  });

  it('happy path：像素数据可读 → 返回非 null（防「一律 null」的过度修复）', () => {
    const data = new Uint8ClampedArray(128 * 128 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 100;
      data[i + 1] = 110;
      data[i + 2] = 120;
      data[i + 3] = 255;
    }
    mockCtx(() => ({ data, width: 128, height: 128 }) as ImageData);
    const result = computeAutoTone(new Image());
    expect(result).not.toBeNull();
    expect(typeof result!.exposure).toBe('number');
  });
});
