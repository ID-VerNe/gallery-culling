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
    description: '选择 JPG 或 RAW 文件夹，即可开始极速选片。',
  },
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
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

  // Handle Pan Dragging
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
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

  const legacySrc = group?.jpg?.path
    ? api.toAssetUrl(group.jpg.path)
    : group?.raw?.path
    ? api.toAssetUrl(group.raw.path)
    : null;
  const imageSrc = lumenPreview.url && !lumenBroken ? lumenPreview.url : legacySrc;
  // A LUMEN render is already tone-mapped: never stack the CSS tone filter on it
  // (that would develop the image twice).
  const toneFilter =
    lumenPreview.url && !lumenBroken
      ? 'none'
      : getToneFilterString(isHoldOriginal ? undefined : tone);

  if (!group || !imageSrc) {
    return <ViewportEmptyStateView emptyState={emptyState} />;
  }

  const zoomPercent = `${Math.round(scale * 100)}%`;

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      className={`relative flex-1 bg-background-base overflow-hidden flex items-center justify-center select-none ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
    >
      {/* Zoomable Image */}
      {lumenPreview.loading && !imageSrc && (
        <div
          role="status"
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-white/80 border border-white/10 pointer-events-none"
        >
          正在渲染 RAW…
        </div>
      )}

      <img
        ref={onImageElement}
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
          filter: toneFilter,
        }}
        className="max-h-full max-w-full object-contain pointer-events-none origin-center"
      />

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

      {/* Floating EXIF capsule at Top-Right (Text selectable) */}
      {group.exif && (
        <div className="absolute top-3 right-3 bg-background-base/75 backdrop-blur-md px-3.5 py-2.5 rounded-lg text-xs text-white/80 flex flex-col gap-1 border border-white/10 pointer-events-auto select-text max-w-[16rem]">
          <div className="font-semibold text-white truncate">
            {group.exif.cameraModel || group.exif.cameraMake || '未知相机'}
          </div>
          {group.exif.lensModel && (
            <div className="text-[11px] text-white/70 truncate">
              {group.exif.lensModel}
            </div>
          )}
          <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums text-white/80 mt-0.5 flex-wrap">
            {group.exif.focalLength && <span>{group.exif.focalLength}</span>}
            {group.exif.aperture && <span>{group.exif.aperture}</span>}
            {group.exif.shutterSpeed && <span>{group.exif.shutterSpeed}</span>}
            {group.exif.iso && <span>ISO{group.exif.iso}</span>}
          </div>
          {group.exif.dateTime && (
            <div className="text-[10px] text-white/70 font-mono tabular-nums mt-0.5">
              {group.exif.dateTime}
            </div>
          )}
        </div>
      )}

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
              className="focus-ring p-1 hover:scale-125 active:scale-95 rounded-sm transition-transform"
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
            className="focus-ring p-1.5 text-white/60 hover:text-white hover:bg-white/10 active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors"
            title="缩小"
            aria-label="缩小"
          >
            <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <span
            className="text-[11px] font-mono tabular-nums text-white/80 w-11 text-center select-none"
            aria-label={`当前缩放 ${zoomPercent}`}
          >
            {zoomPercent}
          </span>
          <button
            onClick={() => zoomBy(ZOOM_STEP)}
            disabled={scale >= MAX_SCALE}
            className="focus-ring p-1.5 text-white/60 hover:text-white hover:bg-white/10 active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors"
            title="放大"
            aria-label="放大"
          >
            <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={resetView}
            className="focus-ring p-1.5 text-white/60 hover:text-white hover:bg-white/10 active:scale-[0.96] rounded-md transition-colors"
            title={`重置缩放与平移（当前 ${zoomPercent}）`}
            aria-label={`重置图片缩放与平移，当前 ${zoomPercent}`}
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
            aria-label="打开调色面板"
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
            className="focus-ring flex items-center gap-1.5 px-3 py-1 bg-white/10 hover:bg-white/20 text-white border border-white/10 active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed rounded-md text-xs font-medium transition-colors"
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
