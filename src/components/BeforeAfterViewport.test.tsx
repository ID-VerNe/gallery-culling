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
 * 底栏折叠态（issue #10）：与单图视口同一套形态 —— 常驻图标，悬停/聚焦才展开标签。
 * jsdom 不跑 CSS，故断言 DOM 结构契约（`w-0` 折叠容器 + `group-hover/bar:` 变体）。
 */
describe('BeforeAfterViewport —— 底栏常驻图标 / 悬停展开（issue #10）', () => {
  function barOf(container: HTMLElement): HTMLElement {
    const anchor = container.querySelector('[aria-label="照片星级打分"]');
    expect(anchor).not.toBeNull();
    return anchor!.parentElement as HTMLElement;
  }

  it('静息态：Pick / Reject 标签折叠为零宽，展开态挂在悬停与聚焦变体上', () => {
    const { container } = renderBA();
    const bar = barOf(container);

    for (const label of ['Pick', 'Reject']) {
      // 只认元素自身文本就是该标签的 <span>：<title> 里也有同名文案。
      // 只认按钮里的可见标签（<button> 下还挂着一个同名 <title>）。
      const span = Array.from(bar.querySelectorAll('button > span')).find(
        (el) => el.textContent === label,
      );
      expect(span, `底栏应有「${label}」标签`).toBeDefined();
      const wrapper = span!;
      expect(wrapper.className).toContain('w-0');
      expect(wrapper.className).toContain('group-hover/bar:w-auto');
      expect(wrapper.className).toContain('group-focus-within/bar:w-auto');
    }
  });

  it('静息态：底板不直接生效，只在展开变体上出现', () => {
    const { container } = renderBA();
    const classes = barOf(container).className.split(/\s+/);

    expect(classes).toContain('group/bar');
    expect(classes).not.toContain('bg-background-base/90');
    expect(classes).not.toContain('shadow-2xl');
    expect(classes).toContain('group-hover/bar:bg-background-base/90');
    expect(classes).toContain('group-focus-within/bar:bg-background-base/90');
  });
});
