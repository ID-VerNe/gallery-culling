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
  clampToPanePair,
  dragGrab,
  dragTarget,
  type Vec2,
} from '../utils/viewportZoom';

const ORIGIN: Vec2 = { x: 0, y: 0 };

interface PaneState {
  scale: number;
  pos: Vec2;
}

const INIT_PANE: PaneState = { scale: 1, pos: ORIGIN };

/** 绑到某一栏容器 div 的手全套 + ref。 */
export interface PaneBind {
  ref: (el: HTMLDivElement | null) => void;
  onWheel: (e: React.WheelEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
}

/** useDualZoomPan 的全部对外面。 */
export interface DualZoomPan<P extends string> {
  scaleOf: (pane: P) => number;
  posOf: (pane: P) => Vec2;
  /** `<img>` 的 transform；与单栏 hook 同格式（pan 测试按它解析）。 */
  transformOf: (pane: P) => string;
  isDragging: boolean;
  /** 联动开关（Split 的 syncZoom / BeforeAfter 的 syncLock）。 */
  sync: boolean;
  toggleSync: () => void;
  /** 独立模式下手势与 ± 的作用栏。 */
  activePane: P;
  focusPane: (pane: P) => void;
  /** 联动时取第一栏；独立时取聚焦栏（± 禁用态与合并读数用）。 */
  effectiveScale: number;
  zoomBy: (factor: number) => void;
  reset: () => void;
  bindPane: (pane: P) => PaneBind;
  /** 绑到某一栏的 `<img>`（夹紧量测渲染尺寸用）。 */
  imgRef: (pane: P) => (el: HTMLImageElement | null) => void;
}

/**
 * 双栏视口（SplitCompareViewport / BeforeAfterViewport）的缩放/平移机器。
 *
 * 两个组件的这套机器在抽取前逐行同构（只差栏名 left/right 与
 * before/after），连注释都一致。收拢后的不变量：
 *  - **联动**：两栏写同一组 scale/pos；滚轮以悬停栏的 rect 为锚点，
 *    拖拽夹到两栏公共边界；
 *  - **独立**：滚轮/拖拽/双击/± 只作用于 activePane；
 *  - **绝对系拖拽**：抓取偏移存 ref，不受 React 批处理影响；
 *  - **换图复位**（F-03）。
 *
 * `panes` 必须是模块级常量（如 `['left', 'right'] as const`）—— 第一栏是
 * 联动模式的基准。`resetKey` 变化即视为换图：Split 传两栏 id 的组合，
 * BeforeAfter 传单栏 id。`initialActivePane` 是独立模式的默认作用栏
 * （BeforeAfter 传第二栏 —— 它的调色结果在右侧）。
 */
export function useDualZoomPan<P extends string>(
  panes: readonly [P, P],
  resetKey: string | undefined,
  initialActivePane: P = panes[0],
): DualZoomPan<P> {
  const [first, setFirst] = useState<PaneState>(INIT_PANE);
  const [second, setSecond] = useState<PaneState>(INIT_PANE);
  const [isDragging, setIsDragging] = useState(false);
  const [sync, setSync] = useState(true);
  const [activePane, setActivePane] = useState<P>(initialActivePane);

  // 绝对系抓取偏移：拖动期间恒定，存 ref（理由同 useZoomPan）。
  const grabRef = useRef<Vec2>({ x: 0, y: 0 });
  const paneEls = useRef<Record<P, HTMLDivElement | null>>({} as Record<P, HTMLDivElement | null>);
  const imgEls = useRef<Record<P, HTMLImageElement | null>>(
    {} as Record<P, HTMLImageElement | null>,
  );

  useEffect(() => {
    setFirst(INIT_PANE);
    setSecond(INIT_PANE);
  }, [resetKey]);

  const isFirst = (p: P) => panes[0] === p;
  const get = (p: P): PaneState => (isFirst(p) ? first : second);
  const setPane = useCallback(
    (p: P, next: PaneState | ((prev: PaneState) => PaneState)) => {
      if (panes[0] === p) setFirst(next);
      else setSecond(next);
    },
    [panes],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      if (sync) {
        // 联动：以第一栏为基准拉齐两图（只改比例，不动平移）
        const next = clampScale(first.scale * factor);
        setFirst((prev) => ({ ...prev, scale: next }));
        setSecond((prev) => ({ ...prev, scale: next }));
      } else {
        setPane(activePane, (prev) => ({ ...prev, scale: clampScale(prev.scale * factor) }));
      }
    },
    [sync, first.scale, activePane, setPane],
  );

  const reset = useCallback(() => {
    setFirst(INIT_PANE);
    setSecond(INIT_PANE);
  }, []);

  const toggleSync = useCallback(() => setSync((v) => !v), []);
  const focusPane = useCallback((p: P) => setActivePane(p), []);

  const handleWheel = (p: P, e: React.WheelEvent) => {
    e.preventDefault();
    setActivePane(p);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const opts = { min: ZOOM_MIN, max: ZOOM_MAX, step: ZOOM_STEP };
    // 悬停栏即锚点（M-08）：联动时两栏 scale/pos 相同，用悬停栏的值与
    // 悬停栏的 rect 算一次，写给两栏。
    const anchor = get(p);
    const next = zoomAtPoint(e, rect, anchor.scale, anchor.pos, opts);
    if (sync) {
      setFirst(next);
      setSecond(next);
    } else {
      setPane(p, next);
    }
  };

  const handlePointerDown = (p: P, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 覆盖层交互元素（设为基准、评分等）不进入拖拽。
    if (e.target !== e.currentTarget) return;
    setIsDragging(true);
    setActivePane(p);
    grabRef.current = dragGrab(e.clientX, e.clientY, get(p).pos);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    // 绝对系：由客户端坐标与抓取偏移反解目标平移量，与 grab 是否已提交无关。
    const target = dragTarget(e.clientX, e.clientY, grabRef.current);
    if (sync) {
      // 联动平移两栏：夹紧取两栏的公共边界，避免任一栏露空。
      const clamped = clampToPanePair(
        paneEls.current[panes[0]],
        imgEls.current[panes[0]],
        first.scale,
        paneEls.current[panes[1]],
        imgEls.current[panes[1]],
        second.scale,
        target,
      );
      setFirst((prev) => ({ ...prev, pos: clamped }));
      setSecond((prev) => ({ ...prev, pos: clamped }));
    } else {
      setPane(activePane, (prev) => ({
        ...prev,
        pos: clampToPane(paneEls.current[activePane], imgEls.current[activePane], target, prev.scale),
      }));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    const host = e.currentTarget as HTMLElement;
    if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
  };

  const handleDoubleClick = (p: P) => {
    setActivePane(p);
    const targetScale = get(p).scale === 1 ? DOUBLE_CLICK_SCALE : 1;
    const next: PaneState = { scale: targetScale, pos: ORIGIN };
    if (sync) {
      setFirst(next);
      setSecond(next);
    } else {
      setPane(p, next);
    }
  };

  const bindPane = (p: P): PaneBind => ({
    ref: (el) => {
      paneEls.current[p] = el;
    },
    onWheel: (e) => handleWheel(p, e),
    onPointerDown: (e) => handlePointerDown(p, e),
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onDoubleClick: () => handleDoubleClick(p),
  });

  const imgRef = (p: P) => (el: HTMLImageElement | null) => {
    imgEls.current[p] = el;
  };

  return {
    scaleOf: (p) => get(p).scale,
    posOf: (p) => get(p).pos,
    transformOf: (p) => {
      const s = get(p);
      return `translate(${s.pos.x}px, ${s.pos.y}px) scale(${s.scale})`;
    },
    isDragging,
    sync,
    toggleSync,
    activePane,
    focusPane,
    effectiveScale: sync ? first.scale : get(activePane).scale,
    zoomBy,
    reset,
    bindPane,
    imgRef,
  };
}
