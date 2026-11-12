/**
 * 取图失败自身的处理（issue #192 后只剩一条路）。
 *
 * 宫格恒走 `get_thumbnail_cmd`（相机内嵌图）。磁盘只读、权限不足、文件被删时
 * 它会抛错 —— 格子不能永远停在「加载中」，也不能产生未处理的 Promise rejection。
 * 修复前 `thumbnail()` 没有 `.catch`，正好是这个洞。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThumbnailGrid } from './ThumbnailGrid';
import { mockInvokeError } from '../test/setup';
import { makeGroup, rawFile } from '../test/factories';

const group = (id: string) =>
  makeGroup(id, { status: 'RAW_ONLY', raw: rawFile(id, 'CR3', 'D:/shoot'), jpg: undefined });

function renderGrid() {
  // @tanstack/react-virtual 在全 0 尺寸下渲染 0 行 —— 断言会假通过
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
  return render(
    <ThumbnailGrid groups={[group('g1')]} selectedIndex={0} onSelect={() => undefined} />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ThumbnailGrid —— 取图失败', () => {
  it('读取失败：格子显示「无预览」，不停在「加载中」，且无未处理 rejection', async () => {
    const unhandled = vi.fn();
    // tsconfig 只配了 DOM lib，不引 node 类型
    const proc = () =>
      (globalThis as unknown as {
        process: {
          on: (e: string, f: (r: unknown) => void) => void;
          off: (e: string, f: (r: unknown) => void) => void;
        };
      }).process;
    proc().on('unhandledRejection', unhandled);

    mockInvokeError('get_thumbnail_cmd', new Error('磁盘只读'));

    const { container } = renderGrid();

    await waitFor(() => {
      expect(screen.queryByText('加载中')).toBeNull();
    });
    expect(screen.getByLabelText('缩略图不可用')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();

    proc().off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
