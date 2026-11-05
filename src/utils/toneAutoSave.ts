import type { AppSettings } from '../types';

/**
 * 调色自动保存的默认值（issue #67）。
 *
 * 与 Rust 侧 `AppSettings::default().tone_auto_save = true` 同一口径：
 * settings 表**缺 `tone_auto_save` 键** = 用户没设置过 → 开启；
 * 键存在且为 `false` = 用户显式关过 → 保持关闭。
 *
 * 前端只在拿到设置对象后判定一次；`null`（设置尚未读回）按默认开启，
 * 因为启动瞬间用户还看不到面板，不会产生「误以为关着」的写盘。
 */
export const DEFAULT_TONE_AUTO_SAVE = true;

/** 读取「调色自动保存」是否生效；缺键按默认开启。 */
export function isToneAutoSaveEnabled(settings: AppSettings | null): boolean {
  return settings?.toneAutoSave ?? DEFAULT_TONE_AUTO_SAVE;
}
