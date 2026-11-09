import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetadataEditorModal } from './MetadataEditorModal';
import { mockInvokeCommand } from '../test/setup';
import { makeGroup, makeFile } from '../test/factories';

const group = makeGroup('IMG_0001', {
  status: 'COMPLETE',
  raw: makeFile('D:/shoot/RAW/IMG_0001.RW2', { extension: 'RW2', size: 1 }),
  jpg: makeFile('D:/shoot/JPG/IMG_0001.JPG', { extension: 'JPG', size: 1 }),
  exif: { lensModel: '50mm', focalLength: '50mm', aperture: 'f/2' },
});

function setup() {
  mockInvokeCommand('batch_update_metadata_cmd', 1);
  mockInvokeCommand('get_lens_presets_cmd', []);
  render(
    <MetadataEditorModal
      isOpen
      onClose={vi.fn()}
      currentGroup={group}
      filteredGroups={[group]}
      allGroups={[group]}
      onMetadataUpdated={vi.fn()}
      onError={vi.fn()}
    />,
  );
}

describe('MetadataEditorModal footer rounded corners (PA-6)', () => {
  it('cancel/close footer button uses rounded-md not rounded-lg', () => {
    setup();
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(cancel.className).toContain('rounded-md');
    expect(cancel.className).not.toContain('rounded-lg');
  });

  it('confirm footer button uses rounded-md not rounded-lg', () => {
    setup();
    const confirm = screen.getByRole('button', { name: /确认并同步/ });
    expect(confirm.className).toContain('rounded-md');
    expect(confirm.className).not.toContain('rounded-lg');
  });
});
