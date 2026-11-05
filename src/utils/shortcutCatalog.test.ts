/**
 * 键位目录的单一事实来源契约（issue #51）。
 *
 * 底栏速查与帮助弹窗曾经各写一份键位文案：#45 把左手别名（`F` / `Shift+1~5`
 * / `T` / `V`）上线后，帮助弹窗改了、底栏没改，用户看到 `P 保留` 会以为别名
 * 不存在。本用例把「键位字符串只许在 catalog 出现一次」钉住：底栏只能按 id
 * 取条目，不能另写一份。
 */
import { describe, expect, it } from 'vitest';
import {
  BAR_SHORTCUT_IDS,
  MOUSE_SHORTCUTS,
  SHORTCUT_GROUPS,
  findShortcut,
} from './shortcutCatalog';

const allItems = [...SHORTCUT_GROUPS.flatMap((group) => group.items), ...MOUSE_SHORTCUTS];

describe('键位目录（issue #51）', () => {
  it('所有条目 id 全局唯一', () => {
    const ids = allItems.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('底栏子集的每个 id 都能解析到条目', () => {
    for (const id of BAR_SHORTCUT_IDS) {
      expect(findShortcut(id), `底栏引用了不存在的 id: ${id}`).toBeDefined();
    }
  });

  it('底栏文案已换成左手别名，且不再出现旧键独有写法', () => {
    const barKeys = BAR_SHORTCUT_IDS.map((id) => findShortcut(id)!.keys);

    // 左手在前、旧键在后；顺序即底栏展示顺序。
    expect(barKeys).toEqual([
      '1 ~ 5',
      'F / P',
      'X',
      'Shift + 1 ~ 5',
      'T / Y',
      'V / \\（按住）',
    ]);

    // 旧键独有写法（裸 P / 6~9 / 裸 Y）不许再出现在底栏。
    for (const legacy of ['P', '6~9', '6 ~ 9', 'Y']) {
      expect(barKeys).not.toContain(legacy);
    }
  });

  it('底栏条目都带短标签，避免把帮助弹窗的长文案塞进 36px 底栏', () => {
    for (const id of BAR_SHORTCUT_IDS) {
      const item = findShortcut(id)!;
      expect(item.barLabel, `${id} 缺少 barLabel`).toBeTruthy();
      expect(item.barLabel!.length).toBeLessThanOrEqual(item.label.length);
    }
  });
});
