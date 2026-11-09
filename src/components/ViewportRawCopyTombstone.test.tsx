/**
 * 三视口 RAW-only 占位 copy 与横幅收敛墓碑（issue #121）。
 *
 * 背景：`PreviewViewport.tsx:296` / `SplitCompareViewport.tsx:96` /
 * `BeforeAfterViewport.tsx:80` 三处守卫形状相同，但 copy 三份、横幅三份
 * （Preview 大档 top-4 px-3.5 py-1.5 text-xs，Split/BeforeAfter 小档 top-3
 * px-3 py-1 text-[11px]）。收敛后 copy 走 `rawOnlyEmptyState`、横幅走
 * `<RawRenderingBanner/>`，以 Preview 双分支为超集。
 *
 * jsdom 无法目视 4px 差异，这里钉**归属**：三份源码内不再出现横幅文案与
 * copy 字面量、不再残留内联大小档横幅 div，而是委托共享模块；行为面钉
 * Split/BeforeAfter 的解码失败分支（此前是单分支「需启用」，收敛后应与
 * Preview 一致） —— 变异回单分支即红。
 */
import { describe, it, expect, vi } from 'vitest';
import previewSource from './PreviewViewport.tsx?raw';
import splitSource from './SplitCompareViewport.tsx?raw';
import beforeAfterSource from './BeforeAfterViewport.tsx?raw';
import { render, screen, waitFor } from '@testing-library/react';
import { SplitCompareViewport } from './SplitCompareViewport';
import { BeforeAfterViewport } from './BeforeAfterViewport';
import { mockInvokeError } from '../test/setup';
import type { LumenStatus, PhotoGroupInfo } from '../types';

const VIEWPORT_SOURCES = [
  { name: 'Preview', source: previewSource },
  { name: 'Split', source: splitSource },
  { name: 'BeforeAfter', source: beforeAfterSource },
] as const;

// Preview 大档白色横幅（与「查看原片」amber 档区分：white/80）。
const LARGE_BANNER_CLASS =
  'absolute top-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-white/80 border border-border-default pointer-events-none';
// Split/BeforeAfter 小档。
const SMALL_BANNER_CLASS =
  'absolute top-3 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3 py-1 rounded-md text-[11px] font-semibold text-white/80 border border-border-default pointer-events-none';

describe('三视口 RAW-only copy 与横幅收敛墓碑（issue #121）', () => {
  for (const { name, source } of VIEWPORT_SOURCES) {
    it(`${name}：copy 委托 rawOnlyEmptyState（不再自写分支）`, () => {
      expect(source).toContain('rawOnlyEmptyState(');
      // 旧三份 copy 字面量不得残留（已收敛到 src/utils/viewportRawCopy.ts）。
      expect(source).not.toContain('LUMEN RAW 引擎未能解码该照片');
      expect(source).not.toContain('启用 LUMEN RAW 引擎后即可在此实时预览');
      expect(source).not.toContain('启用 LUMEN RAW 引擎后即可在此对照预览');
    });

    it(`${name}：横幅委托 <RawRenderingBanner/>（不再内联大小档 div）`, () => {
      expect(source).toContain('RawRenderingBanner');
      // JSX 文本节点不得残留（注释里提「正在渲染 RAW…」不算 drift）。
      expect(source).not.toMatch(/>\s*正在渲染 RAW/);
      expect(source).not.toContain(LARGE_BANNER_CLASS);
      expect(source).not.toContain(SMALL_BANNER_CLASS);
    });
  }

  it('Preview 调用侧保留 !lumenActive 决策（横幅可见性与 markup 分离）', () => {
    // 组件只管 markup，可见性留调用侧；Preview 历史条件是 loading && !lumenActive。
    expect(previewSource).toMatch(/image\.loading\s*&&\s*!image\.lumenActive/);
  });
});

describe('Split / BeforeAfter 解码失败分支（issue #121，收敛后双分支）', () => {
  const AVAILABLE: LumenStatus = {
    available: true,
    enabled: true,
    pinnedVersion: '1.0.0',
    foundVersion: '1.0.0',
    detail: 'ok',
  };
  const UNAVAILABLE: LumenStatus = { ...AVAILABLE, available: false };

  function rawOnly(id: string): PhotoGroupInfo {
    return {
      id,
      baseName: id,
      raw: { name: `${id}.NEF`, extension: 'NEF', path: `D:/shoot/${id}.NEF`, size: 1, mtime: 0 },
      status: 'RAW_ONLY',
      rating: 0,
      flag: 'none',
      label: '',
      hasXmp: false,
    };
  }

  it('Split：引擎可用但解码失败 → 「RAW 预览暂不可用」（此前单分支会误报需启用）', async () => {
    mockInvokeError('lumen_preview_cmd');
    const { container } = render(
      <SplitCompareViewport
        isLeftPinned={false}
        isRightPinned={false}
        onTogglePinLeft={vi.fn()}
        onTogglePinRight={vi.fn()}
        onSwap={vi.fn()}
        leftGroup={rawOnly('a')}
        lumenStatus={AVAILABLE}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('RAW 预览暂不可用')).toBeInTheDocument();
    });
    expect(container.querySelector('img')).toBeNull();
  });

  it('Split：引擎不可用 → 「该 RAW 需启用 LUMEN RAW 引擎」', () => {
    render(
      <SplitCompareViewport
        isLeftPinned={false}
        isRightPinned={false}
        onTogglePinLeft={vi.fn()}
        onTogglePinRight={vi.fn()}
        onSwap={vi.fn()}
        leftGroup={rawOnly('a')}
        lumenStatus={UNAVAILABLE}
      />,
    );
    expect(screen.getByText('该 RAW 需启用 LUMEN RAW 引擎')).toBeInTheDocument();
  });

  it('BeforeAfter：引擎可用但解码失败 → 「RAW 预览暂不可用」', async () => {
    mockInvokeError('lumen_preview_cmd');
    const { container } = render(
      <BeforeAfterViewport group={rawOnly('a')} lumenStatus={AVAILABLE} />,
    );
    await waitFor(() => {
      expect(screen.getByText('RAW 预览暂不可用')).toBeInTheDocument();
    });
    expect(container.querySelector('img')).toBeNull();
  });

  it('BeforeAfter：引擎不可用 → 「该 RAW 需启用 LUMEN RAW 引擎」', () => {
    render(<BeforeAfterViewport group={rawOnly('a')} lumenStatus={UNAVAILABLE} />);
    expect(screen.getByText('该 RAW 需启用 LUMEN RAW 引擎')).toBeInTheDocument();
  });
});
