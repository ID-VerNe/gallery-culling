import { open, save } from '@tauri-apps/plugin-dialog';
import type { OpenDialogOptions, SaveDialogOptions } from '@tauri-apps/plugin-dialog';

/**
 * 对话框取路径收口（issue #118，DRY #7）。
 *
 * `api.ts` 四处 + `lumenApi.ts` 一处以前各自重复尾行
 * `return typeof selected === 'string' ? selected : null;`。本文件只收这一步，
 * dialog 的 options/title/filter 仍由各包装原样构造、不改写。
 */
export function toPath(selected: string | string[] | null | undefined): string | null {
  return typeof selected === 'string' ? selected : null;
}

/**
 * 弹一次对话框并归一所选路径（取消/多选数组一律 null）。
 *
 * - `'open'` 走 `open`，`'save'` 走 `save`（存为选片集必须 save，不能用 open 代替）。
 * - options 原样转发到 dialog。
 */
export async function pickPathWithDialog(
  kind: 'open' | 'save',
  options: OpenDialogOptions | SaveDialogOptions,
): Promise<string | null> {
  const selected =
    kind === 'open'
      ? await open(options as OpenDialogOptions)
      : await save(options as SaveDialogOptions);
  return toPath(selected);
}
