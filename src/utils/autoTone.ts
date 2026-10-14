import { ToneAdjustments } from '../types';

export const DEFAULT_TONE: ToneAdjustments = {
  exposure: 0,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tint: 0,
  contrast: 0,
};

/**
 * Compute smart auto-tone parameters based on image histogram analysis
 * Implements Zone V (18% middle gray) log-average exposure and Gray World white balance
 */
export function computeAutoTone(imgElement: HTMLImageElement): ToneAdjustments {
  try {
    const canvas = document.createElement('canvas');
    const sampleSize = 128;
    canvas.width = sampleSize;
    canvas.height = sampleSize;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { ...DEFAULT_TONE };

    ctx.drawImage(imgElement, 0, 0, sampleSize, sampleSize);
    const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
    const data = imageData.data;
    const totalPixels = sampleSize * sampleSize;

    let logSum = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let validColorCount = 0;

    const histogram = new Uint32Array(256);

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Perceptual luminance (Rec. 709)
      const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      histogram[lum]++;

      // Accumulate for log-average luminance (avoid log(0))
      logSum += Math.log(1.0 + lum);

      // Collect non-clipped pixels for Gray World white balance
      if (lum > 15 && lum < 240) {
        sumR += r;
        sumG += g;
        sumB += b;
        validColorCount++;
      }
    }

    // 1. Log-average luminance: L_log = exp(1/N * sum(ln(1 + Y)))
    const logAvgLum = Math.exp(logSum / totalPixels) - 1.0;

    // Target middle gray in sRGB is ~118 (18% linear gray under 2.2 gamma)
    const targetMidGray = 118.0;
    let autoExposure = 0;
    if (logAvgLum > 5) {
      autoExposure = Math.log2(targetMidGray / logAvgLum);
    }
    // Clamp exposure between -1.5 EV and +2.0 EV
    autoExposure = Math.max(-1.5, Math.min(2.0, autoExposure));
    autoExposure = Math.round(autoExposure * 20) / 20; // 0.05 step

    // 2. Percentile analysis for Highlights & Shadows
    let count = 0;
    let p05 = 0;
    let p95 = 255;
    const threshold05 = totalPixels * 0.05;
    const threshold95 = totalPixels * 0.95;

    for (let val = 0; val < 256; val++) {
      count += histogram[val];
      if (count >= threshold05 && p05 === 0) {
        p05 = val;
      }
      if (count >= threshold95) {
        p95 = val;
        break;
      }
    }

    // If shadows crushed (p05 < 25), lift shadows
    let autoShadows = 0;
    if (p05 < 30) {
      autoShadows = Math.min(60, Math.round((30 - p05) * 1.6));
    }

    // If highlights blown (p95 > 235), pull highlights down
    let autoHighlights = 0;
    if (p95 > 235) {
      autoHighlights = -Math.min(50, Math.round((p95 - 235) * 1.5));
    }

    // 3. Contrast based on dynamic range spread
    const dynamicRange = p95 - p05;
    let autoContrast = 0;
    if (dynamicRange < 150) {
      autoContrast = Math.min(25, Math.round((150 - dynamicRange) * 0.25));
    }

    // 4. Gray World White Balance
    let autoTemp = 0;
    let autoTint = 0;
    if (validColorCount > 100) {
      const avgR = sumR / validColorCount;
      const avgG = sumG / validColorCount;
      const avgB = sumB / validColorCount;
      const avgAll = (avgR + avgG + avgB) / 3.0;

      if (avgAll > 10) {
        // R higher than B -> image is too warm -> cool down (negative temp)
        const redBlueDiff = (avgR - avgB) / avgAll;
        autoTemp = -Math.round(redBlueDiff * 45);
        autoTemp = Math.max(-40, Math.min(40, autoTemp));

        // Green deviation
        const greenDiff = (avgG - (avgR + avgB) / 2) / avgAll;
        autoTint = -Math.round(greenDiff * 45);
        autoTint = Math.max(-30, Math.min(30, autoTint));
      }
    }

    return {
      exposure: autoExposure,
      highlights: autoHighlights,
      shadows: autoShadows,
      temperature: autoTemp,
      tint: autoTint,
      contrast: autoContrast,
    };
  } catch (err) {
    console.warn('Failed to compute auto tone:', err);
    return { ...DEFAULT_TONE };
  }
}

/**
 * Generate CSS filter string for instant GPU accelerated tone rendering
 */
export function getToneFilterString(tone?: ToneAdjustments): string {
  if (!tone) return 'none';

  const { exposure, contrast, temperature, tint, shadows, highlights } = tone;
  if (
    exposure === 0 &&
    contrast === 0 &&
    temperature === 0 &&
    tint === 0 &&
    shadows === 0 &&
    highlights === 0
  ) {
    return 'none';
  }

  // Exposure: 2^EV
  const brightnessVal = Math.max(0.1, Math.pow(2, exposure) * (1 + shadows * 0.0025 + highlights * 0.0015));

  // Contrast: 100% baseline
  const contrastVal = Math.max(0.2, 1 + contrast / 100 * 0.35);

  const filters: string[] = [
    `brightness(${brightnessVal.toFixed(3)})`,
    `contrast(${contrastVal.toFixed(3)})`,
  ];

  // Temperature approximation using sepia & hue-rotate
  if (temperature > 0) {
    // Warm: sepia
    const warmAmount = (temperature / 100) * 0.25;
    filters.push(`sepia(${warmAmount.toFixed(2)})`);
  } else if (temperature < 0) {
    // Cool: hue-rotate towards blue
    const coolAmount = (-temperature / 100) * 15;
    filters.push(`hue-rotate(${coolAmount.toFixed(1)}deg)`);
  }

  if (tint !== 0) {
    const tintAmount = (tint / 100) * 10;
    filters.push(`hue-rotate(${tintAmount.toFixed(1)}deg)`);
  }

  return filters.join(' ');
}

/**
 * C3：调色逐字段严格比较。
 *
 * 滑杆值都是量化后的整数/定点数（见 models 侧），严格相等即可，不需要容差。
 * 与 `DEFAULT_TONE` 同处一文件是因为它们回答同一个问题：「当前调色值是什么」。
 */
export function toneEquals(a: ToneAdjustments, b: ToneAdjustments): boolean {
  return (Object.keys(a) as Array<keyof ToneAdjustments>).every((k) => a[k] === b[k]);
}
