/**
 * 宿主调色 ↔ LUMEN RAW recipe 的转换契约。
 *
 * 这些断言锁的是 Rust 侧 `lumen::tone_to_recipe` 的同名字段行为，两边必须一致
 * （见 toneToRecipe.ts 的注释）。改这里的期望值 = 改跨语言契约。
 */
import { describe, expect, it } from 'vitest';
import { toneToRecipe, recipeToTone, toneIsDirty } from './toneToRecipe';
import { DEFAULT_TONE } from './autoTone';
import type { ToneAdjustments } from '../types';

const tone: ToneAdjustments = {
  exposure: 0.65,
  highlights: -12,
  shadows: 34,
  temperature: -20,
  tint: 8,
  contrast: 15,
};

describe('toneToRecipe', () => {
  it('默认不带 temperature —— 宿主是绝对 K，lumen 是相对偏移，量纲不同', () => {
    const { adjustments } = toneToRecipe(tone);

    expect(adjustments).not.toHaveProperty('temperature');
    expect(Object.keys(adjustments).sort()).toEqual([
      'contrast',
      'exposure',
      'highlights',
      'shadows',
      'tint',
    ]);
  });

  it('显式开关才带 temperature', () => {
    const { adjustments } = toneToRecipe(tone, true);

    expect(adjustments.temperature).toBe(-20);
  });

  it('第二个参数为 false 与不传等价（不能被 truthy 判断误伤）', () => {
    expect(toneToRecipe(tone, false)).toEqual(toneToRecipe(tone));
  });

  it('4 位小数量化：0.65 不会被 f32 直转污染成 0.6499999761581421', () => {
    const { adjustments } = toneToRecipe(tone);

    expect(adjustments.exposure).toBe(0.65);
    expect(adjustments.exposure).toBe(Object.is(adjustments.exposure, 0.65) ? 0.65 : NaN);
  });

  it('长小数被截到 4 位而不是原样透传', () => {
    const { adjustments } = toneToRecipe({ ...tone, exposure: 0.123456789 });
    expect(adjustments.exposure).toBe(0.1235);
  });

  it('每条记录的十进制位都 ≤ 4（缓存键稳定性）', () => {
    const { adjustments } = toneToRecipe(tone, true);

    for (const value of Object.values(adjustments)) {
      const decimals = (String(value).split('.')[1] ?? '').length;
      expect(decimals).toBeLessThanOrEqual(4);
    }
  });

  it('NaN / Infinity 被安全归零，不会污染 recipe', () => {
    const { adjustments } = toneToRecipe(
      { ...tone, exposure: NaN, contrast: Infinity, shadows: -Infinity },
      true,
    );

    expect(adjustments.exposure).toBe(0);
    expect(adjustments.contrast).toBe(0);
    expect(adjustments.shadows).toBe(0);
  });

  it('temperature 越界被夹紧到滑杆量程（两侧单位统一后的新约束）', () => {
    const high = toneToRecipe({ ...tone, temperature: 500 }, true);
    const low = toneToRecipe({ ...tone, temperature: -500 }, true);

    expect(high.adjustments.temperature).toBe(100);
    expect(low.adjustments.temperature).toBe(-100);
  });

  it('recipeToTone 同样夹紧回读到的越界温度（UI 不失控）', () => {
    expect(recipeToTone({ temperature: 999 }).temperature).toBe(100);
    expect(recipeToTone({ temperature: -999 }).temperature).toBe(-100);
    expect(recipeToTone({ temperature: 40 }).temperature).toBe(40);
  });
  it('字段值是最终值而非增量（与 edit.apply 覆盖语义一致）', () => {
    const { adjustments } = toneToRecipe({ ...DEFAULT_TONE, shadows: 40 });
    expect(adjustments.shadows).toBe(40);
  });
});

describe('recipeToTone', () => {
  it('完整载荷逐字段回读', () => {
    expect(recipeToTone(toneToRecipe(tone, true).adjustments)).toEqual(tone);
  });

  it('缺失字段按 0 处理（宿主滑杆零点）', () => {
    expect(recipeToTone({ exposure: 1 })).toEqual({
      exposure: 1,
      highlights: 0,
      shadows: 0,
      temperature: 0,
      tint: 0,
      contrast: 0,
    });
  });

  it.each([
    ['undefined 载荷', undefined],
    ['空对象', {}],
  ])('%s → 全 0', (_label, payload) => {
    expect(recipeToTone(payload as never)).toEqual(DEFAULT_TONE);
  });

  it('非数字 / NaN / Infinity 一律归 0，不把脏值带进滑杆', () => {
    const dirty = recipeToTone({
      exposure: '0.5',
      highlights: null,
      shadows: NaN,
      temperature: Infinity,
      tint: -Infinity,
      contrast: undefined,
    } as never);

    expect(dirty).toEqual({
      exposure: 0,
      highlights: 0,
      shadows: 0,
      temperature: 0,
      tint: 0,
      contrast: 0,
    });
  });

  it('temperature 仍是 opt-in：默认不写，显式开关才写', () => {
    const withoutTemp = recipeToTone(toneToRecipe(tone).adjustments);
    const withTemp = recipeToTone(toneToRecipe(tone, true).adjustments);

    expect(withoutTemp.temperature).toBe(0);
    expect(withTemp.temperature).toBe(-20);
  });
});

describe('toneIsDirty', () => {
  it('全零 = 未改动', () => {
    expect(toneIsDirty(DEFAULT_TONE)).toBe(false);
  });

  it('任一字段偏离默认值即视为改动（含 temperature）', () => {
    for (const key of Object.keys(DEFAULT_TONE) as Array<keyof ToneAdjustments>) {
      expect(toneIsDirty({ ...DEFAULT_TONE, [key]: 0.01 })).toBe(true);
    }
  });

  it('显式传回全零对象（而非复用 DEFAULT_TONE 引用）仍判定为干净', () => {
    expect(toneIsDirty({ ...DEFAULT_TONE })).toBe(false);
  });

  it('往返转换后仍然判定为有改动（量化不会把改动抹平）', () => {
    const recovered = recipeToTone(toneToRecipe(tone, true).adjustments);
    expect(toneIsDirty(recovered)).toBe(true);
  });
});
