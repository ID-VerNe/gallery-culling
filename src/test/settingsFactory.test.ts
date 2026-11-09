/**
 * `src/test/settingsFactory.ts` —— AppSettings 共享 mock 工厂（issue #134）。
 *
 * 背景：25 个测试文件各贴一遍 9 字段字面量（`get_settings_cmd` 25 文件 /
 * `mockStartup` 19 处 / `baseSettings` 3 处），加字段即 25 处同改。
 * 本文件把默认 9 字段收敛为单一真值；`toneAutoSave` 的缺键语义必须保留
 * （缺键 = 默认开启，只有显式 `false` 才是关闭，见 `types/index.ts:88-92`）。
 */
import { describe, it, expect } from 'vitest';
import { makeSettings } from './settingsFactory';

describe('makeSettings —— 默认 9 字段（issue #134）', () => {
  it('默认返回与 App.scan.test.tsx:53-63 范本逐值一致', () => {
    expect(makeSettings()).toEqual({
      defaultJpgFolder: 'D:/shoot/JPG',
      defaultRawFolder: '',
      photoshopPath: '',
      thumbnailWidth: 200,
      sortOrder: 'time_filename',
      lumenEnabled: false,
      lumenCliPath: '',
      lumenGridThumbnails: false,
      lumenExpectAi: false,
    });
  });

  it('默认缺 toneAutoSave 键（缺键 = 默认开启语义，不得补 true）', () => {
    expect('toneAutoSave' in makeSettings()).toBe(false);
  });
});

describe('makeSettings —— overrides 透传', () => {
  it('partial 覆盖单个字段，其余保持默认', () => {
    expect(makeSettings({ defaultJpgFolder: '' })).toEqual({
      defaultJpgFolder: '',
      defaultRawFolder: '',
      photoshopPath: '',
      thumbnailWidth: 200,
      sortOrder: 'time_filename',
      lumenEnabled: false,
      lumenCliPath: '',
      lumenGridThumbnails: false,
      lumenExpectAi: false,
    });
  });

  it('可显式透传 toneAutoSave: false（toneAutoSave 显式关闭用例口径）', () => {
    const s = makeSettings({ toneAutoSave: false });
    expect(s.toneAutoSave).toBe(false);
    expect('toneAutoSave' in s).toBe(true);
  });

  it('可显式透传 toneAutoSave: true', () => {
    expect(makeSettings({ toneAutoSave: true }).toneAutoSave).toBe(true);
  });

  it('多次调用返回独立对象（改一个不污染另一个）', () => {
    const a = makeSettings();
    const b = makeSettings();
    expect(a).not.toBe(b);
    a.thumbnailWidth = 999;
    expect(b.thumbnailWidth).toBe(200);
  });
});
