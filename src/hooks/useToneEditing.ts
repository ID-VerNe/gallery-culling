import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_TONE, toneEquals } from '../utils/autoTone';
import { groupPath } from '../utils/groupPath';
import { useToneAutoSave } from './useToneAutoSave';
import { useAutoTone } from './useAutoTone';
import { useLumenToneActions } from './useLumenToneActions';
import type { PhotoGroupInfo, ToneAdjustments, ViewMode } from '../types';

/** 兼容：静默窗口常量定义在写盘管线 hook 里，门面 re-export 保持导入路径不变。 */
export { TONE_AUTOSAVE_DEBOUNCE_MS } from './useToneAutoSave';

/**
 * 调色编辑态门面（issue #113：按管线拆分后的组合入口）。
 *
 * 子模块分工：
 * - `useToneAutoSave`：400ms 静默窗口 + 单飞/队列写盘（#67 语义）；
 * - `useAutoTone`：自动调色采样回退链；
 * - `useLumenToneActions`：预设 / 蒙版 / 统一状态读回。
 *
 * 关键不变量：
 * - 编辑只落在 `toneMap`（内存），**不**同步写 `groups[].tone`。后者是
 *   「磁盘真值」的基线，一旦被编辑覆盖，"是否有未保存改动"就无从判断。
 *   保存成功时才把基线更新为新值，dirty 随之清零。
 * - 面板可见性是**派生值**（用户意图 && 当前有可调对象），不是意图本身。
 *   此前显示层只读意图，于是筛选变空时会出现「按钮说开着、屏幕显示着宫格」。
 * - 离开（切图 / 关面板 / 换筛选）前若 dirty，先确认，绝不静默丢改动；
 *   自动保存开启时改为「先 flush 再离开」，不让用户为 400ms 的乐观写盘反复确认。
 */
export function useToneEditing(opts: {
  currentGroup: PhotoGroupInfo | undefined;
  viewMode: ViewMode;
  lumenAvailable: boolean;
  lumenCapsAiMasks: boolean | undefined;
  /** 调色自动保存是否开启（设置项 `toneAutoSave`，默认开启）。 */
  autoSaveEnabled: boolean;
  /** 保存成功后要把新基线写回集合（groups[].tone / hasXmp）。 */
  onGroupsPatched: (id: string, patch: Partial<PhotoGroupInfo>) => void;
  /** AI 蒙版读回后交给上层渲染。 */
  onMasksLoaded: (masks: Array<{ index?: number; name?: string; kind?: string }>) => void;
}) {
  const {
    currentGroup,
    viewMode,
    lumenAvailable,
    lumenCapsAiMasks,
    autoSaveEnabled,
    onGroupsPatched,
    onMasksLoaded,
  } = opts;

  const [toneMap, setToneMap] = useState<Record<string, ToneAdjustments>>({});
  const [showTonalPanel, setShowTonalPanel] = useState(false);
  /** XMP 与 LUMEN RAW 工程两侧调色是否不一致（统一管线的分歧标记） */
  const [toneDivergent, setToneDivergent] = useState(false);
  /** C3：调色未保存时"离开"动作的暂存。用户在确认框里选"放弃改动"才执行它，
      选"继续编辑"就丢弃。null = 没有待确认的离开。 */
  const [pendingLeaveTone, setPendingLeaveTone] = useState<
    { run: () => void } | null
  >(null);

  /** A13：打开调色面板前的焦点元素，关闭时归还（键盘用户的"回家"路径）。 */
  const tonalTriggerRef = useRef<HTMLElement | null>(null);

  /**
   * M-10：调色面板的**单一真值**。
   *
   * `showTonalPanel` 是「用户意图」，`currentGroup` 是「当前是否有可调对象」，
   * 可见性 = 二者与。`showTonalPanel` 保持为意图（筛选恢复后面板自动回来）。
   */
  const tonalPanelVisible = showTonalPanel && !!currentGroup;

  const handleToggleTonalPanel = useCallback(() => {
    // A13：记下打开前的焦点元素，关闭面板时归还焦点，键盘用户不会"迷路"。
    if (!showTonalPanel) {
      const ae = document.activeElement;
      if (ae instanceof HTMLElement) tonalTriggerRef.current = ae;
    }
    setShowTonalPanel((prev) => !prev);
  }, [showTonalPanel]);

  const currentTone = currentGroup
    ? toneMap[currentGroup.id] || currentGroup.tone || DEFAULT_TONE
    : undefined;

  /**
   * 程序化写入内存值：读回真值、套用预设等**不是用户拖动**的场景走这里，
   * 绝不触发自动保存（否则读回即写盘、预设套用后再多写一次）。
   */
  const handleToneChange = useCallback(
    (newTone: ToneAdjustments) => {
      if (!currentGroup) return;
      setToneMap((prev) => ({ ...prev, [currentGroup.id]: newTone }));
    },
    [currentGroup],
  );

  // 写盘管线：成功且仍在当前照片时清分歧标记（与原来 `persistTone` 内
  // `setToneDivergent(false)` 的触发时机一致）。
  const handlePersistSuccess = useCallback(() => {
    setToneDivergent(false);
  }, []);
  const {
    isSavingTone,
    autoSaveStatus,
    autoSaveError,
    flushAutoSave,
    scheduleAutoSave,
    saveToneNow,
  } = useToneAutoSave({
    currentGroup,
    onPersistSuccess: handlePersistSuccess,
    onGroupsPatched,
  });

  /**
   * 用户拖动滑杆 / 自动调色 / 重置：写内存 + （开启时）400ms 静默窗口后写盘。
   *
   * 「写内存」在本门面，「调度写盘」在 `useToneAutoSave`
   * （同一照片连续改动只落盘最后一次；写盘期间的新改动由队列补写）。
   */
  const handleUserToneChange = useCallback(
    (newTone: ToneAdjustments) => {
      if (!currentGroup) return;
      setToneMap((prev) => ({ ...prev, [currentGroup.id]: newTone }));
      if (!autoSaveEnabled) return;
      const path = groupPath(currentGroup);
      if (!path) return;
      scheduleAutoSave({ groupId: currentGroup.id, path, tone: newTone });
    },
    [autoSaveEnabled, currentGroup, scheduleAutoSave],
  );

  /** 重置也是用户改动：自动保存开启时同样要落盘。 */
  const handleResetTone = useCallback(() => {
    if (!currentGroup) return;
    handleUserToneChange({ ...DEFAULT_TONE });
  }, [currentGroup, handleUserToneChange]);

  // 自动调色采样管线（采到的值经 `handleUserToneChange` 写内存并调度）。
  const { isAutoToning, setPreviewImage, handleAutoTone } = useAutoTone({
    currentGroup,
    viewMode,
    lumenAvailable,
    onUserToneChange: handleUserToneChange,
  });

  // LUMEN 预设 / 蒙版 / 状态读回管线（程序化写入走 `handleToneChange`）。
  const { handleApplyLumenPreset, handleApplyLumenMask } = useLumenToneActions({
    currentGroup,
    showTonalPanel,
    lumenCapsAiMasks,
    toneMap,
    onToneChange: handleToneChange,
    onGroupsPatched,
    onMasksLoaded,
    onDivergentChange: setToneDivergent,
  });

  /** C3：调色是否有未保存改动（当前编辑值 ≠ 磁盘基线）。 */
  const toneDirty =
    !!currentGroup &&
    !!currentTone &&
    !toneEquals(currentTone, currentGroup.tone ?? DEFAULT_TONE);

  /**
   * FR-07：批量套用成功后，丢弃这些照片的未保存编辑。
   *
   * 套用写的是磁盘真值，而 `toneMap` 里的旧编辑是内存值且优先级更高
   * （`currentTone` 先读 toneMap）。不清掉的话，用户切过去看到的是套用前的
   * 调色，还会误以为套用失败。一次批量只调一次，避免 N 次 setState。
   */
  const discardToneEditsFor = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setToneMap((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
  }, []);

  /** C3：丢弃当前照片的未保存编辑，回到磁盘基线。 */
  const discardToneEdits = useCallback(() => {
    if (!currentGroup) return;
    discardToneEditsFor([currentGroup.id]);
  }, [currentGroup, discardToneEditsFor]);

  /**
   * C3：离开保护。切图 / 关面板前若存在未保存改动，先弹确认，避免静默丢失。
   * 用户选"放弃改动"才真正执行离开动作（并丢弃内存中的编辑）。
   *
   * issue #67：自动保存开启时不弹确认 —— 待写任务会先 flush，改动不会丢；
   * 让用户为 400ms 的乐观写盘反复点「放弃」只会训练出盲点确认。
   */
  const guardToneLeave = useCallback(
    (run: () => void) => {
      if (autoSaveEnabled) {
        flushAutoSave();
        run();
        return;
      }
      if (toneDirty) {
        setPendingLeaveTone({
          run: () => {
            discardToneEdits();
            run();
          },
        });
      } else {
        run();
      }
    },
    [autoSaveEnabled, flushAutoSave, toneDirty, discardToneEdits],
  );

  /** C3：关闭调色面板（带未保存保护）。 */
  const closeTonePanel = useCallback(() => {
    guardToneLeave(() => setShowTonalPanel(false));
  }, [guardToneLeave]);

  /** 手动保存：清掉待自动保存任务，立即写当前值（不新增第二个入口）。 */
  const handleSaveTone = useCallback(async () => {
    if (!currentGroup) return;
    const toneToSave =
      toneMap[currentGroup.id] || currentGroup.tone || DEFAULT_TONE;
    const targetPath = groupPath(currentGroup);
    if (!targetPath) return;
    await saveToneNow(
      { groupId: currentGroup.id, path: targetPath, tone: toneToSave },
    );
  }, [currentGroup, toneMap, saveToneNow]);

  // L-08：调色面板此前没有任何「按 Esc 关闭」的出口——8 个触发入口都只负责
  // 打开，用户被关进一个只能靠鼠标或原快捷键原路退出的面板。
  //
  // 只在**没有其它弹窗**时生效：各弹窗自己的 Esc 处理优先，否则会出现
  // 「一次 Esc 关两层」（弹窗和面板同时消失）。判断谓词与键盘守卫的
  // `isDialogOpen` 保持一致，避免两处对"什么算弹窗"有不同答案。
  useEffect(() => {
    if (!tonalPanelVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      // C3：走带未保存保护的关闭路径（有改动时先确认）。
      closeTonePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tonalPanelVisible, closeTonePanel]);

  // A13：面板从"可见"变为"不可见"时，把焦点归还给打开它的那个元素。
  const prevTonalVisibleRef = useRef(false);
  useEffect(() => {
    if (prevTonalVisibleRef.current && !tonalPanelVisible) {
      const el = tonalTriggerRef.current;
      if (el && document.contains(el)) el.focus({ preventScroll: true });
      tonalTriggerRef.current = null;
    }
    prevTonalVisibleRef.current = tonalPanelVisible;
  }, [tonalPanelVisible]);

  /** 扫描完成后用 XMP 真值整体替换编辑态（不属于用户编辑，故不逐张 merge）。 */
  const seedToneMap = useCallback((next: Record<string, ToneAdjustments>) => {
    setToneMap(next);
  }, []);

  /** 打开面板前的焦点元素（供上层做「关闭时归还焦点」）。 */
  const triggerRef = tonalTriggerRef;

  return {
    toneMap,
    showTonalPanel,
    tonalPanelVisible,
    toneDivergent,
    isSavingTone,
    isAutoToning,
    pendingLeaveTone,
    currentTone,
    toneDirty,
    setPreviewImage,
    triggerRef,
    handleToggleTonalPanel,
    handleToneChange,
    /** 用户改动入口（滑杆/重置/自动调色）：自动保存开启时会调度写盘。 */
    handleUserToneChange,
    autoSaveStatus,
    autoSaveError,
    handleResetTone,
    discardToneEdits,
    discardToneEditsFor,
    guardToneLeave,
    closeTonePanel,
    handleAutoTone,
    handleSaveTone,
    handleApplyLumenPreset,
    handleApplyLumenMask,
    setPendingLeaveTone,
    setShowTonalPanel,
    /** 扫描完成后用 XMP 真值整体替换编辑态。 */
    seedToneMap,
  };
}
