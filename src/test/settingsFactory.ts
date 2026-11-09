/**
 * `AppSettings` 共享 mock 工厂（issue #134）。
 *
 * 25 个测试文件各贴一遍 9 字段字面量（`get_settings_cmd` 25 文件 /
 * `mockStartup` 19 处 / `baseSettings` 3 处），加字段即 25 处同改。
 * 本模块是测试侧 9 字段默认值的**单一真值**（取 `App.scan.test.tsx:53-63`
 * 范本），生产默认值不在此定义——生产代码与默认值不在本单范围。
 *
 * 关键约束：默认**刻意不含** `toneAutoSave` 键。缺键 = 默认开启，只有
 * 显式 `false` 才是用户主动关闭（见 `types/index.ts:88-92` 与
 * `toneAutoSave.test.ts` 的口径），不可默认补 `true`，否则
 * 「没设置过」会被误判为「显式开启」。
 */

import type { AppSettings } from '../types';

/**
 * 造一份默认 AppSettings（9 必需字段，缺 `toneAutoSave`）。
 *
 * 参数为部分覆盖并整体透传展开；传 `toneAutoSave: false/true` 即显式声明
 * 自动保存开关（`App.toneAutoSave.test.tsx` 的两种设置态由它表达）。
 *
 * @example
 * mockInvokeCommand('get_settings_cmd', makeSettings());
 * mockInvokeCommand('get_settings_cmd', makeSettings({ defaultJpgFolder: '' }));
 */
export function makeSettings(partial: Partial<AppSettings> = {}): AppSettings {
  return {
    defaultJpgFolder: 'D:/shoot/JPG',
    defaultRawFolder: '',
    photoshopPath: '',
    thumbnailWidth: 200,
    sortOrder: 'time_filename',
    lumenEnabled: false,
    lumenCliPath: '',
    lumenGridThumbnails: false,
    lumenExpectAi: false,
    ...partial,
  };
}
