/**
 * 宫格的缩略图来源。
 *
 * issue #192 起宫格**恒走相机内嵌缩略图**（`get_thumbnail_cmd`）：LUMEN 真实解码
 * 1.2s/张且引擎侧单实例互斥，宫格只能一张一张排队。这里用 invoke 的**命令名**
 * 锁住「一次都不碰 lumen_preview_cmd」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GRID_THUMB_WIDTH, resetThumbnailLoaderForTest, ThumbnailGrid } from './ThumbnailGrid';
import { invokeCount, lastInvokeArgs, mockInvokeCommand } from '../test/setup';
import { makeGroup, rawFile } from '../test/factories';
import type { PhotoGroupInfo } from '../types';

const group = (id: string, overrides: Partial<PhotoGroupInfo> = {}) =>
  makeGroup(id, { status: 'RAW_ONLY', raw: rawFile(id, 'CR3', 'D:/shoot'), jpg: undefined, ...overrides });

function renderGrid(groups: PhotoGroupInfo[]) {
  return render(<ThumbnailGrid groups={groups} selectedIndex={0} onSelect={() => {}} />);
}

const cellFor = (name: string) =>
  screen.getByRole('option', { name: new RegExp(name) });

// issue #107：loader 提到模块级后跨用例存活 — 每个用例从空缓存起测，
// 否则共用路径（D:/shoot/a.*）会在测试间串扰计数。
beforeEach(() => {
  resetThumbnailLoaderForTest();
});

describe('ThumbnailGrid —— 缩略图来源（issue #192：恒走内嵌图）', () => {
  it('只调 get_thumbnail_cmd，一次都不碰 lumen_preview_cmd', async () => {
    const groups = [group('a'), group('b'), group('c')];
    mockInvokeCommand('get_thumbnail_cmd', (args) => `thumb-${args?.filePath}`);
    // 即使引擎「可用」（IPC 会成功），宫格也不得走真实解码：任一格调用即红。
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 200,
      original: null,
      cached: false,
    }));

    renderGrid(groups);

    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(3));
    expect(invokeCount('lumen_preview_cmd')).toBe(0);
  });

  it('按 200px 宽度请求，且 JPG 优先于 RAW', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid([
      group('a', {
        jpg: { name: 'a.jpg', extension: 'jpg', path: 'D:/shoot/a.jpg', size: 1, mtime: 0 },
      }),
    ]);

    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(1));
    expect(lastInvokeArgs('get_thumbnail_cmd')).toMatchObject({
      filePath: 'D:/shoot/a.jpg',
      width: 200,
    });
  });

  it('无配对 JPG 的 RAW_ONLY 组用 raw 路径取内嵌缩略图', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid([group('raw-only')]);

    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(1));
    expect(lastInvokeArgs('get_thumbnail_cmd')).toMatchObject({
      filePath: 'D:/shoot/raw-only.CR3',
    });
  });

  it('多格混合时每格都有图（没有一格停在「加载中」）', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid([group('raw-a'), group('raw-b'), group('raw-c')]);

    for (const id of ['raw-a', 'raw-b', 'raw-c']) {
      const cell = cellFor(id);
      await waitFor(() => {
        expect(cell.querySelector('img')).not.toBeNull();
      });
      expect(within(cell).queryByText('加载中')).toBeNull();
    }
  });
});

describe('ThumbnailGrid —— 无障碍与选择', () => {
  it('每格的 aria-label 把徽标信息说全', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid(
      [
        group('a', {
          rating: 3,
          flag: 'pick',
          label: '', hasXmp: true,
          tone: { exposure: 1, highlights: 0, shadows: 0, temperature: 0, tint: 0, contrast: 0 },
        }),
      ],
    );

    await waitFor(() => expect(screen.getByRole('option')).toBeInTheDocument());
    const label = screen.getByRole('option').getAttribute('aria-label') ?? '';
    expect(label).toContain('第 1 / 1 张');
    expect(label).toContain('a');
    expect(label).toContain('3 星');
    expect(label).toContain('已保留');
    expect(label).toContain('含 RAW');
    expect(label).toContain('含 XMP');
    expect(label).toContain('已调色');
  });

  it('listbox 的 aria-activedescendant 指向选中项', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid([group('a'), group('b')]);

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const list = screen.getByRole('listbox');
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);
  });

  it('空列表显示空态而不是空白', () => {
    renderGrid([]);
    expect(screen.getByText('当前筛选下没有照片')).toBeInTheDocument();
  });

  it('L-06：每个 option 带 aria-setsize / aria-posinset（虚拟化列表也能报出总数与位置）', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid([group('a'), group('b'), group('c')]);

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    const cells = screen.getAllByRole('option');
    cells.forEach((cell, i) => {
      expect(cell).toHaveAttribute('aria-setsize', '3');
      expect(cell).toHaveAttribute('aria-posinset', String(i + 1));
    });
  });

  it('L-07：单元格不可聚焦，点击不抢容器焦点，且选中回调照常', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    const onSelect = vi.fn();
    render(
      <ThumbnailGrid
        groups={[group('a'), group('b')]}
        selectedIndex={0}
        onSelect={onSelect}
      />,
    );

    const list = await screen.findByRole('listbox');
    const cells = screen.getAllByRole('option');

    // 焦点主始终是 listbox 容器
    list.focus();
    expect(document.activeElement).toBe(list);

    // mousedown 上 preventDefault 生效（fireEvent 返回 false = 已取消默认动作）
    expect(fireEvent.mouseDown(cells[1])).toBe(false);

    // 单元格自身不再可聚焦（有 tabIndex={-1} 时这行会失败）
    cells[1].focus();
    expect(document.activeElement).not.toBe(cells[1]);
    expect(cells[1].hasAttribute('tabindex')).toBe(false);

    // 点击仍触发选中
    fireEvent.click(cells[1]);
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});

describe('ThumbnailGrid —— 色标色点（FR-02）', () => {
  it('有色标的格子渲染色点，并把色名写进无障碍标签', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid([group('a', { label: 'Red' })]);

    const cell = await screen.findByRole('option', { name: /色标红/ });
    const dot = within(cell).getByRole('img', { name: '色标：红' });
    expect(dot.className).toContain('bg-rose-500');
  });

  it('无色标的格子不渲染色点', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid([group('b', { label: '' })]);

    const cell = await screen.findByRole('option', { name: /b/ });
    expect(within(cell).queryByRole('img', { name: /^色标：/ })).toBeNull();
  });

  it('色点与旗标角标并存（红标 + 淘汰是两个维度）', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid([group('c', { label: 'Red', flag: 'reject' })]);

    const cell = await screen.findByRole('option', { name: /已淘汰/ });
    expect(within(cell).getByRole('img', { name: '已标记淘汰' })).toBeTruthy();
    expect(within(cell).getByRole('img', { name: '色标：红' })).toBeTruthy();
  });
});

describe('ThumbnailGrid —— 宫格宽度独立值（issue #133 墓碑）', () => {
  it('宫格缩略图宽度是独立产品值，恒为 200（不跟随设置）', () => {
    expect(GRID_THUMB_WIDTH).toBe(200);
  });
});
