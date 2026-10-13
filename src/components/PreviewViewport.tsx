import React, { useCallback, useRef, useState, useEffect } from 'react';
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
import { api } from '../services/api';
import { getToneFilterString } from '../utils/autoTone';
import { zoomAtPoint } from '../utils/zoom';
import { useLumenPreview } from '../hooks/useLumenPreview';
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
}

/** Everything the viewports need to render a meaningful empty state. */
export interface ViewportEmptyState {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 10;
const ZOOM_STEP = 1.25;

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
  emptyState = {
    title: '未加载照片',
    description: '请选择存放 JPG 的文件夹用于浏览与选片；RAW 文件夹可选。',
  },
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Reset zoom & pan when image changes
  useEffect(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [group?.id]);

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => Math.min(Math.max(s * factor, MIN_SCALE), MAX_SCALE));
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  // 同时把 <img> 交给宿主（直方图采样）并保留本地引用（拖拽夹紧要量测其渲染尺寸）。
  const setImageRef = useCallback(
    (el: HTMLImageElement | null) => {
      imgRef.current = el;
      onImageElement?.(el);
    },
    [onImageElement],
  );

  // C8：把平移夹紧到「照片不露出视口」的范围。缩放后图像超出容器的半边宽度
  // 即为最大可平移量；不超出（适应窗口）则锁死居中。
  const clampPosition = useCallback((next: { x: number; y: number }, s: number) => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (!container || !img) return next;
    const maxX = Math.max(0, (img.offsetWidth * s - container.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * s - container.clientHeight) / 2);
    return {
      x: Math.min(Math.max(next.x, -maxX), maxX),
      y: Math.min(Math.max(next.y, -maxY), maxY),
    };
  }, []);

  // Handle Wheel Zoom —— 命中光标（M-08）：改 scale 的同时按光标反算 pos，
  // 光标下的图像点保持在指针下。与快捷键说明「滚轮 · 以指针为中心缩放」一致。
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const next = zoomAtPoint(e, rect, scale, position, {
        min: MIN_SCALE,
        max: MAX_SCALE,
        step: ZOOM_STEP,
      });
      setScale(next.scale);
      setPosition(next.pos);
    },
    [scale, position],
  );

  // Handle Pan Dragging（C8：Pointer 事件 + 指针捕获，快速拖到容器外也不丢拽）
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 覆盖层按钮 / EXIF 胶囊等交互元素不进入拖拽，避免抢走点击。
    if (e.target !== e.currentTarget) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setPosition(
      clampPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y }, scale),
    );
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    const host = e.currentTarget as HTMLElement;
    if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
  };

  // Double click to toggle fit / 250%
  const handleDoubleClick = () => {
    setScale((s) => (s === 1 ? 2.5 : 1));
    setPosition({ x: 0, y: 0 });
  };

  // RAW real-decode preview via LUMEN RAW sidecar (P0). Null → legacy path.
  const lumenPreview = useLumenPreview(group, lumenStatus ?? LUMEN_UNAVAILABLE, lumenPreviewWidth);
  const [lumenBroken, setLumenBroken] = useState(false);

  // Reset the fallback latch whenever the photo changes.
  useEffect(() => {
    setLumenBroken(false);
  }, [group?.id]);

  if (!group) {
    return <ViewportEmptyStateView emptyState={emptyState} />;
  }

  const hasJpg = Boolean(group.jpg?.path);
  const hasRaw = Boolean(group.raw?.path);
  const lumenActive = Boolean(lumenPreview.url && !lumenBroken);
  // RAW-only（无 JPG）分组：引擎不可用时不再回落到 .NEF 资产 URL（C2，会永久破图）。
  const rawOnly = !hasJpg && hasRaw;
  const legacySrc = hasJpg
    ? api.toAssetUrl(group.jpg!.path)
    : hasRaw
    ? api.toAssetUrl(group.raw!.path)
    : null;
  const imageSrc = rawOnly ? (lumenActive ? lumenPreview.url : null) : legacySrc;
  // A LUMEN render is already tone-mapped: never stack the CSS tone filter on it
  // (that would develop the image twice).
  const toneFilter = lumenActive ? 'none' : getToneFilterString(isHoldOriginal ? undefined : tone);

  // C1/C2：RAW-only 解码中 → 走主视图显示「正在渲染 RAW…」横幅；失败/未启用 → 明确占位而非破图。
  if (!imageSrc && !(rawOnly && lumenPreview.loading)) {
    const engineAvailable = lumenStatus?.available === true;
    return (
      <ViewportEmptyStateView
        emptyState={
          rawOnly
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

  const zoomPercent = `${Math.round(scale * 100)}%`;
  // C6：scale=1 实为「适应窗口」，并非 1:1 像素，别显示误导性的 100%。
  const zoomLabel = Math.abs(scale - 1) < 0.001 ? '适应' : zoomPercent;

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      className={`relative flex-1 bg-background-base overflow-hidden flex items-center justify-center select-none ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
    >
      {/* Zoomable Image */}
      {lumenPreview.loading && !lumenPreview.url && (
        <div
          role="status"
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-white/80 border border-default pointer-events-none"
        >
          正在渲染 RAW…
        </div>
      )}

      {imageSrc && (
        <img
          ref={setImageRef}
          src={imageSrc}
          alt={group.baseName}
          draggable={false}
          onError={() => {
            // A stale/invalid cached preview must never blank the viewport.
            if (lumenPreview.url && !lumenBroken) setLumenBroken(true);
          }}
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transition: isDragging ? 'none' : 'transform 0.08s ease-out',
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
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            disabled={scale <= MIN_SCALE}
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
            onClick={() => zoomBy(ZOOM_STEP)}
            disabled={scale >= MAX_SCALE}
            className="focus-ring tap-target p-1.5 text-white/60 hover:text-white hover:bg-white/10 active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors"
            title="放大"
            aria-label="放大"
          >
            <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={resetView}
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
