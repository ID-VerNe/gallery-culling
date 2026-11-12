/**
 * B6：缩略图字号提底 + 格头间距 + 分段圆角同心 + 按下反馈（issue #18 · PA-3 + PA-9 + PB-3 + PC-7）。
 *
 * PC-7：序号 / 未同步 / 基准 / 候选 / 图例从 8-9px 提到 10px；R/X/T/E 角标保留 9px
 *       但补 tracking-[0.02em] 收紧字距。
 * PA-3：格头标题↔控件组 gap-3、控件组 gap-1.5、已选 ml-1 + 降一档色（text-white/50）。
 * PA-9：分段控件外壳 rounded-md（配内块 4px 同心，外壳 6px = 内块 4px + padding 2px）。
 * PB-3：onPointerDown 即时加 pressed 态（scale-[0.985]），不等 onClick 落定。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ThumbnailGrid } from './ThumbnailGrid';
import { mockInvokeCommand } from '../test/setup';
import { makeGroup, rawFile } from '../test/factories';
import type { PhotoGroupInfo } from '../types';

const group = (id: string, overrides: Partial<PhotoGroupInfo> = {}) =>
  makeGroup(id, { status: 'RAW_ONLY', raw: rawFile(id, 'CR3', 'D:/shoot'), jpg: undefined, ...overrides });

/** 取第一格（选中态）。waitFor 等 virtualizer 把行挂出来。 */
async function firstCell(): Promise<HTMLElement> {
  const cells = await screen.findAllByRole('option');
  return cells[0];
}

function renderGrid(props: Partial<React.ComponentProps<typeof ThumbnailGrid>> = {}) {
  mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
  return render(
    <ThumbnailGrid
      groups={[group('a'), group('b'), group('c')]}
      selectedIndex={0}
      onSelect={() => {}}
      {...props}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('B6 · PC-7：缩略图字号提底', () => {
  it('序号 #{index+1} 用 text-[10px] 而非 text-[9px]', async () => {
    renderGrid();
    const cell = await firstCell();
    const indexBadge = within(cell).getByText('#1');
    expect(indexBadge.className).toContain('text-[10px]');
    expect(indexBadge.className).not.toContain('text-[9px]');
  });

  it('「未同步」按钮用 text-[10px] 而非 text-[8px]', async () => {
    renderGrid({
      unsyncedIds: new Set(['a']),
      onRetrySync: () => {},
    });
    const cell = await firstCell();
    const btn = within(cell).getByRole('button', { name: /未同步/ });
    expect(btn.className).toContain('text-[10px]');
    expect(btn.className).not.toContain('text-[8px]');
  });

  it('「基准」徽标用 text-[10px] 而非 text-[9px]', async () => {
    renderGrid({ pinnedId: 'a' });
    const cell = await firstCell();
    const badge = within(cell).getByText('基准').parentElement!;
    expect(badge.className).toContain('text-[10px]');
    expect(badge.className).not.toContain('text-[9px]');
  });

  it('「候选」徽标用 text-[10px] 而非 text-[9px]', async () => {
    renderGrid({ candidateId: 'a' });
    const cell = await firstCell();
    const badge = within(cell).getByText('候选').parentElement!;
    expect(badge.className).toContain('text-[10px]');
    expect(badge.className).not.toContain('text-[9px]');
  });

  it('R/X/T/E 角标保留 text-[9px] 但补 tracking-[0.02em]', async () => {
    renderGrid({
      groups: [
        group('a', {
          hasXmp: true,
          tone: { exposure: 1, highlights: 0, shadows: 0, temperature: 0, tint: 0, contrast: 0 },
          edited: { name: 'a.tif', extension: 'tif', path: 'D:/shoot/a.tif', size: 1, mtime: 0 },
        }),
      ],
    });
    const cell = await firstCell();
    for (const letter of ['R', 'X', 'T', 'E']) {
      const badge = within(cell).getByText(letter);
      expect(badge.className).toContain('text-[9px]');
      expect(badge.className).toContain('tracking-[0.02em]');
    }
  });

  it('角标图例用 text-[10px] 而非 text-[9px]', () => {
    renderGrid();
    const legend = screen.getByRole('note', { name: /角标图例/ });
    expect(legend.className).toContain('text-[10px]');
    expect(legend.className).not.toContain('text-[9px]');
  });
});

describe('B6 · PA-3：格头间距服从邻近原则', () => {
  function renderWithSelection() {
    return renderGrid({
      selectedIds: new Set(['a']),
      onSelectionChange: () => {},
    });
  }

  it('格头容器标题↔控件组用 gap-3（不是 gap-2）', () => {
    renderWithSelection();
    const status = screen.getByText(/宫格列表/);
    const header = status.parentElement!;
    expect(header.className).toContain('gap-3');
    expect(header.className).not.toContain('gap-2');
  });

  it('控件组用 gap-1.5（不是 gap-1）', () => {
    renderWithSelection();
    const status = screen.getByText(/宫格列表/);
    const header = status.parentElement!;
    const controls = header.children[1] as HTMLElement;
    expect(controls.className).toContain('gap-1.5');
  });

  it('已选计数用 ml-1（不是 ml-1.5）', () => {
    renderWithSelection();
    const selected = screen.getByText(/已选 1/);
    expect(selected.className).toContain('ml-1');
    expect(selected.className).not.toContain('ml-1.5');
  });

  it('已选计数降一档色（text-white/50，不是 text-white/60）', () => {
    renderWithSelection();
    const selected = screen.getByText(/已选 1/);
    expect(selected.className).toContain('text-white/50');
    expect(selected.className).not.toContain('text-white/60');
  });
});

describe('B6 · PA-9：分段控件圆角同心', () => {
  it('外壳用 rounded-md（不是 rounded-lg）', () => {
    renderGrid();
    const btn = screen.getByRole('button', { name: '切换为一行 3 张缩略图' });
    const shell = btn.parentElement!;
    expect(shell.className).toContain('rounded-md');
    expect(shell.className).not.toContain('rounded-lg');
  });
});

describe('B6 · PB-3：按下即时反馈', () => {
  it('单元格 onPointerDown 按下时加 pressed 态（scale-[0.985]）', async () => {
    renderGrid();
    const cell = await firstCell();
    expect(cell.className).not.toContain('scale-[0.985]');
    fireEvent.pointerDown(cell);
    expect(cell.className).toContain('scale-[0.985]');
  });
});

describe('issue #105 墓碑：格头单行不折行（flex 收缩竖排回归）', () => {
  function renderHeader() {
    return renderGrid({
      selectedIds: new Set(['a']),
      onSelectionChange: () => {},
      onSearchOpenChange: () => {},
      searchOpen: false,
    });
  }

  it('格头容器带 min-w-0（给 flex 链收缩位，与底部工具条 :903 范式一致）', () => {
    renderHeader();
    const status = screen.getByText(/宫格列表/);
    const header = status.parentElement!;
    expect(header.className).toContain('min-w-0');
  });

  it('状态侧带 min-w-0 truncate 而非 whitespace-nowrap（超长省略不撑爆控件）', () => {
    renderHeader();
    const status = screen.getByText(/宫格列表/);
    expect(status.className).toContain('min-w-0');
    expect(status.className).toContain('truncate');
    expect(status.className).not.toContain('whitespace-nowrap');
  });

  it('右侧控件组带 shrink-0（按钮组整体不可收缩）', () => {
    renderHeader();
    const status = screen.getByText(/宫格列表/);
    const header = status.parentElement!;
    const controls = header.children[1] as HTMLElement;
    expect(controls.className).toContain('shrink-0');
  });

  it('5 个按钮按钮体都带 shrink-0 whitespace-nowrap（删任一即竖排）', () => {
    renderHeader();
    const names = [
      '全选宫格照片',
      '清除宫格多选',
      '按条件筛选照片',
      '切换为一行 3 张缩略图',
      '切换为一行 4 张缩略图',
    ];
    for (const name of names) {
      const btn = screen.getByRole('button', { name });
      expect(btn.className, name).toContain('shrink-0');
      expect(btn.className, name).toContain('whitespace-nowrap');
    }
  });

  it('全选/清除文字节点带 whitespace-nowrap（#79 常驻入口保留文字）', () => {
    renderHeader();
    expect(screen.getByText('全选').className).toContain('whitespace-nowrap');
    expect(screen.getByText('清除').className).toContain('whitespace-nowrap');
    // 常驻可见：不得收进菜单、不得仅多选态显示
    expect(screen.getByRole('button', { name: '全选宫格照片' })).toBeDefined();
    expect(screen.getByRole('button', { name: '清除宫格多选' })).toBeDefined();
  });

  it('3列/4列/搜索已图标化：文字 span 消失但 aria-label/title/aria-pressed 保留', () => {
    renderHeader();
    expect(screen.queryByText('3列')).toBeNull();
    expect(screen.queryByText('4列')).toBeNull();
    expect(screen.queryByText('搜索')).toBeNull();
    const c3 = screen.getByRole('button', { name: '切换为一行 3 张缩略图' });
    const c4 = screen.getByRole('button', { name: '切换为一行 4 张缩略图' });
    const search = screen.getByRole('button', { name: '按条件筛选照片' });
    expect(c3.getAttribute('title')).toBe('一行 3 张缩略图');
    expect(c4.getAttribute('title')).toBe('一行 4 张缩略图');
    expect(search.getAttribute('title')).toBe('按条件筛选 (快捷键 Ctrl+F)');
    expect(c3.getAttribute('aria-pressed')).not.toBeNull();
    expect(c4.getAttribute('aria-pressed')).not.toBeNull();
    expect(search.getAttribute('aria-pressed')).not.toBeNull();
    expect(c3.getAttribute('aria-label')).toBe('切换为一行 3 张缩略图');
    expect(c4.getAttribute('aria-label')).toBe('切换为一行 4 张缩略图');
    expect(search.getAttribute('aria-label')).toBe('按条件筛选照片');
  });

  it('全选按钮的 aria-pressed / aria-keyshortcuts 与 title 保留（图标化不回退 #79）', () => {
    renderHeader();
    const all = screen.getByRole('button', { name: '全选宫格照片' });
    expect(all.getAttribute('aria-pressed')).not.toBeNull();
    expect(all.getAttribute('aria-keyshortcuts')).toBe('Control+A');
    expect(all.getAttribute('title')).toBe('全选当前宫格（Ctrl+A）');
  });
});
