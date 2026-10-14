/**
 * 三视口（单图 Preview / 双图对比 Split / 前后对照 BeforeAfter）共用的缩放几何。
 *
 * 这三个视口的缩放机器曾经逐份拷贝：常量各写一遍、夹紧各写一遍、
 * 「适应」读数各写一遍。FE-03b 把不变量收在这里 —— 改量程、改夹紧规则、
 * 改读数措辞，都只有一处真值。
 *
 * 配套的状态机在 `hooks/useZoomPan.ts`（单栏）与 `hooks/useDualZoomPan.ts`（双栏）。
 */
export interface Vec2 {
  x: number;
  y: number;
}

/** 缩放下限。scale=1 即「适应窗口」，再小没有选片意义。 */
export const ZOOM_MIN = 0.2;
/** 缩放上限（10x 以上是像素级噪点）。 */
export const ZOOM_MAX = 10;
/** 每格滚轮 / 每次 ± 的缩放倍数。 */
export const ZOOM_STEP = 1.25;
/** 双击在「适应 ↔ 此比例」之间切换。 */
export const DOUBLE_CLICK_SCALE = 2.5;

/** 夹到量程内。 */
export function clampScale(s: number): number {
  return Math.min(Math.max(s, ZOOM_MIN), ZOOM_MAX);
}

/**
 * C6 / V-01：scale=1 实为「适应窗口」，不是 1:1 像素 —— 读数说「适应」，
 * 不说误导性的 100%。三视口的读数与重置 tooltip 必须同一措辞。
 */
export function scaleLabel(s: number): string {
  return Math.abs(s - 1) < 0.001 ? '适应' : `${Math.round(s * 100)}%`;
}

/**
 * C8：把平移夹到「照片不露出视口」的范围。缩放后图像超出容器的半边
 * 尺寸即最大可平移量；不超出（适应窗口）则锁死居中。
 *
 * 任一 ref 缺失（首帧 / 卸载中）时原样返回 —— 与三视口既有行为一致：
 * Preview 直接 return next，Split/BA 的 Infinity 边界也是恒等。
 */
export function clampToPane(
  pane: HTMLElement | null,
  img: HTMLElement | null,
  pos: Vec2,
  scale: number,
): Vec2 {
  if (!pane || !img) return pos;
  const maxX = Math.max(0, (img.offsetWidth * scale - pane.clientWidth) / 2);
  const maxY = Math.max(0, (img.offsetHeight * scale - pane.clientHeight) / 2);
  return {
    x: Math.min(Math.max(pos.x, -maxX), maxX),
    y: Math.min(Math.max(pos.y, -maxY), maxY),
  };
}

/**
 * 绝对系拖拽的抓取偏移：记「抓取点相对图像原点的偏移」，move 时由
 * 客户端坐标反解目标平移量（`client − grab`）。
 *
 * 为什么必须是绝对系：增量系（`dx = client − dragStart` 再把 client 写回
 * dragStart）把 dragStart 放进 React state，同帧内派发的两个 pointermove
 * 会被批处理成读到**同一个旧 dragStart**，dx 被重复计算、位移丢一帧。
 * 快速拖拽 / 低帧率下放大成可见抖动。绝对系天然免疫。
 * 不变量由 `ViewportPanConsistency.test.tsx` 锁死。
 */
export function dragGrab(clientX: number, clientY: number, pos: Vec2): Vec2 {
  return { x: clientX - pos.x, y: clientY - pos.y };
}

/** 由抓取偏移与当前客户端坐标反解目标平移量（绝对系）。 */
export function dragTarget(clientX: number, clientY: number, grab: Vec2): Vec2 {
  return { x: clientX - grab.x, y: clientY - grab.y };
}
