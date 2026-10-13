import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Columns2,
  Link,
  Unlink,
  Star,
  Check,
  X,
  Pin,
  ArrowLeftRight,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Sparkles,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { PhotoGroupInfo, ToneAdjustments, LumenStatus } from '../types';
import { api } from '../services/api';
import { getToneFilterString } from '../utils/autoTone';
import { zoomAtPoint } from '../utils/zoom';
import { useLumenPreview, type UseLumenPreviewResult } from '../hooks/useLumenPreview';
import { LUMEN_UNAVAILABLE } from '../hooks/useLumenStatus';
import { ViewportEmptyStateView } from './ViewportEmptyState';

interface SplitCompareViewportProps {
  leftGroup?: PhotoGroupInfo;
  rightGroup?: PhotoGroupInfo;
  isLeftPinned: boolean;
  isRightPinned: boolean;
  onTogglePinLeft: () => void;
  onTogglePinRight: () => void;
  onSwap: () => void;
  onRate: (group: PhotoGroupInfo, rating: number) => void;
  onFlag: (group: PhotoGroupInfo, flag: 'pick' | 'reject' | 'none') => void;
  /** LUMEN RAW 引擎握手状态；可用时 RAW-only 分组走真实解码，与单图视图同口径（M-02）。 */
  lumenStatus?: LumenStatus;
  /** 按分组取当前生效的调色（宿主传 `toneMap[id] ?? group.tone`）；缺失 → 不套 CSS 滤镜。 */
  getTone?: (group: PhotoGroupInfo) => ToneAdjustments | undefined;
  /** 翻页回调（C7）：仅当传入时渲染左右翻页覆盖层按钮；由宿主接线。 */
  onPrev?: () => void;
  onNext?: () => void;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 10;
const ZOOM_STEP = 1.25;
/** 窗格级 LUMEN 渲染宽边（与单图视图一致）。 */
const LUMEN_PANE_WIDTH = 1600;

/** C6：scale=1 实为适应窗口，读数显示「适应」而非误导性的 100%。 */
const scaleLabel = (s: number) => (Math.abs(s - 1) < 0.001 ? '适应' : `${Math.round(s * 100)}%`);

export const SplitCompareViewport: React.FC<SplitCompareViewportProps> = ({
  leftGroup,
  rightGroup,
  isLeftPinned,
  isRightPinned,
  onTogglePinLeft,
  onTogglePinRight,
  onSwap,
  onRate,
  onFlag,
  lumenStatus,
  getTone,
  onPrev,
  onNext,
}) => {
  const [syncZoom, setSyncZoom] = useState(true);
  const [leftScale, setLeftScale] = useState(1);
  const [leftPos, setLeftPos] = useState({ x: 0, y: 0 });
  const [rightScale, setRightScale] = useState(1);
  const [rightPos, setRightPos] = useState({ x: 0, y: 0 });

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  // 最近一次交互的窗格：独立模式下 ± / 滚轮 / 拖拽的作用目标（M-01）。
  // 不再在 mouseup 置空 —— 拖拽门控由 isDragging 负责。
  const [focusedPane, setFocusedPane] = useState<'left' | 'right'>('left');

  // C8：拖拽夹紧需要量测各栏容器与图像的渲染尺寸。
  const paneRefs = useRef<{ left: HTMLDivElement | null; right: HTMLDivElement | null }>({
    left: null,
    right: null,
  });
  const imgRefs = useRef<{ left: HTMLImageElement | null; right: HTMLImageElement | null }>({
    left: null,
    right: null,
  });

  // 两个窗格各自持有 LUMEN 解码实例（有 JPG 时 hook 内短路 → 零请求、零额外成本）。
  const leftLumen = useLumenPreview(leftGroup, lumenStatus ?? LUMEN_UNAVAILABLE, LUMEN_PANE_WIDTH);
  const rightLumen = useLumenPreview(rightGroup, lumenStatus ?? LUMEN_UNAVAILABLE, LUMEN_PANE_WIDTH);
  // 陈旧预览解码失败时静默回落到静态路径（与单图视图同语义）。
  const [leftLumenBroken, setLeftLumenBroken] = useState(false);
  const [rightLumenBroken, setRightLumenBroken] = useState(false);

  const resetView = useCallback(() => {
    setLeftScale(1);
    setRightScale(1);
    setLeftPos({ x: 0, y: 0 });
    setRightPos({ x: 0, y: 0 });
  }, []);

  // Reset zoom & pan whenever either pane shows a different photo.
  //
  // Preview view already did this; split view did not, so advancing a
  // candidate left you zoomed into empty space on the new image (F-03).
  useEffect(() => {
    resetView();
    setLeftLumenBroken(false);
    setRightLumenBroken(false);
  }, [leftGroup?.id, rightGroup?.id, resetView]);

  // 翻页/钉基准后，把焦点指向「当前会变的那一侧」，
  // 避免独立模式下 ± 去动一张静止的基准图（M-01 风险项）。
  useEffect(() => {
    if (isLeftPinned && !isRightPinned) setFocusedPane('right');
    else if (isRightPinned && !isLeftPinned) setFocusedPane('left');
  }, [isLeftPinned, isRightPinned]);

  const zoomBy = useCallback(
    (factor: number) => {
      const clamp = (s: number) => Math.min(Math.max(s * factor, MIN_SCALE), MAX_SCALE);
      if (syncZoom) {
        // 联动：以左为基准拉齐两图
        const next = clamp(leftScale);
        setLeftScale(next);
        setRightScale(next);
      } else if (focusedPane === 'left') {
        setLeftScale(clamp);
      } else {
        setRightScale(clamp);
      }
    },
    [syncZoom, leftScale, focusedPane],
  );

  // 命中光标缩放（M-08）：每栏各自持有 rect，光标只可能在其中一栏。
  // 联动模式下以**悬停栏**为锚点算一次，再把同一组 scale/pos 写给两栏；
  // 独立模式下只动被悬停的那一栏（批次 B 的独立缩放语义不变）。
  const handleWheel = (isLeft: boolean, e: React.WheelEvent) => {
    e.preventDefault();
    setFocusedPane(isLeft ? 'left' : 'right');
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const opts = { min: MIN_SCALE, max: MAX_SCALE, step: ZOOM_STEP };

    if (syncZoom) {
      const next = zoomAtPoint(e, rect, leftScale, leftPos, opts);
      setLeftScale(next.scale);
      setRightScale(next.scale);
      setLeftPos(next.pos);
      setRightPos(next.pos);
    } else if (isLeft) {
      const next = zoomAtPoint(e, rect, leftScale, leftPos, opts);
      setLeftScale(next.scale);
      setLeftPos(next.pos);
    } else {
      const next = zoomAtPoint(e, rect, rightScale, rightPos, opts);
      setRightScale(next.scale);
      setRightPos(next.pos);
    }
  };

  // 单栏允许的最大平移量（C8）：缩放后图像超出该栏容器的半边尺寸。
  const paneMaxPan = (side: 'left' | 'right', s: number) => {
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
    dx: number,
    dy: number,
    maxX: number,
    maxY: number,
  ) => ({
    x: Math.min(Math.max(p.x + dx, -maxX), maxX),
    y: Math.min(Math.max(p.y + dy, -maxY), maxY),
  });

  // Left-click pan drag（C8：Pointer 事件 + 捕获，拖出容器不丢拽）
  const handlePointerDown = (isLeft: boolean, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 覆盖层交互元素（设为基准、评分等）不进入拖拽。
    if (e.target !== e.currentTarget) return;
    setIsDragging(true);
    setFocusedPane(isLeft ? 'left' : 'right');
    setDragStart({ x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setDragStart({ x: e.clientX, y: e.clientY });

    if (syncZoom) {
      // 联动平移两栏：夹紧取两栏的公共边界，避免任一栏露空。
      const lm = paneMaxPan('left', leftScale);
      const rm = paneMaxPan('right', rightScale);
      const mx = Math.min(lm.x, rm.x);
      const my = Math.min(lm.y, rm.y);
      setLeftPos((prev) => clampTo(prev, dx, dy, mx, my));
      setRightPos((prev) => clampTo(prev, dx, dy, mx, my));
    } else if (focusedPane === 'left') {
      const m = paneMaxPan('left', leftScale);
      setLeftPos((prev) => clampTo(prev, dx, dy, m.x, m.y));
    } else {
      const m = paneMaxPan('right', rightScale);
      setRightPos((prev) => clampTo(prev, dx, dy, m.x, m.y));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    const host = e.currentTarget as HTMLElement;
    if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
  };

  // Double click to toggle fit (1.0x) / 250% and recentre
  const handleDoubleClick = (isLeft: boolean) => {
    setFocusedPane(isLeft ? 'left' : 'right');
    const currentScale = isLeft ? leftScale : rightScale;
    const targetScale = currentScale === 1 ? 2.5 : 1;
    if (syncZoom) {
      setLeftScale(targetScale);
      setRightScale(targetScale);
      setLeftPos({ x: 0, y: 0 });
      setRightPos({ x: 0, y: 0 });
    } else if (isLeft) {
      setLeftScale(targetScale);
      setLeftPos({ x: 0, y: 0 });
    } else {
      setRightScale(targetScale);
      setRightPos({ x: 0, y: 0 });
    }
  };

  const renderPane = (
    group: PhotoGroupInfo | undefined,
    isLeft: boolean,
    scale: number,
    pos: { x: number; y: number },
    lumen: UseLumenPreviewResult,
    lumenBroken: boolean,
    markLumenBroken: () => void,
  ) => {
    const hasJpg = Boolean(group?.jpg?.path);
    const hasRaw = Boolean(group?.raw?.path);
    const lumenActive = Boolean(lumen.url && !lumenBroken);
    // RAW-only（无 JPG）分组：引擎不可用时不再回落 .NEF 资产 URL（C2，会永久破图）。
    const rawOnly = !hasJpg && hasRaw;
    const legacySrc = group?.jpg?.path
      ? api.toAssetUrl(group.jpg.path)
      : group?.raw?.path
      ? api.toAssetUrl(group.raw.path)
      : null;
    const src = rawOnly ? (lumenActive ? lumen.url : null) : legacySrc;

    if (!group) {
      return (
        <ViewportEmptyStateView
          variant="pane"
          emptyState={{
            title: isLeft ? '左侧未选择' : '右侧未选择',
            description: isLeft ? '从右侧宫格选一张作为基准' : '从右侧宫格选一张进行对比',
          }}
        />
      );
    }

    // RAW-only：解码中 → 渲染窗格并显示横幅；失败/未启用 → 明确占位而非破图（C2）。
    if (!src && !(rawOnly && lumen.loading)) {
      return (
        <ViewportEmptyStateView
          variant="pane"
          emptyState={
            rawOnly
              ? {
                  title: '该 RAW 需启用 LUMEN RAW 引擎',
                  description: '启用 LUMEN RAW 引擎后即可在此实时预览。',
                }
              : {
                  title: isLeft ? '左侧未选择' : '右侧未选择',
                  description: isLeft
                    ? '从右侧宫格选一张作为基准'
                    : '从右侧宫格选一张进行对比',
                }
          }
        />
      );
    }

    // LUMEN 命中时不再叠加 CSS 滤镜（否则会把图像 develop 两次）——与单图视图同规则。
    const toneFilter = lumenActive ? 'none' : getToneFilterString(getTone?.(group));

    const isPinned = isLeft ? isLeftPinned : isRightPinned;
    const onTogglePin = isLeft ? onTogglePinLeft : onTogglePinRight;
    const shortcutHint = isLeft ? '[ 或 B' : '] 或 空格';
    const isFocused = !syncZoom && focusedPane === (isLeft ? 'left' : 'right');

    return (
      <div
        ref={(el) => {
          paneRefs.current[isLeft ? 'left' : 'right'] = el;
        }}
        onWheel={(e) => handleWheel(isLeft, e)}
        onPointerDown={(e) => handlePointerDown(isLeft, e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => handleDoubleClick(isLeft)}
        className={`relative flex-1 bg-background-surface overflow-hidden flex items-center justify-center border-r border-border-subtle last:border-r-0 select-none ${
          isDragging ? 'cursor-grabbing' : 'cursor-grab'
        } ${isPinned ? 'ring-2 ring-inset ring-amber-500/50' : ''}`}
      >
        {/* 当前聚焦窗格的可见提示（独立模式下 ± / 滚轮作用于它）。
            用叠加描边而非 hover，窄屏/触控下依然可靠。 */}
        {isFocused && (
          <div
            className="absolute inset-0 border-2 border-sky-400/60 pointer-events-none z-10"
            aria-hidden="true"
          />
        )}

        {src && (
          <img
            ref={(el) => {
              imgRefs.current[isLeft ? 'left' : 'right'] = el;
            }}
            src={src}
            alt={group.baseName}
            draggable={false}
            onError={() => {
              // 陈旧的 LUMEN 预览不能把窗格变空。
              if (lumen.url && !lumenBroken) markLumenBroken();
            }}
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
              transition: isDragging ? 'none' : 'transform 0.05s ease-out',
              imageOrientation: 'from-image',
              filter: toneFilter,
            }}
            className="max-h-full max-w-full object-contain pointer-events-none origin-center"
          />
        )}

        {/* RAW-only 首次进入时的轻提示（与单图视图一致，不弹窗） */}
        {lumen.loading && (
          <div
            role="status"
            className="absolute top-3 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3 py-1 rounded-md text-[11px] font-semibold text-white/80 border border-white/10 pointer-events-none"
          >
            正在渲染 RAW…
          </div>
        )}

        {/* 含成品提示：该分组存在 edited（Luminar 成果）。
            仅作提示，主图口径仍是工作版（jpg/raw + LUMEN 调色）。 */}
        {group.edited && (
          <div
            className="absolute top-3 right-3 bg-purple-500/15 border border-purple-500/30 text-purple-300 backdrop-blur px-2 py-1 rounded-md text-[10px] font-medium flex items-center gap-1 pointer-events-none"
            title="包含精修成果 (Luminar AI)"
          >
            <Sparkles className="w-3 h-3" aria-hidden="true" />
            <span>含成品</span>
          </div>
        )}

        {/* Top title, Reference status & Pin button */}
        <div className="absolute top-3 left-3 flex items-center gap-2 select-none pointer-events-auto flex-wrap max-w-[calc(100%-1.5rem)]">
          <div className="bg-background-base/85 backdrop-blur px-3 py-1.5 rounded-lg text-xs text-white flex items-center gap-2 border border-white/10 select-text">
            <span className="font-mono font-medium">{group.baseName}</span>
            {group.exif && (
              <span className="text-[11px] text-white/70 font-mono tabular-nums">
                {[
                  group.exif.focalLength,
                  group.exif.aperture,
                  group.exif.shutterSpeed,
                  group.exif.iso ? `ISO${group.exif.iso}` : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              </span>
            )}
          </div>

          {/* Reference / Candidate badge & Pin trigger */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            className={`focus-ring flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isPinned
                ? 'bg-amber-500 text-black font-semibold ring-1 ring-amber-400'
                : 'bg-background-base/85 hover:bg-white/15 text-white/80 hover:text-white border border-white/15'
            }`}
            title={
              isPinned
                ? `已锁定为基准（按 B 或对应键取消）`
                : `锁定对比基准（${shortcutHint}）`
            }
            aria-label={
              isPinned
                ? `取消将 ${group.baseName} 锁定为对比基准`
                : `将 ${group.baseName} 锁定为对比基准（${shortcutHint}）`
            }
            aria-pressed={isPinned}
          >
            <Pin
              className={`w-3.5 h-3.5 ${isPinned ? 'fill-black' : ''}`}
              aria-hidden="true"
            />
            <span className="pb-[1px] whitespace-nowrap">
              {isPinned ? '基准参考' : `设为基准 (${shortcutHint})`}
            </span>
          </button>
        </div>

        {/* Bottom ratings */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-3 bg-background-base/85 backdrop-blur px-3.5 py-1.5 rounded-lg flex items-center gap-2.5 border border-white/15 pointer-events-auto"
          role="group"
          aria-label={`为照片 ${group.baseName} 打分和标记`}
        >
          {/* Stars */}
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                onClick={() => onRate(group, group.rating === star ? 0 : star)}
                className="focus-ring p-1 hover:scale-125 active:scale-95 rounded-sm transition-transform"
                title={`评 ${star} 星`}
                aria-label={`为 ${group.baseName} 评 ${star} 星`}
                aria-pressed={group.rating >= star}
              >
                <Star
                  className={`w-3.5 h-3.5 ${
                    group.rating >= star
                      ? 'fill-amber-400 text-amber-400'
                      : 'text-white/60 hover:text-white'
                  }`}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>

          <div className="w-px h-3.5 bg-white/25" />

          {/* Pick / Reject */}
          <button
            onClick={() => onFlag(group, group.flag === 'pick' ? 'none' : 'pick')}
            className={`focus-ring p-1.5 rounded-md text-xs active:scale-[0.96] transition-colors border ${
              group.flag === 'pick'
                ? 'bg-emerald-600/40 text-emerald-300 border-emerald-500/50'
                : 'bg-transparent text-white/70 hover:text-white hover:bg-white/10 border-transparent'
            }`}
            title="保留 (Pick)"
            aria-label={`将 ${group.baseName} 标记保留 (Pick)`}
            aria-pressed={group.flag === 'pick'}
          >
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={() => onFlag(group, group.flag === 'reject' ? 'none' : 'reject')}
            className={`focus-ring p-1.5 rounded-md text-xs active:scale-[0.96] transition-colors border ${
              group.flag === 'reject'
                ? 'bg-rose-600/40 text-rose-300 border-rose-500/50'
                : 'bg-transparent text-white/70 hover:text-white hover:bg-white/10 border-transparent'
            }`}
            title="淘汰 (Reject)"
            aria-label={`将 ${group.baseName} 标记淘汰 (Reject)`}
            aria-pressed={group.flag === 'reject'}
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  };

  const effectiveScale = syncZoom
    ? leftScale
    : focusedPane === 'left'
    ? leftScale
    : rightScale;

  return (
    <div className="flex-1 flex flex-col h-full w-full bg-background-surface relative">
      {/* Top Sync & Compare Control Bar */}
      <div className="h-9 bg-background-base border-b border-white/10 flex items-center justify-between gap-2 px-3 text-xs text-white/80 select-none">
        <div className="flex items-center gap-2 font-medium min-w-0">
          <Columns2 className="w-4 h-4 text-white shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap">双图对比视图</span>
          <span className="text-[11px] text-white/60 truncate hidden lg:inline">
            {isLeftPinned
              ? '左图为基准，流动切换右图'
              : isRightPinned
              ? '右图为基准，流动切换左图'
              : '点击“设为基准”固定任意一张对比'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Swap A/B button */}
          <button
            onClick={onSwap}
            className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white/80 hover:text-white rounded text-[11px] font-medium transition-colors"
            title="对调左右两张照片 (快捷键 S)"
            aria-label="对调左右两张照片（快捷键 S）"
          >
            <ArrowLeftRight className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="pb-[1px]">左右互换 (S)</span>
          </button>

          {/* Zoom: – / readout / reset / + */}
          <div className="flex items-center gap-0.5 bg-white/10 rounded text-[11px]">
            <button
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              disabled={effectiveScale <= MIN_SCALE}
              className="focus-ring p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-l active:scale-[0.96] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="缩小"
              aria-label="缩小双图"
            >
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            {syncZoom ? (
              <span
                className="font-mono tabular-nums text-white/80 w-10 text-center"
                aria-label={`当前缩放 ${scaleLabel(leftScale)}`}
              >
                {scaleLabel(leftScale)}
              </span>
            ) : (
              <span
                className="font-mono tabular-nums text-white/80 px-1 text-center flex items-center gap-1"
                aria-label={`当前缩放：左 ${scaleLabel(leftScale)}，右 ${scaleLabel(
                  rightScale,
                )}%（聚焦${focusedPane === 'left' ? '左' : '右'}图）`}
              >
                <span className={focusedPane === 'left' ? 'text-white' : 'text-white/60'}>
                  L {scaleLabel(leftScale)}
                </span>
                <span className="text-white/25">/</span>
                <span className={focusedPane === 'right' ? 'text-white' : 'text-white/60'}>
                  R {scaleLabel(rightScale)}
                </span>
              </span>
            )}
            <button
              onClick={() => zoomBy(ZOOM_STEP)}
              disabled={effectiveScale >= MAX_SCALE}
              className="focus-ring p-1 text-white/70 hover:text-white hover:bg-white/15 active:scale-[0.96] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="放大"
              aria-label="放大双图"
            >
              <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              onClick={resetView}
              className="focus-ring p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-r active:scale-[0.96] transition-colors"
              title={`重置缩放与平移（当前 ${scaleLabel(effectiveScale)}）`}
              aria-label="重置缩放与平移"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Sync Zoom toggle */}
          <button
            onClick={() => setSyncZoom(!syncZoom)}
            className={`focus-ring flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium active:scale-[0.96] transition-colors ${
              syncZoom
                ? 'bg-white text-black shadow-sm'
                : 'bg-white/5 text-white/70 hover:text-white hover:bg-white/10'
            }`}
            title="开启后双图同步缩放和平移；关闭后滚轮/拖拽/± 只作用于聚焦窗格"
            aria-label="切换双图联动同步缩放"
            aria-pressed={syncZoom}
          >
            {syncZoom ? (
              <Link className="w-3 h-3" aria-hidden="true" />
            ) : (
              <Unlink className="w-3 h-3" aria-hidden="true" />
            )}
            <span className="pb-[1px] whitespace-nowrap">
              {syncZoom ? '联动同步开启' : '独立缩放'}
            </span>
          </button>
        </div>
      </div>

      {/* Side-by-side Panes */}
      <div className="flex-1 flex overflow-hidden select-none">
        {renderPane(
          leftGroup,
          true,
          leftScale,
          leftPos,
          leftLumen,
          leftLumenBroken,
          () => setLeftLumenBroken(true),
        )}
        {renderPane(
          rightGroup,
          false,
          rightScale,
          rightPos,
          rightLumen,
          rightLumenBroken,
          () => setRightLumenBroken(true),
        )}
      </div>

      {/* 翻页覆盖层（C7）：仅当宿主传入回调时渲染，复用单图视图的样式与图标。 */}
      {onPrev && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          className="focus-ring absolute left-3 top-1/2 -translate-y-1/2 p-3 z-20 bg-background-base/70 hover:bg-background-base/90 active:scale-[0.96] text-white rounded-full transition-colors backdrop-blur-sm pointer-events-auto"
          title="上一张 (A / ←)"
          aria-label="上一张照片（快捷键 A 或 ←）"
        >
          <ChevronLeft className="w-6 h-6" aria-hidden="true" />
        </button>
      )}
      {onNext && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 p-3 z-20 bg-background-base/70 hover:bg-background-base/90 active:scale-[0.96] text-white rounded-full transition-colors backdrop-blur-sm pointer-events-auto"
          title="下一张 (D / →)"
          aria-label="下一张照片（快捷键 D 或 →）"
        >
          <ChevronRight className="w-6 h-6" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
