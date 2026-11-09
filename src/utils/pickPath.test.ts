/**
 * `pickPath` 收口的护栏（issue #118，DRY #7）。
 *
 * 五个对话框包装（api.ts 四处 + lumenApi.ts 一处）以前各自重复尾行
 * `return typeof selected === 'string' ? selected : null;`。本文件钉死：
 *  - `toPath` 只认字符串，null / 数组（多选）/ 非字符串一律归 null（取消 ≠ 空串）；
 *  - `pickPathWithDialog` 原样转发 options，且 open/save 走各自通道（存为必须 save）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { open, save } from '@tauri-apps/plugin-dialog';
import { toPath, pickPathWithDialog } from './pickPath';

beforeEach(() => {
  (open as ReturnType<typeof vi.fn>).mockReset();
  (save as ReturnType<typeof vi.fn>).mockReset();
  (open as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (save as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe('toPath', () => {
  it('字符串原样返回', () => {
    expect(toPath('D:/a/b.jpg')).toBe('D:/a/b.jpg');
  });

  it('null（取消）归 null，不变成空串', () => {
    expect(toPath(null)).toBeNull();
  });

  it('undefined 归 null', () => {
    expect(toPath(undefined)).toBeNull();
  });

  it('数组（多选结果）一律归 null，不取第一项', () => {
    expect(toPath(['D:/a.jpg', 'D:/b.jpg'])).toBeNull();
  });

  it('非字符串运行时值归 null（防御类型外回传）', () => {
    expect(toPath(42 as unknown as string)).toBeNull();
  });
});

describe('pickPathWithDialog', () => {
  it('open：options 原样转发并透传所选路径', async () => {
    (open as ReturnType<typeof vi.fn>).mockResolvedValue('D:/shoot');
    const options = { directory: true, multiple: false, title: '选择照片文件夹' };
    await expect(pickPathWithDialog('open', options)).resolves.toBe('D:/shoot');
    expect(open).toHaveBeenCalledWith(options);
    expect(save).not.toHaveBeenCalled();
  });

  it('open：取消（null）返回 null', async () => {
    (open as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(pickPathWithDialog('open', { title: '打开选片集' })).resolves.toBeNull();
  });

  it('open：多选数组结果归 null', async () => {
    (open as ReturnType<typeof vi.fn>).mockResolvedValue(['D:/a.jpg']);
    await expect(pickPathWithDialog('open', { multiple: true })).resolves.toBeNull();
  });

  it('save：走 save 通道（不是 open），透传所选路径', async () => {
    (save as ReturnType<typeof vi.fn>).mockResolvedValue('D:/存为.galleryalbum');
    const options = { title: '存为选片集', filters: [{ name: '选片集', extensions: ['galleryalbum'] }] };
    await expect(pickPathWithDialog('save', options)).resolves.toBe('D:/存为.galleryalbum');
    expect(save).toHaveBeenCalledWith(options);
    expect(open).not.toHaveBeenCalled();
  });

  it('save：取消返回 null', async () => {
    (save as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(pickPathWithDialog('save', { title: '存为选片集' })).resolves.toBeNull();
  });

  it('filter/title 不改写：原样到 dialog', async () => {
    (open as ReturnType<typeof vi.fn>).mockResolvedValue('D:/x.lrcat');
    const options = {
      multiple: false,
      directory: false,
      title: '选择 Lightroom 目录',
      filters: [{ name: 'Lightroom 目录', extensions: ['lrcat'] }],
    };
    await pickPathWithDialog('open', options);
    expect(open).toHaveBeenCalledWith(options);
  });
});
