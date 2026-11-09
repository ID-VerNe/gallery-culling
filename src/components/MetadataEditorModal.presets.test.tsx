/**
 * 镜头预设 → 镜头元数据表单的桥接集成（ADR-013，issue #114 后仅留桥接）。
 *
 * 纯 CRUD（新增/删除/恢复/校验/兜底）已随 `LensPresetPanel` 迁到 `LensPresetPanel.test.tsx`；
 * 这里只锁：点预设，把型号 / 焦段 / 光圈一起填进父级表单（`handleApplyPreset`）。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MetadataEditorModal } from './MetadataEditorModal';
import { mockInvokeCommand } from '../test/setup';
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

const chip = (name: string) =>
  screen.getByRole('button', { name: new RegExp(`套用预设 ${name}`) });

describe('MetadataEditorModal —— 预设桥接集成（ADR-013）', () => {
  it('点预设把型号 / 焦段 / 光圈一起填进表单', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: /套用预设 Zeiss ZM 35mm F2/ });

    await user.click(chip('Zeiss ZM 35mm F2'));

    expect(screen.getByLabelText('镜头型号')).toHaveValue('Zeiss ZM 35mm F2');
    expect(screen.getByLabelText('焦段 / 焦距')).toHaveValue('35mm');
    expect(screen.getByLabelText('光圈值')).toHaveValue('f/2.0');
  });
});
