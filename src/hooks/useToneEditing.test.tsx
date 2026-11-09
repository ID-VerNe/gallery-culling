/**
 * 调色编辑门面（`useToneEditing`）的管线级锁定（issue #113）。
 *
 * 本文件守的是**自动保存写盘管线**这一条行为契约，拆分（useToneAutoSave /
 * useAutoTone / useLumenToneActions）前后必须原样成立：
 * - 400ms 静默窗口：窗口内多次拖动只落盘一次，且落的是最后一次的值；
 * - 单飞队列：写盘进行中到达的新值按 group 入队，当前次落地后补写，不丢；
 * - flush-on-leave：离开动作（guardToneLeave）立即落盘，不等窗口；
 * - 公开返回面：恰好 28 个字段，名字/顺序与拆分前一致（门面兼容的验收锚点）。
 *
 * 变异靶点：把 `TONE_AUTOSAVE_DEBOUNCE_MS` 改成 0、把队列的 Map 改成单槽覆盖、
 * 或删/改任一返回字段，三者都应让本文件变红。
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  TONE_AUTOSAVE_DEBOUNCE_MS,
  useToneEditing,
} from './useToneEditing';
import { invokeCalls, mockInvokeCommand } from '../test/setup';
import { DEFAULT_TONE } from '../utils/autoTone';
import type { PhotoGroupInfo } from '../types';

const group: PhotoGroupInfo = {
  id: 'g1',
  baseName: 'IMG_0001',
  jpg: {
    name: 'IMG_0001.jpg',
    extension: 'jpg',
    path: 'D:/shoot/JPG/IMG_0001.jpg',
    size: 1024,
    mtime: 0,
  },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
};

const toneReport = {
  xmpWritten: true,
  lumenApplied: false,
  projectPath: null,
  warnings: [],
};

function makeGroup(id: string, baseName: string): PhotoGroupInfo {
  return {
    ...group,
    id,
    baseName,
    jpg: {
      ...group.jpg!,
      name: `${baseName}.jpg`,
      path: `D:/shoot/JPG/${baseName}.jpg`,
    },
  };
}
function setup(opts: { currentGroup?: PhotoGroupInfo | undefined } = {}) {
  mockInvokeCommand('apply_tone_cmd', toneReport);
  const hook = renderHook(
    (props: { currentGroup: PhotoGroupInfo | undefined }) =>
      useToneEditing({
        currentGroup: props.currentGroup,
        viewMode: 'single',
        lumenAvailable: false,
        lumenCapsAiMasks: undefined,
        autoSaveEnabled: true,
        onGroupsPatched: () => {},
        onMasksLoaded: () => {},
      }),
    { initialProps: { currentGroup: opts.currentGroup ?? group } },
  );
  return hook;
}

const toneCalls = () => invokeCalls('apply_tone_cmd');
const toneOf = (i: number) => ({ ...DEFAULT_TONE, exposure: i });

describe('useToneEditing —— 公开返回面（issue #113）', () => {
  it('返回面恰好 28 个字段，名字与顺序不变', () => {
    const { result } = setup();
    expect(Object.keys(result.current)).toEqual([
      'toneMap',
      'showTonalPanel',
      'tonalPanelVisible',
      'toneDivergent',
      'isSavingTone',
      'isAutoToning',
      'pendingLeaveTone',
      'currentTone',
      'toneDirty',
      'setPreviewImage',
      'triggerRef',
      'handleToggleTonalPanel',
      'handleToneChange',
      'handleUserToneChange',
      'autoSaveStatus',
      'autoSaveError',
      'handleResetTone',
      'discardToneEdits',
      'discardToneEditsFor',
      'guardToneLeave',
      'closeTonePanel',
      'handleAutoTone',
      'handleSaveTone',
      'handleApplyLumenPreset',
      'handleApplyLumenMask',
      'setPendingLeaveTone',
      'setShowTonalPanel',
      'seedToneMap',
    ]);
  });

  it('静默窗口常量仍是 400ms（#67）', () => {
    expect(TONE_AUTOSAVE_DEBOUNCE_MS).toBe(400);
  });
});

describe('useToneEditing —— 自动保存管线（issue #113）', () => {
  it('400ms 窗口内连续 user 变更只写一次盘，落的是最后一次的值', async () => {
    const { result } = setup();

    act(() => {
      result.current.handleUserToneChange(toneOf(1));
      result.current.handleUserToneChange(toneOf(2));
      result.current.handleUserToneChange(toneOf(3));
    });

    // 静默窗口未结束前绝不允许写盘：这条打红"debounce 改成 0"的变异。
    await new Promise((r) => setTimeout(r, 200));
    expect(toneCalls()).toHaveLength(0);

    await waitFor(() => expect(toneCalls()).toHaveLength(1), {
      timeout: 2000,
    });
    expect(toneCalls()[0].args?.tone).toEqual(toneOf(3));
    expect(toneCalls()[0].args?.filePath).toBe('D:/shoot/JPG/IMG_0001.jpg');

    // 过期的拖动不应该再补写第二次。
    await new Promise((r) => setTimeout(r, 600));
    expect(toneCalls()).toHaveLength(1);
  });

  it('写盘进行中 g1/g2 两个待写任务共存，逐张补写不丢较早那张（单飞 Map 队列）', async () => {
    const deferred: Array<(value: unknown) => void> = [];
    const g2 = makeGroup('g2', 'IMG_0002');
    const { result, rerender } = setup();
    // setup() 之后覆盖：第一次写盘停在 pending，才能稳定制造“在写”窗口。
    mockInvokeCommand(
      'apply_tone_cmd',
      () => new Promise((resolve) => deferred.push(resolve)),
    );

    // 第一次写盘：手动保存 g1，停在 pending 制造“在写”窗口。
    let savePromise: Promise<void> | undefined;
    act(() => {
      savePromise = result.current.handleSaveTone();
    });
    expect(toneCalls()).toHaveLength(1);

    // g1 在写；g2 的新值也到达并经 flush 入队（单槽实现会把 g1 覆盖成 g2）。
    act(() => {
      result.current.handleUserToneChange(toneOf(9));
      result.current.guardToneLeave(() => {});
    });
    rerender({ currentGroup: g2 });
    act(() => {
      result.current.handleUserToneChange(toneOf(8));
      result.current.guardToneLeave(() => {});
    });
    // 还在 g1 写盘中，入队不应另开写。
    expect(toneCalls()).toHaveLength(1);

    deferred[0](toneReport);
    await waitFor(() => expect(toneCalls()).toHaveLength(2), {
      timeout: 2000,
    });
    // 队列按 group 保留：较早的 g1 值先落地（单槽变异会丢 g1，只剩 g2）。
    expect(toneCalls()[1].args?.tone).toEqual(toneOf(9));
    expect(toneCalls()[1].args?.filePath).toBe('D:/shoot/JPG/IMG_0001.jpg');

    deferred[1](toneReport);
    await waitFor(() => expect(toneCalls()).toHaveLength(3), {
      timeout: 2000,
    });
    expect(toneCalls()[2].args?.tone).toEqual(toneOf(8));
    expect(toneCalls()[2].args?.filePath).toBe('D:/shoot/JPG/IMG_0002.jpg');
    deferred[2]?.(toneReport);
    await savePromise;
  });

  it('guardToneLeave 立即 flush 待写任务，不等 400ms 窗口', async () => {
    const { result } = setup();

    act(() => {
      result.current.handleUserToneChange(toneOf(1));
    });
    expect(toneCalls()).toHaveLength(0);

    act(() => {
      result.current.guardToneLeave(() => {});
    });
    expect(toneCalls()).toHaveLength(1);
    expect(toneCalls()[0].args?.tone).toEqual(toneOf(1));
  });
});
