/**
 * FR-11 Lightroom 导入弹窗 —— 边界优先。
 *
 * 每条断言都对着一个「安静地做错事」的可能：
 * - 覆盖默认勾上 → 用户在 LR 之外做的判断被无提示盖掉；
 * - 写入张数不写在按钮上 → 用户不知道这次会改多少张；
 * - 未匹配不给入口 → 用户无法回答「我明明在 LR 里标了」；
 * - 失败列表不显示路径 → 只给个数字没法去修。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LrcatDialog } from './LrcatDialog';
import { planLrcatImport } from '../utils/lrcatMatch';
import type { LrcatPhoto, LrcatReadResult, PhotoGroupInfo } from '../types';

function group(base: string, over: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id: `D:/shoot/${base}`,
    baseName: base,
    raw: { name: `${base}.ARW`, extension: 'ARW', path: `D:/shoot/${base}.ARW`, size: 1, mtime: 0 },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: false,
    ...over,
  } as PhotoGroupInfo;
}

function photo(over: Partial<LrcatPhoto> = {}): LrcatPhoto {
  return { path: 'D:/shoot/A.ARW', rating: 0, flag: 'none', label: '', ...over };
}

function report(over: Partial<LrcatReadResult> = {}): LrcatReadResult {
  return {
    catalog: 'D:/LR/Lightroom Catalog.lrcat',
    photos: [],
    skippedVirtual: 0,
    total: 0,
    copied: false,
    ...over,
  };
}

const GROUPS = [group('A'), group('B', { rating: 3 })];
const PHOTOS = [
  photo({ path: 'D:/shoot/A.ARW', rating: 5, flag: 'pick' }),
  photo({ path: 'D:/shoot/B.ARW', rating: 5 }),
  photo({ path: 'D:/shoot/GONE.ARW', rating: 1 }),
];

function setup(overrides: Partial<React.ComponentProps<typeof LrcatDialog>> = {}) {
  const onPick = vi.fn();
  const onApply = vi.fn();
  const onCancel = vi.fn();
  const onClose = vi.fn();
  const props: React.ComponentProps<typeof LrcatDialog> = {
    isOpen: true,
    onClose,
    reading: false,
    applying: false,
    report: report({ photos: PHOTOS, total: 3 }),
    plan: planLrcatImport(GROUPS, PHOTOS),
    progress: null,
    failures: null,
    cancelling: false,
    onPick,
    onApply,
    onCancel,
    ...overrides,
  };
  const view = render(<LrcatDialog {...props} />);
  return { ...view, onPick, onApply, onCancel, onClose, props };
}

describe('LrcatDialog —— 入口与统计', () => {
  it('还没读目录时给「选择目录」，不显示统计', () => {
    setup({ report: null, plan: null });
    expect(screen.getByRole('button', { name: /选择目录/ })).toBeTruthy();
    expect(screen.queryByText(/能对上/)).toBeNull();
  });

  it('读完后显示库规模与三格匹配数', () => {
    setup();
    expect(screen.getByText(/库里 3 张/)).toBeTruthy();
    const cells = screen.getByText('能对上').parentElement!;
    expect(within(cells).getByText('2')).toBeTruthy();
    expect(screen.getByText('当前目录没有').parentElement!.textContent).toContain('1');
  });

  it('走复制副本时明确说出来（否则用户以为读的是最新状态）', () => {
    setup({ report: report({ photos: PHOTOS, total: 3, copied: true }) });
    expect(screen.getByText(/Lightroom 正在运行，读的是副本/)).toBeTruthy();
  });

  it('跳过虚拟副本时给出数量', () => {
    setup({ report: report({ photos: PHOTOS, total: 5, skippedVirtual: 2 }) });
    expect(screen.getByText(/跳过虚拟副本 2 张/)).toBeTruthy();
  });
});

describe('LrcatDialog —— 覆盖开关与写入张数', () => {
  it('默认不覆盖：按钮只算空白组（1 张）', () => {
    const { onApply } = setup();
    const btn = screen.getByRole('button', { name: '导入 1 张' });
    expect(btn).toBeTruthy();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText(/跳过 1 张/)).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('勾上覆盖后张数跟着变（2 张）', async () => {
    const { onApply } = setup();
    await userEvent.click(screen.getByRole('checkbox'));
    const btn = screen.getByRole('button', { name: '导入 2 张' });
    await userEvent.click(btn);
    expect(onApply).toHaveBeenCalledWith(true);
  });

  it('没有可写项时按钮禁用，但原因写在状态行', () => {
    setup({ plan: planLrcatImport([group('B', { rating: 3 })], [photo({ path: 'D:/shoot/B.ARW', rating: 5 })]) });
    const btn = screen.getByRole('button', { name: '导入 0 张' });
    expect(btn).toBeDisabled();
    expect(screen.getByRole('status').textContent).toContain('跳过 1 张');
  });
});

describe('LrcatDialog —— 未匹配与失败', () => {
  it('未匹配默认收起，点开才列出来（带路径）', async () => {
    setup();
    expect(screen.queryByText('shoot/GONE.ARW')).toBeNull();
    const toggle = screen.getByRole('button', { name: /Lightroom 有、当前目录没有的 1 张/ });
    await userEvent.click(toggle);
    expect(screen.getByText('shoot/GONE.ARW')).toBeTruthy();
  });

  it('同名匹配的数量单独说明（不让用户以为全是精确路径）', () => {
    const g = group('C');
    const plan = planLrcatImport([g], [photo({ path: 'D:/shoot/C.JPG', rating: 4 })]);
    setup({ plan });
    expect(screen.getByText(/其中 1 张是「同目录同名」对上的/)).toBeTruthy();
  });

  it('失败列表带文件名与原因', () => {
    setup({
      failures: [{ name: 'A', path: 'D:/shoot/A.ARW', reason: 'sidecar 只读' }],
    });
    const box = screen.getByLabelText('导入失败报告');
    expect(within(box).getByText('A')).toBeTruthy();
    expect(within(box).getByText(/sidecar 只读/)).toBeTruthy();
  });

  it('应用中出现进度与取消按钮', () => {
    const { onCancel } = setup({
      applying: true,
      progress: { processed: 1, total: 4 },
    });
    expect(screen.getByText('1 / 4')).toBeTruthy();
    const cancel = screen.getByRole('button', { name: '取消' });
    return userEvent.click(cancel).then(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  it('读取/导入中不允许关闭（防止半截状态）', () => {
    setup({ applying: true });
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  });
});
