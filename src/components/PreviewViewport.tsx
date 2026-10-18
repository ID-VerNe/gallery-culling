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
import { ZOOM_STEP, ZOOM_MIN, ZOOM_MAX, scaleLabel } from '../utils/viewportZoom';
import { useZoomPan } from '../hooks/useZoomPan';
import { useViewportImage } from '../hooks/useViewportImage';
import { useLumenDetail } from '../hooks/useLumenDetail';
import { LUMEN_UNAVAILABLE } from '../hooks/useLumenStatus';
import { ViewportEmptyStateView } from './ViewportEmptyState';
import { ExifCapsule } from './ExifCapsule';

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
  /** 上一次 1:1 的比例（用于「再按一次回适应」的判定）。 */
  const oneToOneScaleRef = useRef<number | null>(null);
  /** 按 Z 时细节还没就绪 → 等 img onLoad 再切，不能立刻用预览宽度算。 */
  const pendingOneToOneRef = useRef(false);

  const toggleOneToOne = useCallback(() => {
    // 已在 1:1 → 回适应（同一个键来回切，与双击的「适应 ↔ 放大」同构）。
    const known = oneToOneScaleRef.current;
    if (known !== null && Math.abs(zoom.scale - known) < 0.02) {
      zoom.reset();
      oneToOneScaleRef.current = null;
      return;
    }

    // JPG 分组：原图就是全分辨率，不需要（也不该）花 6–8 秒渲染。
    const hasJpg = Boolean(group?.jpg?.path);
    if (!hasJpg && !detail.url) {
      // 还没细节：先请求，等图真正加载完再切（onLoad 里接手）。
      pendingOneToOneRef.current = true;
      detail.request();
      return;
    }

    const s = zoom.oneToOne();
    if (s !== null) oneToOneScaleRef.current = s;
  }, [zoom, group, detail]);

  // 把 toggle 注册给全局快捷键（Z）。视口不在时（双栏 / 前后对照）清空，
  // 避免 `Z` 打到已经卸载的视口上。
  useEffect(() => {
    if (!oneToOneRef) return;
    oneToOneRef.current = toggleOneToOne;
    return () => {
      oneToOneRef.current = () => {};
    };
  }, [oneToOneRef, toggleOneToOne]);

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
      onDoubleClick={zoom.bind.onDoubleClick}
      className={`relative flex-1 bg-background-base overflow-hidden flex items-center justify-center select-none ${
        zoom.isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
    >
      {/* Zoomable Image */}
      {image.loading && !image.lumenActive && (
        <div
          role="status"
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-white/80 border border-default pointer-events-none"
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
            const s = zoom.oneToOne();
            if (s !== null) oneToOneScaleRef.current = s;
          }}
          onError={() => {
            // 细节图加载失败（缓存被删/写坏）与预览图加载失败是两条路径：
            // 前者可能根本没走过预览成功，不能靠 image.markBroken 的 latch。
            if (usingDetail) detail.markBroken();
            else image.markBroken();
          }}
          style={{
            transform: zoom.transform,
            transition: zoom.isDragging ? 'none' : 'transform 0.08s ease-out',
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

      {/* Floating Bottom Quick Action Bar
          Always fully opaque — this carries the app's core culling verbs and
          must never be a hover-only affordance (F-02). */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-xl px-4 py-2 rounded-lg flex items-center gap-3 border border-white/15 pointer-events-auto shadow-2xl"
      >
        {/* Rating Stars (1 to 5) */}
        <div
          className="flex items-center gap-1 border-r border-white/15 pr-3"
          role="group"
          aria-label="照片星级打分"
        >
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => onRate(group.rating === star ? 0 : star)}
              className="focus-ring tap-target p-1 hover:scale-125 active:scale-95 rounded-sm transition-transform"
              title={`评 ${star} 星（${star}）`}
              aria-label={`评 ${star} 星`}
              aria-pressed={group.rating >= star}
            >
              <Star
                className={`w-4 h-4 ${
                  group.rating >= star
                    ? 'fill-amber-400 text-amber-400'
                    : 'text-white/60 hover:text-white'
                }`}
                aria-hidden="true"
              />
            </button>
          ))}
        </div>

        {/* Pick / Reject / Unflag */}
        <div
          className="flex items-center gap-1.5 border-r border-white/15 pr-3"
          role="group"
          aria-label="保留或淘汰标记"
        >
          <button
            onClick={() => onFlag(group.flag === 'pick' ? 'none' : 'pick')}
            className={`focus-ring flex items-center gap-1 px-3 py-1 rounded-md text-xs font-semibold active:scale-[0.96] transition-colors ${
              group.flag === 'pick'
                ? 'bg-emerald-600/40 text-emerald-300 border border-emerald-500/50'
                : 'bg-white/10 text-white/80 hover:bg-white/20 border border-transparent'
            }`}
            title="保留 (P)"
            aria-label="标记保留 (Pick)"
            aria-pressed={group.flag === 'pick'}
          >
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Pick</span>
          </button>
          <button
            onClick={() => onFlag(group.flag === 'reject' ? 'none' : 'reject')}
            className={`focus-ring flex items-center gap-1 px-3 py-1 rounded-md text-xs font-semibold active:scale-[0.96] transition-colors ${
              group.flag === 'reject'
                ? 'bg-rose-600/40 text-rose-300 border border-rose-500/50'
                : 'bg-white/10 text-white/80 hover:bg-white/20 border border-transparent'
            }`}
            title="淘汰 (X)"
            aria-label="标记淘汰 (Reject)"
            aria-pressed={group.flag === 'reject'}
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Reject</span>
          </button>
        </div>

        {/* Zoom: – / readout / reset / +
            Zoom used to live only on wheel and double-click, both of which
            are undiscoverable and keyboard-inaccessible (F-25). */}
        <div
          className="flex items-center gap-0.5 border-r border-white/15 pr-3"
          role="group"
          aria-label="缩放控制"
        >
          <button
            onClick={() => zoom.zoomBy(1 / ZOOM_STEP)}
            disabled={zoom.scale <= ZOOM_MIN}
            className="focus-ring tap-target p-1.5 text-white/60 hover:text-white hover:bg-white/10 active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors"
            title="缩小"
            aria-label="缩小"
          >
            <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <span
            className="text-[11px] font-mono tabular-nums text-white/80 w-11 text-center select-none"
            aria-label={`当前缩放 ${zoomLabel}`}
          >
            {zoomLabel}
          </span>
          <button
            onClick={() => zoom.zoomBy(ZOOM_STEP)}
            disabled={zoom.scale >= ZOOM_MAX}
            className="focus-ring tap-target p-1.5 text-white/60 hover:text-white hover:bg-white/10 active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors"
            title="放大"
            aria-label="放大"
          >
            <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={zoom.reset}
            className="focus-ring tap-target p-1.5 text-white/60 hover:text-white hover:bg-white/10 active:scale-[0.96] rounded-md transition-colors"
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
            className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-white/10 hover:bg-white/20 active:scale-[0.96] text-white rounded-md text-xs font-medium transition-colors"
            title="调色面板 (E)"
            aria-label="调色面板"
            aria-pressed={isTonalPanelOpen}
            aria-expanded={isTonalPanelOpen}
            aria-controls="tonal-adjuster-panel"
          >
            <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
            <span>调色</span>
          </button>
        )}

        {/* Luminar AI Roundtrip */}
        {onOpenLuminar && (
          <button
            onClick={onOpenLuminar}
            disabled={isLuminarRunning}
            className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-white/10 hover:bg-white/20 text-white border border-default active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed rounded-md text-xs font-medium transition-colors"
            title="Luminar AI 修图"
            aria-label="在 Luminar AI 中修图"
          >
            <Sparkles
              className={`w-3.5 h-3.5 ${isLuminarRunning ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>{isLuminarRunning ? '运行中…' : 'Luminar AI'}</span>
          </button>
        )}

        {/* Open in Photoshop / External app */}
        <button
          onClick={onOpenExternal}
          className="focus-ring flex items-center gap-1.5 px-3.5 py-1.5 bg-white/10 hover:bg-white/20 text-white active:scale-[0.96] rounded-md font-medium transition-colors"
          title="外部打开 (O)"
          aria-label="在修图或外部程序中打开"
        >
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="pb-[1px] text-xs">外部打开</span>
        </button>
      </div>
    </div>
  );
};
