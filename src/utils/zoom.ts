/**
 * 命中光标缩放（M-08）——「滚轮以指针为中心缩放」这句承诺的实现。
 *
 * 三个视口原先的 `handleWheel` 只改 `scale`：因为 `<img>` 是 `origin-center`
 * 且由 flex 居中，缩放锚点固定在**画面中心**，光标下的内容会漂移 —— 与快捷键
 * 说明里的「以指针为中心缩放」不符。这里把「改 scale 的同时按光标反算 pos」
 * 抽成纯函数，三处共用。
 *
 * 数学模型（`O` = 视口中心，`p` = 图像坐标，`m` = 光标 client 坐标）：
 * ```
 *   屏幕位置   s(p) = O + pos + scale·(p − O)
 *   光标下的图像点   p − O = (m − O − pos) / scale
 *   要求缩放前后同一图像点仍落在光标下：
 *     pos′ = k·pos + (1 − k)·(m − O)，其中 k = scale′ / scale   ……… 命中缩放公式
 * ```
 * `k === 1`（触顶/触底被 clamp）时公式退化为恒等，`pos` 不变，无需特判。
 */
export interface ZoomAtPointOptions {
  min: number;
  max: number;
  /** 每一格滚轮的缩放倍数（>1）。 */
  step: number;
}

export interface ZoomAtPointResult {
  scale: number;
  pos: { x: number; y: number };
}

export function zoomAtPoint(
  pointer: { clientX: number; clientY: number; deltaY: number },
  rect: { left: number; top: number; width: number; height: number },
  scale: number,
  pos: { x: number; y: number },
  { min, max, step }: ZoomAtPointOptions,
): ZoomAtPointResult {
  const next = Math.min(
    Math.max(scale * (pointer.deltaY < 0 ? step : 1 / step), min),
    max,
  );
  const k = next / scale;
  const dx = pointer.clientX - (rect.left + rect.width / 2);
  const dy = pointer.clientY - (rect.top + rect.height / 2);
  return {
    scale: next,
    pos: { x: k * pos.x + (1 - k) * dx, y: k * pos.y + (1 - k) * dy },
  };
}
