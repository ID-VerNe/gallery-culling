/**
 * 调色自动保存默认值口径（issue #67）。
 *
 * 「没设置过」与「显式关过」的唯一区分点是 `toneAutoSave` 是否存在：
 * - 缺键（全新安装 / 老库还没写过该键）→ 默认开启；
 * - 显式 `false` → 保持关闭，绝不因为「默认改成开」就覆盖用户的显式选择。
 */
import { describe, it, expect } from 'vitest';
import type { AppSettings } from '../types';
import { DEFAULT_TONE_AUTO_SAVE, isToneAutoSaveEnabled } from './toneAutoSave';

const base = (patch: Partial<AppSettings> = {}): AppSettings =>
  ({
    defaultJpgFolder: '',
    defaultRawFolder: '',
    photoshopPath: '',
    thumbnailWidth: 200,
    sortOrder: 'time_filename',
    lumenEnabled: false,
    lumenCliPath: '',
    lumenExpectAi: false,
    ...patch,
  }) as AppSettings;

describe('isToneAutoSaveEnabled —— 默认值口径', () => {
  it('设置尚未加载（null）时按默认开启', () => {
    expect(isToneAutoSaveEnabled(null)).toBe(true);
  });

  it('老设置对象没有 toneAutoSave 键 → 默认开启', () => {
    expect(isToneAutoSaveEnabled(base())).toBe(true);
  });

  it('用户显式关掉 → 保持关闭', () => {
    expect(isToneAutoSaveEnabled(base({ toneAutoSave: false }))).toBe(false);
  });

  it('用户显式开启 → 开启', () => {
    expect(isToneAutoSaveEnabled(base({ toneAutoSave: true }))).toBe(true);
  });

  it('默认值常量与默认行为一致', () => {
    expect(DEFAULT_TONE_AUTO_SAVE).toBe(true);
  });
});
