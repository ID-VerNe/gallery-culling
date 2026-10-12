import React, { useState, useEffect, useCallback } from 'react';
import {
  Columns2,
  Link,
  Star,
  Check,
  X,
  Sparkles,
  Sliders,
  RotateCcw,
  Camera,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { PhotoGroupInfo, ToneAdjustments } from '../types';
import { api } from '../services/api';
import { getToneFilterString } from '../utils/autoTone';
import type { ViewportEmptyState } from './PreviewViewport';

interface BeforeAfterViewportProps {
  group?: PhotoGroupInfo;
  tone?: ToneAdjustments;
  isHoldOriginal?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onRate: (rating: number) => void;
  onFlag: (flag: 'pick' | 'reject' | 'none') => void;
  onOpenLuminar?: () => void;
  onToggleTonalAdjuster?: () => void;
  isLuminarRunning?: boolean;
  isTonalPanelOpen?: boolean;
  /** Copy and action for the "nothing to show" state, decided by the shell. */
  emptyState?: ViewportEmptyState;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 10;
const ZOOM_STEP = 1.25;

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
  emptyState = {
    title: '未加载照片',
    description: '选择 JPG 或 RAW 文件夹，即可开始极速选片。',
  },
}) => {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Reset zoom and pan on photo change
  useEffect(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, [group?.id]);

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => Math.min(Math.max(s * factor, MIN_SCALE), MAX_SCALE));
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, []);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pos.x, y: e.clientY - pos.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPos({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleDoubleClick = () => {
    setScale((s) => (s === 1 ? 2.5 : 1));
    setPos({ x: 0, y: 0 });
  };

  // Original image source (Before)
  const beforeSrc = group?.jpg?.path
    ? api.toAssetUrl(group.jpg.path)
    : group?.raw?.path
    ? api.toAssetUrl(group.raw.path)
    : null;

  // After image source: If Luminar AI edited version exists, use it; otherwise use base image with tone filter
  const hasLuminarEdit = !!group?.edited?.path;
  const afterSrc = group?.edited?.path
    ? api.toAssetUrl(group.edited.path)
    : beforeSrc;

  const toneFilter =
    !hasLuminarEdit && !isHoldOriginal ? getToneFilterString(tone) : 'none';

  if (!group || !beforeSrc) {
    // Same shape as the single-view empty state so the two "nothing selected"
    // conditions read identically (F-18).
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background-base text-white/60 p-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-4">
          <Camera className="w-8 h-8 text-white stroke-[1.5]" aria-hidden="true" />
        </div>
        <h3 className="text-base font-medium text-white mb-1">
          {emptyState.title}
        </h3>
        <p className="text-xs text-white/60 max-w-sm mb-5 leading-relaxed">
          {emptyState.description}
        </p>
        {emptyState.onAction && (
          <button
            onClick={emptyState.onAction}
            className="focus-ring flex items-center gap-2 px-4 py-2 bg-white hover:bg-white/90 text-black active:scale-[0.96] rounded-lg text-xs font-semibold transition-transform"
            aria-label={emptyState.actionLabel}
          >
            <span>{emptyState.actionLabel ?? '继续'}</span>
          </button>
        )}
      </div>
    );
  }

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
              disabled={scale <= MIN_SCALE}
              className="focus-ring p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-l active:scale-[0.96] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="缩小"
              aria-label="缩小"
            >
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <span
              className="font-mono tabular-nums text-white/80 w-10 text-center"
              aria-label={`当前缩放 ${Math.round(scale * 100)}%`}
            >
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() => zoomBy(ZOOM_STEP)}
              disabled={scale >= MAX_SCALE}
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
          >
            <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
            <span>调色面板</span>
          </button>

          {/* Sync Zoom indicator */}
          <div
            className="flex items-center gap-1 px-2 py-0.5 bg-white/10 text-white border border-white/25 rounded text-[11px] font-medium"
            title="锁定同步缩放"
          >
            <Link className="w-3 h-3" aria-hidden="true" />
            <span>联动锁焦</span>
          </div>
        </div>
      </div>

      {/* Dual Split Panes */}
      <div
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        className={`flex-1 flex overflow-hidden ${
          isDragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
      >
        {/* Left: Before (Original) */}
        <div className="relative flex-1 bg-background-surface overflow-hidden flex items-center justify-center border-r border-border-subtle">
          <img
            src={beforeSrc}
            alt={`${group.baseName} 调色前原片`}
            draggable={false}
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
              transition: isDragging ? 'none' : 'transform 0.05s ease-out',
              imageOrientation: 'from-image',
            }}
            className="max-h-full max-w-full object-contain pointer-events-none origin-center"
          />

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
        <div className="relative flex-1 bg-background-surface overflow-hidden flex items-center justify-center">
          <img
            src={afterSrc ?? beforeSrc}
            alt={`${group.baseName} 调色后效果`}
            draggable={false}
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
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
