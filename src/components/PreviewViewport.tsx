import React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Star,
  Check,
  X,
  ExternalLink,
  RotateCcw,
  Sparkles,
  Sliders,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { PhotoGroupInfo, ToneAdjustments, LumenStatus, ColorLabel } from '../types';
import { getToneFilterString } from '../utils/autoTone';
import { ZOOM_STEP, ZOOM_MIN, ZOOM_MAX, isFitScale, scaleLabel } from '../utils/viewportZoom';
import { useZoomPan } from '../hooks/useZoomPan';
import { useViewportImage } from '../hooks/useViewportImage';
import { useLumenDetail } from '../hooks/useLumenDetail';
import { LUMEN_UNAVAILABLE } from '../hooks/useLumenStatus';
import { ViewportEmptyStateView } from './ViewportEmptyState';
import { ExifCapsule } from './ExifCapsule';
import { LabelDots } from './LabelDots';
import {
  BAR_BUTTON,
  BAR_DIVIDER,
  BAR_GROUP_HOST,
  BAR_HANDLE,
  BAR_ICONS,
  BAR_ICON_BUTTON,
  BAR_LABEL,
  BAR_PLATE,
  BAR_STAR_BUTTON,
} from './viewportBarStyles';

interface PreviewViewportProps {
  group?: PhotoGroupInfo;
  tone?: ToneAdjustments;
  isHoldOriginal?: boolean;
  onPrev: () => void;
  onNext: () => void;
  onRate: (rating: number) => void;
  onFlag: (flag: 'pick' | 'reject' | 'none') => void;
  /** SH-01：底栏色点（鼠标可达），语义与 `Shift+1…5` 完全一致。 */
  onLabel?: (label: ColorLabel) => void;
  onOpenExternal: () => void;
  onOpenLuminar?: () => void;
  onToggleTonalAdjuster?: () => void;
  isLuminarRunning?: boolean;
  /** Whether the tonal panel is currently shown, for the toggle's pressed state. */
  isTonalPanelOpen?: boolean;
  /**
   * Receives the rendered <img> so the shell can sample the histogram for
   * auto-tone. Previously the shell did `querySelector('img[alt=...]')`,
   * which breaks as soon as two photos share a basename (F-15).
   */
  onImageElement?: (el: HTMLImageElement | null) => void;
  /** Copy and action for the "nothing to show" state, decided by the shell. */
  emptyState?: ViewportEmptyState;
  /** LUMEN RAW 引擎握手状态；可用时 RAW 走真实解码预览。 */
  lumenStatus?: LumenStatus;
  /** 渲染中的宽边（默认 1600，宿主侧上限）。 */
  lumenPreviewWidth?: number;
  /**
   * 1:1 的触发通道：视口把自己的 toggle 注册进这个 ref，App 的全局快捷键
   * 只负责把 `Z` 映射过来。缩放状态属于视口，不能提到 App（否则双栏/前后
   * 对照各有一份，`Z` 该切哪个就说不清了）。
   */
  oneToOneRef?: React.MutableRefObject<() => void>;
}

/** Everything the viewports need to render a meaningful empty state. */
export interface ViewportEmptyState {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const PreviewViewport: React.FC<PreviewViewportProps> = ({
  group,
  tone,
  isHoldOriginal = false,
  onPrev,
  onNext,
  onRate,
  onFlag,
  onLabel,
  onOpenExternal,
  onOpenLuminar,
  onToggleTonalAdjuster,
  isLuminarRunning = false,
  onImageElement,
  isTonalPanelOpen = false,
  lumenStatus,
  lumenPreviewWidth = 1600,
  oneToOneRef,
  emptyState = {
    title: '未加载照片',
    description: '请选择存放 JPG 的文件夹用于浏览与选片；RAW 文件夹可选。',
  },
}) => {
  // 缩放/平移机器（绝对系拖拽、命中光标缩放、夹紧、换图复位）。
  const zoom = useZoomPan(group?.id, onImageElement);

  // 图片源解析（LUMEN 预览 + 失败 latch + C2 口径，三视口共用）。
  const image = useViewportImage(group, lumenStatus ?? LUMEN_UNAVAILABLE, lumenPreviewWidth);

  // FR-05：RAW-only 的全分辨率细节（按 Z 才请求，6–8 秒/张）。
  const detail = useLumenDetail(group, lumenStatus ?? LUMEN_UNAVAILABLE);
  /**
   * PB-10：上一次按 Z 的落点是 1:1 还是适应（同一个键来回切）。
   *
   * 不能记下 1:1 的比例再拿当前 scale 跟它比 —— 固定窗口（`|差| < 0.02`）
   * 会把「离开了一格又落回窗口内」读成「还在 1:1」，精确相等又会让 1:1
   * 只在当前值恰好等于它时成立，而重算 1:1 与「已经在 1:1」在数值上不可区分。
   * 记模式是唯一自洽的：1:1 的落点就是 `zoom.oneToOne()`，离开 1:1 的
   * 每个入口（滚轮 / 拖拽 / 双击 / 复位 / 换图）都会把模式打回适应。
   */
  const oneToOneModeRef = useRef(false);

  /**
   * 等在飞的细节图时，「这次请求是不是为了进 1:1」。
   *
   * 请求与模式是两件事：等图的 6–8 秒里用户可能滚轮 / 拖拽 / 换图离开，
   * 也可能按 Z 放弃（PB-10 的 C1 场景）。图加载完时若不再是要进 1:1，
   * **什么都不做**——直接 `zoom.oneToOne()` 会把用户已经调好的画面掰回去。
   */
  const pendingOneToOneRef = useRef(false);
  /**
   * 上面那个「等细节到位再切」的意图，**这一次请求**还算不算数。
   *
   * `pendingOneToOneRef` 只回答「按过 Z 还没有结果」，会被「再按一次收回」
   * 与离开 1:1 清掉；`wantOneToOneRef` 只在「按 Z 请求」时置位、在结果到达时
   * 消费。两者分开是因为 `src` 从预览换成细节时 React 复用同一个 `<img>`
   * 节点，**不保证**再送一次 `onLoad`：到达结算走的是结果到达的 effect，
   * 而 onLoad 那条路可能根本不来。`want` 回答「这次请求还算不算数」，模式位
   * 回答「画面现在是不是 1:1」—— 混成一个的话，图到了、也切到了 1:1，下一次
   * 按 Z 却会当成「再进一次 1:1」。
   */
  const wantOneToOneRef = useRef(false);

  // 等图期间「撤销进 1:1」的唯一出口：取消（按钮与再按 Z 都落到这里）、
  // 判失败。
  //
  // 它同时也退出 1:1：进 1:1 时画面**当场**就切成细节的落点（图还没到，
  // 先按预览算），所以取消之后画面仍停在放大状态。不把模式一起打回去的话，
  // 下一次按 Z 走的是「已在 1:1 → 复位」，`enterOneToOne` 根本不执行、在飞
  // 的那次不会被认领，图到了也没有人采用（真机 e2e 的 D13/D14）。
  //
  // 反过来，**结果到达时不能调它**：那时模式刚被置成真，进来就是一次
  // `zoomReset()`，等于在到达的当帧把刚切上的 1:1 撤掉。
  const zoomReset = zoom.reset;
  const zoomOneToOne = zoom.oneToOne;
  const zoomLeave = zoom.setOneToOneLeaveListener;

  const abandonPendingOneToOne = useCallback(() => {
    if (oneToOneModeRef.current) zoomReset();
    oneToOneModeRef.current = false;
    pendingOneToOneRef.current = false;
    wantOneToOneRef.current = false;
  }, [zoomReset]);

  /**
   * 进 1:1 的唯一入口：按 Z 与双击都落在这里。
   * JPG 分组原图就是全分辨率，不需要（也不该）花 6–8 秒渲染。
   *
   * `fallback` 只在算不出 1:1（预览还没布局）时兜底，见 `zoom.oneToOne`。
   */
  const enterOneToOne = useCallback(
    (fallback?: number) => {
      const showDetail = () => {
        if (zoomOneToOne(fallback) !== null) oneToOneModeRef.current = true;
      };
      if (group?.jpg?.path || detail.url) {
        showDetail();
        return;
      }
      // RAW-only 且还没细节：先请求，等图真正加载完再切（onLoad 里接手）。
      pendingOneToOneRef.current = true;
      wantOneToOneRef.current = true;
      // 先请求**再**结算落点：`detail.request()` 是同步的，取消后马上再按 Z
      // 会让 hook 重新认领在飞的那张 —— 复用它上面已经拿到的一次 setLoading
      // 重渲染。顺序反过来的话，这一帧的渲染可能带着 cancel() 留下的
      // `loading=false` 落到 DOM 上（15ms 真实计时器静默吞掉一次 setState）。
      detail.request();
      // 一张照片可能早就被别处请求过（缓存在飞）。这时 onLoad 也会来，
      // 但不能把「这一帧什么都不做」当成默认 —— 算得出落点就先切过去，
      // 等到手的也只是同一个落点。算不出来（预览还没布局）才交给 onLoad。
      showDetail();
    },
    [zoomOneToOne, group, detail],
  );

  const toggleOneToOne = useCallback(() => {
    // 已在 1:1 → 回适应（同一个键来回切，与双击的「适应 ↔ 放大」同构）。
    if (oneToOneModeRef.current) {
      // 回适应同样是一次「不再等」：放着 pending 的话，图一到，结果到达的
      // effect 会把画面从适应拽回细节落点 —— 用户刚按了「退出 1:1」，画面
      // 却在 6–8 秒后自己放大。
      pendingOneToOneRef.current = false;
      wantOneToOneRef.current = false;
      zoomReset();
      oneToOneModeRef.current = false;
      return;
    }

    // 正在等这次请求的图：再按一次 = 收回请求，图到了也不要再切过去。
    if (pendingOneToOneRef.current) {
      abandonPendingOneToOne();
      return;
    }

    enterOneToOne();
  }, [enterOneToOne, abandonPendingOneToOne]);

  // 任何非 Z 的离开 1:1 都会让模式打回适应，否则下一次按 Z 会复位到一个
  // 用户早就离开的画面；等图的请求同样作废。
  useEffect(() => {
    zoomLeave(() => {
      oneToOneModeRef.current = false;
      pendingOneToOneRef.current = false;
      wantOneToOneRef.current = false;
    });
  }, [zoomLeave]);

  // 换图：`resetKey` 变化已经把画面复位了（并在离开 1:1 的监听里清掉了
  // 等图标志），这里只补模式位。不能调 `abandonPendingOneToOne`：它会顺手
  // `zoom.reset()`，等于在复位效果里再 set 一次同样的值，多一轮渲染。
  useEffect(() => {
    oneToOneModeRef.current = false;
    pendingOneToOneRef.current = false;
    wantOneToOneRef.current = false;
  }, [group?.id]);


  // 结果到达就切：不能只指望 `src` 换成细节时 `<img onLoad>` 会再来一次。
  // 布局还没起来（真机上早于 onLoad）时算不出落点，那就**什么都别消费**，
  // 留给 onLoad 接手 —— 先清标志再算落点，会让 onLoad 看到一个「没人等」的
  // pending，图到了却停在适应。
  useEffect(() => {
    if (!wantOneToOneRef.current || !detail.url) return;
    const land = zoomOneToOne();
    if (land === null) return;
    // 落点已经结算，这里**只**清两个等图标志，绝不能走
    // `abandonPendingOneToOne` —— 它见到模式为真就会 `zoom.reset()`，等于
    // 在结果到达的当帧把刚切上的 1:1 撤掉。模式标记也不能跟着 `want` 一起
    // 清：`want` 回答的是「这次请求还算不算数」，模式回答的是「画面现在是
    // 不是 1:1」；混成一个的话，图到了、也确实切到了 1:1，下一次按 Z 却会
    // 当成「再进一次 1:1」。
    oneToOneModeRef.current = true;
    pendingOneToOneRef.current = false;
    wantOneToOneRef.current = false;
    // 刻意不依赖 `abandonPendingOneToOne`：它的身份随 `zoom` 变化，而
    // `zoom.reset()` 会换掉 `zoom.scale` 的对象身份 —— 依赖它等于让这个
    // 「结果到了」的 effect 在每次复位后重跑。
  }, [detail.url, zoomOneToOne]);

  useEffect(() => {
    if (!detail.failed) return;
    abandonPendingOneToOne();
  }, [detail.failed, abandonPendingOneToOne]);

  // 把 toggle 注册给全局快捷键（Z）。视口不在时（双栏 / 前后对照）清空，
  // 避免 `Z` 打到已经卸载的视口上。
  useEffect(() => {
    if (!oneToOneRef) return;
    oneToOneRef.current = toggleOneToOne;
    return () => {
      oneToOneRef.current = () => {};
    };
  }, [oneToOneRef, toggleOneToOne]);

  // 双击与 Z 同构：适应 → 1:1（必要时先请求细节），1:1 → 适应。落点走同一组
  // 入口，读数才一致；否则双击在 RAW 上会跳到一个「适应 × 2.5」的假放大。
  // 算不出 1:1（预览还没布局）时退到「适应 × DOUBLE_CLICK_SCALE」，仍是放大。
  const zoomDoubleClickScale = zoom.bind.doubleClickScale;
  const handleDoubleClick = useCallback(() => {
    const target = zoomDoubleClickScale();
    if (isFitScale(target)) {
      zoom.reset();
      oneToOneModeRef.current = false;
      return;
    }
    enterOneToOne(target);
  }, [zoomDoubleClickScale, zoom, enterOneToOne]);

  if (!group) {
    return <ViewportEmptyStateView emptyState={emptyState} />;
  }

  // A LUMEN render is already tone-mapped: never stack the CSS tone filter on it
  // (that would develop the image twice). 细节图同样是 LUMEN 渲染的成品。
  const usingDetail = Boolean(detail.url);
  const displaySrc = detail.url ?? image.src;
  const toneFilter = image.lumenActive || usingDetail
    ? 'none'
    : getToneFilterString(isHoldOriginal ? undefined : tone);

  // C1/C2：RAW-only 解码中 → 走主视图显示「正在渲染 RAW…」横幅；失败/未启用 → 明确占位而非破图。
  if (!displaySrc && !(image.rawOnly && image.loading)) {
    const engineAvailable = lumenStatus?.available === true;
    return (
      <ViewportEmptyStateView
        emptyState={
          image.rawOnly
            ? engineAvailable
              ? {
                  title: 'RAW 预览暂不可用',
                  description: 'LUMEN RAW 引擎未能解码该照片，请稍后重试或改用其它视图。',
                }
              : {
                  title: '该 RAW 需启用 LUMEN RAW 引擎',
                  description:
                    '当前为 RAW-only 照片，启用 LUMEN RAW 引擎后即可实时预览；JPG 照片不受影响。',
                }
            : emptyState
        }
      />
    );
  }

  // C6：scale=1 实为「适应窗口」，并非 1:1 像素，别显示误导性的 100%。
  const zoomLabel = scaleLabel(zoom.scale);

  return (
    <div
      ref={zoom.containerRef}
      onWheel={zoom.bind.onWheel}
      onPointerDown={zoom.bind.onPointerDown}
      onPointerMove={zoom.bind.onPointerMove}
      onPointerUp={zoom.bind.onPointerUp}
      onPointerCancel={zoom.bind.onPointerUp}
      onDoubleClick={handleDoubleClick}
      className={`relative flex-1 bg-background-base overflow-hidden flex items-center justify-center select-none ${
        zoom.isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
    >
      {/* Zoomable Image */}
      {image.loading && !image.lumenActive && (
        <div
          role="status"
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-white/80 border border-border-default pointer-events-none"
        >
          正在渲染 RAW…
        </div>
      )}

      {/* FR-05：1:1 细节是 6–8 秒的操作，必须说清楚在做什么（不能只有转圈）。 */}
      {detail.loading && (
        <div
          role="status"
          className="absolute top-14 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-background-base/90 backdrop-blur-md pl-3.5 pr-1.5 py-1 rounded-md text-xs font-semibold text-sky-300 border border-sky-500/40 pointer-events-none"
        >
          正在生成 1:1 细节…（6–8 秒，可继续浏览其它照片）
          {/* 出口标准要求「渲染中可取消」：取消只让提示消失，渲染会跑完并落缓存。
              不再等待 = 这一次按 Z 的意图作废，结果到了也不切 1:1。 */}
          <button
            type="button"
            onClick={() => {
              detail.cancel();
              abandonPendingOneToOne();
            }}
            title="只是不再等待；渲染会继续跑完并落缓存，下次按 Z 直接命中"
            className="pointer-events-auto px-2 py-0.5 rounded text-[11px] font-semibold text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          >
            取消
          </button>
        </div>
      )}
      {detail.busy && (
        <div
          role="status"
          className="absolute top-14 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-amber-300 border border-amber-500/40 pointer-events-none"
        >
          另一张的 1:1 细节正在生成，请稍候再按 Z
        </div>
      )}
      {detail.failed && (
        <div
          role="status"
          className="absolute top-14 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-rose-300 border border-rose-500/40 pointer-events-none"
        >
          细节渲染失败，已退回预览图
        </div>
      )}

      {displaySrc && (
        <img
          ref={zoom.imageRef}
          src={displaySrc}
          alt={group.baseName}
          draggable={false}
          // 自动调色会对这张图做 canvas 采样（getImageData）。asset:// 是跨源
          // 资源，不带 crossOrigin 时 canvas 被污染、采样必抛 SecurityError
          // （表现为「自动按钮无反应」，2026-10-15 真窗口 e2e 复现）。asset 协议
          // 对全部响应返回 Access-Control-Allow-Origin（tauri 2.11.5
          // protocol/asset.rs），可安全启用。
          crossOrigin="anonymous"
          onLoad={() => {
            // 细节图加载完才知道真实像素宽：此刻才能算 1:1。
            // 结果到达的 effect 已经先试过一次（缓存命中时比布局早），到这里
            // 只剩「那次没算出来」与「还没到」两种。两条路径共用同一个出口，
            // 否则 onLoad 不来的那一次会让 pending 永远挂住。
            if (!pendingOneToOneRef.current) return;
            abandonPendingOneToOne();
            if (zoom.oneToOne() !== null) oneToOneModeRef.current = true;
          }}
          onError={() => {
            // 细节图加载失败（缓存被删/写坏）与预览图加载失败是两条路径：
            // 前者可能根本没走过预览成功，不能靠 image.markBroken 的 latch。
            if (usingDetail) detail.markBroken();
            else image.markBroken();
          }}
          style={{
            transform: zoom.transform,
            transition: zoom.transition,
            imageOrientation: 'from-image',
            filter: toneFilter,
          }}
          className="max-h-full max-w-full object-contain pointer-events-none origin-center"
        />
      )}

      {/* 含成品提示：该分组存在 edited（Luminar 成果）。
          主图口径仍是工作版（jpg/raw + LUMEN 调色）——这里只提示、不改显示内容，
          避免 edited 在单图视图里无声消失。 */}
      {group.edited && (
        <div
          className="absolute top-3 left-3 bg-purple-500/15 border border-purple-500/30 text-purple-300 backdrop-blur-md px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 pointer-events-none"
          title="包含精修成果 (Luminar AI)"
        >
          <Sparkles className="w-3 h-3" aria-hidden="true" />
          <span>含成品</span>
        </div>
      )}

      {/* Hold Original Indicator — static, no pulsing animation (F-20) */}
      {isHoldOriginal && (
        <div
          role="status"
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-amber-300 border border-amber-500/40 flex items-center gap-2 pointer-events-none"
        >
          <span>正在查看原片（松开 V 键恢复）</span>
        </div>
      )}

      <ExifCapsule exif={group.exif} />

      {/* Navigation Overlay Buttons — opaque enough to read over any photo */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onPrev();
        }}
        className="focus-ring absolute left-3 top-1/2 -translate-y-1/2 p-3 bg-background-base/70 hover:ring-1 hover:ring-white/25 active:scale-[0.96] text-white rounded-full press backdrop-blur-sm pointer-events-auto"
        title="上一张 (A)"
        aria-label="上一张照片（快捷键 A）"
      >
        <ChevronLeft className="w-6 h-6" aria-hidden="true" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onNext();
        }}
        className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 p-3 bg-background-base/70 hover:ring-1 hover:ring-white/25 active:scale-[0.96] text-white rounded-full press backdrop-blur-sm pointer-events-auto"
        title="下一张 (D)"
        aria-label="下一张照片（快捷键 D）"
      >
        <ChevronRight className="w-6 h-6" aria-hidden="true" />
      </button>

      {/* Floating Bottom Quick Action Bar — geometry frozen (issue #12)
          The bar carries the app's core culling verbs, so it must never be a
          hover-only affordance (F-02, .plan/ux-audit-2026-10-13.md:39): the
          buttons stay reachable by Tab, and a small handle keeps the bar
          discoverable while it rests (issue #47).

          #10 made the outer box change size on hover (px-3→px-4 / py-1→py-2 /
          w-0→w-auto), which measured 497px → 753px in a real browser. A box
          that grows under the cursor makes `:hover` flicker: this is the bug
          #12 replaces. The rules that keep it frozen live in
          `viewportBarStyles.ts` — read that first.

          Notes specific to this call site:
          - Hover is pure CSS: no `useState`, so a stale "left open" frame
            (the other failure mode F-02 recorded) cannot happen.
          - `overflow-hidden` is deliberately absent on the plate: it would
            clip the 2px `.focus-ring` outline (index.css focus-ring).
          - Issue #46: the plate itself is `pointer-events-auto` (the wrapper
            keeps `pointer-events-none`, so the empty space around the bar
            still passes clicks to the photo). There is **no** transparent
            oversized hit layer: it painted above the buttons and swallowed
            every click.
          - Issue #47: at rest the whole plate is translated out of the
            viewport; only the 4px `BAR_HANDLE` remains. It is a descendant of
            `group/bar`, so hovering/focusing it slides the plate back.
          - The `group/bar` host is a separate wrapper (issue #14): Tailwind
            compiles `group-hover/bar:x` to a DESCENDANT selector, so an
            element can never be its own group ancestor. See the root-cause
            note in `viewportBarStyles.ts`. */}
      <div className={BAR_GROUP_HOST}>
        {/* 展开手柄（issue #47）：静息时唯一留在屏幕上的底栏痕迹。 */}
        <div
          className={BAR_HANDLE}
          data-bar-handle
          tabIndex={0}
          aria-label="展开底栏工具栏"
        />
        <div
          onClick={(e) => e.stopPropagation()}
          className={BAR_PLATE}
          data-bar-plate
        >
          {/* Rating Stars (1 to 5) */}
          <div className={BAR_DIVIDER} role="group" aria-label="照片星级打分">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                onClick={() => onRate(group.rating === star ? 0 : star)}
                className={`${BAR_STAR_BUTTON} ${BAR_ICONS} ${
                  group.rating >= star
                    ? 'text-amber-400 hover:text-amber-300'
                    : 'text-white/60 hover:text-white'
                }`}
                title={`评 ${star} 星（${star}）`}
                aria-label={`评 ${star} 星`}
                aria-pressed={group.rating >= star}
              >
                <Star
                  className={`w-4 h-4 ${group.rating >= star ? 'fill-amber-400' : ''}`}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>

          {/* Pick / Reject / Unflag */}
          <div className={BAR_DIVIDER} role="group" aria-label="保留或淘汰标记">
            <button
              onClick={() => onFlag(group.flag === 'pick' ? 'none' : 'pick')}
              className={`${BAR_BUTTON} ${BAR_ICONS} ${
                group.flag === 'pick'
                  ? 'bg-emerald-600/40 text-emerald-300 border border-emerald-500/50'
                  : 'bg-transparent text-white/80 hover:bg-white/20 border border-transparent'
              }`}
              title="保留 (P)"
              aria-label="标记保留 (Pick)"
              aria-pressed={group.flag === 'pick'}
            >
              <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className={BAR_LABEL}>Pick</span>
            </button>
            <button
              onClick={() => onFlag(group.flag === 'reject' ? 'none' : 'reject')}
              className={`${BAR_BUTTON} ${BAR_ICONS} ${
                group.flag === 'reject'
                  ? 'bg-rose-600/40 text-rose-300 border border-rose-500/50'
                  : 'bg-transparent text-white/80 hover:bg-white/20 border border-transparent'
              }`}
              title="淘汰 (X)"
              aria-label="标记淘汰 (Reject)"
              aria-pressed={group.flag === 'reject'}
            >
              <X className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className={BAR_LABEL}>Reject</span>
            </button>
          </div>

          {/* 色标（SH-01）：鼠标可达的五色入口，与 Shift+1…5 同语义。 */}
          {onLabel && (
            <div className={BAR_DIVIDER}>
              <LabelDots label={group.label} onSelect={onLabel} />
            </div>
          )}

          {/* Zoom: – / readout / reset / +
              Zoom used to live only on wheel and double-click, both of which
              are undiscoverable and keyboard-inaccessible (F-25). */}
          <div className={BAR_DIVIDER} role="group" aria-label="缩放控制">
            <button
              onClick={() => zoom.zoomBy(1 / ZOOM_STEP)}
              disabled={zoom.scale <= ZOOM_MIN}
              className={`${BAR_ICON_BUTTON} ${BAR_ICONS}`}
              title="缩小"
              aria-label="缩小"
            >
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            {/* Zoom readout: same constant-width slot as the text labels, so
                the value going 100% → 1000% cannot drag the plate wider. */}
            <span
              className={`${BAR_LABEL} font-mono tabular-nums text-[11px] text-white/80 select-none`}
              aria-label={`当前缩放 ${zoomLabel}`}
            >
              {zoomLabel}
            </span>
            <button
              onClick={() => zoom.zoomBy(ZOOM_STEP)}
              disabled={zoom.scale >= ZOOM_MAX}
              className={`${BAR_ICON_BUTTON} ${BAR_ICONS}`}
              title="放大"
              aria-label="放大"
            >
              <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              onClick={zoom.reset}
              className={`${BAR_ICON_BUTTON} ${BAR_ICONS}`}
              title={`重置缩放与平移（当前 ${zoomLabel}）`}
              aria-label={`重置缩放与平移，当前 ${zoomLabel}`}
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Tonal Adjuster Toggle */}
          {onToggleTonalAdjuster && (
            <button
              onClick={onToggleTonalAdjuster}
              className={`${BAR_BUTTON} bg-white/10 hover:bg-white/20 text-white`}
              title="调色面板 (E)"
              aria-label="调色面板"
              aria-pressed={isTonalPanelOpen}
              aria-expanded={isTonalPanelOpen}
              aria-controls="tonal-adjuster-panel"
            >
              <Sliders className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className={BAR_LABEL}>调色</span>
            </button>
          )}

          {/* Luminar AI Roundtrip */}
          {onOpenLuminar && (
            <button
              onClick={onOpenLuminar}
              disabled={isLuminarRunning}
              className={`${BAR_BUTTON} bg-white/10 hover:bg-white/20 text-white border border-border-default disabled:opacity-40 disabled:cursor-not-allowed`}
              title="Luminar AI 修图"
              aria-label="在 Luminar AI 中修图"
            >
              <Sparkles
                className={`w-3.5 h-3.5 shrink-0 ${isLuminarRunning ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {/* 槽位宽度由 .bar-label 常驻给足，「运行中…」不会把盒子撑开。 */}
              <span className={BAR_LABEL}>
                {isLuminarRunning ? '运行中…' : 'Luminar AI'}
              </span>
            </button>
          )}

          {/* Open in Photoshop / External app */}
          <button
            onClick={onOpenExternal}
            className={`${BAR_BUTTON} bg-white/10 hover:bg-white/20 text-white`}
            title="外部打开 (W)"
            aria-label="在修图或外部程序中打开"
          >
            <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className={BAR_LABEL}>外部打开</span>
          </button>
        </div>
      </div>
    </div>
  );
};
