/**
 * 对比视图的三视口一致性护栏（M-02）：
 *  - RAW-only 分组必须走 LUMEN 真实解码，而不是把 .NEF 直接丢给 <img>（修复前破图）；
 *  - 已调色分组两窗格都要套上 tone CSS 滤镜（LUMEN 未命中时）；
 *  - 有 JPG 的照片零 lumen 请求（防止「顺手把解码成本翻倍」）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { SplitCompareViewport } from './SplitCompareViewport';
import { invokeCount, mockInvokeCommand } from '../test/setup';
import type { LumenStatus, PhotoGroupInfo, ToneAdjustments } from '../types';

const AVAILABLE: LumenStatus = {
  available: true,
  enabled: true,
  pinnedVersion: '1.0.0',
  foundVersion: '1.0.0',
  detail: 'ok',
};

function rawOnly(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    raw: { name: `${id}.NEF`, extension: 'NEF', path: `D:/shoot/${id}.NEF`, size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    hasXmp: false,
  };
}

function withJpg(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    jpg: { name: `${id}.jpg`, extension: 'jpg', path: `D:/shoot/${id}.jpg`, size: 1, mtime: 0 },
    status: 'JPG_ONLY',
    rating: 0,
    flag: 'none',
    hasXmp: false,
  };
}

function renderSplit(props: Partial<ComponentProps<typeof SplitCompareViewport>> = {}) {
  return render(
    <SplitCompareViewport
      isLeftPinned={false}
      isRightPinned={false}
      onTogglePinLeft={vi.fn()}
      onTogglePinRight={vi.fn()}
      onSwap={vi.fn()}
      onRate={vi.fn()}
      onFlag={vi.fn()}
      {...props}
    />,
  );
}

describe('SplitCompareViewport —— LUMEN 与调色口径（M-02）', () => {
  it('RAW-only 分组在对比窗格走 lumen 预览 URL', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));

    const { container } = renderSplit({
      leftGroup: rawOnly('a'),
      lumenStatus: AVAILABLE,
    });

    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      // 修复前这里是 asset://localhost/D:/shoot/a.NEF（破图）
      expect(img?.getAttribute('src')).toBe('asset://localhost/D:/shoot/a.NEF.preview');
    });
  });

  it('对已调色分组两窗格都套用 tone filter', async () => {
    const tone: ToneAdjustments = {
      exposure: 1,
      highlights: 0,
      shadows: 0,
      temperature: 0,
      tint: 0,
      contrast: 0,
    };

    const { container } = renderSplit({
      leftGroup: withJpg('left'),
      rightGroup: withJpg('right'),
      lumenStatus: AVAILABLE,
      getTone: () => tone,
    });

    await waitFor(() => {
      const imgs = container.querySelectorAll('img');
      expect(imgs).toHaveLength(2);
      imgs.forEach((img) => {
        expect(img.style.filter).not.toBe('');
        expect(img.style.filter).not.toBe('none');
      });
    });
  });

  it('有 JPG 时不触发 lumen 请求', async () => {
    mockInvokeCommand('lumen_preview_cmd', {
      previewPath: 'should-not-be-used.jpg',
      width: 1600,
      original: false,
      cached: false,
    });

    const { container } = renderSplit({
      leftGroup: withJpg('left'),
      rightGroup: withJpg('right'),
      lumenStatus: AVAILABLE,
    });

    expect(container.querySelectorAll('img')).toHaveLength(2);
    expect(invokeCount('lumen_preview_cmd')).toBe(0);
  });
});
