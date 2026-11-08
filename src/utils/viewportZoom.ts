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
/**
 * 缩放上限。
 *
 * 这个数不是「看着合适」定的，是被 1:1 反推出来的：`scale` 是相对适应窗口
 * 的倍数，真 1:1 的倍数 = 原图宽 / 显示宽。24MP（6024px）在 600px 宽的
 * 窄窗口下就是 10.04× —— 旧的 10 会把它夹住，让「1:1」在窄窗口里变成
 * 一个假读数。留到 32 足够覆盖 45MP + 更窄的窗口。
 *
 * 代价：滚轮能滚到 32×，在 1600 预览上就是一团糊。但那是用户自己滚的，
 * 比「1:1 永远到不了」要好得多。
 */
export const ZOOM_MAX = 32;
/** 每格滚轮 / 每次 ± 的缩放倍数。 */
export const ZOOM_STEP = 1.25;
/** 双击在「适应 ↔ 此比例」之间切换。 */
export const DOUBLE_CLICK_SCALE = 2.5;

/** 夹到量程内。 */
export function clampScale(s: number): number {
  return Math.min(Math.max(s, ZOOM_MIN), ZOOM_MAX);
}

/**
 * 一格滚轮/± 的落点。夹紧规则与 `zoomAtPoint` 相同，单独抽出来是因为
 * 「不经过指针的连乘」也需要同一条量程 —— 判定容差的用例靠它复现
 * 连滚出来的比例。
 */
export function chainScale(s: number, factor: number): number {
  return clampScale(s * factor);
}

/**
 * 真 1:1 的缩放倍数：`naturalWidth / displayedWidth`。
 *
 * `scale` 的语义是「相对适应窗口的倍数」，所以 1:1 的倍数取决于原图尺寸与
 * 窗口大小 —— 24MP 在 1200px 宽窗口是 5×，在 600px 窄窗口是 10×。
 * 分母缺失/非法时返回 `null`：调用方应保留原缩放，而不是跳到一个 NaN。
 */
export function oneToOneScale(naturalWidth: number, displayedWidth: number): number | null {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(displayedWidth)) return null;
  if (naturalWidth <= 0 || displayedWidth <= 0) return null;
  return clampScale(naturalWidth / displayedWidth);
}

/**
 * C6 / V-01：scale=1 实为「适应窗口」，不是 1:1 像素 —— 读数说「适应」，
 * 不说误导性的 100%。三视口的读数与重置 tooltip 必须同一措辞。
 */
export function scaleLabel(s: number): string {
  return isFitScale(s) ? '适应' : `${Math.round(s * 100)}%`;
}

/**
 * PB-10：「当前是否处于适应窗口」的唯一判据，双击 / Z 键都走它。
 *
 * 不能用 `s === 1`。`scale` 是浮点连乘的产物 —— 滚轮一格乘 `ZOOM_STEP`、
 * 往回一格乘 `1 / ZOOM_STEP`（`zoomAtPoint` 用的正是这个式子）。当前
 * `ZOOM_STEP = 1.25` 的一次往返在 IEEE754 下**恰好精确**回到 1，所以这个
 * 缺陷现在不可见；但「一整档步长算出整数」是步长的巧合，不是判据可以写死
 * 的依据 —— 换成 1.4，连滚三格再连退三格落到 0.999…98，读数仍写「适应」、
 * `=== 1` 却判成已放大，用户双击以为会放大，画面反而缩回适应。
 *
 * 容差与 `scaleLabel` 共用同一条：读数写「适应」的那一段，行为上就必须是
 * 适应，两者不许各说各话。
 */
export function isFitScale(s: number): boolean {
  return Math.abs(s - 1) < 0.001;
}

/**
 * 单栏允许的最大平移量（C8）。refs 缺失时为 Infinity —— 夹紧退化为恒等，
 * 与三视口既有行为一致（首帧 / 卸载中不该把平移掰回原点）。
 */
export function paneMaxPan(pane: HTMLElement | null, img: HTMLElement | null, scale: number): Vec2 {
  if (!pane || !img) return { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  return {
    x: Math.max(0, (img.offsetWidth * scale - pane.clientWidth) / 2),
    y: Math.max(0, (img.offsetHeight * scale - pane.clientHeight) / 2),
  };
}

/** 夹到给定边界内（负边界 = 反向限位）。 */
export function clampTo(pos: Vec2, maxX: number, maxY: number): Vec2 {
  return {
    x: Math.min(Math.max(pos.x, -maxX), maxX),
    y: Math.min(Math.max(pos.y, -maxY), maxY),
  };
}

/**
 * C8：把平移夹到「照片不露出视口」的范围。缩放后图像超出容器的半边
 * 尺寸即最大可平移量；不超出（适应窗口）则锁死居中。
 */
export function clampToPane(
  pane: HTMLElement | null,
  img: HTMLElement | null,
  pos: Vec2,
  scale: number,
): Vec2 {
  const max = paneMaxPan(pane, img, scale);
  return clampTo(pos, max.x, max.y);
}

/**
 * 联动拖拽（双栏视口）：夹到两栏的**公共边界** —— 任一一栏都不许露空。
 * 两栏各自夹紧一次等价于夹到交集，但显式取 min 更能说明意图。
 */
export function clampToPanePair(
  paneA: HTMLElement | null,
  imgA: HTMLElement | null,
  scaleA: number,
  paneB: HTMLElement | null,
  imgB: HTMLElement | null,
  scaleB: number,
  pos: Vec2,
): Vec2 {
  const ma = paneMaxPan(paneA, imgA, scaleA);
  const mb = paneMaxPan(paneB, imgB, scaleB);
  return clampTo(pos, Math.min(ma.x, mb.x), Math.min(ma.y, mb.y));
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

// ---------------------------------------------------------------------------
// 拖拽收尾（issue #22 · PB-6 速度继承 + PB-8 越界回弹）
//
// 手势结束不是「把位置定住」，而是「把手上的速度交出去，再收敛回允许区间」。
// 这里的数学全部是纯函数 + 一个 rAF 驱动器：hooks 只负责采样与写 state，
// 投影距离、阻尼、收敛曲线都只有这一处真值，双栏与单栏不可能算出两种手感。
//
// 收尾的三条硬约束（由视图层用例逐帧断言，不靠肉眼）：
//  1. 落点先过 `clampToPane` / `clampToPanePair` —— 惯性再大也不会把画面甩出边界；
//  2. 每帧写入前再过一次同样的夹紧 —— 收尾途中换图/改窗口也不会越界；
//  3. 收尾只写 `pos`，`scale` 一个字节都不碰，量程约束不受影响。
// ---------------------------------------------------------------------------

/** 速度采样窗口（ms）：只认最近 100ms 的指针位移。 */
export const VELOCITY_WINDOW_MS = 100;

/**
 * 松手速度 → 滑行距离的当量时间常数（ms）。
 *
 * 指数收敛下 `距离 = v · τ`，且抬手瞬间的速度正好接上手指速度（不加速、不减速）。
 * issue 建议的 `d≈0.998` 折合 499ms 当量：尾巴要爬 3–4 秒才落到亚像素，
 * 读作「飘」。250ms 当量 1–2 秒内收敛，观感更接近照片查看器而不是惯性滚动列表。
 */
export const FLING_TAU_MS = 250;

/** 抬手速度上限（px/ms）。采样抖动会算出 100px/ms 这种手做不到的速度，一律按上限算。 */
export const FLING_MAX_SPEED = 6;

/** 低于这个速度（px/ms）不算甩动：投影不足 12.5px，肉眼不可见。 */
export const FLING_MIN_SPEED = 0.05;

/** 一次收尾的硬上界（ms）。指数收敛理论上无限长，这里兜住环境时钟异常。 */
export const FLING_MAX_MS = 2000;

/** 与落点相差不足这个距离（px）即视为落定，不再逐帧写。 */
export const FLING_SETTLE_EPSILON = 0.5;

/** 越界段的阻尼系数（PB-8 建议 0.3–0.5，取中值）。 */
export const RUBBER_BAND = 0.4;

/** 一次指针采样：时刻（ms）+ 客户端坐标。 */
export interface PointerSample {
  t: number;
  x: number;
  y: number;
}

/** 单调时钟。测试里由 `vi.useFakeTimers()` 接管 `performance.now`。 */
export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 推入一次采样并裁掉窗口外的旧点。抬手前停顿超过窗口，速度自然归零。 */
export function pushPointerSample(
  samples: readonly PointerSample[],
  sample: PointerSample,
): PointerSample[] {
  const kept = samples.filter((s) => sample.t - s.t <= VELOCITY_WINDOW_MS);
  return [...kept, sample];
}

/** 用窗口首尾两点求指针速度（px/ms），并按上限截断（保方向）。 */
export function pointerVelocity(samples: readonly PointerSample[]): Vec2 {
  if (samples.length < 2) return { x: 0, y: 0 };
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt <= 0) return { x: 0, y: 0 };
  const vx = (last.x - first.x) / dt;
  const vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed <= FLING_MAX_SPEED) return { x: vx, y: vy };
  const k = FLING_MAX_SPEED / speed;
  return { x: vx * k, y: vy * k };
}

/** 抬手速度是否够得上「甩」：低于门槛就当没动过。 */
export function isFlingVelocity(velocity: Vec2): boolean {
  return Math.hypot(velocity.x, velocity.y) >= FLING_MIN_SPEED;
}

/** 速度 → 投影位移（px）。 */
export function projectFling(velocity: Vec2): Vec2 {
  return { x: velocity.x * FLING_TAU_MS, y: velocity.y * FLING_TAU_MS };
}

/**
 * PB-8：越界部分乘阻尼。界内原样返回 —— 越界只在拖动过程中出现，
 * 抬手后由 `clampToPane` 收回去，所以这里不做上限截断（手指能推多远就多远）。
 */
export function dampOverscroll(pos: Vec2, max: Vec2): Vec2 {
  const axis = (v: number, m: number) => {
    if (v > m) return m + (v - m) * RUBBER_BAND;
    if (v < -m) return -m + (v + m) * RUBBER_BAND;
    return v;
  };
  return { x: axis(pos.x, max.x), y: axis(pos.y, max.y) };
}

/** 单栏：越界阻尼版的目标位置。 */
export function dampToPane(
  pane: HTMLElement | null,
  img: HTMLElement | null,
  pos: Vec2,
  scale: number,
): Vec2 {
  const max = paneMaxPan(pane, img, scale);
  return dampOverscroll(pos, max);
}

/** 联动双栏：越界阻尼版的目标位置（公共边界，口径同 `clampToPanePair`）。 */
export function dampToPanePair(
  paneA: HTMLElement | null,
  imgA: HTMLElement | null,
  scaleA: number,
  paneB: HTMLElement | null,
  imgB: HTMLElement | null,
  scaleB: number,
  pos: Vec2,
): Vec2 {
  const ma = paneMaxPan(paneA, imgA, scaleA);
  const mb = paneMaxPan(paneB, imgB, scaleB);
  return dampOverscroll(pos, { x: Math.min(ma.x, mb.x), y: Math.min(ma.y, mb.y) });
}

/**
 * 收尾曲线：从 `from` 指数逼近 `to`。
 *
 * 初始速度 = `(to − from) / τ`，而 `to − from` 正是 `v · τ` 的投影 ——
 * 抬手瞬间的速度与手指速度连续，不会出现「一松手画面突然加速/顿住」。
 */
export function inertiaAt(from: Vec2, to: Vec2, elapsedMs: number): Vec2 {
  const remain = Math.exp(-Math.max(0, elapsedMs) / FLING_TAU_MS);
  return { x: to.x + (from.x - to.x) * remain, y: to.y + (from.y - to.y) * remain };
}

/** 在飞的收尾句柄。`stop()` 之后不会再有任何一帧写入。 */
export interface InertiaRun {
  stop: () => void;
}

/**
 * 用 rAF 驱动一次收尾：每帧 `onFrame(位置)`，落定调 `onDone()`。
 *
 * 为什么是 rAF 而不是 CSS `transition`：惯性要把「速度」逐步泄掉，落点还得
 * 每帧重夹；CSS 补间只能从 A 到 B，途中改不了。通道用 `GESTURE`（不补间），
 * 否则 CSS 会追着每一帧再补一次，变成双重缓动。
 */
export function runInertia(
  from: Vec2,
  to: Vec2,
  onFrame: (pos: Vec2) => void,
  onDone: () => void,
): InertiaRun {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  let frame = 0;
  let start = Number.NaN;

  const tick = (now: number) => {
    if (Number.isNaN(start)) start = now;
    const elapsed = now - start;
    const remain = Math.exp(-Math.max(0, elapsed) / FLING_TAU_MS);
    if (elapsed >= FLING_MAX_MS || distance * remain <= FLING_SETTLE_EPSILON) {
      frame = 0;
      onFrame(to);
      onDone();
      return;
    }
    onFrame(inertiaAt(from, to, elapsed));
    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);
  return {
    stop: () => {
      if (!frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
