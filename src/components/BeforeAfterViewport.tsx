import React, { useState, useEffect, useCallback } from 'react';
import {
  Columns2,
  Link,
  Unlink,
  Star,
  Check,
  X,
  Sparkles,
  Sliders,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { PhotoGroupInfo, ToneAdjustments, LumenStatus } from '../types';
import { api } from '../services/api';
import { getToneFilterString } from '../utils/autoTone';
import { zoomAtPoint } from '../utils/zoom';
import { useLumenPreview } from '../hooks/useLumenPreview';
import { LUMEN_UNAVAILABLE } from '../hooks/useLumenStatus';
import type { ViewportEmptyState } from './PreviewViewport';
import { ViewportEmptyStateView } from './ViewportEmptyState';

interface BeforeAfterViewportProps {
  group?: PhotoGroupInfo;
  tone?: ToneAdjustments;
  isHoldOriginal?: boolean;
  onRate: (rating: number) => void;
  onFlag: (flag: 'pick' | 'reject' | 'none') => void;
  onOpenLuminar?: () => void;
  onToggleTonalAdjuster?: () => void;
  isLuminarRunning?: boolean;
  isTonalPanelOpen?: boolean;
  /** LUMEN RAW 引擎握手状态；可用时 RAW-only 分组走真实解码（M-02）。 */
  lumenStatus?: LumenStatus;
  /** Copy and action for the "nothing to show" state, decided by the shell. */
  emptyState?: ViewportEmptyState;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 10;
const ZOOM_STEP = 1.25;
const LUMEN_PANE_WIDTH = 1600;

type PaneSide = 'before' | 'after';

export const BeforeAfterViewport: React.FC<BeforeAfterViewportProps> = ({
  group,
  tone,
  isHoldOriginal = false,
  onRate,
  onFlag,
  onOpenLuminar,
  onToggleTonalAdjuster,
  isLuminarRunning = false,
  isTonalPanelOpen = false,
  lumenStatus,
  emptyState = {
    title: '未加载照片',
    description: '选择 JPG 或 RAW 文件夹，即可开始极速选片。',
  },
}) => {
  // 联动锁焦为真开关（L-01）：锁定时两图共用比例/位移，解锁后各自独立。
  const [syncLock, setSyncLock] = useState(true);
  const [beforeScale, setBeforeScale] = useState(1);
  const [beforePos, setBeforePos] = useState({ x: 0, y: 0 });
  const [afterScale, setAfterScale] = useState(1);
  const [afterPos, setAfterPos] = useState({ x: 0, y: 0 });

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  // 独立模式下接受手势、以及 ± 作用的窗格。
  const [activePane, setActivePane] = useState<PaneSide>('after');

  // RAW 真实解码（有 JPG 时零请求）；与单图/对比视图同口径。
  const lumenPreview = useLumenPreview(group, lumenStatus ?? LUMEN_UNAVAILABLE, LUMEN_PANE_WIDTH);
  const [lumenBroken, setLumenBroken] = useState(false);

  // Reset zoom and pan on photo change
  useEffect(() => {
    setBeforeScale(1);
    setAfterScale(1);
    setBeforePos({ x: 0, y: 0 });
    setAfterPos({ x: 0, y: 0 });
    setLumenBroken(false);
  }, [group?.id]);

  const clampScale = (s: number) => Math.min(Math.max(s, MIN_SCALE), MAX_SCALE);

  const zoomBy = useCallback(
    (factor: number) => {
      if (syncLock) {
        const next = clampScale(beforeScale * factor);
        setBeforeScale(next);
        setAfterScale(next);
      } else if (activePane === 'before') {
        setBeforeScale((s) => clampScale(s * factor));
      } else {
        setAfterScale((s) => clampScale(s * factor));
      }
    },
    [syncLock, beforeScale, activePane],
  );

  const resetView = useCallback(() => {
    setBeforeScale(1);
    setAfterScale(1);
    setBeforePos({ x: 0, y: 0 });
    setAfterPos({ x: 0, y: 0 });
  }, []);

  // 命中光标缩放（M-08）：两栏各自持有 rect，光标所在栏即锚点。
  // 联动锁定时两栏写同一组 scale/pos（保持批次 B 的联动语义）。
  const handleWheel = (side: PaneSide, e: React.WheelEvent) => {
    e.preventDefault();
    setActivePane(side);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const opts = { min: MIN_SCALE, max: MAX_SCALE, step: ZOOM_STEP };

    if (syncLock) {
      const next = zoomAtPoint(e, rect, beforeScale, beforePos, opts);
      setBeforeScale(next.scale);
      setAfterScale(next.scale);
      setBeforePos(next.pos);
      setAfterPos(next.pos);
    } else if (side === 'before') {
      const next = zoomAtPoint(e, rect, beforeScale, beforePos, opts);
      setBeforeScale(next.scale);
      setBeforePos(next.pos);
    } else {
      const next = zoomAtPoint(e, rect, afterScale, afterPos, opts);
      setAfterScale(next.scale);
      setAfterPos(next.pos);
    }
  };

  const handleMouseDown = (side: PaneSide, e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setActivePane(side);
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setDragStart({ x: e.clientX, y: e.clientY });

    if (syncLock) {
      setBeforePos((p) => ({ x: p.x + dx, y: p.y + dy }));
      setAfterPos((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else if (activePane === 'before') {
      setBeforePos((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else {
      setAfterPos((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleDoubleClick = (side: PaneSide) => {
    setActivePane(side);
    const currentScale = side === 'before' ? beforeScale : afterScale;
    const targetScale = currentScale === 1 ? 2.5 : 1;
    if (syncLock) {
      setBeforeScale(targetScale);
      setAfterScale(targetScale);
      setBeforePos({ x: 0, y: 0 });
      setAfterPos({ x: 0, y: 0 });
    } else if (side === 'before') {
      setBeforeScale(targetScale);
      setBeforePos({ x: 0, y: 0 });
    } else {
      setAfterScale(targetScale);
      setAfterPos({ x: 0, y: 0 });
    }
  };

  // Original image source (Before): LUMEN RAW preview when available, else jpg/raw.
  const legacySrc = group?.jpg?.path
    ? api.toAssetUrl(group.jpg.path)
    : group?.raw?.path
    ? api.toAssetUrl(group.raw.path)
    : null;
  const lumenActive = Boolean(lumenPreview.url && !lumenBroken);
  const beforeSrc = lumenActive ? lumenPreview.url : legacySrc;

  // After image source: If Luminar AI edited version exists, use it; otherwise use base image with tone filter
  const hasLuminarEdit = !!group?.edited?.path;
  const afterSrc = group?.edited?.path
    ? api.toAssetUrl(group.edited.path)
    : beforeSrc;

  // LUMEN 命中时不再叠加 CSS 滤镜（否则 develop 两次）；edited 成品与按住原片同样不套。
  const toneFilter =
    !hasLuminarEdit && !isHoldOriginal && !lumenActive
      ? getToneFilterString(tone)
      : 'none';

  if (!group || !beforeSrc) {
    // Same shared empty state as the single view (M-03).
    return <ViewportEmptyStateView emptyState={emptyState} />;
  }

  const effectiveScale = syncLock
    ? beforeScale
    : activePane === 'before'
    ? beforeScale
    : afterScale;

  const beforeFocused = !syncLock && activePane === 'before';
  const afterFocused = !syncLock && activePane === 'after';

  return (
    <div className="flex-1 flex flex-col h-full w-full bg-background-surface relative select-none">
      {/* Top Header Control Bar */}
      <div className="h-9 bg-background-base border-b border-white/10 flex items-center justify-between gap-2 px-3 text-xs text-white/80">
        <div className="flex items-center gap-2 font-medium min-w-0">
          <Columns2 className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap">本张照片前后对照 (Before / After)</span>
          <span className="text-[11px] text-white/60 truncate hidden lg:inline">
            {hasLuminarEdit
              ? '右侧呈现 Luminar AI 精修成品'
              : '右侧呈现 WebGL 实时调色预检效果'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Zoom controls */}
          <div className="flex items-center gap-0.5 bg-white/10 rounded text-[11px]">
            <button
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              disabled={effectiveScale <= MIN_SCALE}
              className="focus-ring p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-l active:scale-[0.96] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="缩小"
              aria-label="缩小"
            >
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            {syncLock ? (
              <span
                className="font-mono tabular-nums text-white/80 w-10 text-center"
                aria-label={`当前缩放 ${Math.round(beforeScale * 100)}%`}
              >
                {Math.round(beforeScale * 100)}%
              </span>
            ) : (
              <span
                className="font-mono tabular-nums text-white/80 px-1 text-center flex items-center gap-1"
                aria-label={`当前缩放：前 ${Math.round(beforeScale * 100)}%，后 ${Math.round(
                  afterScale * 100,
                )}%（聚焦${activePane === 'before' ? '前' : '后'}图）`}
              >
                <span className={activePane === 'before' ? 'text-white' : 'text-white/45'}>
                  前 {Math.round(beforeScale * 100)}%
                </span>
                <span className="text-white/25">/</span>
                <span className={activePane === 'after' ? 'text-white' : 'text-white/45'}>
                  后 {Math.round(afterScale * 100)}%
                </span>
              </span>
            )}
            <button
              onClick={() => zoomBy(ZOOM_STEP)}
              disabled={effectiveScale >= MAX_SCALE}
              className="focus-ring p-1 text-white/70 hover:text-white hover:bg-white/15 active:scale-[0.96] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="放大"
              aria-label="放大"
            >
              <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              onClick={resetView}
              className="focus-ring p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-r active:scale-[0.96] transition-colors"
              title="复位缩放"
              aria-label="复位缩放与平移"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Quick open Luminar AI */}
          <button
            onClick={onOpenLuminar}
            disabled={isLuminarRunning}
            className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white border border-white/10 rounded text-[11px] font-semibold transition-colors active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed"
            title="Luminar AI 修图"
            aria-label="在 Luminar AI 中修图当前照片"
          >
            <Sparkles
              className={`w-3.5 h-3.5 ${isLuminarRunning ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>{isLuminarRunning ? '运行中…' : 'Luminar AI 修图'}</span>
          </button>

          {/* Toggle Tonal Adjuster */}
          <button
            onClick={onToggleTonalAdjuster}
            className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white/80 hover:text-white rounded text-[11px] font-medium transition-colors active:scale-[0.96]"
            title="调色面板 (快捷键 E)"
            aria-label="打开调色面板"
            aria-pressed={isTonalPanelOpen}
            aria-expanded={isTonalPanelOpen}
            aria-controls="tonal-adjuster-panel"
          >
            <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
            <span>调色面板</span>
          </button>

          {/* Sync-zoom lock toggle (L-01): a real, keyboard-operable switch. */}
          <button
            onClick={() => setSyncLock((v) => !v)}
            className={`focus-ring flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium active:scale-[0.96] transition-colors border ${
              syncLock
                ? 'bg-white/10 text-white border-white/25'
                : 'bg-white/5 text-white/60 border-white/10 hover:text-white hover:bg-white/10'
            }`}
            title={
              syncLock
                ? '两图同步缩放与平移（点击解锁独立对照）'
                : '两图独立缩放与平移（点击恢复联动）'
            }
            aria-label="切换前后两图联动缩放"
            aria-pressed={syncLock}
          >
            {syncLock ? (
              <Link className="w-3 h-3" aria-hidden="true" />
            ) : (
              <Unlink className="w-3 h-3" aria-hidden="true" />
            )}
            <span className="pb-[1px]">{syncLock ? '联动锁焦' : '独立对照'}</span>
          </button>
        </div>
      </div>

      {/* Dual Split Panes */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Before (Original) */}
        <div
          onWheel={(e) => handleWheel('before', e)}
          onMouseDown={(e) => handleMouseDown('before', e)}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={() => handleDoubleClick('before')}
          className={`relative flex-1 bg-background-surface overflow-hidden flex items-center justify-center border-r border-border-subtle ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          {beforeFocused && (
            <div
              className="absolute inset-0 border-2 border-sky-400/60 pointer-events-none z-10"
              aria-hidden="true"
            />
          )}

          <img
            src={beforeSrc}
            alt={`${group.baseName} 调色前原片`}
            draggable={false}
            onError={() => {
              if (lumenPreview.url && !lumenBroken) setLumenBroken(true);
            }}
            style={{
              transform: `translate(${beforePos.x}px, ${beforePos.y}px) scale(${beforeScale})`,
              transition: isDragging ? 'none' : 'transform 0.05s ease-out',
              imageOrientation: 'from-image',
            }}
            className="max-h-full max-w-full object-contain pointer-events-none origin-center"
          />

          {lumenPreview.loading && (
            <div
              role="status"
              className="absolute top-3 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3 py-1 rounded-md text-[11px] font-semibold text-white/80 border border-white/10 pointer-events-none"
            >
              正在渲染 RAW…
            </div>
          )}

          {/* Before Badge */}
          <div className="absolute top-3 left-3 bg-background-base/85 backdrop-blur-xl px-3 py-1.5 rounded-lg text-xs text-white/80 flex items-center gap-2 border border-white/15 select-text">
            <span className="font-semibold text-white">原片 (Before)</span>
            <span className="text-white/40">|</span>
            <span className="font-mono text-[11px] text-white/70">
              {group.baseName}
            </span>
          </div>
        </div>

        {/* Right: After (Adjusted or Luminar Edit) */}
        <div
          onWheel={(e) => handleWheel('after', e)}
          onMouseDown={(e) => handleMouseDown('after', e)}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={() => handleDoubleClick('after')}
          className={`relative flex-1 bg-background-surface overflow-hidden flex items-center justify-center ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          {afterFocused && (
            <div
              className="absolute inset-0 border-2 border-sky-400/60 pointer-events-none z-10"
              aria-hidden="true"
            />
          )}

          <img
            src={afterSrc ?? beforeSrc}
            alt={`${group.baseName} 调色后效果`}
            draggable={false}
            style={{
              transform: `translate(${afterPos.x}px, ${afterPos.y}px) scale(${afterScale})`,
              transition: isDragging ? 'none' : 'transform 0.05s ease-out',
              filter: toneFilter,
              imageOrientation: 'from-image',
            }}
            className="max-h-full max-w-full object-contain pointer-events-none origin-center"
          />

          {/* After Badge */}
          <div className="absolute top-3 right-3 bg-background-base/85 backdrop-blur-xl px-3 py-1.5 rounded-lg text-xs text-white/80 flex items-center gap-2 border border-white/15 select-text">
            {hasLuminarEdit ? (
              <span className="font-semibold flex items-center gap-1 text-white">
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                精修 (After)
              </span>
            ) : (
              <span className="font-semibold flex items-center gap-1 text-white">
                <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
                调色预检 (After)
                {tone && tone.exposure !== 0 && (
                  <span className="font-mono text-[11px] text-white/70 ml-1">
                    (
                    {tone.exposure > 0
                      ? `+${tone.exposure.toFixed(2)}`
                      : tone.exposure.toFixed(2)}
                    EV)
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Floating Rating & Flag Capsule — always fully opaque (F-02) */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-xl px-4 py-2 rounded-lg flex items-center gap-3 border border-white/15 pointer-events-auto shadow-2xl"
      >
        {/* Rating Stars */}
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

        {/* Pick / Reject */}
        <div
          className="flex items-center gap-1.5"
          role="group"
          aria-label="保留或淘汰标记"
        >
          <button
            onClick={() => onFlag(group.flag === 'pick' ? 'none' : 'pick')}
            className={`focus-ring flex items-center gap-1 px-3 py-1 rounded-md text-xs font-semibold active:scale-[0.96] transition-colors border ${
              group.flag === 'pick'
                ? 'bg-emerald-600/40 text-emerald-300 border-emerald-500/50'
                : 'bg-transparent text-white/80 hover:bg-white/20 border-transparent'
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
            className={`focus-ring flex items-center gap-1 px-3 py-1 rounded-md text-xs font-semibold active:scale-[0.96] transition-colors border ${
              group.flag === 'reject'
                ? 'bg-rose-600/40 text-rose-300 border-rose-500/50'
                : 'bg-transparent text-white/80 hover:bg-white/20 border-transparent'
            }`}
            title="淘汰 (X)"
            aria-label="标记淘汰 (Reject)"
            aria-pressed={group.flag === 'reject'}
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Reject</span>
          </button>
        </div>
      </div>
    </div>
  );
};
