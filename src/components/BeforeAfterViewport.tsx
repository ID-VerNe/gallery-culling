import React, { useState, useEffect, useCallback, useRef } from 'react';
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

const MIN_SCALE = 0.2;
const MAX_SCALE = 10;
const ZOOM_STEP = 1.25;
const LUMEN_PANE_WIDTH = 1600;

/** C6/C12：scale=1 实为适应窗口；复位措辞统一为「重置缩放与平移」。 */
const scaleLabel = (s: number) => (Math.abs(s - 1) < 0.001 ? '适应' : `${Math.round(s * 100)}%`);

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
    description: '请选择存放 JPG 的文件夹用于浏览与选片；RAW 文件夹可选。',
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

  // C8：拖拽夹紧需要量测各栏容器与图像的渲染尺寸。
  const paneRefs = useRef<{ before: HTMLDivElement | null; after: HTMLDivElement | null }>({
    before: null,
    after: null,
  });
  const imgRefs = useRef<{ before: HTMLImageElement | null; after: HTMLImageElement | null }>({
    before: null,
    after: null,
  });

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

  // 单栏允许的最大平移量（C8）：缩放后图像超出该栏容器的半边尺寸。
  const paneMaxPan = (side: PaneSide, s: number) => {
    const pane = paneRefs.current[side];
    const img = imgRefs.current[side];
    if (!pane || !img) return { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
    return {
      x: Math.max(0, (img.offsetWidth * s - pane.clientWidth) / 2),
      y: Math.max(0, (img.offsetHeight * s - pane.clientHeight) / 2),
    };
  };
  const clampTo = (
    p: { x: number; y: number },
    maxX: number,
    maxY: number,
  ) => ({
    x: Math.min(Math.max(p.x, -maxX), maxX),
    y: Math.min(Math.max(p.y, -maxY), maxY),
  });

  // 拖拽平移（C8：Pointer 事件 + 捕获，拖出容器不丢拽）
  //
  // 坐标系：**绝对系**（与 PreviewViewport / SplitCompareViewport 一致）。
  // `dragStart` 记的是「抓取点相对图像原点的偏移」，move 时直接由当前
  // 客户端坐标反解出目标平移量。
  //
  // 原先这里是增量系（`dx = client - dragStart` 再把 client 写回 dragStart）：
  // dragStart 是 React state，同帧内派发的两个 pointermove 会被批处理，
  // 第二个 handler 读到**同一个旧 dragStart**，dx 被重复计算、位移丢一帧。
  // 快速拖拽 / 低帧率下会放大成可见抖动。绝对系天然免疫。
  const handlePointerDown = (side: PaneSide, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 覆盖层交互元素不进入拖拽。
    if (e.target !== e.currentTarget) return;
    setIsDragging(true);
    setActivePane(side);
    const origin = side === 'before' ? beforePos : afterPos;
    setDragStart({ x: e.clientX - origin.x, y: e.clientY - origin.y });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    // 绝对系：由客户端坐标与抓取偏移反解目标平移量，与 dragStart 是否已提交无关。
    const target = { x: e.clientX - dragStart.x, y: e.clientY - dragStart.y };

    if (syncLock) {
      // 联动平移两栏：夹紧取两栏的公共边界，避免任一栏露空。
      const bm = paneMaxPan('before', beforeScale);
      const am = paneMaxPan('after', afterScale);
      const mx = Math.min(bm.x, am.x);
      const my = Math.min(bm.y, am.y);
      setBeforePos(clampTo(target, mx, my));
      setAfterPos(clampTo(target, mx, my));
    } else if (activePane === 'before') {
      const m = paneMaxPan('before', beforeScale);
      setBeforePos(clampTo(target, m.x, m.y));
    } else {
      const m = paneMaxPan('after', afterScale);
      setAfterPos(clampTo(target, m.x, m.y));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    const host = e.currentTarget as HTMLElement;
    if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
  };

  // 保留 mouseDown 仅作「聚焦窗格」入口（与拖拽/滚轮同一入口；jsdom 不派发 pointerdown）。
  const handleMouseDown = (side: PaneSide) => setActivePane(side);

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
  const hasJpg = Boolean(group?.jpg?.path);
  const hasRaw = Boolean(group?.raw?.path);
  const lumenActive = Boolean(lumenPreview.url && !lumenBroken);
  // RAW-only（无 JPG）分组：引擎不可用时不再回落 .NEF 资产 URL（C2，会永久破图）。
  const rawOnly = !hasJpg && hasRaw;
  const legacySrc = group?.jpg?.path
    ? api.toAssetUrl(group.jpg.path)
    : group?.raw?.path
    ? api.toAssetUrl(group.raw.path)
    : null;
  const beforeSrc = rawOnly ? (lumenActive ? lumenPreview.url : null) : legacySrc;

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
  // C5：未做任何调色时左右逐像素相同，需给出提示而非误标 Before/After。
  const hasTone = toneFilter !== 'none';

  if (!group) {
    // Same shared empty state as the single view (M-03).
    return <ViewportEmptyStateView emptyState={emptyState} />;
  }

  // RAW-only：解码中 → 渲染主视图并显示横幅；失败/未启用 → 明确占位而非破图（C2）。
  if (!beforeSrc && !(rawOnly && lumenPreview.loading)) {
    return (
      <ViewportEmptyStateView
        emptyState={
          rawOnly
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
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              disabled={effectiveScale <= MIN_SCALE}
              className="focus-ring tap-target p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-l active:scale-[0.96] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="缩小"
              aria-label="缩小"
            >
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            {syncLock ? (
              <span
                className="font-mono tabular-nums text-white/80 w-10 text-center"
                aria-label={`当前缩放 ${scaleLabel(beforeScale)}`}
              >
                {scaleLabel(beforeScale)}
              </span>
            ) : (
              <span
                className="font-mono tabular-nums text-white/80 px-1 text-center flex items-center gap-1"
                aria-label={`当前缩放：前 ${scaleLabel(beforeScale)}，后 ${scaleLabel(
                  afterScale,
                )}（聚焦${activePane === 'before' ? '前' : '后'}图）`}
              >
                <span className={activePane === 'before' ? 'text-white' : 'text-white/45'}>
                  前 {scaleLabel(beforeScale)}
                </span>
                <span className="text-white/25">/</span>
                <span className={activePane === 'after' ? 'text-white' : 'text-white/45'}>
                  后 {scaleLabel(afterScale)}
                </span>
              </span>
            )}
            <button
              onClick={() => zoomBy(ZOOM_STEP)}
              disabled={effectiveScale >= MAX_SCALE}
              className="focus-ring tap-target p-1 text-white/70 hover:text-white hover:bg-white/15 active:scale-[0.96] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="放大"
              aria-label="放大"
            >
              <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              onClick={resetView}
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
            onClick={() => setSyncLock((v) => !v)}
            className={`focus-ring flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium active:scale-[0.96] transition-colors border ${
              syncLock
                ? 'bg-white/10 text-white border-white/25'
                : 'bg-background-surface-hover text-white/60 border-default hover:text-white hover:bg-white/10'
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
          ref={(el) => {
            paneRefs.current.before = el;
          }}
          onWheel={(e) => handleWheel('before', e)}
          onMouseDown={() => handleMouseDown('before')}
          onPointerDown={(e) => handlePointerDown('before', e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
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

          {beforeSrc && (
            <img
              ref={(el) => {
                imgRefs.current.before = el;
              }}
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
          )}

          {lumenPreview.loading && (
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
          ref={(el) => {
            paneRefs.current.after = el;
          }}
          onWheel={(e) => handleWheel('after', e)}
          onMouseDown={() => handleMouseDown('after')}
          onPointerDown={(e) => handlePointerDown('after', e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
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

          {afterSrc && (
            <img
              ref={(el) => {
                imgRefs.current.after = el;
              }}
              src={afterSrc}
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
