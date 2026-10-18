/**
 * 单图视口的滚轮缩放（M-08）。
 *
 * 快捷键说明承诺「滚轮 · 以指针为中心缩放」；本用例把光标放在离画面中心
 * (600, 400) 的偏移处滚一格，断言 `transform` 里的平移量按命中公式反算 ——
 * 修复前只改 scale、translate 恒为 0，本用例会直接失败。
 *
 * 坐标依赖 `src/test/setup.ts` 里给 `getBoundingClientRect` 打的桩：
 * left/top = 0，width 1200 / height 800，故视口中心 O = (600, 400)。
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PreviewViewport } from './PreviewViewport';
import {
  invokeCount,
  mockInvokeCommand,
  mockInvokeError,
  setInvokeHandler,
} from '../test/setup';
import type { LumenStatus, PhotoGroupInfo } from '../types';

const group: PhotoGroupInfo = {
  id: 'g1',
  baseName: 'g1',
  jpg: { name: 'g1.jpg', extension: 'jpg', path: 'D:/shoot/g1.jpg', size: 1, mtime: 0 },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  label: '', hasXmp: false,
};

function renderViewport() {
  const { container } = render(
    <PreviewViewport
      group={group}
      onPrev={vi.fn()}
      onNext={vi.fn()}
      onRate={vi.fn()}
      onFlag={vi.fn()}
      onOpenExternal={vi.fn()}
    />,
  );
  return { wheelHost: container.firstElementChild as HTMLElement, container };
}

describe('PreviewViewport —— 滚轮以指针为中心缩放（M-08）', () => {
  it('光标不在中心时，按命中公式反算平移量', () => {
    const { wheelHost, container } = renderViewport();
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.style.transform).toContain('translate(0px, 0px)');

    // d = (1200, 800) − (600, 400) = (600, 400)；k = 1.25
    // pos′ = 1.25·0 + (1 − 1.25)·d = (−150, −100)
    fireEvent.wheel(wheelHost, { clientX: 1200, clientY: 800, deltaY: -100 });

    expect(img.style.transform).toContain('translate(-150px, -100px)');
    expect(img.style.transform).toContain('scale(1.25)');
  });

  it('光标在画面正中时退化为「只改缩放」，不产生平移', () => {
    const { wheelHost, container } = renderViewport();
    const img = container.querySelector('img') as HTMLImageElement;

    fireEvent.wheel(wheelHost, { clientX: 600, clientY: 400, deltaY: -100 });

    expect(img.style.transform).toContain('translate(0px, 0px)');
    expect(img.style.transform).toContain('scale(1.25)');
  });
});

/**
 * RAW-only 分组的图片解析口径（C2 / M-02，三视口共用 `resolveViewportImage`）。
 *
 * 修复前：RAW-only 且 LUMEN 没顶上时把 .NEF 资产 URL 直接丢给 <img>，
 * 浏览器解不了 → 永久破图。现在必须是「明确占位」：
 *  - 引擎可用但解码失败 → 「RAW 预览暂不可用」；
 *  - 引擎不可用 → 「该 RAW 需启用 LUMEN RAW 引擎」；
 *  - 解码成功 → 走 LUMEN 预览 URL。
 */
describe('PreviewViewport —— RAW-only 图片解析（C2）', () => {
  const AVAILABLE: LumenStatus = {
    available: true,
    enabled: true,
    pinnedVersion: '1.0.0',
    foundVersion: '1.0.0',
    detail: 'ok',
  };
  const UNAVAILABLE: LumenStatus = { ...AVAILABLE, available: false };

  const rawGroup: PhotoGroupInfo = {
    id: 'raw1',
    baseName: 'raw1',
    raw: { name: 'raw1.NEF', extension: 'NEF', path: 'D:/shoot/raw1.NEF', size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
  };

  function renderRaw(lumenStatus: LumenStatus) {
    const { container } = render(
      <PreviewViewport
        group={rawGroup}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onRate={vi.fn()}
        onFlag={vi.fn()}
        onOpenExternal={vi.fn()}
        lumenStatus={lumenStatus}
      />,
    );
    return { container };
  }

  it('引擎可用且解码成功 → 渲染 LUMEN 预览 URL 的图片', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));

    const { container } = renderRaw(AVAILABLE);

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      // 修复前这里是 asset://localhost/D:/shoot/raw1.NEF（破图）
      expect(img?.getAttribute('src')).toBe('asset://localhost/D:/shoot/raw1.NEF.preview');
    });
  });

  it('引擎可用但解码失败 → 「RAW 预览暂不可用」占位，不留破图', async () => {
    mockInvokeError('lumen_preview_cmd');

    const { container } = renderRaw(AVAILABLE);

    await waitFor(() => {
      expect(screen.getByText('RAW 预览暂不可用')).toBeInTheDocument();
    });
    expect(container.querySelector('img')).toBeNull();
  });

  it('引擎不可用 → 「该 RAW 需启用 LUMEN RAW 引擎」占位，不留破图', async () => {
    const { container } = renderRaw(UNAVAILABLE);

    expect(screen.getByText('该 RAW 需启用 LUMEN RAW 引擎')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('预览渲染成功后加载失败（onError latch）→ 回落占位，不破图', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));

    const { container } = renderRaw(AVAILABLE);

    // 先等到 LUMEN 预览图渲染出来（证明 latch 之前是有图的）。
    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'asset://localhost/D:/shoot/raw1.NEF.preview',
      );
    });

    // 陈旧/损坏的缓存预览触发 <img onError>： latch 后必须回落占位（C2），
    // 而不是把 .NEF 丢给 <img> 永久破图。
    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    await waitFor(() => {
      expect(screen.getByText('RAW 预览暂不可用')).toBeInTheDocument();
    });
    expect(container.querySelector('img')).toBeNull();
  });
});

/**
 * 自动调色采样的 CORS 前提（问题二，2026-10-15）。
 *
 * 「自动」按钮会把视口这张 <img> 画进 canvas 再 getImageData。asset:// 是
 * 跨源资源，缺 crossOrigin 时 canvas 被污染 → 采样抛 SecurityError →
 * 用户看到「点了没反应」。真窗口 e2e 复现证据：断言B1=false +
 * console.warn「The canvas has been tainted by cross-origin data.」。
 * asset 协议对全部响应返回 ACAO（tauri 2.11.5 protocol/asset.rs），
 * 故这里必须固定 crossOrigin="anonymous"。
 */
describe('PreviewViewport —— 自动调色采样的 CORS 前提', () => {
  it('视口 img 带 crossOrigin="anonymous"（缺则 canvas 污染、采样必抛 SecurityError）', () => {
    const { container } = renderViewport();
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.crossOrigin).toBe('anonymous');
  });
});

/**
 * FR-05：RAW-only 的 1:1 细节。
 *
 * 按 Z 之前看到的是 1600px 预览拉大，判断不了对焦；按 Z 之后必须换成
 * `photo.export` 出的原生尺寸图，并把缩放切到真 1:1（`naturalWidth /
 * 显示宽度`，不是写死的倍数）。
 *
 * jsdom 不布局，`naturalWidth` / `offsetWidth` 恒为 0 —— 每个用例显式打桩，
 * 否则算出来的比例是 null，断言会误判成「实现没生效」。
 */
describe('PreviewViewport —— 1:1 细节（FR-05）', () => {
  const AVAILABLE: LumenStatus = {
    available: true,
    enabled: true,
    pinnedVersion: '1.6.0',
    foundVersion: '1.6.0',
    detail: 'ok',
  };

  const jpgGroup: PhotoGroupInfo = {
    id: 'jpg1',
    baseName: 'jpg1',
    jpg: { name: 'jpg1.jpg', extension: 'jpg', path: 'D:/shoot/jpg1.jpg', size: 1, mtime: 0 },
    status: 'JPG_ONLY',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: false,
  };

  const rawGroup: PhotoGroupInfo = {
    id: 'raw1',
    baseName: 'raw1',
    raw: { name: 'raw1.ARW', extension: 'ARW', path: 'D:/shoot/raw1.ARW', size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: false,
  };

  /** jsdom 不布局：给元素补上真实像素与显示宽度。 */
  function stubMetrics(img: HTMLImageElement, naturalWidth: number, displayedWidth: number) {
    Object.defineProperty(img, 'naturalWidth', { value: naturalWidth, configurable: true });
    Object.defineProperty(img, 'offsetWidth', { value: displayedWidth, configurable: true });
  }

  function renderWithRef(group: PhotoGroupInfo, status?: LumenStatus) {
    const ref = { current: () => {} } as React.MutableRefObject<() => void>;
    const { container } = render(
      <PreviewViewport
        group={group}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onRate={vi.fn()}
        onFlag={vi.fn()}
        onOpenExternal={vi.fn()}
        lumenStatus={status}
        oneToOneRef={ref}
      />,
    );
    return { container, ref };
  }

  it('JPG 分组：按 Z 直接进 1:1，不请求细节（原图本身就是全分辨率）', () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: null, width: 1600, original: false, cached: false });
    const { container, ref } = renderWithRef(jpgGroup, AVAILABLE);
    const img = container.querySelector('img') as HTMLImageElement;
    stubMetrics(img, 6024, 1200);

    act(() => ref.current());

    expect(img.style.transform).toContain('scale(5.02)');
    expect(invokeCount('lumen_detail_cmd')).toBe(0);
  });

  it('已在 1:1 再按 Z → 回到适应窗口（同一键来回切）', () => {
    mockInvokeCommand('lumen_preview_cmd', { previewPath: null, width: 1600, original: false, cached: false });
    const { container, ref } = renderWithRef(jpgGroup, AVAILABLE);
    const img = container.querySelector('img') as HTMLImageElement;
    stubMetrics(img, 6024, 1200);

    act(() => ref.current());
    expect(img.style.transform).toContain('scale(5.02)');

    act(() => ref.current());
    expect(img.style.transform).toContain('scale(1)');
  });

  it('RAW-only：按 Z 请求细节，就绪后换成全分辨率图并切到 1:1', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));
    mockInvokeCommand('lumen_detail_cmd', {
      detailPath: 'D:/cache/lumen/raw1_detail_lumen.jpg',
      cached: false,
      elapsedMs: 6500,
    });

    const { container, ref } = renderWithRef(rawGroup, AVAILABLE);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const img = container.querySelector('img') as HTMLImageElement;
    stubMetrics(img, 1600, 1200); // 预览阶段：1600px 源

    act(() => ref.current());

    // 细节返回 → src 换成 detail（不再是预览）
    await waitFor(() => expect(img.src).toContain('raw1_detail_lumen.jpg'));

    // 浏览器加载完真实尺寸的图后 onLoad 才触发；jsdom 不会自己加载。
    stubMetrics(img, 6024, 1200);
    fireEvent.load(img);

    expect(img.style.transform).toContain('scale(5.02)');
    expect(invokeCount('lumen_detail_cmd')).toBe(1);
  });

  it('细节渲染失败：保留预览图并明确说明，不静默', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));
    mockInvokeError('lumen_detail_cmd', new Error('sidecar 挂了'));

    const { container, ref } = renderWithRef(rawGroup, AVAILABLE);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const img = container.querySelector('img') as HTMLImageElement;
    stubMetrics(img, 1600, 1200);

    act(() => ref.current());

    await waitFor(() => {
      expect(screen.getByText(/细节渲染失败，已退回预览图/)).toBeInTheDocument();
    });
    // 仍是 1600 预览，不是破图
    expect(img.src).toContain('.preview');
  });

  it('细节图加载失败（缓存被删 / 写坏）→ 退回预览，不永久破图', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));
    mockInvokeCommand('lumen_detail_cmd', {
      detailPath: 'D:/cache/lumen/raw1_detail_lumen.jpg',
      cached: false,
      elapsedMs: 6500,
    });

    const { container, ref } = renderWithRef(rawGroup, AVAILABLE);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const img = container.querySelector('img') as HTMLImageElement;
    stubMetrics(img, 1600, 1200);

    act(() => ref.current());
    await waitFor(() => expect(img.src).toContain('raw1_detail_lumen.jpg'));

    // 缓存文件被 LRU 删掉 / 写坏了：浏览器加载失败
    fireEvent.error(img);

    await waitFor(() => expect(img.src).toContain('.preview'));
    expect(screen.getByText(/细节渲染失败，已退回预览图/)).toBeInTheDocument();
  });

  it('细节渲染中显示可取消说明（6-8 秒不能只有转圈没有话）', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));
    // 永不完成：停在渲染中
    setInvokeHandler((cmd) => {
      if (cmd === 'lumen_detail_cmd') return new Promise(() => {});
      if (cmd === 'lumen_preview_cmd') {
        return { previewPath: 'D:/c/p.preview', width: 1600, original: false, cached: false };
      }
      return undefined;
    });

    const { container, ref } = renderWithRef(rawGroup, AVAILABLE);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    act(() => ref.current());

    await waitFor(() => {
      expect(screen.getByText(/正在生成 1:1 细节/)).toBeInTheDocument();
    });
  });

  it('渲染中点「取消」：提示消失，仍停在预览图（不是失败）', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));
    // 永不完成：停在渲染中
    setInvokeHandler((cmd) => {
      if (cmd === 'lumen_detail_cmd') return new Promise(() => {});
      if (cmd === 'lumen_preview_cmd') {
        return { previewPath: 'D:/c/p.preview', width: 1600, original: false, cached: false };
      }
      return undefined;
    });

    const { container, ref } = renderWithRef(rawGroup, AVAILABLE);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const img = container.querySelector('img') as HTMLImageElement;
    stubMetrics(img, 1600, 1200);

    act(() => ref.current());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() =>
      expect(screen.queryByText(/正在生成 1:1 细节/)).toBeNull(),
    );
    // 取消 ≠ 失败：不能顺手弹出「渲染失败」吓人
    expect(screen.queryByText(/细节渲染失败/)).toBeNull();
    expect(img.src).toContain('.preview');
  });
});
