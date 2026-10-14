/**
 * WP6 索引联动回归矩阵（N-01 / N-03）。
 *
 * 这两条缺陷都藏在 `filterMode × gridSearch × pinnedId` 的组合里，且只在
 * 「钉了基准之后再走到某个特定下标」时才现形 —— 靠渲染整体 App 很难穷举，
 * 所以推导被抽到 `deriveCompareGroups` 纯函数，这里逐个组合断言。
 */
import { describe, it, expect } from 'vitest';
import { deriveCompareGroups } from './compareGroups';
import type { PhotoGroupInfo } from '../types';

const g = (id: string, baseName: string): PhotoGroupInfo => ({
  id,
  baseName,
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  hasXmp: false,
});

const three = [g('a', 'IMG_0001'), g('b', 'IMG_0002'), g('c', 'IMG_0003')];

describe('deriveCompareGroups —— 无基准', () => {
  it('左 = 当前选中，右 = 当前候选，两侧不同', () => {
    const r = deriveCompareGroups(three, 0, 1, null, false);
    expect(r.leftCompareGroup?.id).toBe('a');
    expect(r.rightCompareGroup?.id).toBe('b');
    expect(r.isLeftPinned).toBe(false);
    expect(r.isRightPinned).toBe(false);
  });

  it('候选撞上选中下标 → 右回退到相邻一张（同图守卫）', () => {
    const r = deriveCompareGroups(three, 1, 1, null, false);
    expect(r.leftCompareGroup?.id).toBe('b');
    expect(r.rightCompareGroup?.id).not.toBe('b');
    expect(r.rightCompareGroup?.id).toBe('c');
  });

  it('选中在末位、候选撞上时 → 回退到工作集里任意另一张', () => {
    const r = deriveCompareGroups(three, 2, 2, null, false);
    expect(r.leftCompareGroup?.id).toBe('c');
    expect(r.rightCompareGroup?.id).not.toBe('c');
  });
});

describe('deriveCompareGroups —— 钉左基准 (N-01)', () => {
  it('左 = 基准，右 = 候选', () => {
    const r = deriveCompareGroups(three, 0, 2, 'a', true);
    expect(r.leftCompareGroup?.id).toBe('a');
    expect(r.rightCompareGroup?.id).toBe('c');
    expect(r.isLeftPinned).toBe(true);
    expect(r.isRightPinned).toBe(false);
  });

  it('候选走到基准下标时不得左右同图（修复前：同一张）', () => {
    // 钉左基准 = IMG_0001，compareIndex 又被移回 0 → 两侧都会指向 a。
    const r = deriveCompareGroups(three, 0, 0, 'a', true);
    expect(r.leftCompareGroup?.id).toBe('a');
    expect(r.rightCompareGroup?.id).not.toBe('a');
  });
});

describe('deriveCompareGroups —— 钉右基准 (N-01)', () => {
  it('右 = 基准，左 = 当前选中', () => {
    const r = deriveCompareGroups(three, 0, 1, 'c', false);
    expect(r.rightCompareGroup?.id).toBe('c');
    expect(r.leftCompareGroup?.id).toBe('a');
    expect(r.isRightPinned).toBe(true);
    expect(r.isLeftPinned).toBe(false);
  });

  it('选中走到基准下标时不得左右同图（修复前：同一张）', () => {
    // 钉右基准 = IMG_0003，连续 next 直到 selectedIndex 落在基准上。
    const r = deriveCompareGroups(three, 2, 0, 'c', false);
    expect(r.rightCompareGroup?.id).toBe('c');
    expect(r.leftCompareGroup?.id).not.toBe('c');
  });
});

describe('deriveCompareGroups —— 基准被筛出工作集 (N-03)', () => {
  it('基准不在工作集内 → 不再谎称「已钉」', () => {
    // 搜索命中只剩 IMG_0001，而基准是 IMG_0003。
    const visible = [g('a', 'IMG_0001')];
    const r = deriveCompareGroups(visible, 0, 0, 'c', true);
    expect(r.isLeftPinned).toBe(false);
    expect(r.isRightPinned).toBe(false);
    expect(r.leftCompareGroup?.id).toBe('a');
  });

  it('基准回到工作集后，「已钉」状态自动恢复（pinnedId 未被清除）', () => {
    const r = deriveCompareGroups(three, 1, 0, 'c', true);
    expect(r.isLeftPinned).toBe(true);
    expect(r.leftCompareGroup?.id).toBe('c');
  });
});

describe('deriveCompareGroups —— 退化输入', () => {
  it('空工作集：不崩，两侧皆 undefined', () => {
    const r = deriveCompareGroups([], 0, 0, null, false);
    expect(r.leftCompareGroup).toBeUndefined();
    expect(r.rightCompareGroup).toBeUndefined();
  });

  it('只剩一张：允许左右同图（无从回退），但不崩', () => {
    const one = [g('a', 'IMG_0001')];
    const r = deriveCompareGroups(one, 0, 0, null, false);
    expect(r.leftCompareGroup?.id).toBe('a');
    expect(r.rightCompareGroup?.id).toBe('a');
  });

  it('基准 id 指向已消失的照片：等同未钉', () => {
    const r = deriveCompareGroups(three, 0, 1, 'ghost', true);
    expect(r.isLeftPinned).toBe(false);
    expect(r.isRightPinned).toBe(false);
    expect(r.leftCompareGroup?.id).toBe('a');
  });
});
