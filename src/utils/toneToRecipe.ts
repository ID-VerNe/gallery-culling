import { ToneAdjustments } from '../types';
import { DEFAULT_TONE } from './autoTone';

/**
 * 宿主 ToneAdjustments → LUMEN RAW recipe（`edit.apply` 的 changes 载荷）。
 *
 * **temperature 被刻意排除**：宿主的 temperature 是绝对 K（XMP `crs:Temperature`
 * 基线 5350，见 xmp.rs），而 LUMEN RAW 的 `adjustments.temperature` 是**相对偏移**
 * （实测 `edit.get` 默认 0.0）。两者量纲不同，透传会把画面色温彻底带偏，所以只有
 * 在显式打开开关（等换算实现落地）时才带上。Rust 侧 `lumen::tone_to_recipe` 有
 * 一份对应实现与逐字段测试，两边必须保持一致。
 *
 * 字段值是**最终值**（不是增量）——lumen 的 `edit.apply` 按目标状态覆盖。
 */
export function toneToRecipe(
  tone: ToneAdjustments,
  includeTemperature = false,
): { adjustments: Record<string, number> } {
  const adjustments: Record<string, number> = {
    exposure: round4(tone.exposure),
    highlights: round4(tone.highlights),
    shadows: round4(tone.shadows),
    tint: round4(tone.tint),
    contrast: round4(tone.contrast),
  };
  if (includeTemperature) {
    adjustments.temperature = round4(tone.temperature);
  }
  return { adjustments };
}

/**
 * LUMEN RAW recipe（`edit.get` 的 `state.adjustments`）→ 宿主 ToneAdjustments。
 * 缺失字段按 0 处理（宿主滑块的零点）。
 */
export function recipeToTone(adjustments: Partial<Record<string, number>> | undefined): ToneAdjustments {
  const pick = (key: string): number =>
    typeof adjustments?.[key] === 'number' && Number.isFinite(adjustments[key] as number)
      ? (adjustments[key] as number)
      : 0;
  return {
    exposure: pick('exposure'),
    highlights: pick('highlights'),
    shadows: pick('shadows'),
    // 回读也不参与回写（量纲问题同上），仅作展示
    temperature: pick('temperature'),
    tint: pick('tint'),
    contrast: pick('contrast'),
  };
}

/** 宿主调色是否"有改动"（决定保存按钮是否可用）。 */
export function toneIsDirty(tone: ToneAdjustments): boolean {
  return (Object.keys(DEFAULT_TONE) as Array<keyof ToneAdjustments>).some(
    (k) => tone[k] !== DEFAULT_TONE[k],
  );
}

/**
 * 4 位小数量化：与 Rust 侧 `json_f32` 对齐。
 * 0.65 在 f32→JSON 直转会变成 0.6499999761581421，既污染缓存键也让"是否改动"
 * 的比较变脆。
 */
function round4(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}