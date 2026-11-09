/**
 * 状态栏视图模型纯 selector（issue #112，源自 AppShell 的 `statusZoom` /
 * `statusPanes` 内联派生，issue #62 窗格分流语义不变）。
 *
 * 三视口共用同一个底栏：单图 / 前后对照 1 个窗格，双图按 `L` / `R` 分
 * 两组，每组动作回调绑定本窗格自己的 group —— 给左图点红标不能落到右图。
 */
import type { StatusPane, StatusZoom } from '../components/BottomBar';
import type { PreviewZoomApi } from '../components/PreviewViewport';
import type { ColorLabel, PhotoGroupInfo, ToneAdjustments, ViewMode } from '../types';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, scaleLabel } from './viewportZoom';

export interface SelectStatusZoomInput {
  viewMode: ViewMode;
  currentGroup: PhotoGroupInfo | undefined;
  previewZoom: PreviewZoomApi | null;
}

/**
 * 状态栏缩放组：只有单图视口把缩放面交给宿主（双图 / 前后对照顶部已有
 * 自己的控制条，不占用底栏）。
 */
export function selectStatusZoom(input: SelectStatusZoomInput): StatusZoom | undefined {
  if (input.viewMode !== 'single' || !input.currentGroup || !input.previewZoom) {
    return undefined;
  }
  const previewZoom = input.previewZoom;
  return {
    label: scaleLabel(previewZoom.scale),
    atMin: previewZoom.scale <= ZOOM_MIN,
    atMax: previewZoom.scale >= ZOOM_MAX,
    onZoomOut: () => previewZoom.zoomBy(1 / ZOOM_STEP),
    onZoomIn: () => previewZoom.zoomBy(ZOOM_STEP),
    onReset: previewZoom.reset,
  };
}

export interface SelectStatusPanesInput {
  viewMode: ViewMode;
  leftCompareGroup: PhotoGroupInfo | undefined;
  rightCompareGroup: PhotoGroupInfo | undefined;
  toneMap: Record<string, ToneAdjustments>;
  currentGroup: PhotoGroupInfo | undefined;
  currentTone: ToneAdjustments | undefined;
  /** 单图窗格的动作分流（多选时批量确认）。 */
  applyRating: (rating: number) => void;
  applyFlag: (flag: 'pick' | 'reject' | 'none') => void;
  applyLabel: (label: ColorLabel) => void;
  /** 双图窗格的单图动作（直接绑窗格自己的 group）。 */
  handleRate: (rating: number, group: PhotoGroupInfo) => void;
  handleFlag: (flag: 'pick' | 'reject' | 'none', group: PhotoGroupInfo) => void;
  setLabel: (label: ColorLabel, group: PhotoGroupInfo) => void;
}

export function selectStatusPanes(input: SelectStatusPanesInput): StatusPane[] {
  if (input.viewMode === 'split') {
    const pane = (
      slot: 'L' | 'R',
      group: PhotoGroupInfo | undefined,
    ): StatusPane => ({
      slot,
      group,
      tone: group ? input.toneMap[group.id] || group.tone : undefined,
      onRate: (rating) => group && input.handleRate(rating, group),
      onFlag: (flag) => group && input.handleFlag(flag, group),
      onLabel: (label) => group && void input.setLabel(label, group),
    });
    return [pane('L', input.leftCompareGroup), pane('R', input.rightCompareGroup)];
  }
  return [{
    group: input.currentGroup,
    tone: input.currentTone,
    onRate: input.applyRating,
    onFlag: input.applyFlag,
    onLabel: input.applyLabel,
  }];
}
