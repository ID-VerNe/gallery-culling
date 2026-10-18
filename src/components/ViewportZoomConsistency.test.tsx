/**
 * 三视口缩放读数与 a11y 的一致性契约（UX-04 / UX-05 / V-04 / V-05 / V-07）。
 *
 * 这些修复的共同点是「同一个语义在三处必须说同一句话」：
 *   - 读数走同一个 scaleLabel（fit 态说「适应」，不是「100%」）
 *   - aria-label 不得出现 `250%%` / `适应%` 这类拼接事故
 *   - 重置按钮的 aria-label 必须带上当前缩放（tooltip 有，SR 不能没有）
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SplitCompareViewport } from './SplitCompareViewport';
import { BeforeAfterViewport } from './BeforeAfterViewport';
import { ExifCapsule } from './ExifCapsule';
import type { PhotoGroupInfo, LumenStatus } from '../types';

vi.mock('../services/api', () => ({
  api: {
    toAssetUrl: (p: string) => `asset://${p}`,
    applyLumenPreview: vi.fn(),
  },
}));

const lumenStatus = {
  available: false,
  version: '',
  message: '',
} as unknown as LumenStatus;

/** Split 的必填 props 的最小合法集合。 */
function renderSplit() {
  return render(
    <SplitCompareViewport
      leftGroup={group('a')}
      rightGroup={group('b')}
      isLeftPinned={false}
      isRightPinned={false}
      onTogglePinLeft={() => {}}
      onTogglePinRight={() => {}}
      onSwap={() => {}}
      onRate={() => {}}
      onFlag={() => {}}
      lumenStatus={lumenStatus}
    />,
  );
}

function group(id: string): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    jpg: { name: `${id}.JPG`, extension: 'JPG', path: `D:/s/${id}.JPG`, size: 1, mtime: 0 },
    raw: { name: `${id}.CR3`, extension: 'CR3', path: `D:/s/${id}.CR3`, size: 1, mtime: 0 },
    status: 'PAIRED',
    rating: 0,
    flag: 'none',
    label: '', hasXmp: false,
    exif: {
      cameraModel: 'Canon EOS R5',
      lensModel: 'RF 24-70',
      focalLength: '50mm',
      aperture: 'f/2.8',
      shutterSpeed: '1/250',
      iso: 400,
      dateTime: '2026:10:13 10:00:00',
    },
  } as unknown as PhotoGroupInfo;
}

describe('视口缩放读数一致性', () => {
  it('UX-04：Split 的 aria-label 不得出现重复百分号或「适应%」', () => {
    renderSplit();
    const labels = screen.getAllByLabelText(/当前缩放/).map((el) => el.getAttribute('aria-label'));
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l).not.toBeNull();
      expect(l!).not.toContain('%%');
      expect(l!).not.toContain('适应%');
    }
  });

  it('UX-05：BeforeAfter fit 态读数为「适应」，与 Preview/Split 措辞一致', () => {
    render(
      <BeforeAfterViewport
        group={group('a')}
        onRate={() => {}}
        onFlag={() => {}}
      />,
    );
    // scale=1 实为「适应窗口」，原先硬编码显示 100%
    expect(screen.getByLabelText('当前缩放 适应')).toBeTruthy();
  });

  it('V-04：重置按钮的 aria-label 必须含当前缩放（不能只有 title 有）', () => {
    renderSplit();
    const reset = screen.getAllByLabelText(/^重置缩放与平放|^重置缩放与平移/)[0];
    expect(reset.getAttribute('aria-label')).toMatch(/当前/);
  });
});

describe('V-07：EXIF 在三视口都要可见', () => {
  it('Preview 呈现相机型号', () => {
    render(<ExifCapsule exif={group('a').exif} />);
    expect(screen.getByText('Canon EOS R5')).toBeTruthy();
    expect(screen.getByText('50mm')).toBeTruthy();
  });

  it('ExifCapsule 在无 EXIF 时不渲染任何东西', () => {
    const { container } = render(<ExifCapsule exif={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('BeforeAfter 也呈现 EXIF（原先该视口完全没有）', () => {
    render(
      <BeforeAfterViewport
        group={group('a')}
        onRate={() => {}}
        onFlag={() => {}}
      />,
    );
    expect(screen.getAllByText('Canon EOS R5').length).toBeGreaterThan(0);
  });
});
