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
import { makeGroup } from '../test/factories';
import type { FilterMode } from '../types';

const GROUPS = [
  makeGroup('a', { rating: 3, flag: 'pick', jpg: undefined }),
  makeGroup('b', { flag: 'reject', jpg: undefined }),
  makeGroup('c', { jpg: undefined }),
  makeGroup('d', { rating: 5, jpg: undefined }),
];

function renderTopBar(
  filterCounts?: Record<FilterMode, number>,
  folderDetection?: import('../types').FolderProbe | null,
) {
  return render(
    <TopBar
      jpgFolder="D:/shoot/JPG"
      tonalPanelVisible={false}
      rawFolder=""
      onJpgFolderChange={vi.fn()}
      onRawFolderChange={vi.fn()}
      onBrowseJpg={vi.fn()}
      onBrowseRaw={vi.fn()}
      onBrowseAuto={vi.fn()}
      folderDetection={folderDetection}
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

describe('TopBar —— #66 单目录自动识别标记', () => {
  it('混合目录把 JPG / RAW 两侧计数画在顶栏', () => {
    renderTopBar(undefined, {
      mode: 'mixed',
      jpgCount: 12,
      rawCount: 4,
      subdirCount: 0,
    });

    expect(screen.getByTestId('topbar-folder-detection')).toHaveTextContent(
      '已识别 JPG + RAW 混合 · JPG 12 / RAW 4',
    );
  });

  it('空目录文案说明「路径未改动」而不是假装识别成功', () => {
    renderTopBar(undefined, {
      mode: 'empty',
      jpgCount: 0,
      rawCount: 0,
      subdirCount: 3,
    });

    expect(screen.getByTestId('topbar-folder-detection')).toHaveTextContent(
      '已识别 所选文件夹为空（路径未改动）',
    );
  });

  it('没有识别结果时不渲染标记（手动填路径不应挂着自动识别的牌子）', () => {
    renderTopBar(undefined, null);
    expect(screen.queryByTestId('topbar-folder-detection')).toBeNull();
  });
});

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
