import { ToneAdjustments } from '../types';
import { DEFAULT_TONE } from './autoTone';

/**
 * 宿主 ToneAdjustments → LUMEN RAW recipe（`edit.apply` 的 changes 载荷）。
 *
 * **temperature 现在直通**：Step 12 修掉了真正的量纲错配。宿主滑杆是
 * `-100..=100` 的"冷暖偏移"，但宿主曾把它写进 `crs:Temperature`（Lightroom 视为
 * **绝对 Kelvin**，+30 → 30K → 通蓝废片）。现在两侧统一用相对刻度：宿主写
 * `crs:Temperature2012`，lumen 用 `adjustments.temperature`（实测同为 ±100，传 500
 * 会被截断成 100）。Rust 侧 `lumen::tone_to_recipe` 有对应实现与逐字段测试，
 * 两边必须保持一致。
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
    // 夹紧到滑杆量程：lumen 侧实测会把 500 截断成 100，宿主先夹紧则两侧一致
    adjustments.temperature = round4(clamp(tone.temperature, -100, 100));
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
    // 单位已统一（±100 相对），越界值夹紧以免 UI 失控
    temperature: clamp(pick('temperature'), -100, 100),
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

function clamp(v: number, min: number, max: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : 0;
}