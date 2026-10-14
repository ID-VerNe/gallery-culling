import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { zoomAtPoint } from '../utils/zoom';
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  DOUBLE_CLICK_SCALE,
  clampScale,
  clampToPane,
  dragGrab,
  dragTarget,
  type Vec2,
} from '../utils/viewportZoom';

/** useZoomPan 的全部对外面（单图视口在用；双栏视口用 useDualZoomPan）。 */
export interface ZoomPan {
  scale: number;
  pos: Vec2;
  isDragging: boolean;
  /** `<img>` 的 transform；三视口同格式（ViewportPanConsistency 按它解析）。 */
  transform: string;
  /** 视口容器 —— 夹紧要量它的 clientWidth/Height。 */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 绑到 `<img>`；同时转发给宿主（单图视图的直方图采样）。 */
  imageRef: (el: HTMLImageElement | null) => void;
  zoomBy: (factor: number) => void;
  reset: () => void;
  /** 绑到视口容器的全套手势（滚轮 / 拖拽 / 双击）。 */
  bind: {
    onWheel: (e: React.WheelEvent) => void;
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
  };
}

/**
 * 单图视口的缩放/平移机器（PreviewViewport）。
 *
 * 收拢的三份不变量：
 *  - **绝对系拖拽**：抓取偏移存 ref，move 由当前客户端坐标反解 —— 不受
 *    React 批处理影响（增量系会丢帧，详见 viewportZoom.ts 的 dragGrab 注释）；
 *  - **命中光标缩放**（M-08）：滚轮改 scale 的同时按光标反算 pos；
 *  - **夹紧**（C8）：照片不露出视口；
 *  - **换图复位**（F-03）：不复位会让用户 zoom 进新图的空白里。
 *
 * `resetKey` 变化即视为换图（传 `group?.id`）。
 */
export function useZoomPan(
  resetKey: string | undefined,
  onImageElement?: (el: HTMLImageElement | null) => void,
): ZoomPan {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState<Vec2>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  // 绝对系抓取偏移：拖动期间恒定，故存 ref 而非 state —— 少一次 state
  // 更新，也从结构上排除「读到旧 dragStart」的可能。
  const grabRef = useRef<Vec2>({ x: 0, y: 0 });

  useEffect(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, [resetKey]);

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => clampScale(s * factor));
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const next = zoomAtPoint(e, rect, scale, pos, {
        min: ZOOM_MIN,
        max: ZOOM_MAX,
        step: ZOOM_STEP,
      });
      setScale(next.scale);
      setPos(next.pos);
    },
    [scale, pos],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // 覆盖层按钮 / EXIF 胶囊等交互元素不进入拖拽，避免抢走点击。
      if (e.target !== e.currentTarget) return;
      setIsDragging(true);
      grabRef.current = dragGrab(e.clientX, e.clientY, pos);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      const target = dragTarget(e.clientX, e.clientY, grabRef.current);
      setPos(clampToPane(containerRef.current, imgRef.current, target, scale));
    },
    [isDragging, scale],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      setIsDragging(false);
      const host = e.currentTarget as HTMLElement;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
    },
    [isDragging],
  );

  const handleDoubleClick = useCallback(() => {
    setScale((s) => (s === 1 ? DOUBLE_CLICK_SCALE : 1));
    setPos({ x: 0, y: 0 });
  }, []);

  const imageRef = useCallback(
    (el: HTMLImageElement | null) => {
      imgRef.current = el;
      onImageElement?.(el);
    },
    [onImageElement],
  );

  return {
    scale,
    pos,
    isDragging,
    transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
    containerRef,
    imageRef,
    zoomBy,
    reset,
    bind: {
      onWheel: handleWheel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onDoubleClick: handleDoubleClick,
    },
  };
}
