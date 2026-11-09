/**
 * thumbnailLoader 单元单测（issue #116 承接 perf N-09 本体）。
 *
 * ThumbnailGrid.perf.test.tsx 的集成用例侧重「滚走滚回 / 切面板」的 IPC 计数，
 * 这里直接对 loader 做本体断言：并发共享 inflight、完成命中不发 IPC、
 * 失败不缓存可重试、LUMEN 无预览不缓存。README(vitest config)约定 pool=vmForks。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GRID_THUMB_WIDTH,
  getSharedThumbnailLoader,
  resetThumbnailLoaderForTest,
} from './thumbnailLoader';
import {
  invokeCount,
  mockInvokeCommand,
  mockInvokeError,
  setInvokeHandler,
} from '../test/setup';

beforeEach(() => {
  resetThumbnailLoaderForTest();
});

describe('thumbnailLoader —— 去重与缓存（issue #116 承接 N-09）', () => {
  it('GRID_THUMB_WIDTH 是独立产品值恒为 200', () => {
    expect(GRID_THUMB_WIDTH).toBe(200);
  });

  it('同一路径并发共享 inflight，只发一次 IPC', async () => {
    let resolveThumb!: (value: string) => void;
    const pending = new Promise<string>((res) => {
      resolveThumb = res;
    });
    setInvokeHandler((command) => {
      if (command === 'get_thumbnail_cmd') return pending;
      throw new Error(`unexpected command in test: ${command}`);
    });

    const loader = getSharedThumbnailLoader();
    const a = loader.thumbnail('D:/shoot/shared.CR3', 200);
    const b = loader.thumbnail('D:/shoot/shared.CR3', 200);
    expect(invokeCount('get_thumbnail_cmd')).toBe(1);
    expect(b).toBe(a); // 共享同一个 Promise 实例

    resolveThumb('thumb-shared.jpg');
    await expect(a).resolves.toBe('asset://localhost/thumb-shared.jpg');
    await expect(b).resolves.toBe('asset://localhost/thumb-shared.jpg');
  });

  it('完成命中缓存：再次请求不发 IPC', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    const loader = getSharedThumbnailLoader();

    await expect(loader.thumbnail('D:/shoot/a.CR3', 200)).resolves.toBe(
      'asset://localhost/thumb.jpg',
    );
    expect(invokeCount('get_thumbnail_cmd')).toBe(1);

    await expect(loader.thumbnail('D:/shoot/a.CR3', 200)).resolves.toBe(
      'asset://localhost/thumb.jpg',
    );
    expect(invokeCount('get_thumbnail_cmd')).toBe(1);
  });

  it('不同宽度或路径不复用缓存', async () => {
    mockInvokeCommand('get_thumbnail_cmd', (args) =>
      `thumb-${String(args?.filePath)}-${String(args?.width)}`,
    );
    const loader = getSharedThumbnailLoader();

    await loader.thumbnail('D:/shoot/a.CR3', 200);
    await loader.thumbnail('D:/shoot/a.CR3', 400);
    await loader.thumbnail('D:/shoot/b.CR3', 200);
    expect(invokeCount('get_thumbnail_cmd')).toBe(3);
  });

  it('失败不缓存：下一次重试重新发 IPC 并成功', async () => {
    mockInvokeError('get_thumbnail_cmd', new Error('磁盘抖动'));
    const loader = getSharedThumbnailLoader();

    await expect(loader.thumbnail('D:/shoot/r1.CR3', 200)).rejects.toThrow('磁盘抖动');
    expect(invokeCount('get_thumbnail_cmd')).toBe(1);

    mockInvokeCommand('get_thumbnail_cmd', 'recovered.jpg');
    await expect(loader.thumbnail('D:/shoot/r1.CR3', 200)).resolves.toBe(
      'asset://localhost/recovered.jpg',
    );
    expect(invokeCount('get_thumbnail_cmd')).toBe(2);
  });

  it('lumenPreview 成功时返回预览路径且命中缓存', async () => {
    mockInvokeCommand('lumen_preview_cmd', {
      previewPath: 'C:/preview/a.jpg',
      width: 200,
      original: null,
      cached: false,
    });
    const loader = getSharedThumbnailLoader();

    await expect(loader.lumenPreview('D:/shoot/a.CR3', 200)).resolves.toBe('C:/preview/a.jpg');
    await expect(loader.lumenPreview('D:/shoot/a.CR3', 200)).resolves.toBe('C:/preview/a.jpg');
    expect(invokeCount('lumen_preview_cmd')).toBe(1);
  });

  it('lumenPreview 无预览路径不缓存：下一次重新请求', async () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: null, width: 200, original: null, cached: false });
    const loader = getSharedThumbnailLoader();

    await expect(loader.lumenPreview('D:/shoot/none.CR3', 200)).rejects.toThrow(
      'lumen preview unavailable',
    );
    expect(invokeCount('lumen_preview_cmd')).toBe(1);

    mockInvokeCommand('lumen_preview_cmd', {
      previewPath: 'C:/preview/none.jpg',
      width: 200,
      original: null,
      cached: false,
    });
    await expect(loader.lumenPreview('D:/shoot/none.CR3', 200)).resolves.toBe('C:/preview/none.jpg');
    expect(invokeCount('lumen_preview_cmd')).toBe(2);
  });

  it('reset 清掉模块级缓存：同一请求重新发 IPC', async () => {
    mockInvokeCommand('get_thumbnail_cmd', 'thumb.jpg');
    const first = getSharedThumbnailLoader();
    await first.thumbnail('D:/shoot/reset.CR3', 200);
    expect(invokeCount('get_thumbnail_cmd')).toBe(1);

    resetThumbnailLoaderForTest();
    const second = getSharedThumbnailLoader();
    expect(second).not.toBe(first);
    await second.thumbnail('D:/shoot/reset.CR3', 200);
    expect(invokeCount('get_thumbnail_cmd')).toBe(2);
  });
});
