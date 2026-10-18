/**
 * 回落路径自身的失败处理。
 *
 * 已有 ThumbnailGrid.test.tsx 覆盖"引擎失败 → 回落成功"。这里补另一半：
 * **回落也失败**时（磁盘只读、权限不足，与引擎死亡同源）格子不能永远停在
 * "加载中"，也不能产生未处理的 Promise rejection。修复前 fallback 的
 * getThumbnail 没有 .catch，正好是这个洞。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThumbnailGrid } from './ThumbnailGrid';
import { mockInvokeCommand, mockInvokeError } from '../test/setup';
import type { PhotoGroupInfo } from '../types';

function group(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    raw: { name: `${id}.CR3`, extension: 'CR3', path: `D:/shoot/${id}.CR3`, size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
  } as unknown as PhotoGroupInfo;
}

function renderGrid() {
  // @tanstack/react-virtual 在全 0 尺寸下渲染 0 行 —— 断言会假通过
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
  return render(
    <ThumbnailGrid
      groups={[group('g1')]}
      selectedIndex={0}
      onSelect={() => undefined}
      lumenThumbnails
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ThumbnailGrid —— 回落路径自身失败', () => {
  it('引擎与回落都失败：格子不得停在「加载中」，且无未处理 rejection', async () => {
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

    mockInvokeError('lumen_preview_cmd', new Error('引擎挂了'));
    mockInvokeError('get_thumbnail_cmd', new Error('磁盘只读'));

    renderGrid();

    await waitFor(() => {
      expect(screen.queryByText('加载中')).toBeNull();
    });

    proc().off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('引擎失败、回落成功：照常显示内嵌缩略图（不能被前一条的错误处理牵连）', async () => {
    mockInvokeError('lumen_preview_cmd', new Error('引擎挂了'));
    mockInvokeCommand('get_thumbnail_cmd', 'fallback-thumb.jpg');

    const { container } = renderGrid();

    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'asset://localhost/fallback-thumb.jpg',
      );
    });
    expect(screen.queryByText('加载中')).toBeNull();
  });
});