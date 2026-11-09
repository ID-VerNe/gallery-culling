/**
 * 视口空状态纯 selector 单测（issue #112，源自 AppShell 的
 * `viewportEmptyState` 内联派生；文案语义不变）。
 *
 * 「未加载照片」与「筛选匹配为空」是两个不同问题，不得共用一条文案。
 */
import { describe, it, expect, vi } from 'vitest';
import { selectViewportEmptyState } from './viewportEmptyState';

describe('selectViewportEmptyState', () => {
  it('没加载任何照片 → 未加载分支（JPG/RAW/混合都支持；动作打开照片文件夹）', () => {
    const onBrowseAuto = vi.fn();
    const onShowAll = vi.fn();
    const s = selectViewportEmptyState({ totalCount: 0, filteredCount: 0, onBrowseAuto, onShowAll });
    expect(s.title).toBe('未加载照片');
    expect(s.description).toContain('只有 JPG、只有 RAW、或两者混合都支持');
    expect(s.actionLabel).toBe('打开照片文件夹');
    expect(s.onAction).toBe(onBrowseAuto);
  });

  it('加载了照片但筛选为空 → 筛空分支（动作显示全部照片）', () => {
    const onBrowseAuto = vi.fn();
    const onShowAll = vi.fn();
    const s = selectViewportEmptyState({ totalCount: 10, filteredCount: 0, onBrowseAuto, onShowAll });
    expect(s.title).toBe('当前筛选下没有照片');
    expect(s.actionLabel).toBe('显示全部照片');
    expect(s.onAction).toBe(onShowAll);
  });

  it('有可见照片 → 未选择分支（无动作）', () => {
    const s = selectViewportEmptyState({
      totalCount: 10,
      filteredCount: 10,
      onBrowseAuto: vi.fn(),
      onShowAll: vi.fn(),
    });
    expect(s.title).toBe('未选择照片');
    expect(s.actionLabel).toBeUndefined();
    expect(s.onAction).toBeUndefined();
  });
});
