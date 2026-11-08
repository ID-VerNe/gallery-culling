/**
 * 键位目录的单一事实来源契约（issue #51 / #61）。
 *
 * 底栏速查与帮助弹窗曾经各写一份键位文案：#45 把左手别名上线后，帮助弹窗
 * 改了、底栏没改，用户看到 `P 保留` 会以为别名不存在。本用例把「键位字符串
 * 只许在 catalog 出现一次」钉住：底栏只能按 id 取条目，不能另写一份。
 *
 * issue #61 起右手键全部删除，每个动作只保留左手路径；下面用逐 id 的
 * `keys` 精确断言锁住「不能悄悄把右手键加回来」。
 */
import { describe, expect, it } from 'vitest';
import {
  BAR_SHORTCUT_IDS,
  MOUSE_SHORTCUTS,
  SHORTCUT_GROUPS,
  findShortcut,
} from './shortcutCatalog';

const allItems = [...SHORTCUT_GROUPS.flatMap((group) => group.items), ...MOUSE_SHORTCUTS];

describe('键位目录（issue #51 / #61）', () => {
  it('所有条目 id 全局唯一', () => {
    const ids = allItems.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('底栏子集的每个 id 都能解析到条目', () => {
    for (const id of BAR_SHORTCUT_IDS) {
      expect(findShortcut(id), `底栏引用了不存在的 id: ${id}`).toBeDefined();
    }
  });

  it('底栏只用左手键，且不再出现右手旧键写法', () => {
    const barKeys = BAR_SHORTCUT_IDS.map((id) => findShortcut(id)!.keys);

    // 顺序即底栏展示顺序。
    expect(barKeys).toEqual(['1 ~ 5', 'F', 'X', 'Shift + 1 ~ 5', 'T', 'V（按住）']);

    for (const legacy of ['P', 'Y', '0', 'U', '\\', '6~9', '6 ~ 9']) {
      expect(barKeys).not.toContain(legacy);
    }
  });

  it('每个动作的键位与 issue #61 的裁决表逐字一致（右手键不得回流）', () => {
    const expected: Record<string, string> = {
      prev: 'A',
      next: 'D',
      search: 'Ctrl/⌘ + F',
      'open-external': 'W',
      rating: '1 ~ 5',
      clear: 'R',
      pick: 'F',
      reject: 'X',
      'label-left': 'Shift + 1 ~ 5',
      undo: 'Ctrl/⌘ + Z',
      redo: 'Ctrl/⌘ + Shift + Z',
      'batch-export': 'Ctrl/⌘ + E',
      // issue #79：宫格连选（一只手即可，无需鼠标）。
      'grid-extend-rows': 'Shift + ↑ / ↓',
      'grid-extend-steps': 'Shift + A / D',
      compare: 'C',
      'before-after': 'T',
      tone: 'E',
      'zoom-1to1': 'Z',
      'hold-original': 'V（按住）',
      'base-left': 'Q / B',
      'base-right': 'Shift + Q',
      'base-current': '空格',
      swap: 'S',
      'lens-meta': 'G',
      help: 'F1',
    };

    for (const [id, keys] of Object.entries(expected)) {
      expect(findShortcut(id), `缺少条目: ${id}`).toBeDefined();
      expect(findShortcut(id)!.keys, `${id} 的键位漂移`).toBe(keys);
    }
  });

  it('issue #79：宫格连选键位已登记，且不改 #61 定档的既有键', () => {
    expect(findShortcut('grid-extend-rows')?.keys).toBe('Shift + ↑ / ↓');
    expect(findShortcut('grid-extend-steps')?.keys).toBe('Shift + A / D');
    // 既有键位原样保留，连选只加 Shift 分支。
    expect(findShortcut('prev')?.keys).toBe('A');
    expect(findShortcut('next')?.keys).toBe('D');
    expect(findShortcut('grid-rows')?.keys).toBe('↑ / ↓');
  });

  it('右手旧色标条目已删除', () => {
    expect(findShortcut('label-legacy')).toBeUndefined();
    expect(findShortcut('label-purple')).toBeUndefined();
  });

  it('底栏条目都带短标签，避免把帮助弹窗的长文案塞进 36px 底栏', () => {
    for (const id of BAR_SHORTCUT_IDS) {
      const item = findShortcut(id)!;
      expect(item.barLabel, `${id} 缺少 barLabel`).toBeTruthy();
      expect(item.barLabel!.length).toBeLessThanOrEqual(item.label.length);
    }
  });
});
