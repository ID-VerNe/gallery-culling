/**
 * FR-10 选片集弹窗 —— 边界优先。
 *
 * 每一条断言都对着一个「安静地做错事」的可能：
 * - 保存范围没写在按钮上 → 用户存了他没想存的那批；
 * - 0 张时只给灰按钮不给原因 → 看起来像坏了；
 * - 缺失项没列出来 → 用户不知道少的是哪几张（验收标准就这一条）；
 * - 报告只有计数没有文件名 → 计数没法修，文件名才能去找。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlbumDialog } from './AlbumDialog';
import type { AlbumOpenResult } from '../types';

function report(missing: number): AlbumOpenResult {
  const entries = Array.from({ length: 3 }, (_, i) => ({
    source: `raw/DSC${i}.ARW`,
    path: `D:/shoot/raw/DSC${i}.ARW`,
    exists: i >= missing,
    isRaw: true,
    size: 1,
    mtime: 1,
    jpgPath: null,
    jpgExists: false,
    jpgSize: 0,
    jpgMtime: 0,
    hasXmp: false,
    tone: null,
    rating: i === 0 ? 3 : 0,
    flag: i === 0 ? 'pick' : 'none',
    label: '',
  }));
  return { path: 'D:/shoot/pick.galleryalbum', entries, missing };
}

function setup(overrides: Partial<React.ComponentProps<typeof AlbumDialog>> = {}) {
  const onSave = vi.fn();
  const onOpen = vi.fn();
  const onDismissReport = vi.fn();
  const onClose = vi.fn();
  render(
    <AlbumDialog
      isOpen
      onClose={onClose}
      totalCount={156}
      filteredCount={42}
      selectedCount={0}
      saveScope="filtered"
      albumPath={null}
      saving={false}
      opening={false}
      report={null}
      onSave={onSave}
      onOpen={onOpen}
      onDismissReport={onDismissReport}
      {...overrides}
    />,
  );
  return { onSave, onOpen, onDismissReport, onClose };
}

describe('AlbumDialog —— 保存范围', () => {
  it('没有多选时存「当前筛选」，张数写在按钮上', () => {
    setup();
    expect(screen.getByRole('button', { name: /存为选片集/ })).toHaveTextContent(
      '存为选片集（当前筛选 42 张）',
    );
  });

  it('有多选时存「选中」，且不再提筛选 —— 范围不能让用户猜', () => {
    setup({ selectedCount: 5, saveScope: 'selected' });
    expect(screen.getByRole('button', { name: /存为选片集/ })).toHaveTextContent(
      '存为选片集（选中 5 张）',
    );
  });

  it('没有可保存的照片时按钮禁用，并把原因写在屏幕上', () => {
    setup({ filteredCount: 0 });
    expect(screen.getByRole('button', { name: /存为选片集/ })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('当前筛选下没有照片');
  });

  it('一张都没加载时，原因换成「先扫描或打开」', () => {
    setup({ totalCount: 0, filteredCount: 0 });
    expect(screen.getByRole('status')).toHaveTextContent('还没有加载照片');
  });

  it('点击保存/打开分别落到各自回调', async () => {
    const { onSave, onOpen } = setup();
    await userEvent.click(screen.getByRole('button', { name: /存为选片集/ }));
    await userEvent.click(screen.getByRole('button', { name: '打开选片集' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('进行中时两个按钮都禁用（避免重复写盘/重复开文件对话框）', () => {
    setup({ saving: true });
    expect(screen.getByRole('button', { name: /存为选片集/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '打开选片集' })).toBeDisabled();
  });
});

describe('AlbumDialog —— 缺失报告', () => {
  it('没有报告时不渲染报告区', () => {
    setup();
    expect(screen.queryByLabelText('缺失文件报告')).not.toBeInTheDocument();
  });

  it('有报告时列出缺失的文件名，并说清没被从选片集里删掉', () => {
    setup({ report: report(2) });
    const box = screen.getByLabelText('缺失文件报告');
    expect(within(box).getByText('2 张找不到（其余 1 张已载入）')).toBeInTheDocument();
    // 缺的是前两张（exists=false）
    expect(within(box).getByText('raw/DSC0.ARW')).toBeInTheDocument();
    expect(within(box).getByText('raw/DSC1.ARW')).toBeInTheDocument();
    expect(within(box).queryByText('raw/DSC2.ARW')).not.toBeInTheDocument();
    expect(within(box).getByText(/没有被从选片集里删掉/)).toBeInTheDocument();
  });

  it('缺失项带上「原来是什么标记」，用户能判断要不要找回', () => {
    setup({ report: report(2) });
    const box = screen.getByLabelText('缺失文件报告');
    expect(within(box).getByText(/原 3★ 保留/)).toBeInTheDocument();
  });

  it('「收起」只清报告', async () => {
    const { onDismissReport, onClose } = setup({ report: report(1) });
    await userEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(onDismissReport).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('已经打开的选片集名写在当前状态行里', () => {
    setup({ albumPath: 'D:/shoot/pick.galleryalbum' });
    expect(screen.getByText('来自选片集 pick.galleryalbum')).toBeInTheDocument();
  });
});
