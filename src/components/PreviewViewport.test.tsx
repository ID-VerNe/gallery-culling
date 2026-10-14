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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PreviewViewport } from './PreviewViewport';
import { mockInvokeCommand, mockInvokeError } from '../test/setup';
import type { LumenStatus, PhotoGroupInfo } from '../types';

const group: PhotoGroupInfo = {
  id: 'g1',
  baseName: 'g1',
  jpg: { name: 'g1.jpg', extension: 'jpg', path: 'D:/shoot/g1.jpg', size: 1, mtime: 0 },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  hasXmp: false,
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
    hasXmp: false,
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
