/**
 * 扫描会话「恢复/钳制」策略的纯函数单测（issue #112）。
 *
 * 原实现内联在 `AppShell.handleScanned`（空依赖 useCallback，闭包内写着
 * 恢复分支；2026-10-15 e2e run5 实锤用户在扫描窗口内的点击会被会话恢复
 * 覆盖）。抽为纯函数后，恢复/钳制/默认三分支在这里逐条断言；集成侧的
 * 行为仍由 `App.scanRestore.test.tsx` 锁着。
 */
import { describe, it, expect } from 'vitest';
import {
  decideScanIndexRestore,
  effectiveHistoryIndex,
  userMovedDuringScan,
} from './scanSessionPolicy';

describe('userMovedDuringScan', () => {
  it('扫描开始时没有快照（null）→ 不算用户动过', () => {
    expect(userMovedDuringScan(null, 3)).toBe(false);
  });

  it('快照与当前一致 → 用户没动过', () => {
    expect(userMovedDuringScan(2, 2)).toBe(false);
  });

  it('快照与当前不一致 → 用户在扫描窗口内动过', () => {
    expect(userMovedDuringScan(1, 4)).toBe(true);
  });
});

describe('effectiveHistoryIndex', () => {
  const startup = { folder: 'D:/shoot/JPG', index: 7 };

  it('扫描时读回有值 → 以扫描时为准（启动预读不能覆盖它）', () => {
    expect(effectiveHistoryIndex(2, startup, 'D:/shoot/JPG')).toBe(2);
  });

  it('扫描时读回为空、同目录 → 用启动预读兜底', () => {
    expect(effectiveHistoryIndex(null, startup, 'D:/shoot/JPG')).toBe(7);
  });

  it('目录写法分叉（反斜杠/尾斜杠/大小写）仍算同目录', () => {
    expect(effectiveHistoryIndex(null, startup, 'D:\\shoot\\JPG\\')).toBe(7);
  });

  it('扫描时读回为空、目录不同 → 不用预读', () => {
    expect(effectiveHistoryIndex(null, startup, 'D:/other')).toBeNull();
  });

  it('扫描时读回为空、无预读 → null', () => {
    expect(effectiveHistoryIndex(null, null, 'D:/shoot/JPG')).toBeNull();
  });
});

describe('decideScanIndexRestore', () => {
  const base = {
    scannedCount: 5,
    historyIndex: null as number | null,
    selectedIndexAtStart: null as number | null,
    currentSelectedIndex: 0,
    startupHistory: null as { folder: string; index: number } | null,
    scannedJpgFolder: 'D:/shoot/JPG',
  };

  it('用户动过 → clamp（只钳制不恢复，哪怕会话断点有效）', () => {
    expect(
      decideScanIndexRestore({ ...base, historyIndex: 2, selectedIndexAtStart: 1, currentSelectedIndex: 4 }),
    ).toEqual({ kind: 'clamp' });
  });

  it('用户没动、断点有效 → restore，compareIndex = 断点 + 1', () => {
    expect(
      decideScanIndexRestore({ ...base, historyIndex: 2, selectedIndexAtStart: 0, currentSelectedIndex: 0 }),
    ).toEqual({ kind: 'restore', selectedIndex: 2, compareIndex: 3 });
  });

  it('断点在最后一张 → compareIndex 钳到最后一张', () => {
    expect(
      decideScanIndexRestore({ ...base, historyIndex: 4, selectedIndexAtStart: 0, currentSelectedIndex: 0 }),
    ).toEqual({ kind: 'restore', selectedIndex: 4, compareIndex: 4 });
  });

  it('断点越界（新集合更小）→ 默认回第 0 张', () => {
    expect(
      decideScanIndexRestore({ ...base, historyIndex: 9, selectedIndexAtStart: 0, currentSelectedIndex: 0 }),
    ).toEqual({ kind: 'default', selectedIndex: 0, compareIndex: 1 });
  });

  it('无断点 → 默认第 0 张 / 对比第 1 张', () => {
    expect(
      decideScanIndexRestore({ ...base, selectedIndexAtStart: 0, currentSelectedIndex: 0 }),
    ).toEqual({ kind: 'default', selectedIndex: 0, compareIndex: 1 });
  });

  it('只有一张图 → 默认对比位也是 0', () => {
    expect(
      decideScanIndexRestore({ ...base, scannedCount: 1, selectedIndexAtStart: 0, currentSelectedIndex: 0 }),
    ).toEqual({ kind: 'default', selectedIndex: 0, compareIndex: 0 });
  });

  it('扫描时读回为空、同目录预读有效 → 用预读恢复', () => {
    expect(
      decideScanIndexRestore({
        ...base,
        startupHistory: { folder: 'D:/shoot/JPG', index: 3 },
        selectedIndexAtStart: 0,
        currentSelectedIndex: 0,
      }),
    ).toEqual({ kind: 'restore', selectedIndex: 3, compareIndex: 4 });
  });

  it('扫描时读回为空、预读异目录 → 默认（不串目录）', () => {
    expect(
      decideScanIndexRestore({
        ...base,
        startupHistory: { folder: 'D:/other', index: 3 },
        selectedIndexAtStart: 0,
        currentSelectedIndex: 0,
      }),
    ).toEqual({ kind: 'default', selectedIndex: 0, compareIndex: 1 });
  });
});
