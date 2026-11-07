/**
 * issue #32 / SH-13：导出键位必须有持久提示。
 *
 * 此前 `Ctrl+E` 只写在帮助弹窗里，工具栏导出按钮的 `title` 是纯文案，
 * 鼠标用户无从得知；`aria-keyshortcuts` 让读屏在聚焦时直接播报。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolbarRow } from './ToolbarRow';

function renderToolbar() {
  render(
    <ToolbarRow
      filterMode="all"
      onFilterChange={vi.fn()}
      sortOrder="time_filename"
      onSortChange={vi.fn()}
      viewMode="single"
      onViewModeChange={vi.fn()}
      onOpenExportModal={vi.fn()}
      tonalPanelVisible={false}
    />,
  );
}

describe('issue #32 / SH-13 —— 导出按钮的键位可达性', () => {
  it('导出按钮同时给出 aria-keyshortcuts 与 title 键位', () => {
    renderToolbar();

    const button = screen.getByRole('button', { name: '批量挑选导出照片' });
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+E');
    expect(button.getAttribute('title')).toContain('Ctrl+E');
  });
});
