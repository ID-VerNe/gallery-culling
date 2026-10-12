/**
 * 顶部筛选下拉的「每档数量」（M-14）。
 *
 * 两条契约：传了 `filterCounts` 时计数必须挂在对应档位上；**没传时优雅降级**
 * （只显示文案、不显示 `(0)`、不崩溃）—— 这让 TopBar 能在宿主尚未接线时
 * 独立编译与测试。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopBar } from './TopBar';
import { countByFilter } from '../utils/filterMatch';
import type { CullFlag, FilterMode, PhotoGroupInfo } from '../types';

const GROUPS: PhotoGroupInfo[] = [
  { id: 'a', baseName: 'a', status: 'JPG_ONLY', rating: 3, flag: 'pick', hasXmp: false },
  { id: 'b', baseName: 'b', status: 'JPG_ONLY', rating: 0, flag: 'reject', hasXmp: false },
  { id: 'c', baseName: 'c', status: 'JPG_ONLY', rating: 0, flag: 'none' as CullFlag, hasXmp: false },
  { id: 'd', baseName: 'd', status: 'JPG_ONLY', rating: 5, flag: 'none' as CullFlag, hasXmp: false },
];

function renderTopBar(filterCounts?: Record<FilterMode, number>) {
  return render(
    <TopBar
      jpgFolder="D:/shoot/JPG"
      rawFolder=""
      onJpgFolderChange={vi.fn()}
      onRawFolderChange={vi.fn()}
      onBrowseJpg={vi.fn()}
      onBrowseRaw={vi.fn()}
      onScan={vi.fn()}
      isLoading={false}
      filterMode="all"
      onFilterChange={vi.fn()}
      filterCounts={filterCounts}
      sortOrder="time_filename"
      onSortChange={vi.fn()}
      viewMode="single"
      onViewModeChange={vi.fn()}
      onOpenExportModal={vi.fn()}
      onOpenSettingsModal={vi.fn()}
    />,
  );
}

const filterOptionTexts = () => {
  const select = screen.getByLabelText('照片筛选过滤') as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.textContent ?? '');
};

describe('TopBar —— 筛选每档数量', () => {
  it('传入 filterCounts 时每档都带 (N)，且与 countByFilter 一致', () => {
    renderTopBar(countByFilter(GROUPS));

    const texts = filterOptionTexts();
    expect(texts).toContain('全部照片 (4)');
    expect(texts).toContain('仅已保留 (Pick) (1)');
    expect(texts).toContain('已淘汰 (Reject) (1)');
    expect(texts).toContain('未标记 (1)');
    expect(texts).toContain('★3 星以上 (2)');
    expect(texts).toContain('★5 星精选 (1)');
  });

  it('计数为 0 也如实显示（空档提示用户别白跑一趟）', () => {
    // 没有任何「未标记」照片
    const groups = GROUPS.filter((g) => !(g.flag === 'none' && g.rating === 0));
    renderTopBar(countByFilter(groups));
    expect(filterOptionTexts()).toContain('未标记 (0)');
  });

  it('未传 filterCounts 时优雅降级：只显示档位文案，无 (N)', () => {
    renderTopBar(undefined);
    const texts = filterOptionTexts();
    expect(texts).toContain('全部照片');
    expect(texts).toContain('★5 星精选');
    // 关键：不能出现 `(0)` 这种「假信息」占位
    expect(texts.some((t) => /\(\d+\)/.test(t))).toBe(false);
  });

  it('筛选下拉始终可访问（有可读的 aria-label）', () => {
    renderTopBar(undefined);
    expect(screen.getByLabelText('照片筛选过滤')).toBeInTheDocument();
  });
});
