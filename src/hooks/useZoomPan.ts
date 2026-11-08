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
  dampToPane,
  dragGrab,
  dragTarget,
  isFitScale,
  isFlingVelocity,
  nowMs,
  oneToOneScale,
  pointerVelocity,
  projectFling,
  pushPointerSample,
  runInertia,
  type InertiaRun,
  type PointerSample,
  type Vec2,
} from '../utils/viewportZoom';
import { GESTURE, SETTLE } from '../utils/viewportMotion';

/** useZoomPan 的全部对外面（单图视口在用；双栏视口用 useDualZoomPan）。 */
export interface ZoomPan {
  scale: number;
  pos: Vec2;
  isDragging: boolean;
  /** `<img>` 的 transform；三视口同格式（ViewportPanConsistency 按它解析）。 */
  transform: string;
  /**
   * `<img>` 的 `transition`。由**产生这次变化的输入**决定，不由 `isDragging`
   * 决定 —— 滚轮抬手后 isDragging 已是 false，但滚轮仍属手势通道。
   */
  transition: string;
  /** 视口容器 —— 夹紧要量它的 clientWidth/Height。 */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 绑到 `<img>`；同时转发给宿主（单图视图的直方图采样）。 */
  imageRef: (el: HTMLImageElement | null) => void;
  zoomBy: (factor: number) => void;
  reset: () => void;
  /**
   * 切到真 1:1（一个图片像素 = 一个屏幕像素）。
   *
   * 比例是 `naturalWidth / offsetWidth` —— `scale` 的语义是「相对适应窗口
   * 的倍数」，所以 1:1 取决于原图尺寸与窗口大小，不能写死。
   * 元素未挂载 / 还没布局（宽度为 0）时算不出来：给了 `fallback` 就落在
   * `fallback` 上并返回它（双击在算不出 1:1 的宿主上仍是一个放大），
   * 没给则返回 null、画面不动（Z 的语义是「到 1:1」，不是「到某个倍数」）。
   */
  oneToOne: (fallback?: number) => number | null;
  /**
   * 注册「离开 1:1」的回调（PB-10）。除 `oneToOne()` 以外的每一个**真的改变了
   * 画面**的缩放 / 平移 / 复位入口都会触发它 —— 1:1 只在 `oneToOne()` 的落点
   * 上成立，调用方据此维护「当前是不是 1:1」，而不是拿比例去跟一个算出来的数比。
   * 按住不放的单击不触发：它没有改变任何东西，只是「可能开始拖」。
   */
  setOneToOneLeaveListener: (fn: () => void) => void;
  /** 绑到视口容器的全套手势（滚轮 / 拖拽 / 双击）。 */
  bind: {
    onWheel: (e: React.WheelEvent) => void;
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
    /**
     * 双击该落到哪个比例：适应窗口 → `DOUBLE_CLICK_SCALE`，否则 → 1。
     * 读的是当前 `scale`，不是 setState 回调里的旧值。
     */
    doubleClickScale: () => number;
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
  // 动效通道（PB-1）：手势通道不补间，跳变通道补间。见 viewportMotion.ts。
  const [transition, setTransition] = useState(SETTLE);
  // 绝对系抓取偏移：拖动期间恒定，故存 ref 而非 state —— 少一次 state
  // 更新，也从结构上排除「读到旧 dragStart」的可能。
  const grabRef = useRef<Vec2>({ x: 0, y: 0 });
  const leaveListenerRef = useRef<(() => void) | null>(null);
  // 收尾采样与在飞的收尾（issue #22）。采样存 ref：pointermove 的频率不该变成渲染次数。
  const samplesRef = useRef<PointerSample[]>([]);
  const inertiaRef = useRef<InertiaRun | null>(null);

  /** 停掉在飞的收尾：任何「新意图」（按下 / 滚轮 / ± / 复位 / 换图）都优先。 */
  const cancelInertia = useCallback(() => {
    inertiaRef.current?.stop();
    inertiaRef.current = null;
  }, []);

  // 卸载时不能留 rAF：否则收尾会在组件消失后继续 setState。
  useEffect(() => cancelInertia, [cancelInertia]);

  const leaveOneToOne = useCallback(() => {
    leaveListenerRef.current?.();
  }, []);

  const setOneToOneLeaveListener = useCallback((fn: () => void) => {
    leaveListenerRef.current = fn;
  }, []);

  // 换图复位。函数身份全部稳定（见下面 `reset` 的注释），所以这里真的只
  // 在 `resetKey` 变化时跑；首次挂载状态本来就是 1 / {0,0}，无需补一次。
  useEffect(() => {
    leaveOneToOne();
    // 换图即取消在飞的收尾：惯性属于上一张照片的位移，带进新图就会把它推出画面。
    inertiaRef.current?.stop();
    inertiaRef.current = null;
    samplesRef.current = [];
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, [resetKey, leaveOneToOne]);

  const zoomBy = useCallback(
    (factor: number) => {
      leaveOneToOne();
      cancelInertia();
      setTransition(SETTLE);
      setScale(clampScale(scale * factor));
    },
    [scale, leaveOneToOne, cancelInertia],
  );

  /**
   * 回适应窗口。
   *
   * 依赖里没有 `leaveOneToOne` 是**故意**的：`setOneToOneLeaveListener` 又
   * 依赖它，调用方每次渲染都会拿到新的监听注册函数；把 `leaveOneToOne` 写进
   * 依赖，`reset` / `oneToOne` 的身份就会跟着每次渲染变化，宿主那边依赖它们
   * 的 effect（结果到达就切 1:1）会被无谓地重跑 —— 跟着重跑的还有上面那个
   * 换图复位。监听器存在 ref 里，读的永远是最新那个，不需要进依赖。
   */
  const reset = useCallback(() => {
    leaveListenerRef.current?.();
    inertiaRef.current?.stop();
    inertiaRef.current = null;
    samplesRef.current = [];
    setTransition(SETTLE);
    setScale(1);
    setPos({ x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const oneToOne = useCallback((fallback?: number): number | null => {
    const img = imgRef.current;
    const s = img ? oneToOneScale(img.naturalWidth, img.offsetWidth) : null;
    const landing = s ?? fallback;
    if (landing === undefined) return null;
    inertiaRef.current?.stop();
    inertiaRef.current = null;
    samplesRef.current = [];
    setTransition(SETTLE);
    setScale(landing);
    setPos({ x: 0, y: 0 });
    return landing;
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      leaveOneToOne();
      cancelInertia();
      setTransition(GESTURE);
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const next = zoomAtPoint(e, rect, scale, pos, {
        min: ZOOM_MIN,
        max: ZOOM_MAX,
        step: ZOOM_STEP,
      });
      setScale(next.scale);
      setPos(next.pos);
    },
    [scale, pos, leaveOneToOne, cancelInertia],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // 覆盖层按钮 / EXIF 胶囊等交互元素不进入拖拽，避免抢走点击。
      if (e.target !== e.currentTarget) return;
      // 只按下还什么都没离开 1:1：没有位移的单击（选片、进调色）不该把
      // 1:1 状态打掉。真正的离开判据是 handlePointerMove 里的「真的动了」。
      cancelInertia();
      samplesRef.current = [];
      setTransition(GESTURE);
      setIsDragging(true);
      grabRef.current = dragGrab(e.clientX, e.clientY, pos);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos, cancelInertia],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      const target = dragTarget(e.clientX, e.clientY, grabRef.current);
      // PB-8：越界段乘阻尼，手指贴着边推仍然有反馈；抬手后再由 clampToPane 收回。
      const next = dampToPane(containerRef.current, imgRef.current, target, scale);
      // 速度采样：只留最近 100ms，抬手前停一下速度自然归零（不会「一停手还在飞」）。
      samplesRef.current = pushPointerSample(samplesRef.current, {
        t: nowMs(),
        x: e.clientX,
        y: e.clientY,
      });
      // 夹紧之后位置真变了才算离开 1:1：1:1 时平移本就封死在原点，按着不放
      // 不该让「再按 Z」变成「重新进 1:1」而不是「回适应」。
      if (next.x !== pos.x || next.y !== pos.y) leaveOneToOne();
      setPos(next);
    },
    [isDragging, scale, pos, leaveOneToOne],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      setIsDragging(false);
      const host = e.currentTarget as HTMLElement;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);

      // PB-6：把手上的速度交出去。落点先过 clampToPane —— 惯性再大也不会
      // 把画面甩出「照片不露空」的范围；越界时这就是回弹的落点。
      //
      // 松手点本身必须入样：停手 400ms 再松手时窗口里只剩它一个点，速度自然
      // 归零；少了这一步，400ms 前的旧速度会被当成「手指当前速度」继续甩。
      const velocity = pointerVelocity(
        pushPointerSample(samplesRef.current, {
          t: nowMs(),
          x: e.clientX,
          y: e.clientY,
        }),
      );
      samplesRef.current = [];
      const projection = projectFling(velocity);
      const target = clampToPane(
        containerRef.current,
        imgRef.current,
        { x: pos.x + projection.x, y: pos.y + projection.y },
        scale,
      );
      const settled = clampToPane(containerRef.current, imgRef.current, pos, scale);
      const outOfBounds = settled.x !== pos.x || settled.y !== pos.y;

      if (!isFlingVelocity(velocity) && !outOfBounds) {
        setTransition(SETTLE);
        return;
      }

      // 收尾期间是手势通道：逐帧写 transform，不能再让 CSS 补一次间。
      setTransition(GESTURE);
      inertiaRef.current?.stop();
      inertiaRef.current = runInertia(
        pos,
        target,
        // 中间帧不做夹紧：越界量要跟着 remain 一起衰减，硬夹会把回弹压成瞬跳。
        (next) => setPos(next),
        () => {
          inertiaRef.current = null;
          // 落定这一帧按当前几何再夹一次：收尾途中换图 / 改窗口也不会留在界外。
          setPos(clampToPane(containerRef.current, imgRef.current, target, scale));
          setTransition(SETTLE);
        },
      );
    },
    [isDragging, pos, scale],
  );

  /** 双击：一处判「是不是适应」，一处应用落点 —— 三视口共用。 */
  const doubleClickScale = useCallback(() => (isFitScale(scale) ? DOUBLE_CLICK_SCALE : 1), [scale]);

  const handleDoubleClick = useCallback(() => {
    leaveOneToOne();
    cancelInertia();
    setTransition(SETTLE);
    setScale(doubleClickScale());
    setPos({ x: 0, y: 0 });
  }, [leaveOneToOne, doubleClickScale, cancelInertia]);

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
    transition,
    transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
    containerRef,
    imageRef,
    zoomBy,
    reset,
    oneToOne,
    setOneToOneLeaveListener,
    bind: {
      onWheel: handleWheel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onDoubleClick: handleDoubleClick,
      // 双击的落点由宿主决定：Preview 的落点里可能要先等细节图（Z 同构），
      // 单栏视口自己算不出来，所以只把「该落在哪」暴露出去。
      doubleClickScale,
    },
  };
}
