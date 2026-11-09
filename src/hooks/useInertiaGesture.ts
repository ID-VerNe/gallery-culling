/**
 * 手势惯性状态机骨架（issue #123）。
 *
 * `useZoomPan`（单栏）与 `useDualZoomPan`（双栏）的抬手收尾接线逐字同形，
 * 只有注入点不同：夹紧分叉与写栏分叉。把这套骨架收进工厂，两 hook 只负责
 * 注入自己的分叉：
 *  - 单栏注入 `clampToPane` / `setPos` / `paneMaxPan`（见 `useZoomPan`）；
 *  - 双栏注入 `sync ? clampToPanePair : clampToPane` /
 *    `sync ? 写两栏 : 写 activePane` / `sync ? paneMaxPanPair : paneMaxPan`
 *    （见 `useDualZoomPan`）。
 *
 * 工厂持有 `samplesRef` / `inertiaRef` / `cancelInertia`、卸载清与换图清，
 * 以及抬手编排（采样→速度→投影→target/overflow→`runInertia`→落定重夹）。
 * 数学（投影、曲线、逐帧夹紧）仍是 `viewportZoom.ts` 的纯函数，这里只做
 * 采样与写 state 的接线。`oneToOne` / Z 键（PB-10）与 `viewportZoom.ts`
 * 的纯函数都不经过这里。
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  clampToTrail,
  isFlingVelocity,
  nowMs,
  pointerVelocity,
  projectFling,
  pushPointerSample,
  runInertia,
  type InertiaRun,
  type PointerSample,
  type Vec2,
} from '../utils/viewportZoom';
import { GESTURE, SETTLE } from '../utils/viewportMotion';

export interface InertiaGestureOpts {
  /** 把位置夹到允许区间（单栏 `clampToPane`，双栏 sync 分叉）。 */
  clampPos: (p: Vec2) => Vec2;
  /** 写位置（单栏 `setPos`，双栏 sync 分叉）。 */
  writePos: (p: Vec2) => void;
  /** 当前边界（单栏 `paneMaxPan`，双栏 sync 分叉），逐帧读取几何。 */
  getMaxPan: () => Vec2;
  /** 动效通道写入器（宿主 hook 的 `setTransition`）。 */
  setTransition: (t: string) => void;
}

export interface InertiaGesture {
  /** 停掉在飞的收尾：任何「新意图」（按下 / 滚轮 / ± / 复位 / 换图）都优先。 */
  cancelInertia: () => void;
  /** 清掉速度采样（按下 / 复位 / 换图时调用）。 */
  clearSamples: () => void;
  /**
   * 换图/复位清 ref：停惯性 + 清采样。位置尾部（`setScale(1)` /
   * `setFirst/setSecond`、`leaveOneToOne` 的调用顺序）仍由各 hook 在
   * 自身 effect/`reset()` 内显式安排，不由工厂代劳。
   */
  clearForNewImage: () => void;
  /** 拖动中采样：只留最近 100ms，停手后速度自然归零。 */
  sampleDrag: (clientX: number, clientY: number) => void;
  /**
   * 抬手：松手点入样 → 速度 → 投影 → target/overflow →
   * 门槛早返 / `runInertia` → 落定重夹。`current` 为抬手瞬间位置。
   */
  finishPointerUp: (clientX: number, clientY: number, current: Vec2) => void;
}

export function useInertiaGesture(opts: InertiaGestureOpts): InertiaGesture {
  // 注入闭包（分叉的 scale/sync 读数）通过 ref 读最新值，`finishPointerUp`
  // 身份保持稳定——单栏 `handlePointerUp` 的 useCallback 依赖不用跟着变。
  // 飞行期间 scale/sync 不会变（任何改它们的输入都先 cancel 惯性），逐帧
  // 按 `finishPointerUp` 调用那一刻的快照读数，与原来 inline 闭包一致。
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // 收尾采样与在飞的收尾（issue #22）。采样存 ref：pointermove 的频率不该变成渲染次数。
  const samplesRef = useRef<PointerSample[]>([]);
  const inertiaRef = useRef<InertiaRun | null>(null);

  const cancelInertia = useCallback(() => {
    inertiaRef.current?.stop();
    inertiaRef.current = null;
  }, []);

  // 卸载时不能留 rAF：否则收尾会在组件消失后继续 setState。
  useEffect(() => cancelInertia, [cancelInertia]);

  const clearSamples = useCallback(() => {
    samplesRef.current = [];
  }, []);

  const clearForNewImage = useCallback(() => {
    // 换图即取消在飞的收尾：惯性属于上一张照片的位移，带进新图就会把它推出画面。
    inertiaRef.current?.stop();
    inertiaRef.current = null;
    samplesRef.current = [];
  }, []);

  const sampleDrag = useCallback((clientX: number, clientY: number) => {
    samplesRef.current = pushPointerSample(samplesRef.current, {
      t: nowMs(),
      x: clientX,
      y: clientY,
    });
  }, []);

  const finishPointerUp = useCallback(
    (clientX: number, clientY: number, current: Vec2) => {
      const { clampPos, writePos, getMaxPan, setTransition } = optsRef.current;
      // PB-6：把手上的速度交出去。落点先过 clamp —— 惯性再大也不会把画面
      // 甩出「照片不露空」的范围；越界时这就是回弹的落点。
      //
      // 松手点本身必须入样：停手 400ms 再松手时窗口里只剩它一个点，速度自然
      // 归零；少了这一步，400ms 前的旧速度会被当成「手指当前速度」继续甩。
      const velocity = pointerVelocity(
        pushPointerSample(samplesRef.current, { t: nowMs(), x: clientX, y: clientY }),
      );
      samplesRef.current = [];
      const projection = projectFling(velocity);
      const target = clampPos({ x: current.x + projection.x, y: current.y + projection.y });
      const settled = clampPos(current);
      // 抬手瞬间的越界量：收尾时按 remain 逐帧收敛到 0（回弹曲线），而不是被剪掉。
      const overflow = { x: current.x - settled.x, y: current.y - settled.y };
      const outOfBounds = settled.x !== current.x || settled.y !== current.y;

      if (!isFlingVelocity(velocity) && !outOfBounds) {
        setTransition(SETTLE);
        return;
      }

      // 收尾期间是手势通道：逐帧写 transform，不能再让 CSS 补一次间。
      setTransition(GESTURE);
      inertiaRef.current?.stop();
      inertiaRef.current = runInertia(
        current,
        target,
        // 每帧按「当前边界 + 尚未衰减的越界量」夹紧：回弹逐帧收敛，边界中途
        // 收紧时新边界立刻生效（不能等落定才跳回去）。
        (next, remain) => writePos(clampToTrail(next, getMaxPan(), overflow, remain)),
        () => {
          inertiaRef.current = null;
          // 落定这一帧按当前几何再夹一次：收尾途中改窗口 / 换图也不会留在界外。
          writePos(clampPos(target));
          setTransition(SETTLE);
        },
      );
    },
    [],
  );

  return { cancelInertia, clearSamples, clearForNewImage, sampleDrag, finishPointerUp };
}
