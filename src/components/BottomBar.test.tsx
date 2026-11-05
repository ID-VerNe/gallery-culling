/**
 * 底栏 = 常驻状态栏契约（issue #62）与速查文案契约（issue #51）。
 *
 * #62 把「悬浮底栏 + 手柄」换成窗口底部的文档流状态栏：核心选片状态
 * （星级 / 旗标 / 色标）与关键参数必须**永远可见**，不允许 hover-only；
 * 双图要在同一行里区分左右窗格。本文件同时保留 #51 的键位文案断言。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BottomBar, type StatusPane } from './BottomBar';
import { BAR_SHORTCUT_IDS, findShortcut } from '../utils/shortcutCatalog';
import type { PhotoGroupInfo, ToneAdjustments } from '../types';

const group: PhotoGroupInfo = {
  id: 'g1',
  baseName: 'DSC_0001',
  jpg: {
    name: 'DSC_0001.JPG',
    extension: 'jpg',
    path: 'D:/shoot/DSC_0001.JPG',
    size: 1_789_000,
    mtime: 0,
  },
  raw: {
    name: 'DSC_0001.NEF',
    extension: 'NEF',
    path: 'D:/shoot/DSC_0001.NEF',
    size: 25_060_000,
    mtime: 0,
  },
  status: 'COMPLETE',
  rating: 3,
  flag: 'pick',
  label: 'Red',
  hasXmp: true,
  exif: {
    focalLength: '50mm',
    aperture: 'f/2.0',
    shutterSpeed: '1/250s',
    iso: 'ISO100',
    lensModel: 'FE 50mm F1.8',
  },
};

const tone: ToneAdjustments = {
  exposure: 0.3,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tint: 0,
  contrast: 0,
};

function makePane(overrides: Partial<StatusPane> = {}): StatusPane {
  return {
    group,
    onRate: vi.fn(),
    onFlag: vi.fn(),
    onLabel: vi.fn(),
    ...overrides,
  };
}

function renderBar(extra: Partial<React.ComponentProps<typeof BottomBar>> = {}) {
  const onOpenShortcutHelp = extra.onOpenShortcutHelp ?? vi.fn();
  render(
    <BottomBar
      currentIndex={0}
      totalCount={10}
      onOpenExternal={vi.fn()}
      onOpenShortcutHelp={onOpenShortcutHelp}
      {...extra}
    />,
  );
  return onOpenShortcutHelp;
}

function bar(): HTMLElement {
  const el = document.querySelector('[data-status-bar]');
  expect(el, '状态栏应挂 data-status-bar').not.toBeNull();
  return el as HTMLElement;
}

describe('常驻状态栏（issue #62）', () => {
  it('是文档流里的 footer：不悬浮、不位移、不透明隐藏、不横向滚动', () => {
    renderBar({ panes: [makePane()] });
    const el = bar();

    expect(el.tagName).toBe('FOOTER');
    expect(el.className).toContain('shrink-0');
    expect(el.className).not.toContain('absolute');
    expect(el.className).not.toContain('fixed');
    expect(el.className).not.toContain('translate-y');
    expect(el.className).not.toContain('overflow-x-auto');
    // 常驻可见：不允许 opacity-0 / group-hover 这一套。
    expect(el.querySelectorAll('[class*="opacity-0"]')).toHaveLength(0);
    expect(el.querySelectorAll('[class*="group-hover"]')).toHaveLength(0);
  });

  it('组顺序固定：身份 → 参数 → 评级 → 旗标 → 色标', () => {
    renderBar({ panes: [makePane()] });
    const pane = document.querySelector('[data-status-pane="single"]') as HTMLElement;
    const order = Array.from(pane.querySelectorAll('[data-status-group]')).map((el) =>
      el.getAttribute('data-status-group'),
    );

    expect(order).toEqual(['identity', 'params', 'rating', 'flag', 'label']);
  });

  it('参数只取真实字段：文件名 / EXIF / 曝光，不出现编造占位', () => {
    renderBar({ panes: [makePane({ tone })] });

    expect(screen.getByText('DSC_0001')).toBeInTheDocument();
    expect(screen.getByText('50mm · f/2.0 · 1/250s · ISO100')).toBeInTheDocument();
    expect(screen.getByText(/EV \+0\.30/)).toBeInTheDocument();
    // 拿不到的字段不显示，也不写「未知 / N/A」占位。
    expect(screen.queryByText(/未知|N\/A|未读取/)).toBeNull();
  });

  it('没有 EXIF 时不渲染参数组（不留空占位）', () => {
    renderBar({ panes: [makePane({ group: { ...group, exif: undefined } })] });
    expect(document.querySelector('[data-status-group="params"]')).toBeNull();
  });

  it('星级点击把目标值交给宿主；点当前星级 = 清零', () => {
    const onRate = vi.fn();
    renderBar({ panes: [makePane({ onRate })] });

    fireEvent.click(screen.getByRole('button', { name: '评 4 星' }));
    expect(onRate).toHaveBeenCalledWith(4);

    fireEvent.click(screen.getByRole('button', { name: '评 3 星' }));
    expect(onRate).toHaveBeenLastCalledWith(0);
  });

  it('旗标状态常驻：aria-pressed 跟随 pick / reject', () => {
    renderBar({ panes: [makePane()] });
    expect(screen.getByRole('button', { name: '标记保留 (Pick)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '标记淘汰 (Reject)' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('色标状态常驻：当前色点带 aria-pressed，鼠标可改（SH-01）', () => {
    const onLabel = vi.fn();
    renderBar({ panes: [makePane({ onLabel })] });

    expect(screen.getByRole('button', { name: '红色标（快捷 6）' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '蓝色标（快捷 9）' }));
    expect(onLabel).toHaveBeenCalledWith('Blue');

    // SH-01 的原场景：紫色不能只靠 Shift+6，鼠标必须点得到。
    fireEvent.click(screen.getByRole('button', { name: '紫色标（快捷 Shift+6）' }));
    expect(onLabel).toHaveBeenLastCalledWith('Purple');
  });

  it('双图：左右窗格各自分组、各自回调，不串味（SH-01）', () => {
    const leftRate = vi.fn();
    const rightRate = vi.fn();
    const leftLabel = vi.fn();
    const rightLabel = vi.fn();
    renderBar({
      panes: [
        makePane({ slot: 'L', onRate: leftRate, onLabel: leftLabel }),
        makePane({
          slot: 'R',
          group: { ...group, id: 'g2', baseName: 'DSC_0002', rating: 1 },
          onRate: rightRate,
          onLabel: rightLabel,
        }),
      ],
    });

    expect(screen.getByRole('group', { name: '左窗格 DSC_0001' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '右窗格 DSC_0002' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '左窗格：评 4 星' }));
    expect(leftRate).toHaveBeenCalledWith(4);
    expect(rightRate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '右窗格：评 2 星' }));
    expect(rightRate).toHaveBeenCalledWith(2);
    expect(leftRate).toHaveBeenCalledTimes(1);

    // 色标也必须按窗格分流：给左图点红标不能误改右图。
    fireEvent.click(screen.getByRole('button', { name: '左窗格 DSC_0001：蓝色标（快捷 9）' }));
    expect(leftLabel).toHaveBeenCalledWith('Blue');
    expect(rightLabel).not.toHaveBeenCalled();
  });

  it('宽度预算：单图参数组在 lg 出现，双图要等 xl，避免挤爆 1024', () => {
    const { unmount } = render(<BottomBar currentIndex={0} totalCount={1} onOpenExternal={vi.fn()} panes={[makePane()]} />);
    const singleParams = document.querySelector('[data-status-group="params"]') as HTMLElement;
    expect(singleParams.className).toContain('hidden');
    expect(singleParams.className).toContain('lg:flex');
    unmount();

    render(
      <BottomBar
        currentIndex={0}
        totalCount={2}
        onOpenExternal={vi.fn()}
        panes={[makePane({ slot: 'L' }), makePane({ slot: 'R' })]}
      />,
    );
    const splitParams = document.querySelectorAll('[data-status-group="params"]')[0] as HTMLElement;
    expect(splitParams.className).toContain('hidden');
    expect(splitParams.className).toContain('xl:flex');
  });

  it('禁用原因常驻屏幕，不只放 title：撤销/重做/缩放边界', () => {
    renderBar({
      panes: [makePane()],
      canUndo: false,
      canRedo: false,
      zoom: { label: '400%', atMin: false, atMax: true, onZoomOut: vi.fn(), onZoomIn: vi.fn(), onReset: vi.fn() },
    });

    expect(screen.getByRole('button', { name: '撤销（没有可撤销的改动）' }).textContent).toContain('：无');
    expect(screen.getByRole('button', { name: '重做（没有可重做的改动）' }).textContent).toContain('：无');
    expect(screen.getByText('400%·最大')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '放大' })).toBeDisabled();
  });

  it('禁用态解释不依赖 hover：可见文字里有原因', () => {
    renderBar({ panes: [makePane()], canUndo: false, canRedo: false });
    const undo = screen.getByRole('button', { name: '撤销（没有可撤销的改动）' });
    expect(undo.className).not.toContain('group-hover');
    expect(undo.textContent).toContain('：无');
  });

  it('无照片时显示「未加载照片」，外部打开隐藏而不是留一个不可聚焦的禁用按钮', () => {
    renderBar({ panes: [] });
    expect(screen.getByText('未加载照片')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /外部程序/ })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* issue #51：速查文案必须来自键位目录                                          */
/* -------------------------------------------------------------------------- */

function barKeyCaps(): string[] {
  const el = screen.getByRole('group', { name: '常用快捷键提示' });
  return Array.from(el.querySelectorAll('[data-shortcut-keys]')).map(
    (item) => item.getAttribute('data-shortcut-keys') ?? '',
  );
}

describe('底栏速查（issue #51）', () => {
  it('键帽文案逐条来自键位目录，不各写一份', () => {
    renderBar();
    expect(barKeyCaps()).toEqual(BAR_SHORTCUT_IDS.map((id) => findShortcut(id)!.keys));
  });

  it('左手单手可读：F / P、Shift + 1 ~ 5、T / Y、V / \\（按住）都在', () => {
    renderBar();
    const keys = barKeyCaps();
    expect(keys).toContain('F / P');
    expect(keys).toContain('Shift + 1 ~ 5');
    expect(keys).toContain('T / Y');
    expect(keys).toContain('V / \\（按住）');
  });

  it('不再出现旧键独有写法（裸 P / 6~9 / 裸 Y）', () => {
    renderBar();
    const keys = barKeyCaps();
    for (const legacy of ['P', '6~9', '6 ~ 9', 'Y']) {
      expect(keys).not.toContain(legacy);
    }
  });

  it('只保留最高频 6 项，其余交给帮助弹窗（防撑破 36px 底栏）', () => {
    renderBar();
    const keys = barKeyCaps();
    expect(keys).toHaveLength(6);
    for (const moved of ['A / D', 'C', 'E']) {
      expect(keys).not.toContain(moved);
    }
  });

  it('「全部快捷键」入口仍可用', () => {
    const onOpenShortcutHelp = renderBar();
    const [entry] = screen.getAllByRole('button', { name: '查看全部快捷键' });
    fireEvent.click(entry);
    expect(onOpenShortcutHelp).toHaveBeenCalledTimes(1);
  });
});
