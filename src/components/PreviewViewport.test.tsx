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
import { jpgFile, makeGroup, rawFile } from '../test/factories';

const group = makeGroup('g1', { jpg: jpgFile('g1', 'D:/shoot') });

function renderViewport() {
  const { container } = render(
    <PreviewViewport
      group={group}
      onPrev={vi.fn()}
      onNext={vi.fn()}
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

  const rawGroup = makeGroup('raw1', {
    status: 'RAW_ONLY',
    raw: rawFile('raw1', 'NEF', 'D:/shoot'),
    jpg: undefined,
  });

  function renderRaw(lumenStatus: LumenStatus) {
    const { container } = render(
      <PreviewViewport
        group={rawGroup}
        onPrev={vi.fn()}
        onNext={vi.fn()}

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

  const jpgGroup = makeGroup('jpg1', { jpg: jpgFile('jpg1', 'D:/shoot') });

  const rawGroup = makeGroup('raw1', {
    status: 'RAW_ONLY',
    raw: rawFile('raw1', 'ARW', 'D:/shoot'),
    jpg: undefined,
  });

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

    // 细节到达那一帧（`src` 换掉之前）真实像素宽就已经可知：结果到达的
    // effect 在此时结算落点。jsdom 不加载资源，`onLoad` 也就不保证会来 ——
    // 这条用例正是钉住「不靠 onLoad 也能切到 1:1」。
    stubMetrics(img, 6024, 1200);

    // 细节返回 → src 换成 detail（不再是预览）
    await waitFor(() => expect(img.src).toContain('raw1_detail_lumen.jpg'));

    await waitFor(() => expect(img.style.transform).toContain('scale(5.02)'));
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

  /**
   * 取消 → 再按 Z，而后端那次渲**还在飞**：这是真机上的那一下（取消与重按
   * 只隔 21ms，63s 的那张图就是它）。三件事必须一起成立：
   *
   *   1. 重新认领而不是重发 —— 后端并发上限 1，重发只会换来 E_BUSY；
   *   2. 结果到达后换成细节图，不能当成「已取消」丢掉；
   *   3. 且从 1:1 的落点走到新落点 —— 按下那一刻画面就**当场**切成细节的
   *      落点（图还没到，先按预览算），所以取消之后再按 Z 时模式已经是
   *      1:1；不认领而是走「已在 1:1 → 复位」的话，`enterOneToOne` 根本
   *      不执行，在飞的那次无人认领，图到了也没有人采用（真机 e2e 的
   *      D13/D14）。另一端同理：`src` 从预览换成细节时 React 复用同一个
   *      `<img>` 节点，jsdom 与真浏览器都不保证这期间再送一次 `onLoad`，
   *      所以「换成全分辨率后的落点」由结果到达的 effect 结算，不靠 onLoad。
   *
   * 请求必须在重按那一刻**真的还在飞**：`renderHook` 外面先 `await` 一次
   * `waitFor` 的话，微任务会把那次 drain 的 finally 跑完，`inflightRef`
   * 已经清空，重按就走成了「发第二个请求」—— 那时这条用例测的是别的东西，
   * 还会把认领路径整段漏掉。
   *
   * 中途不能碰任何会改画面的输入：取消按钮之外的一次 `waitFor` 就够把
   * 时序拖过界（第一版写成 `await` 清除横幅，重按落成了「已在 1:1 → 复位」）。
   */
  it('取消 → 再按 Z（渲还在飞）→ 认领这次结果，换成细节并切到 1:1', async () => {
    let releaseDetail: ((v: unknown) => void) | null = null;
    setInvokeHandler((cmd) => {
      if (cmd === 'lumen_detail_cmd') {
        return new Promise((res) => {
          releaseDetail = res;
        });
      }
      if (cmd === 'lumen_preview_cmd') {
        return { previewPath: 'D:/c/p.preview', width: 1600, original: false, cached: false };
      }
      return undefined;
    });

    const { container, ref } = renderWithRef(rawGroup, AVAILABLE);
    const viewportImg = () => container.querySelector('img') as HTMLImageElement;
    await waitFor(() => expect(viewportImg()).not.toBeNull());
    stubMetrics(viewportImg(), 1600, 1200); // 预览阶段：1600px 源

    act(() => ref.current());
    stubMetrics(viewportImg(), 6024, 1200); // 细节图就绪后：6024px 源

    // 后端仍在渲：取消只是不再等。
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    // 反悔：同一张再按 Z。这一下必须认领在飞的那次，而不是重发。
    act(() => ref.current());
    expect(invokeCount('lumen_detail_cmd')).toBe(1);

    // 而且画面不得被复位成「适应」去等结果：那样用户按 Z 反而看到图变小。
    // 取消已经退出了 1:1，这一下按 Z 就得当场回到细节的落点 —— 此刻 src 还
    // 是预览、像素宽已经按细节算好，所以是 6024 / 1200 = 5.02。
    expect(viewportImg().style.transform).toContain('scale(5.02)');

    // 认领之后结果才回来 —— 必须采用，并切到 1:1（6024 / 1200 = 5.02）。
    act(() => {
      releaseDetail?.({ detailPath: 'D:/cache/lumen/raw1_detail.jpg', cached: false, elapsedMs: 6500 });
    });

    await waitFor(() => expect(viewportImg().src).toContain('raw1_detail.jpg'));
    await waitFor(() => expect(viewportImg().style.transform).toContain('scale(5.02)'));
  });

  /**
   * 一次按 Z 只能算一次「进入 1:1」，不能算两次。
   *
   * 若结果到达时无条件再补一次 `zoom.oneToOne()`，用户在这 6–8 秒里已经
   * 按过 Z 退出（或滚轮离开）之后，图一到就会**自己**跳回 1:1 —— 用户没
   * 按键，画面却动了。标志位必须在请求时消费掉，而不是到达时消费。
   */
  /**
   * 等待期间按 Z 回适应 → 图到了也不得自己放大。
   *
   * 回适应是一次明确的「不再等」。它必须同时做到三件事：画面回到适应、
   * 模式记成「不在 1:1」（否则下一次按 Z 会当成「再进一次」而去结算一个
   * 早已放弃的落点）、以及结果到达时不再结算。
   *
   * 前两件由 `oneToOneModeRef` 锁住：把 `oneToOneModeRef.current = false;`
   * 从回适应分支里拿掉，这条用例照样绿 —— 因为那里的 `zoom.reset()` 会触发
   * 离开 1:1 的监听，监听里也清了模式。也就是说模式位是**两条路径共同**的
   * 出口，删掉任何一条都不会被现有用例发现。这一点如实记在这里，不假装
   * 这条用例守住了那条语句。
   *
   * 真正被这条用例钉住的是「结果到达时看 `want` 再结算」：把到达 effect
   * 上的 `!wantOneToOneRef.current` 守卫拿掉（曾经的第一版就没有守卫，
   * 结果一到无条件补一次 `zoom.oneToOne()`），用户按 Z 退出后图一到画面
   * 自己放大 —— 实测落在 scale 1.333，这条用例当场变红。收回请求（再按
   * 一次 Z）与回适应是两个不同的出口，两条路径各有一条用例。
   */
  it('等途中按 Z 回适应 → 细节到达后不得自己放大', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));
    let releaseDetail: ((v: unknown) => void) | null = null;
    setInvokeHandler((cmd) => {
      if (cmd === 'lumen_detail_cmd') {
        return new Promise((res) => {
          releaseDetail = res;
        });
      }
      if (cmd === 'lumen_preview_cmd') {
        return { previewPath: 'D:/c/p.preview', width: 1600, original: false, cached: false };
      }
      return undefined;
    });

    const { container, ref } = renderWithRef(rawGroup, AVAILABLE);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const img = container.querySelector('img') as HTMLImageElement;
    stubMetrics(img, 1600, 1200);

    act(() => ref.current()); // 进 1:1：算出 1600 / 1200 = 1.333，并进入等待
    await screen.findByRole('button', { name: '取消' });
    // 此刻模式是 1:1（落点按预览算出来了），再按 Z 就是回适应。
    act(() => ref.current());
    expect(img.style.transform).toContain('scale(1)');
    // 前端这一侧已经放弃，但后端那张仍在跑：进度提示照旧（它说的是后端的
    // 事，不是「我还想切过去」）。这条断言是下面那条的前提 —— 提示在，才
    // 说明「等待」这个状态真的还在。
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();

    // 结果到达：图片内容仍会被换成细节，但缩放必须停在适应。
    act(() => {
      releaseDetail?.({ detailPath: 'D:/cache/lumen/raw1_detail.jpg', cached: false, elapsedMs: 6500 });
    });
    await waitFor(() => expect(img.src).toContain('raw1_detail.jpg'));

    expect(img.style.transform).toContain('scale(1)');
  });

  it('等途中再按 Z 收回请求 → 细节到达后不得自己跳 1:1', async () => {
    mockInvokeCommand('lumen_preview_cmd', (args) => ({
      previewPath: `${String(args?.filePath)}.preview`,
      width: 1600,
      original: false,
      cached: false,
    }));
    let releaseDetail: ((v: unknown) => void) | null = null;
    setInvokeHandler((cmd) => {
      if (cmd === 'lumen_detail_cmd') {
        return new Promise((res) => {
          releaseDetail = res;
        });
      }
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
    await screen.findByRole('button', { name: '取消' });
    act(() => ref.current()); // 收回：图到了也不要切过去

    act(() => {
      releaseDetail?.({ detailPath: 'D:/cache/lumen/raw1_detail.jpg', cached: false, elapsedMs: 6500 });
    });
    await waitFor(() => expect(img.src).toContain('raw1_detail.jpg'));

    stubMetrics(img, 6024, 1200);
    fireEvent.load(img);

    expect(img.style.transform).toContain('scale(1)');
  });
});

/**
 * 常驻状态栏替代悬浮底栏（issue #62）。
 *
 * #47 把静息态做成整条 `translate-y` 移出视口、只剩 48×4 手柄，用户重启后
 * 以为「菜单栏消失了」。现在底栏统一到窗口底部的文档流状态栏（`BottomBar`），
 * 视口里**不允许**再出现底板 / 手柄 / 旧分组，否则就是双份控件与永久遮挡。
 */
describe('PreviewViewport —— 不再有悬浮底栏（issue #62）', () => {
  function renderViewport() {
    const { container } = render(
      <PreviewViewport group={group} onPrev={vi.fn()} onNext={vi.fn()} />,
    );
    return container;
  }

  it('视口内没有悬浮底板、手柄与旧底栏分组', () => {
    const container = renderViewport();

    expect(container.querySelector('[data-bar-plate]')).toBeNull();
    expect(container.querySelector('[data-bar-handle]')).toBeNull();
    expect(container.querySelector('[aria-label="照片星级打分"]')).toBeNull();
    expect(container.querySelector('[aria-label="照片色标"]')).toBeNull();
    expect(container.querySelector('[data-bar-hit-area]')).toBeNull();
  });

  it('不留下 hover / 位移 / 命中层那套旧机制', () => {
    const container = renderViewport();
    const root = container.querySelector('[data-viewport-photo]');

    expect(root, '照片区需要坐标锚点供 e2e 量边界').not.toBeNull();
    expect(container.querySelectorAll('[class*="group-hover"]')).toHaveLength(0);
    // 允许点击的覆盖层只剩「上一张 / 下一张」两个导航按钮；旧底栏那套
    // 透明命中层（#46 的元凶）必须不存在。
    expect(container.querySelectorAll('[class*="pointer-events-auto"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-bar-hit-area]')).toHaveLength(0);
  });

  it('滚轮缩放不受影响（状态栏改造只搬控件，不动几何）', () => {
    const { container } = render(
      <PreviewViewport group={group} onPrev={vi.fn()} onNext={vi.fn()} />,
    );
    const wheelHost = container.firstElementChild as HTMLElement;
    const img = container.querySelector('img') as HTMLImageElement;

    fireEvent.wheel(wheelHost, { clientX: 600, clientY: 400, deltaY: -100 });
    expect(img.style.transform).toContain('scale(1.25)');
  });

  it('缩放能力通过 onZoomApi 交给宿主状态栏', () => {
    const onZoomApi = vi.fn();
    const { unmount } = render(
      <PreviewViewport group={group} onPrev={vi.fn()} onNext={vi.fn()} onZoomApi={onZoomApi} />,
    );
    expect(onZoomApi).toHaveBeenCalled();
    const calls = onZoomApi.mock.calls;
    const api = calls[calls.length - 1]?.[0];
    expect(api?.scale).toBe(1);
    expect(typeof api?.zoomBy).toBe('function');
    expect(typeof api?.reset).toBe('function');

    unmount();
    expect(onZoomApi).toHaveBeenLastCalledWith(null);
  });
});
