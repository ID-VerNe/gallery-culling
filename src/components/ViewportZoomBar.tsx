/**
 * 双图顶部缩放条（issue #120）。
 *
 * `BeforeAfterViewport` 与 `SplitCompareViewport` 顶部的 51 行缩放条逐行一致，
 * 只差 pane 名（before/after「前/后」vs left/right「L/R」）、aria-label
 * （「缩小」vs「缩小双图」）、未激活亮度（text-white/45 vs /60）三处。
 * 收拢为一处 presentational 组件：几何与读数真值仍在 `viewportZoom.ts` /
 * `useDualZoomPan`，这里只做呈现与 effectiveScale 的统一取值。
 *
 * 不变量（由 `ViewportZoomBar.test.tsx` 锁死）：
 * - 4 处（缩小 disabled、放大 disabled、重置 title、重置 aria）统一读
 *   `zoom.effectiveScale`，不建局部别名、不改读某栏的 scale —— 联动取首栏、
 *   独立取聚焦栏的语义由 hook 拥有，这条只消费。
 * - title 恒为「缩小 / 放大」，aria-label 由调用方传参（双图带「双图」）。
 * - 底栏单图缩放（`BottomBar` 的 StatusZoom）形态不同，不在此收拢。
 */
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { ZOOM_STEP, ZOOM_MIN, ZOOM_MAX, scaleLabel } from '../utils/viewportZoom';
import type { DualZoomPan } from '../hooks/useDualZoomPan';

/** 窗格映射：键（hook 的 pane id）+ 展示短标 + aria 长名 + 未激活亮度类。 */
export interface ZoomBarPanes<P extends string> {
  first: P;
  second: P;
  /** 短标：BeforeAfter「前 / 后」，Split「L / R」。 */
  firstShort: string;
  secondShort: string;
  /** aria 长名：BeforeAfter「前 / 后」，Split「左 / 右」。 */
  firstName: string;
  secondName: string;
  /** 未激活窗格的文字亮度类：BeforeAfter text-white/45，Split text-white/60。 */
  dimClass: string;
}

export interface ViewportZoomBarProps<P extends string> {
  zoom: DualZoomPan<P>;
  panes: ZoomBarPanes<P>;
  /** 缩小按钮 aria-label：BeforeAfter「缩小」，Split「缩小双图」。 */
  zoomOutLabel: string;
  /** 放大按钮 aria-label：BeforeAfter「放大」，Split「放大双图」。 */
  zoomInLabel: string;
}

export const ViewportZoomBar = <P extends string>({
  zoom,
  panes,
  zoomOutLabel,
  zoomInLabel,
}: ViewportZoomBarProps<P>) => {
  return (
    <div className="flex items-center gap-0.5 bg-background-surface rounded text-[11px]">
      <button
        onClick={() => zoom.zoomBy(1 / ZOOM_STEP)}
        disabled={zoom.effectiveScale <= ZOOM_MIN}
        className="focus-ring tap-target p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-l active:scale-[0.96] press disabled:opacity-40 disabled:cursor-not-allowed"
        title="缩小"
        aria-label={zoomOutLabel}
      >
        <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      {zoom.sync ? (
        <span
          className="font-mono tabular-nums text-white/80 w-10 text-center"
          aria-label={`当前缩放 ${scaleLabel(zoom.scaleOf(panes.first))}`}
        >
          {scaleLabel(zoom.scaleOf(panes.first))}
        </span>
      ) : (
        <span
          className="font-mono tabular-nums text-white/80 px-1 text-center flex items-center gap-1"
          aria-label={`当前缩放：${panes.firstName} ${scaleLabel(zoom.scaleOf(panes.first))}，${panes.secondName} ${scaleLabel(
            zoom.scaleOf(panes.second),
          )}（聚焦${zoom.activePane === panes.first ? panes.firstName : panes.secondName}图）`}
        >
          <span className={zoom.activePane === panes.first ? 'text-white' : panes.dimClass}>
            {panes.firstShort} {scaleLabel(zoom.scaleOf(panes.first))}
          </span>
          <span className="text-white/25">/</span>
          <span className={zoom.activePane === panes.second ? 'text-white' : panes.dimClass}>
            {panes.secondShort} {scaleLabel(zoom.scaleOf(panes.second))}
          </span>
        </span>
      )}
      <button
        onClick={() => zoom.zoomBy(ZOOM_STEP)}
        disabled={zoom.effectiveScale >= ZOOM_MAX}
        className="focus-ring tap-target p-1 text-white/70 hover:text-white hover:bg-white/15 active:scale-[0.96] press disabled:opacity-40 disabled:cursor-not-allowed"
        title="放大"
        aria-label={zoomInLabel}
      >
        <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      <button
        onClick={zoom.reset}
        className="focus-ring tap-target p-1 text-white/70 hover:text-white hover:bg-white/15 rounded-r active:scale-[0.96] press"
        title={`重置缩放与平移（当前 ${scaleLabel(zoom.effectiveScale)}）`}
        aria-label={`重置缩放与平移（当前 ${scaleLabel(zoom.effectiveScale)}）`}
      >
        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
};
