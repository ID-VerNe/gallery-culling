/**
 * 镜头快捷预设的自定义能力（ADR-013）。
 *
 * 锁住的契约：
 *  1. 弹窗里显示的是**库里那份**预设，不是写死的常量；
 *  2. 新增 / 删除 / 恢复默认都会把**完整数组**写回后端（覆盖语义，不是增量）；
 *  3. 「恢复默认」两步确认，第一步绝不发请求；
 *  4. 校验不通过时不发请求，错误就地显示；
 *  5. 读失败退回出厂 6 条 —— 预设挂了不能连带把镜头元数据编辑一起废掉。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MetadataEditorModal } from './MetadataEditorModal';
import {
  invokeCount,
  lastInvokeArgs,
  mockInvokeCommand,
  mockInvokeError,
} from '../test/setup';
import { BUILTIN_LENS_PRESETS } from '../utils/lensPresets';
import type { LensPreset, PhotoGroupInfo } from '../types';

const GET_PRESETS = 'get_lens_presets_cmd';
const SAVE_PRESETS = 'save_lens_presets_cmd';
const BATCH_CMD = 'batch_update_metadata_cmd';

const CUSTOM_PRESETS: LensPreset[] = [
  { name: 'Voigtlander VM 21mm F3.5', focal: '21mm', aperture: 'f/3.5' },
  { name: 'Zeiss ZM 35mm F2', focal: '35mm', aperture: 'f/2.0' },
];

const GROUP: PhotoGroupInfo = {
  id: 'IMG_0001',
  baseName: 'IMG_0001',
  status: 'COMPLETE',
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
  raw: {
    name: 'IMG_0001.RW2',
    extension: 'RW2',
    path: 'D:/shoot/RAW/IMG_0001.RW2',
    size: 1,
    mtime: 0,
  },
  jpg: {
    name: 'IMG_0001.JPG',
    extension: 'JPG',
    path: 'D:/shoot/JPG/IMG_0001.JPG',
    size: 1,
    mtime: 0,
  },
  exif: { lensModel: '', focalLength: '', aperture: '' },
};

function setup(presets: LensPreset[] = CUSTOM_PRESETS) {
  mockInvokeCommand(GET_PRESETS, presets);
  mockInvokeCommand(SAVE_PRESETS, true);
  mockInvokeCommand(BATCH_CMD, 1);

  const onError = vi.fn();
  const user = userEvent.setup();

  render(
    <MetadataEditorModal
      isOpen
      onClose={vi.fn()}
      currentGroup={GROUP}
      filteredGroups={[GROUP]}
      allGroups={[GROUP]}
      onMetadataUpdated={vi.fn()}
      onError={onError}
    />,
  );

  return { user, onError };
}

/** 预设编辑面板（role=group + aria-label，避免和主表单的同名 label 撞车）。 */
const panel = () => within(screen.getByRole('group', { name: '预设编辑' }));
const chip = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`套用预设 ${name}`) });
const openPanel = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: '编辑预设' }));

describe('MetadataEditorModal —— 镜头快捷预设自定义（ADR-013）', () => {
  it('显示的是库里的预设，不是写死的常量', async () => {
    setup();

    expect(await screen.findByRole('button', { name: /套用预设 Voigtlander VM 21mm F3.5/ }))
      .toBeInTheDocument();
    expect(chip('Zeiss ZM 35mm F2')).toBeInTheDocument();
    // 出厂值一个都不该出现 —— 用户删过的东西不能自己长回来
    expect(screen.queryByRole('button', { name: /套用预设 Voigtlander APO-LANTHAR/ }))
      .toBeNull();
  });

  it('点预设把型号 / 焦段 / 光圈一起填进表单', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });

    await user.click(chip('Zeiss ZM 35mm F2'));

    expect(screen.getByLabelText('镜头型号')).toHaveValue('Zeiss ZM 35mm F2');
    expect(screen.getByLabelText('焦段 / 焦距')).toHaveValue('35mm');
    expect(screen.getByLabelText('光圈值')).toHaveValue('f/2.0');
  });

  it('新增预设写回完整数组，并在 chips 里出现', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });
    await openPanel(user);

    await user.type(panel().getByLabelText('镜头型号'), 'Voigtlander VM 40mm F1.2');
    await user.type(panel().getByLabelText('焦段'), '40mm');
    await user.type(panel().getByLabelText('光圈'), 'f/1.2');
    await user.click(panel().getByRole('button', { name: '添加预设' }));

    await waitFor(() => expect(invokeCount(SAVE_PRESETS)).toBe(1));
    expect(lastInvokeArgs(SAVE_PRESETS)).toEqual({
      presets: [
        ...CUSTOM_PRESETS,
        { name: 'Voigtlander VM 40mm F1.2', focal: '40mm', aperture: 'f/1.2' },
      ],
    });

    expect(
      await screen.findByRole('button', { name: /套用预设 Voigtlander VM 40mm F1.2/ }),
    ).toBeInTheDocument();
    // 存成功后表单清空，方便接着录下一支
    expect(panel().getByLabelText('镜头型号')).toHaveValue('');
  });

  it('名字为空时不发请求，错误就地显示', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });
    await openPanel(user);

    await user.click(panel().getByRole('button', { name: '添加预设' }));

    expect(panel().getByRole('alert')).toHaveTextContent('不能为空');
    expect(invokeCount(SAVE_PRESETS)).toBe(0);
  });

  it('重名时不发请求（忽略大小写与空格）', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });
    await openPanel(user);

    await user.type(panel().getByLabelText('镜头型号'), ' zeiss zm 35mm f2 ');
    await user.click(panel().getByRole('button', { name: '添加预设' }));

    expect(panel().getByRole('alert')).toHaveTextContent('已经有一条');
    expect(invokeCount(SAVE_PRESETS)).toBe(0);
  });

  it('删除写回不含该项的数组', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });
    await openPanel(user);

    await user.click(panel().getByRole('button', { name: '删除预设 Zeiss ZM 35mm F2' }));

    await waitFor(() => expect(invokeCount(SAVE_PRESETS)).toBe(1));
    expect(lastInvokeArgs(SAVE_PRESETS)).toEqual({ presets: [CUSTOM_PRESETS[0]] });
    expect(screen.queryByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ })).toBeNull();
  });

  it('编辑中删掉前面那条：编辑目标跟着前移，保存不会写到隔壁', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });
    await openPanel(user);

    // 正在编辑第 2 条（Zeiss），只改光圈
    await user.click(panel().getByRole('button', { name: '编辑预设 Zeiss ZM 35mm F2' }));
    const apertureInput = panel().getByLabelText('光圈');
    await user.clear(apertureInput);
    await user.type(apertureInput, 'f/2.8');

    // 删掉第 1 条 → 下标整体前移，编辑目标必须从 1 变成 0
    await user.click(
      panel().getByRole('button', { name: '删除预设 Voigtlander VM 21mm F3.5' }),
    );
    await waitFor(() => expect(invokeCount(SAVE_PRESETS)).toBe(1));

    await user.click(panel().getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(invokeCount(SAVE_PRESETS)).toBe(2));
    expect(lastInvokeArgs(SAVE_PRESETS)).toEqual({
      presets: [{ name: 'Zeiss ZM 35mm F2', focal: '35mm', aperture: 'f/2.8' }],
    });
  });

  it('删掉正在编辑的那条：退出编辑态，表单清空', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });
    await openPanel(user);

    await user.click(
      panel().getByRole('button', { name: '编辑预设 Voigtlander VM 21mm F3.5' }),
    );
    expect(panel().getByLabelText('镜头型号')).toHaveValue('Voigtlander VM 21mm F3.5');

    await user.click(
      panel().getByRole('button', { name: '删除预设 Voigtlander VM 21mm F3.5' }),
    );

    // 表单回到「新增」态：否则「保存修改」会写进现在的第 1 条（Zeiss）
    await waitFor(() =>
      expect(panel().getByLabelText('镜头型号')).toHaveValue(''),
    );
    expect(panel().getByRole('button', { name: '添加预设' })).toBeInTheDocument();
  });

  it('全部删空后保持为空，不复种出厂值', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });
    await openPanel(user);

    await user.click(panel().getByRole('button', { name: '删除预设 Voigtlander VM 21mm F3.5' }));
    await waitFor(() => expect(invokeCount(SAVE_PRESETS)).toBe(1));
    await user.click(panel().getByRole('button', { name: '删除预设 Zeiss ZM 35mm F2' }));

    await waitFor(() => expect(invokeCount(SAVE_PRESETS)).toBe(2));
    expect(lastInvokeArgs(SAVE_PRESETS)).toEqual({ presets: [] });

    expect(
      screen.getByText(/还没有预设/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /套用预设 Voigtlander APO-LANTHAR/ }))
      .toBeNull();
  });

  it('恢复默认要两步：第一步只出提示，不发请求', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });
    await openPanel(user);

    await user.click(panel().getByRole('button', { name: '恢复默认' }));
    expect(invokeCount(SAVE_PRESETS)).toBe(0);
    expect(panel().getByText(/不可撤销/)).toBeInTheDocument();

    await user.click(panel().getByRole('button', { name: '再点一次确认' }));

    await waitFor(() => expect(invokeCount(SAVE_PRESETS)).toBe(1));
    expect(lastInvokeArgs(SAVE_PRESETS)).toEqual({ presets: BUILTIN_LENS_PRESETS });
    expect(
      await screen.findByRole('button', { name: /套用预设 Voigtlander APO-LANTHAR 50mm F2/ }),
    ).toBeInTheDocument();
  });

  it('读预设失败时退回出厂 6 条，弹窗照常可用', async () => {
    mockInvokeError(GET_PRESETS);
    mockInvokeCommand(BATCH_CMD, 1);
    userEvent.setup();

    render(
      <MetadataEditorModal
        isOpen
        onClose={vi.fn()}
        currentGroup={GROUP}
        filteredGroups={[GROUP]}
        allGroups={[GROUP]}
        onMetadataUpdated={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole('button', { name: /套用预设 Voigtlander APO-LANTHAR 50mm F2/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('镜头型号')).toBeInTheDocument();
  });

  it('保存失败时保留表单内容并报错，不假装成功', async () => {
    const { user, onError } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });
    await openPanel(user);

    mockInvokeError(SAVE_PRESETS);
    await user.type(panel().getByLabelText('镜头型号'), 'VM 40mm F1.2');
    await user.click(panel().getByRole('button', { name: '添加预设' }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('保存镜头预设失败')),
    );
    // 用户刚打的字还在，可以直接重试
    expect(panel().getByLabelText('镜头型号')).toHaveValue('VM 40mm F1.2');
    // chips 里也不该出现一条库里并不存在的预设
    expect(screen.queryByRole('button', { name: /套用预设 VM 40mm F1.2/ })).toBeNull();
  });
});
