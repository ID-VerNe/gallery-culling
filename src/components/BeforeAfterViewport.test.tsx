/**
 * 前后对照视口的缩放与空态护栏（§6 第 11 行「三个视口缩放与翻页」的 Before/After 部分）。
 *
 * 该组件在批次 B 被改造过：`syncLock`（联动锁焦）默认 **true**，关闭后两侧各自持
 * `scale`/位置，并有 `activePane: 'before' | 'after'`（± 与手势只作用于它）。
 * 本文件把「联动 = 两侧同值 / 独立 = 只动当前窗格 / 独立读数分列两侧」钉住，
 * 与 `SplitCompareViewport.test.tsx` 的独立缩放口径对称。
 *
 * 观察到的偏差（已在批次 D 修复，记录备查）：本组件的 props 曾声明
 * `onPrev?`/`onNext?`，App 也确实传了 `handlePrev`/`handleNext`，但组件**从未消费**
 * 它们（无「上一张/下一张」按钮，也不像 `PreviewViewport` 那样有 ChevronLeft/Right
 * 覆盖层）—— 属半成品接线 / 死 API 面。`SplitCompareViewport` 从一开始就没有这对
 * props。处理方式：**删除**这两个未被消费的 props 与 App 侧的传参（而非新增翻页 UI，
 * 那是需要产品确认的功能变更）。因此「点击翻页按钮触发 onPrev/onNext」在本组件上
 * 依旧不成立 —— 翻页由 App 的全局快捷键与单图视口承担。这里不写「永远查不到按钮」
 * 的假用例，只如实说明。
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { BeforeAfterViewport } from './BeforeAfterViewport';
import type { PhotoGroupInfo } from '../types';

function withJpg(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    jpg: { name: `${id}.jpg`, extension: 'jpg', path: `D:/shoot/${id}.jpg`, size: 1, mtime: 0 },
    status: 'JPG_ONLY',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
  };
}

function renderBA(props: Partial<ComponentProps<typeof BeforeAfterViewport>> = {}) {
  const { container } = render(
    <BeforeAfterViewport
      group={withJpg('IMG_0001')}
      onRate={vi.fn()}
      onFlag={vi.fn()}
      {...props}
    />,
  );
  // DOM 顺序即 [before, after]：两个窗格各一张 <img>。
  return { imgs: container.querySelectorAll('img'), container };
}

/** 关闭联动锁焦，进入「独立对照」。 */
const unlock = () => fireEvent.click(screen.getByLabelText('切换前后两图联动缩放'));

describe('BeforeAfterViewport —— 联动/独立缩放', () => {
  it('联动开启（默认）时，放大按钮让两侧同步缩放', () => {
    const { imgs } = renderBA();
    expect(imgs).toHaveLength(2);
    expect(imgs[0].style.transform).toContain('scale(1)');
    expect(imgs[1].style.transform).toContain('scale(1)');

    fireEvent.click(screen.getByLabelText('放大'));

    expect(imgs[0].style.transform).toContain('scale(1.25)');
    expect(imgs[1].style.transform).toContain('scale(1.25)');
    // 联动时只有合并读数（单值）。
    expect(screen.getByLabelText('当前缩放 125%')).toBeInTheDocument();
  });

  it('关闭联动后，放大只作用于当前窗格（默认 after），另一侧纹丝不动', () => {
    const { imgs } = renderBA();
    unlock();

    fireEvent.click(screen.getByLabelText('放大'));

    expect(imgs[1].style.transform).toContain('scale(1.25)'); // after 变
    expect(imgs[0].style.transform).toContain('scale(1)'); // before 不变
  });

  it('独立模式把焦点切到 before 窗格后，放大只作用于 before', () => {
    const { imgs } = renderBA();
    unlock();

    // 在 before 窗格按下鼠标即把 activePane 切到 before（与拖拽/滚轮同一入口）。
    fireEvent.mouseDown(imgs[0].parentElement as HTMLElement, { button: 0 });
    fireEvent.click(screen.getByLabelText('放大'));

    expect(imgs[0].style.transform).toContain('scale(1.25)'); // before 变
    expect(imgs[1].style.transform).toContain('scale(1)'); // after 不变
  });

  it('独立模式的读数分别显示前/后两侧缩放值，并标出聚焦窗格', () => {
    renderBA();
    unlock();

    // 初始两侧都处于「适应」（scale=1），焦点默认在 after。
    // V-01：fit 态读数走 scaleLabel，显示「适应」而非「100%」——原先这里
    // 硬编码 Math.round(scale*100)+'%'，与 Preview/Split 的「适应」措辞不一致，
    // 且同一组件内重置 tooltip 用的却是 scaleLabel，自相矛盾。
    expect(
      screen.getByLabelText('当前缩放：前 适应，后 适应（聚焦后图）'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('放大'));
    // 只有 after 变，before 保持 —— 这正是「独立读数分列两侧」的证据。
    expect(
      screen.getByLabelText('当前缩放：前 适应，后 125%（聚焦后图）'),
    ).toBeInTheDocument();
  });
});

describe('BeforeAfterViewport —— 空态', () => {
  it('没有 group 时渲染统一的空态文案，而不是崩溃', () => {
    render(
      <BeforeAfterViewport
        onRate={vi.fn()}
        onFlag={vi.fn()}
        emptyState={{ title: '未加载照片', description: '选择 JPG 或 RAW 文件夹。' }}
      />,
    );

    expect(screen.getByText('未加载照片')).toBeInTheDocument();
    expect(screen.getByText('选择 JPG 或 RAW 文件夹。')).toBeInTheDocument();
    // 空态下不应残留任何图片或缩放控件。
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.queryByLabelText('放大')).toBeNull();
  });
});

/**
 * 底栏几何契约（issue #12）：与单图视口同一套口径 —— 悬停/聚焦**不改尺寸**。
 *
 * #10 的 `group-hover/bar:px-4 py-2` + `w-0 → w-auto` 让外接盒随悬停变化，
 * 指针在边缘反复进出就会自激闪烁。jsdom 不跑 CSS，所以锁 className：
 * 变体里出现 padding / width / height / scale 即红。
 */
describe('BeforeAfterViewport —— 底栏几何冻结（issue #12）', () => {
  const GEOMETRY_PREFIXES = ['group-hover/bar:', 'group-focus-within/bar:'];
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
    // translate/scale 走合成层、不参与布局，是标签在常驻槽位里淡入的手法；
    // 真浏览器几何验收（静息 == 悬停）兜住例外情况。
    /^text-/,
    /^leading-/,
    /^tracking-/,
  ];

  function classTokens(el: Element): string[] {
    return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }

  function geometryLeaks(el: Element): string[] {
    return classTokens(el).filter((token) => {
      const prefix = GEOMETRY_PREFIXES.find((p) => token.startsWith(p));
      if (!prefix) return false;
      const utility = token.slice(prefix.length);
      return GEOMETRY_UTILITIES.some((re) => re.test(utility));
    });
  }

  /**
   * 底栏分组宿主：带 `group/bar` 命名组的那一层。它是**包裹层**而非底板
   * （issue #14 根因），几何断言瞄准的仍是底板。
   */
  function groupHostOf(container: HTMLElement): HTMLElement {
    const anchor = container.querySelector('[aria-label="照片星级打分"]');
    expect(anchor).not.toBeNull();
    const host = anchor!.closest('div[class*="group/bar"]');
    expect(host, '底栏应带 group/bar 命名组').not.toBeNull();
    return host as HTMLElement;
  }

  /** 底栏底板：分组宿主的直接子层（命中层所在的那一层）。 */
  function barOf(container: HTMLElement): HTMLElement {
    const host = groupHostOf(container);
    const plate = host.querySelector('[data-bar-hit-area]')?.parentElement;
    expect(plate, '底栏底板应为分组宿主的子层').toBeTruthy();
    expect(plate).not.toBe(host);
    return plate as HTMLElement;
  }

  it('底栏与其内部元素都不许用悬停变体改尺寸', () => {
    const { container } = renderBA();
    const bar = barOf(container);

    expect(geometryLeaks(bar)).toEqual([]);
    const leaks: string[] = [];
    bar.querySelectorAll<HTMLElement>('*').forEach((el) => {
      for (const token of geometryLeaks(el)) leaks.push(`${el.tagName}:${token}`);
    });
    expect(leaks).toEqual([]);
  });

  it('Pick / Reject 标签常驻槽位且不换行', () => {
    const { container } = renderBA();
    const bar = barOf(container);

    for (const label of ['Pick', 'Reject']) {
      // 只认按钮里的可见标签（<title> 里也有同名文案）。
      const span = Array.from(bar.querySelectorAll('button > span')).find(
        (el) => el.textContent === label,
      );
      expect(span, `底栏应有「${label}」标签`).toBeDefined();
      const called = classTokens(span!);

      expect(called, `「${label}」不得再用零宽折叠`).not.toContain('w-0');
      expect(span!.className).not.toContain('group-hover/bar:w-auto');
      expect(called, `「${label}」必须禁止换行`).toContain('whitespace-nowrap');
      expect(called, `「${label}」应标 bar-label 槽位`).toContain('bar-label');
    }
  });

  it('静息态无底色：底板底色只在变体上出现', () => {
    const { container } = renderBA();
    const called = classTokens(barOf(container));

    // `group/bar` 现在挂在外层宿主上（issue #14），底板只剩变体类。
    expect(classTokens(groupHostOf(container))).toContain('group/bar');
    expect(called).not.toContain('group/bar');
    expect(called).not.toContain('bg-background-base/90');
    expect(called).not.toContain('shadow-2xl');
    expect(called).toContain('group-hover/bar:bg-background-base/90');
    expect(called).toContain('group-focus-within/bar:bg-background-base/90');
  });

  it('悬停热区是独立层，比底板更大且不受 hover 影响', () => {
    const { container } = renderBA();
    const hit = barOf(container).querySelector('[data-bar-hit-area]');

    expect(hit, '底栏应有独立的透明命中层').not.toBeNull();
    const called = classTokens(hit!);
    expect(called).toContain('-inset-x-3');
    expect(called).toContain('-inset-y-2');
    expect(geometryLeaks(hit!)).toEqual([]);
  });

  it('星标不再用 hover 改尺寸', () => {
    const { container } = renderBA();
    const stars = barOf(container).querySelectorAll('[aria-label^="评 "]');

    expect(stars).toHaveLength(5);
    stars.forEach((star) => {
      expect(star.className).not.toContain('hover:scale');
      expect(star.className).toContain('tap-target');
    });
  });
});

/** 底栏视觉层级（issue #14）：与单图视口同形，共享 `viewportBarStyles.ts`。 */
describe('BeforeAfterViewport —— 底栏视觉层级（issue #14）', () => {
  function tokens(el: Element): string[] {
    return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
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

  /**
   * 根因防回归（issue #14）：Tailwind 把 `group-hover/bar:x` 编译成**后代
   * 选择器**，元素不可能是自己的祖先。`group/bar` 一旦和变体类同元素，
   * 那批规则全部静默失效，而 jsdom 与 className 断言都看不出来。
   */
  it('group/bar 必须是变体元素的严格祖先', () => {
    const { container } = renderBA();
    const host = groupHostOf(container as HTMLElement);
    const variantEls = Array.from(
      container.querySelectorAll('[class*="group-hover/bar:"], [class*="group-focus-within/bar:"]'),
    );

    expect(variantEls.length).toBeGreaterThan(0);
    for (const el of variantEls) {
      expect(el.matches('[class*="group/bar"]')).toBe(false);
      expect(host !== el && host.contains(el)).toBe(true);
    }
    expect(barOf(container as HTMLElement).parentElement).toBe(host);
  });

  it('整条 bar 静息下沉、悬停回正（只用 translate）', () => {
    const { container } = renderBA();
    const bar = barOf(container as HTMLElement);
    const called = tokens(bar);

    expect(called).toContain('translate-y-1');
    expect(called).toContain('group-hover/bar:translate-y-0');
    expect(called).toContain('group-focus-within/bar:translate-y-0');
    expect(bar.className).not.toMatch(/group-(hover|focus-within)\/bar:scale-/);
  });

  it('图标静息半透明（.bar-icons），不是全隐', () => {
    const { container } = renderBA();
    const bar = barOf(container as HTMLElement);
    const star = bar.querySelector('[aria-label="评 1 星"]')!;

    expect(tokens(star)).toContain('bar-icons');
    expect(star.className).not.toContain('opacity-0');
    expect(bar.querySelectorAll('[class*="bar-icons"]').length).toBeGreaterThanOrEqual(7);
  });

  it('命中层纯透明，悬停不自绘背景', () => {
    const { container } = renderBA();
    const hit = barOf(container as HTMLElement).querySelector('[data-bar-hit-area]')!;

    expect(hit.className).not.toMatch(/group-(hover|focus-within)\/bar:bg-/);
  });
});
