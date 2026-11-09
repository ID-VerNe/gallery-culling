import React, { useEffect } from 'react';
import {
  Columns2,
  Link,
  Unlink,
  Pin,
  ArrowLeftRight,
  Sparkles,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { PhotoGroupInfo, ToneAdjustments, LumenStatus } from '../types';
import { getToneFilterString } from '../utils/autoTone';
import { useViewportImage, type ViewportImage } from '../hooks/useViewportImage';
import { useDualZoomPan } from '../hooks/useDualZoomPan';
import { LUMEN_UNAVAILABLE } from '../hooks/useLumenStatus';
import { ViewportEmptyStateView } from './ViewportEmptyState';
import { ViewportZoomBar } from './ViewportZoomBar';
import { RawRenderingBanner } from './RawRenderingBanner';
import { rawOnlyEmptyState } from '../utils/viewportRawCopy';

interface SplitCompareViewportProps {
  leftGroup?: PhotoGroupInfo;
  rightGroup?: PhotoGroupInfo;
  isLeftPinned: boolean;
  isRightPinned: boolean;
  onTogglePinLeft: () => void;
  onTogglePinRight: () => void;
  onSwap: () => void;
  /** LUMEN RAW 引擎握手状态；可用时 RAW-only 分组走真实解码，与单图视图同口径（M-02）。 */
  lumenStatus?: LumenStatus;
  /** 按分组取当前生效的调色（宿主传 `toneMap[id] ?? group.tone`）；缺失 → 不套 CSS 滤镜。 */
  getTone?: (group: PhotoGroupInfo) => ToneAdjustments | undefined;
  /** 翻页回调（C7）：仅当传入时渲染左右翻页覆盖层按钮；由宿主接线。 */
  onPrev?: () => void;
  onNext?: () => void;
}

/** 窗格级 LUMEN 渲染宽边（与单图视图一致）。 */
const LUMEN_PANE_WIDTH = 1600;

/** 双栏 hook 的栏序：第一栏是联动基准。模块级常量（hook 要求稳定引用）。 */
const PANES = ['left', 'right'] as const;

export const SplitCompareViewport: React.FC<SplitCompareViewportProps> = ({
  leftGroup,
  rightGroup,
  isLeftPinned,
  isRightPinned,
  onTogglePinLeft,
  onTogglePinRight,
  onSwap,
  lumenStatus,
  getTone,
  onPrev,
  onNext,
}) => {
  // 缩放/平移机器（联动/独立、绝对系拖拽、命中光标缩放、夹紧、换图复位）。
  // 两栏 id 任一变化都算换图（F-03：不复位会 zoom 进新图的空白里）。
  const zoom = useDualZoomPan(PANES, `${leftGroup?.id ?? ''}|${rightGroup?.id ?? ''}`);

  // 两个窗格各自的图片源（LUMEN 预览 + 失败 latch + C2 口径，三视口共用；
  // 有 JPG 时 hook 内短路 → 零请求、零额外成本）。
  // 在组件体调两次再传进 renderPane —— 守 hook 规则（不在循环/条件里调 hook）。
  const leftImage = useViewportImage(leftGroup, lumenStatus ?? LUMEN_UNAVAILABLE, LUMEN_PANE_WIDTH);
  const rightImage = useViewportImage(
    rightGroup,
    lumenStatus ?? LUMEN_UNAVAILABLE,
    LUMEN_PANE_WIDTH,
  );

  // 翻页/钉基准后，把焦点指向「当前会变的那一侧」，
  // 避免独立模式下 ± 去动一张静止的基准图（M-01 风险项）。
  useEffect(() => {
    if (isLeftPinned && !isRightPinned) zoom.focusPane('right');
    else if (isRightPinned && !isLeftPinned) zoom.focusPane('left');
  }, [isLeftPinned, isRightPinned, zoom]);

  const renderPane = (
    group: PhotoGroupInfo | undefined,
    isLeft: boolean,
    transform: string,
    image: ViewportImage,
  ) => {
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
    if (!image.src && !(image.rawOnly && image.loading)) {
      const engineAvailable = lumenStatus?.available === true;
      return (
        <ViewportEmptyStateView
          variant="pane"
          emptyState={
            image.rawOnly
              ? rawOnlyEmptyState({ engineAvailable })
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
    const toneFilter = image.lumenActive ? 'none' : getToneFilterString(getTone?.(group));

    const isPinned = isLeft ? isLeftPinned : isRightPinned;
    const onTogglePin = isLeft ? onTogglePinLeft : onTogglePinRight;
    // issue #89：`Q` = 钉左 / 再按取消；`B` 是「切换基准」（有基准则取消，否则钉左），
    // 语义不同，不能并成「Q 或 B」。右栏的钉右键仍是 `Shift + Q`。
    const shortcutHint = isLeft ? 'Q' : 'Shift + Q';
    const pane = isLeft ? 'left' : 'right';
    const bind = zoom.bindPane(pane);
    const isFocused = !zoom.sync && zoom.activePane === pane;

    return (
      <div
        ref={bind.ref}
        data-viewport-photo
        onWheel={bind.onWheel}
        onPointerDown={bind.onPointerDown}
        onPointerMove={bind.onPointerMove}
        onPointerUp={bind.onPointerUp}
        onPointerCancel={bind.onPointerUp}
        onDoubleClick={bind.onDoubleClick}
        className={`relative flex-1 bg-background-surface overflow-hidden flex items-center justify-center border-r border-border-subtle last:border-r-0 select-none ${
          zoom.isDragging ? 'cursor-grabbing' : 'cursor-grab'
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

        {image.src && (
          <img
            ref={zoom.imgRef(pane)}
            src={image.src}
            alt={group.baseName}
            draggable={false}
            onError={image.markBroken}
            style={{
              transform,
              transition: zoom.transition,
              imageOrientation: 'from-image',
              filter: toneFilter,
            }}
            className="max-h-full max-w-full object-contain pointer-events-none origin-center"
          />
        )}

        {/* RAW-only 首次进入时的轻提示（与单图视图一致，不弹窗） */}
        {image.loading && <RawRenderingBanner />}


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
          <div className="bg-background-base/85 backdrop-blur px-3 py-1.5 rounded-md text-xs text-white flex items-center gap-2 border border-border-default select-text">
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
            className={`focus-ring flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
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

        {/* 评级 / 旗标 / 色标已迁到窗口底部常驻状态栏（issue #62）：
            双图时状态栏按 L / R 分两组，各自绑定本窗格的 group。 */}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full w-full bg-background-surface relative">
      {/* Top Sync & Compare Control Bar */}
      <div className="h-9 bg-background-base border-b border-border-default flex items-center justify-between gap-2 px-3 text-xs text-white/80 select-none">
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

          <ViewportZoomBar
            zoom={zoom}
            panes={{
              first: 'left',
              second: 'right',
              firstShort: 'L',
              secondShort: 'R',
              firstName: '左',
              secondName: '右',
              dimClass: 'text-white/60',
            }}
            zoomOutLabel="缩小双图"
            zoomInLabel="放大双图"
          />

          {/* Sync Zoom toggle */}
          <button
            onClick={zoom.toggleSync}
            className={`focus-ring flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium active:scale-[0.96] press ${
              zoom.sync
                ? 'bg-white text-black shadow-sm'
                : 'bg-background-surface-hover text-white/70 hover:text-white hover:bg-white/10'
            }`}
            title="开启后双图同步缩放和平移；关闭后滚轮/拖拽/± 只作用于聚焦窗格"
            aria-label="切换双图联动同步缩放"
            aria-pressed={zoom.sync}
          >
            {zoom.sync ? (
              <Link className="w-3 h-3" aria-hidden="true" />
            ) : (
              <Unlink className="w-3 h-3" aria-hidden="true" />
            )}
            <span className="pb-[1px] whitespace-nowrap">
              {zoom.sync ? '联动同步开启' : '独立缩放'}
            </span>
          </button>
        </div>
      </div>

      {/* Side-by-side Panes */}
      <div className="flex-1 flex overflow-hidden select-none">
        {renderPane(leftGroup, true, zoom.transformOf('left'), leftImage)}
        {renderPane(rightGroup, false, zoom.transformOf('right'), rightImage)}
      </div>

      {/* 翻页覆盖层（C7）：仅当宿主传入回调时渲染，复用单图视图的样式与图标。 */}
      {onPrev && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          className="focus-ring absolute left-3 top-1/2 -translate-y-1/2 p-3 z-20 bg-background-base/70 hover:ring-1 hover:ring-white/25 active:scale-[0.96] text-white rounded-full press backdrop-blur-sm pointer-events-auto"
          title="上一张 (A)"
          aria-label="上一张照片（快捷键 A）"
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
          className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 p-3 z-20 bg-background-base/70 hover:ring-1 hover:ring-white/25 active:scale-[0.96] text-white rounded-full press backdrop-blur-sm pointer-events-auto"
          title="下一张 (D)"
          aria-label="下一张照片（快捷键 D）"
        >
          <ChevronRight className="w-6 h-6" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
