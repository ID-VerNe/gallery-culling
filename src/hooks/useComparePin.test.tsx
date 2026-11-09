/**
 * issue #35（PR #33 的后续）：`togglePinCurrent` 的返回值是「是否真的生效」的
 * 唯一真值。
 *
 * 空格快捷键那条路径靠这个返回值决定要不要 toast —— 如果这里在没有
 * currentGroup 时仍然返回 true / undefined，App 层就会再次播报
 * 「已切换对比基准。」，而界面上什么都没发生（误导性反馈）。
 *
 * 所以本文件同时锁两个方向：no-op 必须返回 `false`；真正切换（钉住或取消）
 * 必须返回 `true`，防止修反了把 SH-03 的成功反馈一起删掉。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useComparePin } from './useComparePin';
import { makeGroup } from '../test/factories';
import type { PhotoGroupInfo } from '../types';

const photo = (id: string) =>
  makeGroup(id, { baseName: `IMG_${id}`, status: 'COMPLETE', jpg: undefined });

function setup(currentGroup: PhotoGroupInfo | undefined, groups: PhotoGroupInfo[] = []) {
  return renderHook(() =>
    useComparePin({
      filteredGroups: groups,
      selectedIndex: 0,
      compareIndex: 1,
      currentGroup,
      onSwapIndices: vi.fn(),
    }),
  );
}

describe('useComparePin —— togglePinCurrent 返回是否真的生效（#35）', () => {
  it('无 currentGroup 时是 no-op：返回 false，pinnedId 不变化', () => {
    const groups = [photo('p1')];
    const { result } = setup(undefined, groups);

    expect(result.current.pinnedId).toBeNull();

    let applied: boolean | void = undefined;
    act(() => {
      applied = result.current.togglePinCurrent();
    });

    // 这一条是本次修复的根：no-op 必须让调用方知道「没生效」。
    expect(applied).toBe(false);
    expect(result.current.pinnedId).toBeNull();
  });

  it('有 currentGroup 时钉住当前照片：返回 true 且 pinnedId 指向它', () => {
    const groups = [photo('p1'), photo('p2')];
    const { result } = setup(groups[0], groups);

    let applied: boolean | void = undefined;
    act(() => {
      applied = result.current.togglePinCurrent();
    });

    expect(applied).toBe(true);
    expect(result.current.pinnedId).toBe('p1');
  });

  it('对同一张再按一次是取消：状态确实变了，仍返回 true', () => {
    const groups = [photo('p1'), photo('p2')];
    const { result } = setup(groups[0], groups);

    act(() => {
      result.current.togglePinCurrent();
    });
    expect(result.current.pinnedId).toBe('p1');

    let applied: boolean | void = undefined;
    act(() => {
      applied = result.current.togglePinCurrent();
    });

    expect(applied).toBe(true);
    expect(result.current.pinnedId).toBeNull();
  });
});
