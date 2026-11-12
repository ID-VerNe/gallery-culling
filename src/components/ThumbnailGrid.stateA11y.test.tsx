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
import { makeGroup, rawFile } from '../test/factories';
import type { PhotoGroupInfo } from '../types';

const group = (id: string, over: Partial<PhotoGroupInfo> = {}) =>
  makeGroup(id, { status: 'RAW_ONLY', raw: rawFile(id, 'CR3', 'D:/s'), jpg: undefined, ...over });

const GROUPS = ['a', 'b', 'c'].map((id) => group(id));

function renderGrid(over: Record<string, unknown> = {}) {
  mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
  return render(
    <ThumbnailGrid
      groups={GROUPS}
      selectedIndex={0}
      onSelect={() => {}}
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

/**
 * issue #79：宫格多选不能只靠「左手修饰键 + 右手鼠标」。
 *
 * 格头必须有常驻的全选/清除入口，且入口对读屏可读：可读名称 + 全选态的
 * `aria-pressed` + `aria-keyshortcuts`，不能只挂 `title`。
 */
describe('issue #79：格头全选 / 清除入口', () => {
  it('启用多选时两个按钮都有可读名称，全选带 aria-pressed 与快捷键', () => {
    renderGrid({ selectedIds: new Set(['a']), onSelectionChange: () => {} });

    const selectAll = screen.getByRole('button', { name: '全选宫格照片' });
    expect(selectAll.getAttribute('aria-pressed')).toBe('false');
    expect(selectAll.getAttribute('aria-keyshortcuts')).toBe('Control+A');
    expect(screen.getByRole('button', { name: '清除宫格多选' })).toBeTruthy();
  });

  it('全选后 aria-pressed=true，再点全选仍提交全集', async () => {
    const onSelectionChange = vi.fn();
    renderGrid({
      selectedIds: new Set(['a', 'b', 'c']),
      onSelectionChange,
    });

    const selectAll = screen.getByRole('button', { name: '全选宫格照片' });
    expect(selectAll.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(selectAll);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(['a', 'b', 'c']));
  });

  it('无选区时清除按钮禁用，有选区时点击写空集', async () => {
    const onSelectionChange = vi.fn();
    const { unmount } = renderGrid({ selectedIds: new Set<string>(), onSelectionChange });
    expect(
      screen.getByRole('button', { name: '清除宫格多选' }).hasAttribute('disabled'),
    ).toBe(true);
    unmount();

    renderGrid({ selectedIds: new Set(['b']), onSelectionChange });
    await userEvent.click(screen.getByRole('button', { name: '清除宫格多选' }));
    expect(onSelectionChange).toHaveBeenCalledWith(new Set());
  });

  it('未启用多选时不渲染全选/清除入口（不留死按钮）', () => {
    renderGrid();
    expect(screen.queryByRole('button', { name: '全选宫格照片' })).toBeNull();
    expect(screen.queryByRole('button', { name: '清除宫格多选' })).toBeNull();
  });

  it('空集合时不渲染全选入口（没有可选对象）', () => {
    renderGrid({ groups: [], selectedIds: new Set<string>(), onSelectionChange: () => {} });
    expect(screen.queryByRole('button', { name: '全选宫格照片' })).toBeNull();
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
 * 相机参数按**配对 JPG 优先**读取（0.14 ms/张，比 RAW 快 80 倍），所以正常
 * 选片集里 `iso:` 是能用的。只有缺配对 JPG 又读不出主路径的那几张没有参数 ——
 * 界面必须说出**缺几张**，否则 `iso:800` 安静漏掉它们，用户会以为自己没拍过。
 */
describe('FR-10：EXIF 条件在有照片缺相机参数时要说明原因', () => {
  const isoQuery = 'iso:800';

  it('查询用到 EXIF 而集合里有人缺相机参数时说出缺几张', () => {
    renderGrid({
      searchOpen: true,
      searchQuery: isoQuery,
      queryParse: parseQuery(isoQuery),
      queryExifMissing: 2,
    });
    expect(screen.getByText(/2 张没有相机参数/)).toBeTruthy();
  });

  it('缺参数为 0 时不误报（普通文件名搜索照常显示匹配数）', () => {
    const nameQuery = 'DSC0';
    renderGrid({
      searchOpen: true,
      searchQuery: nameQuery,
      queryParse: parseQuery(nameQuery),
      queryExifMissing: 0,
    });
    expect(screen.queryByText(/没有相机参数/)).toBeNull();
    expect(screen.getByText(/个条件 · 匹配 3 张/)).toBeTruthy();
  });
});
