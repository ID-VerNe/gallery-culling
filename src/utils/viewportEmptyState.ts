/**
 * 视口空状态纯 selector（issue #112，源自 AppShell 的 `viewportEmptyState`
 * 内联派生；文案与动作语义不变）。
 *
 * 「未加载照片」与「筛选匹配为空」是两个不同问题，不得共用一条文案。
 */
import type { ViewportEmptyState } from '../components/PreviewViewport';

export interface SelectViewportEmptyStateInput {
  totalCount: number;
  filteredCount: number;
  onBrowseAuto: () => void;
  onShowAll: () => void;
}

export function selectViewportEmptyState(
  input: SelectViewportEmptyStateInput,
): ViewportEmptyState {
  if (input.totalCount === 0) {
    return {
      title: '未加载照片',
      // A5/A7 + #66：默认路径是「选一个文件夹」，JPG / RAW / 混合都支持；
      // 只有确实想分目录存放时才需要动第二个输入框。
      description:
        '选择一个包含照片的文件夹即可（只有 JPG、只有 RAW、或两者混合都支持）；如果 RAW 单独放在另一个目录，再手动指定 RAW 路径。',
      actionLabel: '打开照片文件夹',
      onAction: input.onBrowseAuto,
    };
  }
  if (input.filteredCount === 0) {
    return {
      title: '当前筛选下没有照片',
      description:
        '还没有照片匹配这个筛选条件。先给照片打星或标记保留，或者切换到「全部照片」。',
      actionLabel: '显示全部照片',
      onAction: input.onShowAll,
    };
  }
  return {
    title: '未选择照片',
    description: '从右侧宫格列表中选择一张照片。',
  };
}
