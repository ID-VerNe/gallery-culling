import React from 'react';
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
import { ZOOM_STEP, ZOOM_MIN, ZOOM_MAX, scaleLabel } from '../utils/viewportZoom';
import { useViewportImage } from '../hooks/useViewportImage';
import { useDualZoomPan } from '../hooks/useDualZoomPan';
import { LUMEN_UNAVAILABLE } from '../hooks/useLumenStatus';
import type { ViewportEmptyState } from './PreviewViewport';
import { ViewportEmptyStateView } from './ViewportEmptyState';
import { ExifCapsule } from './ExifCapsule';

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

const LUMEN_PANE_WIDTH = 1600;

/** 双栏 hook 的栏序：第一栏是联动基准。模块级常量（hook 要求稳定引用）。 */
const PANES = ['before', 'after'] as const;

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
    description: '请选择存放 JPG 的文件夹用于浏览与选片；RAW 文件夹可选。',
  },
}) => {
  // 缩放/平移机器（联动锁焦 L-01、绝对系拖拽、命中光标缩放、夹紧、换图复位）。
  // 调色结果在右侧，独立模式的默认作用栏是 after。
  const zoom = useDualZoomPan(PANES, group?.id, PANES[1]);

  // 图片源解析（LUMEN 预览 + 失败 latch + C2 口径，三视口共用）。
  const beforeImage = useViewportImage(group, lumenStatus ?? LUMEN_UNAVAILABLE, LUMEN_PANE_WIDTH);

  // After image source: If Luminar AI edited version exists, use it; otherwise use base image with tone filter
  const hasLuminarEdit = !!group?.edited?.path;
  const afterSrc = group?.edited?.path
    ? api.toAssetUrl(group.edited.path)
    : beforeImage.src;

  // LUMEN 命中时不再叠加 CSS 滤镜（否则 develop 两次）；edited 成品与按住原片同样不套。
  const toneFilter =
    !hasLuminarEdit && !isHoldOriginal && !beforeImage.lumenActive
      ? getToneFilterString(tone)
      : 'none';
  // C5：未做任何调色时左右逐像素相同，需给出提示而非误标 Before/After。
  const hasTone = toneFilter !== 'none';

  if (!group) {
    // Same shared empty state as the single view (M-03).
    return <ViewportEmptyStateView emptyState={emptyState} />;
  }

  // RAW-only：解码中 → 渲染主视图并显示横幅；失败/未启用 → 明确占位而非破图（C2）。
  if (!beforeImage.src && !(beforeImage.rawOnly && beforeImage.loading)) {
    return (
      <ViewportEmptyStateView
        emptyState={
          beforeImage.rawOnly
            ? {
                title: '该 RAW 需启用 LUMEN RAW 引擎',
                description:
                  '当前为 RAW-only 照片，启用 LUMEN RAW 引擎后即可在此对照预览；JPG 照片不受影响。',
              }
            : emptyState
        }
      />
    );
  }

  const effectiveScale = zoom.effectiveScale;

  const beforeFocused = !zoom.sync && zoom.activePane === 'before';
  const afterFocused = !zoom.sync && zoom.activePane === 'after';

  const beforeBind = zoom.bindPane('before');
  const afterBind = zoom.bindPane('after');

  return (
    <div className="flex-1 flex flex-col h-full w-full bg-background-surface relative select-none">
      {/* Top Header Control Bar */}
      <div className="h-9 bg-background-base border-b border-default flex items-center justify-between gap-2 px-3 text-xs text-white/80">
        <div className="flex items-center gap-2 font-medium min-w-0">
          <Columns2 className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap">本张照片前后对照 (Before / After)</span>
          <span className="text-[11px] text-white/60 truncate hidden lg:inline">
            {hasLuminarEdit
              ? '右侧呈现 Luminar AI 精修成品'
              : hasTone
              ? '右侧呈现调色预检效果'
              : '尚未调色，拖动滑杆查看效果'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Zoom controls */}
          <div className="flex items-center gap-0.5 bg-white/10 rounded text-[11px]">
            <button
              onClick={() => zoom.zoomBy(1 / ZOOM_STEP)}
              disabled={effectiveScale <= ZOOM_MIN}
              className="focus-ring tap-target p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-l active:scale-[0.96] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="缩小"
              aria-label="缩小"
            >
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            {zoom.sync ? (
              <span
                className="font-mono tabular-nums text-white/80 w-10 text-center"
                aria-label={`当前缩放 ${scaleLabel(zoom.scaleOf('before'))}`}
              >
                {scaleLabel(zoom.scaleOf('before'))}
              </span>
            ) : (
              <span
                className="font-mono tabular-nums text-white/80 px-1 text-center flex items-center gap-1"
                aria-label={`当前缩放：前 ${scaleLabel(zoom.scaleOf('before'))}，后 ${scaleLabel(
                  zoom.scaleOf('after'),
                )}（聚焦${zoom.activePane === 'before' ? '前' : '后'}图）`}
              >
                <span className={zoom.activePane === 'before' ? 'text-white' : 'text-white/45'}>
                  前 {scaleLabel(zoom.scaleOf('before'))}
                </span>
                <span className="text-white/25">/</span>
                <span className={zoom.activePane === 'after' ? 'text-white' : 'text-white/45'}>
                  后 {scaleLabel(zoom.scaleOf('after'))}
                </span>
              </span>
            )}
            <button
              onClick={() => zoom.zoomBy(ZOOM_STEP)}
              disabled={effectiveScale >= ZOOM_MAX}
              className="focus-ring tap-target p-1 text-white/70 hover:text-white hover:bg-white/15 active:scale-[0.96] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="放大"
              aria-label="放大"
            >
              <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              onClick={zoom.reset}
              className="focus-ring tap-target p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-r active:scale-[0.96] transition-colors"
              title={`重置缩放与平移（当前 ${scaleLabel(effectiveScale)}）`}
              aria-label={`重置缩放与平移（当前 ${scaleLabel(effectiveScale)}）`}
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Quick open Luminar AI */}
          <button
            onClick={onOpenLuminar}
            disabled={isLuminarRunning}
            className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white border border-default rounded text-[11px] font-semibold transition-colors active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed"
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
            aria-label="调色面板"
            aria-pressed={isTonalPanelOpen}
            aria-expanded={isTonalPanelOpen}
            aria-controls="tonal-adjuster-panel"
          >
            <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
            <span>调色面板</span>
          </button>

          {/* Sync-zoom lock toggle (L-01): a real, keyboard-operable switch. */}
          <button
            onClick={zoom.toggleSync}
            className={`focus-ring flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium active:scale-[0.96] transition-colors border ${
              zoom.sync
                ? 'bg-white/10 text-white border-white/25'
                : 'bg-background-surface-hover text-white/60 border-default hover:text-white hover:bg-white/10'
            }`}
            title={
              zoom.sync
                ? '两图同步缩放与平移（点击解锁独立对照）'
                : '两图独立缩放与平移（点击恢复联动）'
            }
            aria-label="切换前后两图联动缩放"
            aria-pressed={zoom.sync}
          >
            {zoom.sync ? (
              <Link className="w-3 h-3" aria-hidden="true" />
            ) : (
              <Unlink className="w-3 h-3" aria-hidden="true" />
            )}
            <span className="pb-[1px]">{zoom.sync ? '联动锁焦' : '独立对照'}</span>
          </button>
        </div>
      </div>

      {/* Dual Split Panes */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Before (Original) */}
        <div
          ref={beforeBind.ref}
          onWheel={beforeBind.onWheel}
          onMouseDown={() => zoom.focusPane('before')}
          onPointerDown={beforeBind.onPointerDown}
          onPointerMove={beforeBind.onPointerMove}
          onPointerUp={beforeBind.onPointerUp}
          onPointerCancel={beforeBind.onPointerUp}
          onDoubleClick={beforeBind.onDoubleClick}
          className={`relative flex-1 bg-background-surface overflow-hidden flex items-center justify-center border-r border-border-subtle ${
            zoom.isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          {beforeFocused && (
            <div
              className="absolute inset-0 border-2 border-sky-400/60 pointer-events-none z-10"
              aria-hidden="true"
            />
          )}

          {beforeImage.src && (
            <img
              ref={zoom.imgRef('before')}
              src={beforeImage.src}
              alt={`${group.baseName} 调色前原片`}
              draggable={false}
              onError={beforeImage.markBroken}
              style={{
                transform: zoom.transformOf('before'),
                transition: zoom.isDragging ? 'none' : 'transform 0.05s ease-out',
                imageOrientation: 'from-image',
              }}
              className="max-h-full max-w-full object-contain pointer-events-none origin-center"
            />
          )}

          {beforeImage.loading && (
            <div
              role="status"
              className="absolute top-3 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3 py-1 rounded-md text-[11px] font-semibold text-white/80 border border-default pointer-events-none"
            >
              正在渲染 RAW…
            </div>
          )}

          {/* V-07：与 Preview 视口对齐的 EXIF 胶囊（原先只有 Preview 有）。 */}
          <ExifCapsule exif={group.exif} />

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
          ref={afterBind.ref}
          onWheel={afterBind.onWheel}
          onMouseDown={() => zoom.focusPane('after')}
          onPointerDown={afterBind.onPointerDown}
          onPointerMove={afterBind.onPointerMove}
          onPointerUp={afterBind.onPointerUp}
          onPointerCancel={afterBind.onPointerUp}
          onDoubleClick={afterBind.onDoubleClick}
          className={`relative flex-1 bg-background-surface overflow-hidden flex items-center justify-center ${
            zoom.isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          {afterFocused && (
            <div
              className="absolute inset-0 border-2 border-sky-400/60 pointer-events-none z-10"
              aria-hidden="true"
            />
          )}

          {afterSrc && (
            <img
              ref={zoom.imgRef('after')}
              src={afterSrc}
              alt={`${group.baseName} 调色后效果`}
              draggable={false}
              style={{
                transform: zoom.transformOf('after'),
                transition: zoom.isDragging ? 'none' : 'transform 0.05s ease-out',
                filter: toneFilter,
                imageOrientation: 'from-image',
              }}
              className="max-h-full max-w-full object-contain pointer-events-none origin-center"
            />
          )}

          {/* 未调色提示（C5）：右侧与左侧逐像素相同时，别让人以为功能坏了。 */}
          {!hasLuminarEdit && !hasTone && (
            <div
              role="status"
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 bg-background-base/85 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-medium text-white/80 border border-default pointer-events-none"
            >
              尚未调色，拖动滑杆查看效果
            </div>
          )}

          {/* After Badge */}
          <div className="absolute top-3 right-3 bg-background-base/85 backdrop-blur-xl px-3 py-1.5 rounded-lg text-xs text-white/80 flex items-center gap-2 border border-white/15 select-text">
            {hasLuminarEdit ? (
              <span className="font-semibold flex items-center gap-1 text-white">
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                精修 (After)
              </span>
            ) : hasTone ? (
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
            ) : (
              <span className="font-semibold flex items-center gap-1 text-white">
                <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
                未调色 (After)
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
