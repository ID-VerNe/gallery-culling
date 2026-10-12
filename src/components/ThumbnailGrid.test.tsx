/**
 * 宫格的缩略图来源选择。
 *
 * 这是全应用里最容易造成"整屏空洞"的地方：LUMEN RAW 渲染可能返回 null、可能直接
 * 抛错，两条路都必须静默回落到相机内嵌缩略图。断言用 invoke 的**命令名**来区分
 * 走了哪条路。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThumbnailGrid } from './ThumbnailGrid';
import { invokeCount, lastInvokeArgs, mockInvokeCommand, mockInvokeError } from '../test/setup';
import type { PhotoGroupInfo } from '../types';

function group(id: string, overrides: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    raw: {
      name: `${id}.CR3`,
      extension: 'CR3',
      path: `D:/shoot/${id}.CR3`,
      size: 1,
      mtime: 0,
    },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    hasXmp: false,
    ...overrides,
  };
}

function renderGrid(groups: PhotoGroupInfo[], lumenThumbnails: boolean) {
  return render(
    <ThumbnailGrid
      groups={groups}
      selectedIndex={0}
      onSelect={() => {}}
      lumenThumbnails={lumenThumbnails}
    />,
  );
}

const cellFor = (name: string) =>
  screen.getByRole('option', { name: new RegExp(name) });

describe('ThumbnailGrid —— 缩略图来源', () => {
  it('lumenThumbnails=false：只调 get_thumbnail_cmd，一次都不碰 lumen_preview_cmd', async () => {
    const groups = [group('a'), group('b'), group('c')];
    mockInvokeCommand('get_thumbnail_cmd', (args) => `thumb-${args?.filePath}`);

    renderGrid(groups, false);

    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(3));
    expect(invokeCount('lumen_preview_cmd')).toBe(0);
  });

  it('lumenThumbnails=false 时按 200px 宽度请求，且 JPG 优先于 RAW', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid(
      [
        group('a', {
          jpg: { name: 'a.jpg', extension: 'jpg', path: 'D:/shoot/a.jpg', size: 1, mtime: 0 },
        }),
      ],
      false,
    );

    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(1));
    expect(lastInvokeArgs('get_thumbnail_cmd')).toMatchObject({
      filePath: 'D:/shoot/a.jpg',
      width: 200,
    });
  });

  it('lumenThumbnails=true 且渲染成功：走 lumen_preview_cmd 并直接用预览 URL', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 200,
      original: null,
      cached: false,
    }));
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');

    renderGrid([group('a')], true);

    const cell = cellFor('a');
    await waitFor(() => {
      const img = within(cell).getByRole('presentation', { hidden: true });
      expect(img).toBeInTheDocument();
    });

    expect(invokeCount('lumen_preview_cmd')).toBe(1);
    // 引擎路径成功了就不该再走 EXIF 内嵌缩略图
    expect(invokeCount('get_thumbnail_cmd')).toBe(0);
    await waitFor(() => {
      const img = cell.querySelector('img');
      expect(img?.getAttribute('src')).toBe('asset://localhost/D:/shoot/a.CR3.preview');
    });
  });

  it('lumenThumbnails=true 且 previewPath=null：静默回落到 get_thumbnail_cmd，不留空洞', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: null, width: 200, original: null, cached: false });
    mockInvokeCommand('get_thumbnail_cmd', 'fallback-thumb.jpg');

    renderGrid([group('a')], true);

    const cell = cellFor('a');
    await waitFor(() => {
      const img = cell.querySelector('img');
      expect(img?.getAttribute('src')).toBe('asset://localhost/fallback-thumb.jpg');
    });

    expect(invokeCount('lumen_preview_cmd')).toBe(1);
    expect(invokeCount('get_thumbnail_cmd')).toBe(1);
    // 引擎抖动不该在格子里留"加载中"
    expect(within(cell).queryByText('加载中')).toBeNull();
  });

  it('lumenThumbnails=true 且 invoke 抛错：同样回落，不产生空洞', async () => {
    mockInvokeError('lumen_preview_cmd', new Error('sidecar crashed'));
    mockInvokeCommand('get_thumbnail_cmd', 'fallback-thumb.jpg');

    renderGrid([group('a')], true);

    const cell = cellFor('a');
    await waitFor(() => {
      const img = cell.querySelector('img');
      expect(img?.getAttribute('src')).toBe('asset://localhost/fallback-thumb.jpg');
    });

    expect(invokeCount('get_thumbnail_cmd')).toBe(1);
    expect(within(cell).queryByText('加载中')).toBeNull();
  });

  it('回落时用 jpg||raw 的 targetPath 取内嵌缩略图', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: null, width: 200, original: null, cached: false });
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');

    renderGrid(
      [
        group('a', {
          jpg: { name: 'a.jpg', extension: 'jpg', path: 'D:/shoot/a.jpg', size: 1, mtime: 0 },
        }),
      ],
      true,
    );

    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(1));
    expect(lastInvokeArgs('get_thumbnail_cmd')).toMatchObject({ filePath: 'D:/shoot/a.jpg' });
  });

  it('lumenThumbnails=true 但该组没有 RAW 时，不发 lumen 请求', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: 'p.jpg', width: 200, original: null, cached: false });
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');

    renderGrid(
      [
        group('a', {
          raw: undefined,
          status: 'JPG_ONLY',
          jpg: { name: 'a.jpg', extension: 'jpg', path: 'D:/shoot/a.jpg', size: 1, mtime: 0 },
        }),
      ],
      true,
    );

    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(1));
    expect(invokeCount('lumen_preview_cmd')).toBe(0);
  });

  it('一批照片里只有部分有 RAW：只对有 RAW 的组发 lumen 请求', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: 'p.jpg', width: 200, original: null, cached: false });
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');

    renderGrid(
      [
        group('raw-one'),
        group('jpg-one', {
          raw: undefined,
          status: 'JPG_ONLY',
          jpg: { name: 'jpg-one.jpg', extension: 'jpg', path: 'D:/shoot/jpg-one.jpg', size: 1, mtime: 0 },
        }),
        group('raw-two'),
      ],
      true,
    );

    await waitFor(() => expect(invokeCount('lumen_preview_cmd')).toBe(2));
    expect(invokeCount('get_thumbnail_cmd')).toBe(1); // 只有 jpg-one
  });

  it('三种结果混合时每格都有图（没有一格停在"加载中"）', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) =>
      String(args?.filePath).includes('null') || String(args?.filePath).includes('raw-b')
        ? { previewPath: null, width: 200, original: null, cached: false }
        : { previewPath: `${String(args?.filePath)}.preview`, width: 200, original: null, cached: false },
    );
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');

    renderGrid([group('raw-a'), group('raw-b'), group('raw-c')], true);

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
          hasXmp: true,
          tone: { exposure: 1, highlights: 0, shadows: 0, temperature: 0, tint: 0, contrast: 0 },
        }),
      ],
      false,
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
    renderGrid([group('a'), group('b')], false);

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const list = screen.getByRole('listbox');
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id);
  });

  it('空列表显示空态而不是空白', () => {
    renderGrid([], false);
    expect(screen.getByText('当前筛选下没有照片')).toBeInTheDocument();
  });

  it('L-06：每个 option 带 aria-setsize / aria-posinset（虚拟化列表也能报出总数与位置）', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    renderGrid([group('a'), group('b'), group('c')], false);

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
