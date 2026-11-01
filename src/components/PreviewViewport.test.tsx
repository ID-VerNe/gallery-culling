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

/**
 * 底栏几何契约（issue #12，替代 #10）。
 *
 * #10 的实现全绿但不可用，原因是一个 jsdom 永远测不到的层：
 * 底板挂 `group-hover/bar:px-4 py-2`、标签 `w-0 → w-auto`，悬停时外接盒
 * 从 497px 跳到 753px（真浏览器实测）。盒子一变大，指针就可能「掉到盒外」
 * → `:hover` 失效 → 收起 → 指针又落回 → 再展开，这就是用户看到的闪烁。
 *
 * 所以本组断言的口径变了：**不再测「折叠成什么样」，而是测「什么不允许出现」**。
 * jsdom 不跑 CSS 层叠，但 className 是契约的唯一载体，全部锁在类名上：
 *
 *  1. 底板与任何分组，className 里**不得出现** `group-hover/bar:` /
 *     `group-focus-within/bar:` 前缀的 padding / width / height / scale 类 ——
 *     这类变体会让外接盒尺寸随悬停变化，也就是本 issue 的根因。
 *  2. 文字标签必须标了 `bar-label`（槽位宽度由 CSS 常驻分配）且带
 *     `whitespace-nowrap`（否则 `w-0` 只压宽度不阻止换行，中文会被断成
 *     竖排方块 —— 实测静息态按钮高 87px 就是这么来的）。
 *  3. 静息态无底色：`bg-background-base/90` 只出现在变体上。
 *  4. 悬停热区是**独立的一层**（透明命中层），不靠底板自身撑开尺寸去接指针。
 */
describe('PreviewViewport —— 底栏几何冻结（issue #12）', () => {
  const BAR_LABELS = ['Pick', 'Reject', '调色', 'Luminar AI', '外部打开'];

  /** 会让外接盒尺寸随悬停变化的前缀（本 issue 的根因，一条都不许有）。 */
  const GEOMETRY_PREFIXES = ['group-hover/bar:', 'group-focus-within/bar:'];

  /** 变体前缀 + 这些属性 = 尺寸会动。颜色/透明度/阴影不在禁止之列。 */
  const GEOMETRY_UTILITIES = [
    /^px-/,
    /^py-/,
    /^p-/,
    /^pl-/,
    /^pr-/,
    /^pt-/,
    /^pb-/,
    /^w-/,
    /^h-/,
    /^min-w-/,
    /^min-h-/,
    /^max-w-/,
    /^max-h-/,
    /^gap-/,
    // `translate-*` / `scale-*` 是有意放行的：它们走合成层、不参与布局，
    // 且是「标签在常驻槽位里淡入」的唯一入场手法。真正要禁的是会改变
    // 外接盒的行内尺寸（上面这些）。万一将来改用 translate 做位移式展开，
    // 真浏览器几何验收（静息 == 悬停，逐像素）会兜住。
    /^text-/,
    /^leading-/,
    /^tracking-/,
  ];

  function classTokens(el: Element): string[] {
    return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }

  /** 找出 className 里所有「变体前缀 + 几何工具类」的组合。 */
  function geometryLeaks(el: Element): string[] {
    return classTokens(el).filter((token) => {
      const prefix = GEOMETRY_PREFIXES.find((p) => token.startsWith(p));
      if (!prefix) return false;
      const utility = token.slice(prefix.length);
      return GEOMETRY_UTILITIES.some((re) => re.test(utility));
    });
  }

  /**
   * 「调色」与「Luminar AI」只在对应回调传入时才渲染（App 里恒传，这里默认漏了）。
   * 几何口径必须覆盖全部五类标签，所以本组用例自己把两个回调补齐。
   */
  function renderFullBar() {
    render(
      <PreviewViewport
        group={group}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onRate={vi.fn()}
        onFlag={vi.fn()}
        onOpenExternal={vi.fn()}
        onOpenLuminar={vi.fn()}
        onToggleTonalAdjuster={vi.fn()}
      />,
    );
    return { container: document.body };
  }

  /**
   * 底栏分组宿主：带 `group/bar` 命名组的那一层。
   *
   * 注意它现在是**包裹层**而不是底板本身（issue #14 根因）—— 见下面的
   * 「group/bar 必须是变体元素的祖先」用例。几何断言瞄准的仍是底板。
   */
  function groupHostOf(container: HTMLElement): HTMLElement {
    const anchor = container.querySelector('[aria-label="照片星级打分"]');
    expect(anchor).not.toBeNull();
    const host = anchor!.closest('div[class*="group/bar"]');
    expect(host, '底栏应带 group/bar 命名组').not.toBeNull();
    return host as HTMLElement;
  }

  /** 底栏本体（底板）：分组宿主的直接子层，命中层所在的这一层。 */
  function barOf(container: HTMLElement): HTMLElement {
    const host = groupHostOf(container);
    const plate = host.querySelector('[data-bar-hit-area]')?.parentElement;
    expect(plate, '底栏底板应为分组宿主的子层').toBeTruthy();
    expect(plate).not.toBe(host);
    return plate as HTMLElement;
  }

  it('底栏本体：任何悬停/聚焦变体都不改尺寸（只允许颜色、透明度、阴影）', () => {
    const { container } = renderFullBar();
    const bar = barOf(container);

    expect(geometryLeaks(bar)).toEqual([]);
    // 过渡属性里也不能带 padding，否则尺寸一变就有 150ms 的「拉扯」观感。
    expect(bar.className).not.toMatch(/transition-\[[^\]]*padding[^\]]*\]/);
  });

  it('底栏内部每个元素都不得用 group-hover/bar: 改几何（含分隔线的 pr-3）', () => {
    const { container } = renderFullBar();
    const bar = barOf(container);

    const leaks: string[] = [];
    bar.querySelectorAll<HTMLElement>('*').forEach((el) => {
      for (const token of geometryLeaks(el)) leaks.push(`${el.tagName}:${token}`);
    });
    expect(leaks).toEqual([]);
  });

  it('文字标签常驻槽位且不换行：w-0/w-auto 已消失，whitespace-nowrap 必须在', () => {
    const { container } = renderFullBar();
    const bar = barOf(container);

    for (const label of BAR_LABELS) {
      // 只认按钮里的可见标签（<title> 里也有同名文案，不能用父节点反推）。
      const span = Array.from(bar.querySelectorAll('button > span')).find(
        (el) => el.textContent === label,
      );
      expect(span, `底栏应有「${label}」标签`).toBeDefined();
      const called = classTokens(span!);

      // w-0 + overflow-hidden 不阻止换行，正是静息态被撑成竖排方块的根因。
      expect(called, `「${label}」不得再用零宽折叠`).not.toContain('w-0');
      expect(span!.className).not.toContain('group-hover/bar:w-auto');
      expect(called, `「${label}」必须禁止换行`).toContain('whitespace-nowrap');
      // 槽位宽度由 CSS 常驻分配（.bar-label），折叠只动 opacity/transform。
      expect(called, `「${label}」应标 bar-label 槽位`).toContain('bar-label');
    }
  });

  it('静息态无底色：底板底色与阴影只在变体上出现', () => {
    const { container } = renderFullBar();
    const called = classTokens(barOf(container));

    // `group/bar` 现在挂在外层宿主上（issue #14），底板只剩变体类。
    expect(classTokens(groupHostOf(container))).toContain('group/bar');
    expect(called).not.toContain('group/bar');
    expect(called).not.toContain('bg-background-base/90');
    expect(called).not.toContain('shadow-2xl');
    expect(called).not.toContain('border-white/15');
    expect(called).toContain('group-hover/bar:bg-background-base/90');
    expect(called).toContain('group-focus-within/bar:bg-background-base/90');
    expect(called).toContain('group-hover/bar:shadow-2xl');
  });

  it('悬停热区是独立层：比底板更大且不受 hover 影响', () => {
    const { container } = renderFullBar();
    const bar = barOf(container);
    const hit = bar.querySelector('[data-bar-hit-area]');

    expect(hit, '底栏应有独立的透明命中层').not.toBeNull();
    const called = classTokens(hit!);
    // 向外扩大：指针在底板边缘附近也保持展开，阻断自激回路。
    expect(called).toContain('-inset-x-3');
    expect(called).toContain('-inset-y-2');
    // 命中层自身不参与视觉，也不许有几何变体。
    expect(geometryLeaks(hit!)).toEqual([]);
  });

  it('可访问名不依赖可见文字：折叠只影响视觉，不影响无障碍名', () => {
    renderFullBar();
    expect(screen.getByLabelText('标记保留 (Pick)')).toBeInTheDocument();
    expect(screen.getByLabelText('标记淘汰 (Reject)')).toBeInTheDocument();
    expect(screen.getByLabelText('调色面板')).toBeInTheDocument();
    expect(screen.getByLabelText('在 Luminar AI 中修图')).toBeInTheDocument();
    expect(screen.getByLabelText('在修图或外部程序中打开')).toBeInTheDocument();
  });

  it('星标不再用 hover 改尺寸（原来 hover:scale-125 会溢出 24px 命中盒）', () => {
    const { container } = renderFullBar();
    const bar = barOf(container);
    const stars = bar.querySelectorAll('[aria-label^="评 "]');

    expect(stars).toHaveLength(5);
    stars.forEach((star) => {
      expect(star.className, '星标不得缩放').not.toContain('hover:scale');
      // 24×24 保底（WCAG 2.2 SC 2.5.8）要留着。
      expect(star.className).toContain('tap-target');
    });
  });
});

/**
 * 底栏视觉层级（issue #14）。
 *
 * #12 只把**文字**收了起来，图标与底板盒子都还是常驻绘制，用户看到的是
 * 「一条永远在的工具条」，等于没隐藏。本组钉住三件事：
 *
 * 1. 整条 bar 静息时下沉 4px、悬停回到 0 —— 位移走 `translate`，不重排，
 *    所以 #12 的几何冻结不受影响（上一组用例仍在跑，是交叉验证）；
 * 2. 图标静息压到半透明（不是 0：F-02 要求核心动词可发现）；
 * 3. 命中层纯透明，不再自绘 3% 白（那是悬停瞬间多出来的一层「闪」）。
 */
describe('PreviewViewport —— 底栏视觉层级（issue #14）', () => {
  function renderFullBar() {
    render(
      <PreviewViewport
        group={group}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onRate={vi.fn()}
        onFlag={vi.fn()}
        onOpenExternal={vi.fn()}
        onOpenLuminar={vi.fn()}
        onToggleTonalAdjuster={vi.fn()}
      />,
    );
    return { container: document.body };
  }

  function groupHostOf(container: HTMLElement): HTMLElement {
    const anchor = container.querySelector('[aria-label="照片星级打分"]');
    const host = anchor?.closest('div[class*="group/bar"]');
    expect(host, '底栏应带 group/bar 命名组').toBeTruthy();
    return host as HTMLElement;
  }

  function barOf(container: HTMLElement): HTMLElement {
    const host = groupHostOf(container);
    const plate = host.querySelector('[data-bar-hit-area]')?.parentElement;
    expect(plate, '底栏底板应为分组宿主的子层').toBeTruthy();
    return plate as HTMLElement;
  }

  function tokens(el: Element): string[] {
    return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }

  /**
   * 根因防回归（issue #14）。
   *
   * Tailwind 把 `group-hover/bar:x` 编译成**后代选择器**
   * `.group\/bar:hover .group-hover\/bar\:x`。元素不可能是自己的祖先，
   * 所以只要 `group/bar` 和变体类挂在同一个元素上，那 8 条规则**一条都不
   * 命中** —— 而 jsdom 不跑层叠、原先的 className 断言也照样全绿。
   *
   * 这条用例不测「长什么样」，只测「结构与选择器语义一致」：带 `group/bar`
   * 的元素必须是带 `group-hover/bar:` 变体的那个元素的**严格祖先**。
   */
  it('group/bar 必须是变体元素的严格祖先（后代选择器不会把自身当祖先）', () => {
    const { container } = renderFullBar();
    const host = groupHostOf(container);
    const variantEls = Array.from(
      container.querySelectorAll('[class*="group-hover/bar:"], [class*="group-focus-within/bar:"]'),
    );

    expect(variantEls.length, '底栏应存在悬停/聚焦变体').toBeGreaterThan(0);

    for (const el of variantEls) {
      expect(
        el.matches('[class*="group/bar"]'),
        `${(el.getAttribute('class') ?? '').slice(0, 60)} 不得同时挂 group/bar`,
      ).toBe(false);
      expect(
        host.contains(el) && host !== el,
        '带变体的元素必须落在 group/bar 宿主的子树内',
      ).toBe(true);
    }

    // 宿主自己就是那个严格的祖先：底板是它的子层。
    expect(barOf(container).parentElement).toBe(host);
  });

  it('整条 bar 静息下沉、悬停回正：位移只用 translate，且不进几何', () => {
    const { container } = renderFullBar();
    const called = tokens(barOf(container));

    expect(called, '静息应有上浮量').toContain('translate-y-1');
    expect(called, '悬停应回到原位').toContain('group-hover/bar:translate-y-0');
    expect(called, '聚焦也应回到原位').toContain('group-focus-within/bar:translate-y-0');
    // 位移式浮现绝不能用 scale：它会连动命中层并放大像素边界。
    expect(barOf(container).className).not.toMatch(/group-(hover|focus-within)\/bar:scale-/);
  });

  it('图标静息半透明、悬停全亮：用 .bar-icons 统一承载，不是 0（可发现性）', () => {
    const { container } = renderFullBar();
    const bar = barOf(container);
    const star = bar.querySelector('[aria-label="评 1 星"]')!;

    expect(tokens(star), '星标应挂 bar-icons').toContain('bar-icons');
    // 半透明而非全隐：静息态仍要能看出「这里有一排控件」。
    expect(star.className).not.toContain('opacity-0');
    // 取样足够多的按钮，确认不是只给星标挂了。
    const withIcons = bar.querySelectorAll('[class*="bar-icons"]');
    expect(withIcons.length).toBeGreaterThanOrEqual(8);
  });

  it('命中层纯透明：悬停不得自绘背景（去掉 3% 白的那层「闪」）', () => {
    const { container } = renderFullBar();
    const hit = barOf(container).querySelector('[data-bar-hit-area]')!;

    expect(hit.className).not.toContain('group-hover/bar:bg-white/[0.03]');
    expect(hit.className).not.toMatch(/group-(hover|focus-within)\/bar:bg-/);
  });
});
