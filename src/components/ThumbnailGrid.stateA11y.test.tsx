/**
 * 宫格状态可见性与 a11y 契约（G-01 / G-02 / G-03 / G-07 / G-12）。
 *
 * 这一组都是「状态存在但用户看不见/听不到」：
 *   - 选区规模从不渲染，多选时用户无法知道批量操作会作用到几张
 *   - 加载中/失败态的 aria 处理不一致
 *   - 空状态转换不播报，且筛选空状态没有出口（死胡同）
 *   - 图例逐格重复播报
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThumbnailGrid } from './ThumbnailGrid';
import { mockInvokeCommand } from '../test/setup';
import { parseQuery } from '../utils/queryMatch';
import type { PhotoGroupInfo } from '../types';

function group(id: string, over: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    raw: { name: `${id}.CR3`, extension: 'CR3', path: `D:/s/${id}.CR3`, size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
    ...over,
  } as PhotoGroupInfo;
}

const GROUPS = ['a', 'b', 'c'].map((id) => group(id));

function renderGrid(over: Record<string, unknown> = {}) {
  mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
  return render(
    <ThumbnailGrid
      groups={GROUPS}
      selectedIndex={0}
      onSelect={() => {}}
      lumenThumbnails={false}
      {...(over as object)}
    />,
  );
}

describe('G-02：多选规模必须可见', () => {
  it('启用多选且选区非空时显示「已选 N」', () => {
    renderGrid({ selectedIds: new Set(['a', 'b']), onSelectionChange: () => {} });
    expect(screen.getByText(/已选 2/)).toBeTruthy();
  });

  it('未启用多选时不显示选区计数', () => {
    renderGrid({ selectedIds: new Set(['a', 'b']) });
    expect(screen.queryByText(/已选/)).toBeNull();
  });

  it('启用多选但选区为空时不显示「已选 0」', () => {
    renderGrid({ selectedIds: new Set<string>(), onSelectionChange: () => {} });
    expect(screen.queryByText(/已选/)).toBeNull();
  });
});

describe('G-07：空状态必须被播报', () => {
  it('空宫格根节点带 role=status + aria-live', () => {
    renderGrid({ groups: [] });
    const status = screen.getAllByRole('status').find((el) =>
      /没有匹配的照片|当前筛选下没有照片/.test(el.textContent ?? ''),
    );
    expect(status).toBeTruthy();
  });
});

describe('G-03：筛选空状态不是死胡同', () => {
  it('非搜索的空状态提供「重置筛选」按钮', async () => {
    const onFilterReset = vi.fn();
    renderGrid({ groups: [], onFilterReset });
    const btn = screen.getByRole('button', { name: '重置筛选' });
    await userEvent.click(btn);
    expect(onFilterReset).toHaveBeenCalledTimes(1);
  });

  it('搜索态空状态仍是「清空搜索」，两者不混用', () => {
    renderGrid({ groups: [], searchQuery: 'zzz', onSearchQueryChange: vi.fn() });
    expect(screen.getByRole('button', { name: '清空搜索' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重置筛选' })).toBeNull();
  });

  it('宿主未提供 onFilterReset 时不渲染死按钮', () => {
    renderGrid({ groups: [] });
    expect(screen.queryByRole('button', { name: '重置筛选' })).toBeNull();
  });
});

describe('G-12：图例作为一个整体播报', () => {
  it('图例容器带 aria-label，而不是让 SR 逐个 span 念', () => {
    renderGrid();
    const legend = screen.getByRole('note', { name: /角标图例/ });
    expect(within(legend).getAllByText(/RAW|XMP/).length).toBeGreaterThan(0);
  });
});

/**
 * 选片集视图不读 EXIF（打开速度的代价，见 ADR-010）。代价必须由界面说出来：
 * `iso:800` 安静返回 0 张时，用户会以为自己没拍过，而不是「这批没读 EXIF」。
 */
describe('FR-10：EXIF 条件在无相机参数的集合里要说明原因', () => {
  const isoQuery = 'iso:800';

  it('查询用到 EXIF 且集合没有相机参数时给出提示', () => {
    renderGrid({
      searchOpen: true,
      searchQuery: isoQuery,
      queryParse: parseQuery(isoQuery),
      queryExifUnavailable: true,
    });
    expect(screen.getByText(/相机参数未加载/)).toBeTruthy();
  });

  it('查询不涉及 EXIF 字段时不误报（普通文件名搜索照常显示匹配数）', () => {
    const nameQuery = 'DSC0';
    renderGrid({
      searchOpen: true,
      searchQuery: nameQuery,
      queryParse: parseQuery(nameQuery),
      queryExifUnavailable: false,
    });
    expect(screen.queryByText(/相机参数未加载/)).toBeNull();
    expect(screen.getByText(/个条件 · 匹配 3 张/)).toBeTruthy();
  });
});
