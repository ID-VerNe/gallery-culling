/**
 * 命中光标缩放（M-08）的数学模型守护。
 *
 * 核心不变量：**缩放前后，光标下的那个图像点必须落在同一个屏幕位置**。
 * 用两套坐标互相验证 —— 任何一处符号/系数写错都会立即暴露。
 */
import { describe, expect, it } from 'vitest';
import { zoomAtPoint } from './zoom';

const RECT = { left: 0, top: 0, width: 1200, height: 800 };
const O = { x: RECT.left + RECT.width / 2, y: RECT.top + RECT.height / 2 };
const OPTS = { min: 0.2, max: 10, step: 1.25 };

/** 图像点（相对中心，即 p − O）在给定 scale/pos 下映射到的屏幕位置。 */
const screenOfRel = (
  rel: { x: number; y: number },
  scale: number,
  pos: { x: number; y: number },
) => ({
  x: O.x + pos.x + scale * rel.x,
  y: O.y + pos.y + scale * rel.y,
});

/** 光标 m 对应的图像坐标（与 scale/pos 逆运算）。 */
const imageOf = (
  m: { x: number; y: number },
  scale: number,
  pos: { x: number; y: number },
) => ({
  x: (m.x - O.x - pos.x) / scale,
  y: (m.y - O.y - pos.y) / scale,
});

describe('zoomAtPoint —— 光标锚定不变量', () => {
  it('光标下的图像点在缩放前后落在同一屏幕位置', () => {
    const m = { x: 900, y: 250 };
    const scale = 2;
    const pos = { x: 30, y: -40 };

    const before = imageOf(m, scale, pos);
    const next = zoomAtPoint(
      { clientX: m.x, clientY: m.y, deltaY: -100 },
      RECT,
      scale,
      pos,
      OPTS,
    );
    const after = imageOf(m, next.scale, next.pos);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    // 等价表述：该图像点缩放后仍精确落在光标处。
    const onScreen = screenOfRel(before, next.scale, next.pos);
    expect(onScreen.x).toBeCloseTo(m.x, 6);
    expect(onScreen.y).toBeCloseTo(m.y, 6);
  });

  it('缩小方向同样锚定光标', () => {
    const m = { x: 100, y: 700 };
    const before = imageOf(m, 3, { x: -10, y: 20 });
    const next = zoomAtPoint(
      { clientX: m.x, clientY: m.y, deltaY: 100 },
      RECT,
      3,
      { x: -10, y: 20 },
      OPTS,
    );
    const after = imageOf(m, next.scale, next.pos);
    expect(next.scale).toBeCloseTo(3 / 1.25, 6);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('光标落在画面正中时，行为退化为「只改 scale」（与旧版一致）', () => {
    const center = { clientX: O.x, clientY: O.y, deltaY: -100 };
    const next = zoomAtPoint(center, RECT, 1, { x: 0, y: 0 }, OPTS);
    expect(next.scale).toBeCloseTo(1.25, 6);
    expect(next.pos).toEqual({ x: 0, y: 0 });
  });

  it('触顶时 k===1，pos 保持不变（不产生漂移）', () => {
    const pos = { x: 50, y: 60 };
    const next = zoomAtPoint(
      { clientX: 900, clientY: 100, deltaY: -100 },
      RECT,
      10,
      pos,
      OPTS,
    );
    expect(next.scale).toBe(10);
    expect(next.pos).toEqual(pos);
  });

  it('触底时 k===1，pos 保持不变', () => {
    const pos = { x: -5, y: 8 };
    const next = zoomAtPoint(
      { clientX: 10, clientY: 10, deltaY: 100 },
      RECT,
      0.2,
      pos,
      OPTS,
    );
    expect(next.scale).toBe(0.2);
    expect(next.pos).toEqual(pos);
  });

  it('已有的平移位移参与计算（pos≠0 不会丢）', () => {
    const m = { clientX: 700, clientY: 500, deltaY: -100 };
    const scale = 2;
    const pos = { x: 120, y: -60 };
    const next = zoomAtPoint(m, RECT, scale, pos, OPTS);
    // k = 1.25：pos′ = 1.25·pos + (1 − 1.25)·d
    const dx = m.clientX - O.x;
    const dy = m.clientY - O.y;
    expect(next.pos.x).toBeCloseTo(1.25 * pos.x - 0.25 * dx, 6);
    expect(next.pos.y).toBeCloseTo(1.25 * pos.y - 0.25 * dy, 6);
  });
});
