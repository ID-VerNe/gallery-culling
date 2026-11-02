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
import { PhotoGroupInfo, ToneAdjustments, LumenStatus } from '../types';
import { getToneFilterString } from '../utils/autoTone';
import { ZOOM_STEP, ZOOM_MIN, ZOOM_MAX, isFitScale, scaleLabel } from '../utils/viewportZoom';
import { useZoomPan } from '../hooks/useZoomPan';
import { useViewportImage } from '../hooks/useViewportImage';
import { useLumenDetail } from '../hooks/useLumenDetail';
import { LUMEN_UNAVAILABLE } from '../hooks/useLumenStatus';
import { ViewportEmptyStateView } from './ViewportEmptyState';
import { ExifCapsule } from './ExifCapsule';
import {
  BAR_BUTTON,
  BAR_DIVIDER,
  BAR_GROUP_HOST,
  BAR_HIT_AREA,
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
   * 进 1:1 的唯一入口：按 Z 与双击都落在这里。
   * JPG 分组原图就是全分辨率，不需要（也不该）花 6–8 秒渲染。
   *
   * `fallback` 只在算不出 1:1（预览还没布局）时兜底，见 `zoom.oneToOne`。
   */
  const enterOneToOne = useCallback(
    (fallback?: number) => {
      const showDetail = () => {
        if (zoom.oneToOne(fallback) !== null) oneToOneModeRef.current = true;
      };
      if (group?.jpg?.path || detail.url) {
        showDetail();
        return;
      }
      // RAW-only 且还没细节：先请求，等图真正加载完再切（onLoad 里接手）。
      pendingOneToOneRef.current = true;
      detail.request();
      // 一张照片可能早就被别处请求过（缓存在飞）。这时 onLoad 也会来，
      // 但不能把「这一帧什么都不做」当成默认——算得出落点就先切过去，
      // 等到手的也只是同一个落点。算不出来（预览还没布局）才交给 onLoad。
      showDetail();
    },
    [zoom, group, detail],
  );

  const toggleOneToOne = useCallback(() => {
    // 已在 1:1 → 回适应（同一个键来回切，与双击的「适应 ↔ 放大」同构）。
    if (oneToOneModeRef.current) {
      zoom.reset();
      oneToOneModeRef.current = false;
      return;
    }

    // 正在等这次请求的图：再按一次 = 收回请求，图到了也不要再切过去。
    if (pendingOneToOneRef.current) {
      pendingOneToOneRef.current = false;
      return;
    }

    enterOneToOne();
  }, [zoom, enterOneToOne]);

  // 任何非 Z 的离开 1:1 都会让模式打回适应，否则下一次按 Z 会复位到一个
  // 用户早就离开的画面；等图的请求同样作废。
  useEffect(() => {
    zoom.setOneToOneLeaveListener(() => {
      oneToOneModeRef.current = false;
      pendingOneToOneRef.current = false;
    });
  }, [zoom]);

  // 换图：resetKey 变化会把缩放复位，等图的请求也不再指向当前这张。
  useEffect(() => {
    pendingOneToOneRef.current = false;
    oneToOneModeRef.current = false;
  }, [group?.id]);

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
          {/* 出口标准要求「渲染中可取消」：取消只让提示消失，渲染会跑完并落缓存。 */}
          <button
            type="button"
            onClick={detail.cancel}
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
            if (!pendingOneToOneRef.current) return;
            pendingOneToOneRef.current = false;
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
          <span>正在查看原片（松开 \ 键恢复）</span>
        </div>
      )}

      <ExifCapsule exif={group.exif} />

      {/* Navigation Overlay Buttons — opaque enough to read over any photo */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onPrev();
        }}
        className="focus-ring absolute left-3 top-1/2 -translate-y-1/2 p-3 bg-background-base/70 hover:bg-background-base/90 active:scale-[0.96] text-white rounded-full transition-colors backdrop-blur-sm pointer-events-auto"
        title="上一张 (A / ←)"
        aria-label="上一张照片（快捷键 A 或 ←）"
      >
        <ChevronLeft className="w-6 h-6" aria-hidden="true" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onNext();
        }}
        className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 p-3 bg-background-base/70 hover:bg-background-base/90 active:scale-[0.96] text-white rounded-full transition-colors backdrop-blur-sm pointer-events-auto"
        title="下一张 (D / →)"
        aria-label="下一张照片（快捷键 D 或 →）"
      >
        <ChevronRight className="w-6 h-6" aria-hidden="true" />
      </button>

      {/* Floating Bottom Quick Action Bar — geometry frozen (issue #12)
          The bar carries the app's core culling verbs, so it must never be a
          hover-only affordance (F-02, .plan/ux-audit-2026-10-13.md:39): the
          icons are ALWAYS on screen and always focusable. What collapses is
          the weight — no plate, no shadow, no visible labels — until the
          pointer enters (`group-hover/bar`) or focus lands inside it
          (`group-focus-within/bar`), so keyboard users never operate blind.

          #10 got this shape right but made the outer box change size on
          hover (px-3→px-4 / py-1→py-2 / w-0→w-auto), which measured 497px →
          753px in a real browser. A box that grows under the cursor makes
          `:hover` flicker: this is the bug #12 replaces. The rules that keep
          it frozen live in `viewportBarStyles.ts` — read that first.

          Two extra notes specific to this call site:
          - Hover is pure CSS: no `useState`, so a stale "left open" frame
            (the other failure mode F-02 recorded) cannot happen.
          - `overflow-hidden` is deliberately absent on the plate: it would
            clip the 2px `.focus-ring` outline (index.css focus-ring).
            Hiding is done by opacity on the label slot, not by clipping.
          - `pointer-events-none` on the plate + a larger child hit area
            means the pixels around the icons do not swallow clicks meant
            for the photo beneath, while the bar still opens on approach.
          - The `group/bar` host is a separate wrapper (issue #14): Tailwind
            compiles `group-hover/bar:x` to a DESCENDANT selector, so an
            element can never be its own group ancestor. See the root-cause
            note in `viewportBarStyles.ts`. */}
      <div className={BAR_GROUP_HOST}>
        <div
          onClick={(e) => e.stopPropagation()}
          className={`${BAR_PLATE} pointer-events-none`}
        >
          {/* Hit area: covers the plate plus a ring around it. Transparent and
              size-constant, so it can never be the thing that changes size. */}
          <div className={BAR_HIT_AREA} data-bar-hit-area aria-hidden="true" />

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
                  : 'bg-white/10 text-white/80 hover:bg-white/20 border border-transparent'
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
                  : 'bg-white/10 text-white/80 hover:bg-white/20 border border-transparent'
              }`}
              title="淘汰 (X)"
              aria-label="标记淘汰 (Reject)"
              aria-pressed={group.flag === 'reject'}
            >
              <X className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className={BAR_LABEL}>Reject</span>
            </button>
          </div>

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
              className={`${BAR_BUTTON} bg-white/10 hover:bg-white/20 text-white border border-border-default disabled:opacity-50 disabled:cursor-not-allowed`}
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
            title="外部打开 (O)"
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
