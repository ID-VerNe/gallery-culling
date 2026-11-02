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
  ZOOM_STEP,
  chainScale,
  clampScale,
  isFitScale,
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

/**
 * PB-10：scale 是浮点连乘的产物，「适应」只能用容差判，不能用 `=== 1`。
 *
 * 判据必须**与读数共用同一条容差**：`scaleLabel` 说「适应」的那一段，
 * 双击也必须按「已适应」处理，否则出现「读数写适应、双击却当成已放大」。
 */
describe('isFitScale · 双击的「适应」判定（PB-10）', () => {
  it('1 本身算适应', () => {
    expect(isFitScale(1)).toBe(true);
  });

  it('浮点残差（1 ± 1e-16）算适应：连乘回不到整 1 是常态，不是故障', () => {
    expect(isFitScale(1 + 2.2e-16)).toBe(true);
    expect(isFitScale(0.9999999999999999)).toBe(true);
  });

  it('与读数同一口径：scaleLabel 说「适应」的比例，isFitScale 必须也为真', () => {
    const fitLooking = [1, 1 + 2.2e-16, 0.9999999, 1.0004];
    for (const s of fitLooking) {
      expect(scaleLabel(s)).toBe('适应');
    }
    // 1.0004 是肉眼不可见、但滚轮能造出来的偏离：读数仍写「适应」，
    // 若双击判 `=== 1` 就会把它当成「已放大」，双击变成缩小。
    expect(isFitScale(1.0004)).toBe(true);
  });

  it('真正放大的比例不算适应：1.25 / 2.5 / 0.2 都否', () => {
    expect(isFitScale(1.25)).toBe(false);
    expect(isFitScale(2.5)).toBe(false);
    expect(isFitScale(0.2)).toBe(false);
  });
});

describe('chainScale · 一格一格滚出来的比例', () => {
  it('夹紧：连滚到顶停在 ZOOM_MAX，连退到底停在 ZOOM_MIN', () => {
    let s = 1;
    for (let i = 0; i < 40; i++) s = chainScale(s, 1.25);
    expect(s).toBe(ZOOM_MAX);
    for (let i = 0; i < 80; i++) s = chainScale(s, 1 / 1.25);
    expect(s).toBe(ZOOM_MIN);
  });
});

/**
 * PB-10 的边界证据（如实记录，不美化）：
 *
 * `ZOOM_STEP = 1.25` 的一格往返在 IEEE754 下**精确**回到 1，连滚 8 格再
 * 连退 8 格也精确回到 1 —— **当前步长下 `=== 1` 与 `isFitScale` 的判定结果
 * 完全相同**。但这不是「严格相等可以留着」的许可：只要步长不是 2 的幂的
 * 倒数（如 1.4），同样的往返就落到 0.999…98，读数仍写「适应」、`=== 1`
 * 却判成已放大。所以判定只允许走 `isFitScale`，两条用例分别锁住现状与
 * 反面。
 */
describe('PB-10 · 严格相等的有效期取决于步长', () => {
  it('ZOOM_STEP 的一格往返在当前取值下是精确的', () => {
    const s = chainScale(chainScale(1, ZOOM_STEP), 1 / ZOOM_STEP);
    // 当前 ZOOM_STEP=1.25 时 s 精确为 1：这份「相等」是步长的巧合，不是
    // 判定可以写死 `=== 1` 的许可。下一条用例给出反面。
    expect(s).toBe(1);
    expect(isFitScale(s)).toBe(true);
  });

  it('换一个步长（1.4）连滚三格再连退三格：比例偏离 1，这就是为什么要容差', () => {
    let s = 1;
    for (let i = 0; i < 3; i++) s = chainScale(s, 1.4);
    for (let i = 0; i < 3; i++) s = chainScale(s, 1 / 1.4);
    expect(s).not.toBe(1);
    expect(scaleLabel(s)).toBe('适应');
    expect(isFitScale(s)).toBe(true);
  });
});
