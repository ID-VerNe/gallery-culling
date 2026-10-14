/**
 * 万张规模性能（批次 D）的两条回归护栏：
 *
 * - **N-10 虚拟化行高漂移**：估算行高必须与「子格子高度 + 行容器 pb-1.5」精确一致，
 *   且行容器挂了 measureElement 自测（对样式改动免疫）。
 * - **N-09 缩略图 IPC 去重/缓存**：同一路径的并发/重复请求只发一次 IPC；失败可重试。
 *
 * ⚠️ jsdom 没有真实布局：`@tanstack/react-virtual` 的 measureElement 读的是
 * `offsetHeight`，而测试基座（src/test/setup.ts）把它统一伪装成 800。这里用
 * `mockRowHeight()` 把「带 data-index 的行 div」伪装成浏览器会量到的真实行高，
 * 从而让 `measureElement` 拿到有意义的数字 —— **这是对浏览器测量的模拟，不是真实
 * 像素**；真实像素与掉帧仍需实机验证。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThumbnailGrid, gridRowHeight } from './ThumbnailGrid';
import {
  invokeCount,
  mockInvokeCommand,
  mockInvokeError,
  setInvokeHandler,
} from '../test/setup';
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

const grid = (groups: PhotoGroupInfo[], lumenThumbnails = false) => (
  <ThumbnailGrid
    groups={groups}
    selectedIndex={0}
    onSelect={() => {}}
    lumenThumbnails={lumenThumbnails}
  />
);

const sizerOf = (list: HTMLElement) => list.firstElementChild as HTMLElement;

/**
 * 模拟浏览器对行 div（带 data-index）的实测行高。非行元素（滚动视口等）保持 800，
 * 与原测试基座一致。每个用例结束后由 setup.ts 的 beforeEach 复位。
 */
function mockRowHeight(rowHeight: number): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: function (this: HTMLElement) {
      return this.hasAttribute('data-index') ? rowHeight : 800;
    },
  });
}

describe('N-10 虚拟化行高一致性', () => {
  it('估算行高 = 子格子高度 + 行容器 pb-1.5（3 列 138 / 4 列 116）', () => {
    // 这两个数字若失配，1 万张 / 3 列会累计 ≈6666px 漂移（3333 行 × 2px）。
    expect(gridRowHeight(3)).toBe(138);
    expect(gridRowHeight(4)).toBe(116);
    // 与子格子高度的绑定关系：132/110 各 + 6（pb-1.5）。
    expect(gridRowHeight(3) - gridRowHeight(4)).toBe(132 - 110);
  });

  it('容器总高 = 行数 × 精确行高（30 张 / 3 列 = 10 行 × 138）', async () => {
    mockRowHeight(138);
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    render(grid(Array.from({ length: 30 }, (_, i) => group(`p${i}`))));

    const list = await screen.findByRole('listbox');
    // 回归前估算为 140px → 这里会是 1400px，用例失败。
    await waitFor(() => expect(sizerOf(list).style.height).toBe(`${10 * 138}px`));
  });

  it('切到 4 列后按 116 计算总高（30 张 / 4 列 = 8 行 × 116）', async () => {
    mockRowHeight(116);
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    render(grid(Array.from({ length: 30 }, (_, i) => group(`p${i}`))));

    const list = await screen.findByRole('listbox');
    fireEvent.click(screen.getByRole('button', { name: '切换为一行 4 张缩略图' }));
    // 回归前估算为 118px → 这里会是 944px，用例失败。
    await waitFor(() => expect(sizerOf(list).style.height).toBe(`${8 * 116}px`));
  });

  it('行容器挂了 measureElement：实测尺寸覆盖估算（对样式改动免疫）', async () => {
    // 模拟"样式改了、真实行高变成 200"。若 measureElement 生效，虚拟化器采用实测值；
    // 若未挂 ref（回归前），只会用估算 138 → 用例失败。
    mockRowHeight(200);
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    render(grid([group('a'), group('b'), group('c')])); // 3 张 / 3 列 = 1 行

    const list = await screen.findByRole('listbox');
    await waitFor(() => expect(sizerOf(list).style.height).toBe('200px'));
  });

  it('每个虚拟行都带 data-index，且不写死 height（否则 measureElement 会量到估算值本身）', async () => {
    mockRowHeight(138);
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    render(grid(Array.from({ length: 30 }, (_, i) => group(`p${i}`))));

    const list = await screen.findByRole('listbox');
    const rows = list.querySelectorAll('[data-index]');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((el) => {
      expect(el.getAttribute('data-index')).toMatch(/^\d+$/);
      // 写死 height 会让 offsetHeight 永远等于估算值，自测退化为空转。
      expect((el as HTMLElement).style.height).toBe('');
    });
  });
});

describe('N-09 缩略图 IPC 去重与缓存', () => {
  it('滚动离开再滚回来命中缓存：同一批文件不重复发 IPC', async () => {
    mockInvokeCommand('get_thumbnail_cmd', (args) => `thumb-${String(args?.filePath)}`);
    const setA = [group('a1'), group('a2')];
    const setB = [group('b1')];

    const view = render(grid(setA));
    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(2));

    // 滚到别处：a1/a2 卸载
    view.rerender(grid(setB));
    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(3));

    // 滚回来：结果已在缓存，不得再发 IPC（回归前会变成 5）。
    view.rerender(grid(setA));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(invokeCount('get_thumbnail_cmd')).toBe(3);
  });

  it('同一路径并发挂载：共享 inflight，只发一次 IPC', async () => {
    let resolveThumb!: (value: string) => void;
    const pending = new Promise<string>((res) => {
      resolveThumb = res;
    });
    setInvokeHandler((command) => {
      if (command === 'get_thumbnail_cmd') return pending;
      throw new Error(`unexpected command in test: ${command}`);
    });

    const shared = 'D:/shoot/shared.CR3';
    const raw = { name: 'shared.CR3', extension: 'CR3', path: shared, size: 1, mtime: 0 };
    render(grid([group('dup-a', { raw }), group('dup-b', { raw })]));

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    // 两个格子同时请求同一路径 → inflight 去重（回归前是 2）。
    expect(invokeCount('get_thumbnail_cmd')).toBe(1);

    resolveThumb('thumb-shared.jpg');
    await waitFor(() => expect(document.querySelectorAll('img').length).toBe(2));
  });

  it('失败不被缓存：重挂后可重试并成功', async () => {
    mockInvokeError('get_thumbnail_cmd', new Error('磁盘抖动'));
    const setA = [group('r1')];
    const setB = [group('z1')];

    const view = render(grid(setA));
    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(1));
    // 失败停在"无预览"而不是"加载中"
    await waitFor(() => expect(screen.queryByText('加载中')).toBeNull());
    expect(screen.getByText('无预览')).toBeInTheDocument();

    // 卸载 r1（避免它继续占用 inflight 语义）
    view.rerender(grid(setB));
    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(2));

    // 后端恢复
    mockInvokeCommand('get_thumbnail_cmd', 'recovered.jpg');
    // 滚回：失败没有被缓存 → 会重新请求（回归若缓存了失败，这里会一直停在"无预览"）
    view.rerender(grid(setA));
    await waitFor(() => expect(invokeCount('get_thumbnail_cmd')).toBe(3));
    await waitFor(() =>
      expect(document.querySelector('img')?.getAttribute('src')).toBe(
        'asset://localhost/recovered.jpg',
      ),
    );
  });
});
