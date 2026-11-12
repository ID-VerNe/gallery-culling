/**
 * UX-02：宫格 listbox 必须向 AT 声明多选能力。
 *
 * `multiSelectEnabled` 由宿主是否提供 onSelectionChange 决定。SR 默认按单选
 * 播报，不带 aria-multiselectable 时用户完全不知道 Ctrl/Shift 点选与 Ctrl+A
 * 可用 —— 万张宫格的多选模型对 AT 用户隐形。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThumbnailGrid } from './ThumbnailGrid';
import { mockInvokeCommand } from '../test/setup';
import { makeGroup, rawFile } from '../test/factories';

const group = (id: string) =>
  makeGroup(id, { status: 'RAW_ONLY', raw: rawFile(id, 'CR3', 'D:/s'), jpg: undefined });

const GROUPS = ['a', 'b', 'c'].map(group);

function renderGrid(enabled: boolean) {
  mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
  return render(
    <ThumbnailGrid
      groups={GROUPS}
      selectedIndex={0}
      onSelect={() => {}}
      selectedIds={enabled ? new Set(['a']) : undefined}
      onSelectionChange={enabled ? () => {} : undefined}
    />,
  );
}

const listbox = () => screen.getByRole('listbox');

describe('UX-02 —— aria-multiselectable', () => {
  it('宿主启用多选时声明 aria-multiselectable="true"', () => {
    renderGrid(true);
    expect(listbox().getAttribute('aria-multiselectable')).toBe('true');
  });

  it('宿主未启用多选时不得声明为 true（单选语义要诚实）', () => {
    renderGrid(false);
    expect(listbox().getAttribute('aria-multiselectable')).not.toBe('true');
  });
});
