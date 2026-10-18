/**
 * H-03 —— 批量镜头元数据同步的默认范围与二次确认。
 *
 * 四条契约：
 *  1. 默认范围必须是「仅当前照片」（爆炸半径 = 1）；
 *  2. 目标 > 1 张时，首次点击确认只弹二次确认、**不写盘**；
 *  3. 二次确认通过后才调用 batch_update_metadata_cmd，且 filePaths 数 == 目标数；
 *  4. 目标 == 1 张时无需二次确认，直接写盘。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MetadataEditorModal } from './MetadataEditorModal';
import { invokeCount, lastInvokeArgs, mockInvokeCommand } from '../test/setup';
import type { PhotoGroupInfo } from '../types';

const BATCH_CMD = 'batch_update_metadata_cmd';

function makeGroup(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    status: 'COMPLETE',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
    raw: {
      name: `${id}.RW2`,
      extension: 'RW2',
      path: `D:/shoot/RAW/${id}.RW2`,
      size: 1,
      mtime: 0,
    },
    jpg: {
      name: `${id}.JPG`,
      extension: 'JPG',
      path: `D:/shoot/JPG/${id}.JPG`,
      size: 1,
      mtime: 0,
    },
    // 预填 EXIF：打开模态后校验即可通过（模拟当前照片本身带镜头信息）。
    exif: { lensModel: 'Voigtlander APO-LANTHAR 50mm F2', focalLength: '50mm', aperture: 'f/2.0' },
  };
}

const GROUP_1 = makeGroup('IMG_0001');
const GROUP_2 = makeGroup('IMG_0002');
const GROUP_3 = makeGroup('IMG_0003');
const ALL_GROUPS = [GROUP_1, GROUP_2, GROUP_3];

function setup() {
  // 后端返回「已写入张数」；这里给足，组件只把它拼进成功文案。
  mockInvokeCommand(BATCH_CMD, ALL_GROUPS.length);

  const onClose = vi.fn();
  const onError = vi.fn();
  const onMetadataUpdated = vi.fn();
  const user = userEvent.setup();

  render(
    <MetadataEditorModal
      isOpen
      onClose={onClose}
      currentGroup={GROUP_1}
      filteredGroups={ALL_GROUPS}
      allGroups={ALL_GROUPS}
      onMetadataUpdated={onMetadataUpdated}
      onError={onError}
    />,
  );

  return { user, onClose, onError, onMetadataUpdated };
}

const currentRadio = () => screen.getByRole('radio', { name: /仅当前选中照片/ });
const allRadio = () => screen.getByRole('radio', { name: /全部扫描照片/ });
const primaryButton = () => screen.getByRole('button', { name: /确认并同步/ });

describe('MetadataEditorModal —— 批量同步范围（H-03）', () => {
  it('默认同步范围是「仅当前照片」', () => {
    setup();

    expect(currentRadio()).toBeChecked();
    expect(allRadio()).not.toBeChecked();
    // footer 必须把范围名写出来，而不是只显示数字。
    expect(screen.getByText('「仅当前照片」')).toBeInTheDocument();
    expect(primaryButton()).toHaveTextContent('仅当前照片');
  });

  it('选择「全部扫描照片」后首次点击不写盘，只弹二次确认', async () => {
    const { user } = setup();

    await user.click(allRadio());
    expect(allRadio()).toBeChecked();

    await user.click(primaryButton());

    // 关键断言：二次确认之前，磁盘写操作一次都不能发生。
    expect(invokeCount(BATCH_CMD)).toBe(0);
    expect(
      screen.getByText(`将覆盖 ${ALL_GROUPS.length} 张照片的镜头信息`),
    ).toBeInTheDocument();
  });

  it('二次确认通过后才调用 batchUpdateMetadata，且 filePaths 数 == 全部照片数', async () => {
    const { user } = setup();

    await user.click(allRadio());
    await user.click(primaryButton());

    // 二次确认里的确认按钮
    await user.click(
      screen.getByRole('button', { name: new RegExp(`仍然覆盖 ${ALL_GROUPS.length} 张`) }),
    );

    await waitFor(() => expect(invokeCount(BATCH_CMD)).toBe(1));

    const args = lastInvokeArgs(BATCH_CMD) as { filePaths: string[] } | undefined;
    expect(args?.filePaths).toHaveLength(ALL_GROUPS.length);
  });

  it('张数为 1 时不需要二次确认，直接提交', async () => {
    const { user } = setup();

    // 默认范围 = 仅当前照片（1 张）
    await user.click(primaryButton());

    await waitFor(() => expect(invokeCount(BATCH_CMD)).toBe(1));
    expect(screen.queryByText(/将覆盖 \d+ 张照片的镜头信息/)).toBeNull();

    const args = lastInvokeArgs(BATCH_CMD) as { filePaths: string[] } | undefined;
    expect(args?.filePaths).toHaveLength(1);
  });
});
