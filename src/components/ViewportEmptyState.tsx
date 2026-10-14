import React from 'react';
import { Camera } from 'lucide-react';
import type { ViewportEmptyState } from './PreviewViewport';

interface ViewportEmptyStateProps {
  /** Copy + optional action, decided by the shell (shared with all three viewports). */
  emptyState: ViewportEmptyState;
  /**
   * `full` = single/ before-after viewport (full width, icon + title + description + optional CTA).
   * `pane` = one half of the split compare viewport (short copy, no CTA — the pane has no
   * "open the grid" handle).
   */
  variant?: 'full' | 'pane';
}

/**
 * The one empty state all three viewports render, so "nothing selected" reads identically
 * everywhere (M-03). The type itself lives in PreviewViewport and is reused verbatim.
 */
export const ViewportEmptyStateView: React.FC<ViewportEmptyStateProps> = ({
  emptyState,
  variant = 'full',
}) => {
  if (variant === 'pane') {
    // Half width: short, single-line description, no CTA.
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-background-surface-hover text-white/60 p-4 text-center">
        <div className="w-10 h-10 rounded-xl bg-background-surface-hover border border-default flex items-center justify-center mb-3">
          <Camera className="w-5 h-5 text-white stroke-[1.5]" aria-hidden="true" />
        </div>
        <h3 className="text-sm font-medium text-white mb-1">{emptyState.title}</h3>
        <p className="text-[11px] text-white/60 leading-snug">{emptyState.description}</p>
      </div>
    );
  }

  // Full width: identical DOM + class names to the previous inline markup (zero regression).
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-background-base text-white/60 p-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-background-surface-hover border border-default flex items-center justify-center mb-4">
        <Camera className="w-8 h-8 text-white stroke-[1.5]" aria-hidden="true" />
      </div>
      <h3 className="text-base font-medium text-white mb-1">{emptyState.title}</h3>
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
};
