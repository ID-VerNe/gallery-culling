import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { computeAutoTone, DEFAULT_TONE, toneEquals } from '../utils/autoTone';
import { groupPath } from '../utils/groupPath';
import type { PhotoGroupInfo, ToneAdjustments, ViewMode } from '../types';

/**
 * 调色自动保存的静默窗口（issue #67）。
 *
 * 与 `.plan/adr-002-write-coalescing.md` 的 400ms 合并窗口取同一时长：
 * 连续拖动期间只折叠成一次写盘。ADR-002 的 Coalescer 只服务评级/旗标/色标，
 * 调色还带 `.lumen` 工程写入，语义不同，因此折叠发生在调用侧而不是第二套后端队列。
 */
export const TONE_AUTOSAVE_DEBOUNCE_MS = 400;

/** 一次待落盘的调色任务：拍照/路径/值在**调度时**固化，切图后仍能正确写回。 */
interface ToneSaveJob {
  groupId: string;
  path: string;
  tone: ToneAdjustments;
}

/**
 * 调色编辑态：内存中的调色值、面板开关、离开保护、保存与 AI 蒙版。
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
  const toast = useToast();

  const [toneMap, setToneMap] = useState<Record<string, ToneAdjustments>>({});
  const [showTonalPanel, setShowTonalPanel] = useState(false);
  /** XMP 与 LUMEN RAW 工程两侧调色是否不一致（统一管线的分歧标记） */
  const [toneDivergent, setToneDivergent] = useState(false);
  /** 调色保存进行中：禁用保存按钮并挡住重入，避免连点写两次 XMP/工程。 */
  const [isSavingTone, setIsSavingTone] = useState(false);
  /** UX-12：auto-tone 计算中。RAW-only 要等 LUMEN 预览渲染，采样也是异步的，
      全程数秒无任何反馈，按钮看起来像没生效。 */
  const [isAutoToning, setIsAutoToning] = useState(false);
  /** 自动保存的可见状态（issue #67）：保存中 / 已保存 / 失败。 */
  const [autoSaveStatus, setAutoSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  /** 自动保存失败原因（常驻在面板里，不随 toast 消失）。 */
  const [autoSaveError, setAutoSaveError] = useState<string | null>(null);
  /** 400ms 静默窗口的计时器；同一时刻只允许一个。 */
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 等待窗口结束的任务（已固化 groupId/path/tone，切图后仍能写回原照片）。 */
  const pendingAutoSaveRef = useRef<ToneSaveJob | null>(null);
  /** 正在写盘：自动保存与手动保存共用，避免同一张照片并发写 XMP/工程。 */
  const saveInFlightRef = useRef(false);
  /** 写盘期间又产生的新值：按 groupId 各留最新一份，当前这次落地后逐条补写。 */
  const queuedAutoSaveRef = useRef<Map<string, ToneSaveJob>>(new Map());
  /** 当前正在看的照片 id（写盘完成时用来判断状态该不该显示在这一张上）。 */
  const currentGroupIdRef = useRef<string | undefined>(opts.currentGroup?.id);
  /** 真正写盘的单飞函数（定义在下方，供计时器与 flush 回调调用）。 */
  const persistToneRef = useRef<((job: ToneSaveJob, auto: boolean) => Promise<void>) | null>(
    null,
  );
  /** C3：调色未保存时"离开"动作的暂存。用户在确认框里选"放弃改动"才执行它，
      选"继续编辑"就丢弃。null = 没有待确认的离开。 */
  const [pendingLeaveTone, setPendingLeaveTone] = useState<
    { run: () => void } | null
  >(null);

  // The <img> currently rendered in the single-view viewport, so auto-tone can
  // sample the histogram without a fragile DOM query (F-15).
  const previewImageRef = useRef<HTMLImageElement | null>(null);
  const setPreviewImage = useCallback((el: HTMLImageElement | null) => {
    previewImageRef.current = el;
  }, []);

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

  /** 清掉待写盘计时器（手动保存 / flush 会接管这次任务）。 */
  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  /**
   * 立即落盘待写任务（切图 / 关面板 / 卸载前调用）。
   *
   * 任务在**调度时**就固化了 path 与 tone，即使用户已经切到下一张，
   * 也会正确写回上一张。
   */
  const flushAutoSave = useCallback(() => {
    clearAutoSaveTimer();
    const pending = pendingAutoSaveRef.current;
    pendingAutoSaveRef.current = null;
    if (pending) void persistToneRef.current?.(pending, true);
  }, [clearAutoSaveTimer]);

  /**
   * 用户拖动滑杆 / 自动调色 / 重置：写内存 + （开启时）400ms 静默窗口后写盘。
   *
   * 同一照片连续改动会重置计时器，只落盘最后一次；写盘期间的新改动进
   * `queuedAutoSaveRef`，当前这次落地后再补写最新值，不丢最后一次拖动。
   */
  const handleUserToneChange = useCallback(
    (newTone: ToneAdjustments) => {
      if (!currentGroup) return;
      setToneMap((prev) => ({ ...prev, [currentGroup.id]: newTone }));
      if (!autoSaveEnabled) return;
      const path = groupPath(currentGroup);
      if (!path) return;
      pendingAutoSaveRef.current = {
        groupId: currentGroup.id,
        path,
        tone: newTone,
      };
      setAutoSaveStatus('saving');
      setAutoSaveError(null);
      clearAutoSaveTimer();
      autoSaveTimerRef.current = setTimeout(() => {
        autoSaveTimerRef.current = null;
        const pending = pendingAutoSaveRef.current;
        pendingAutoSaveRef.current = null;
        if (pending) void persistToneRef.current?.(pending, true);
      }, TONE_AUTOSAVE_DEBOUNCE_MS);
    },
    [autoSaveEnabled, clearAutoSaveTimer, currentGroup],
  );

  /** 重置也是用户改动：自动保存开启时同样要落盘。 */
  const handleResetTone = useCallback(() => {
    if (!currentGroup) return;
    handleUserToneChange({ ...DEFAULT_TONE });
  }, [currentGroup, handleUserToneChange]);

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

  const handleAutoTone = useCallback(async () => {
    if (!currentGroup || isAutoToning) return;
    /** 采样并写入滑杆；失败返回 false（调用方决定回退，绝不静默）。 */
    const finish = (img: HTMLImageElement): boolean => {
      const result = computeAutoTone(img);
      if (!result) return false;
      // 自动调色同样是用户主动改动：自动保存开启时要落盘。
      handleUserToneChange(result);
      setIsAutoToning(false);
      return true;
    };

    const loadAndFinish = (src: string) => {
      const tempImg = new Image();
      tempImg.crossOrigin = 'anonymous';
      tempImg.onload = () => {
        if (finish(tempImg)) return;
        // 副本也采不动（画布采样被拦截）→ 如实报错，不留「点了没反应」
        setIsAutoToning(false);
        toast.error('无法读取该照片的像素数据（画布采样被拦截），自动调色已取消。');
      };
      tempImg.onerror = () => {
        setIsAutoToning(false);
        toast.error('无法读取该照片的像素数据，自动调色已取消。');
      };
      tempImg.src = src;
    };

    // The viewport hands us the element it actually rendered, so this works
    // even when two photos share a basename (F-15). 仅单图模式有注入，
    // 对比/前后模式 `previewImageRef` 可能残留旧图，必须忽略。
    const rendered = previewImageRef.current;
    if (
      viewMode === 'single' &&
      rendered &&
      rendered.complete &&
      rendered.naturalWidth > 0
    ) {
      setIsAutoToning(true);
      if (finish(rendered)) return;
      // 渲染图采样失败（历史遗留的 canvas 污染，问题二）→ 用带 CORS 的
      // 副本重采样兜底；副本也失败会在 onload/onerror 里如实报错。
      loadAndFinish(rendered.src);
      return;
    }

    // 有 JPG 就直接采样 JPG，零成本且必成功。
    if (currentGroup.jpg?.path) {
      setIsAutoToning(true);
      loadAndFinish(api.toAssetUrl(currentGroup.jpg.path));
      return;
    }

    // C10：RAW-only 时不能再回落到 `raw.path`（那是 .NEF，浏览器解不了，
    // 必然 onerror）。改为采样 LUMEN RAW 渲染出的预览图；引擎不可用时给出
    // 明确说明，而不是丢一句"无法读取像素数据"。
    const rawPath = currentGroup.raw?.path;
    if (rawPath && lumenAvailable) {
      setIsAutoToning(true);
      try {
        const prev = await api.getLumenPreview(rawPath, { width: 1024 });
        if (prev.previewPath) {
          loadAndFinish(api.toAssetUrl(prev.previewPath));
          return;
        }
      } catch (e) {
        console.warn('自动调色：LUMEN 预览取样失败', e);
      }
    }

    setIsAutoToning(false);
    toast.error(
      '无法读取该照片的像素数据：RAW 自动调色需要启用 LUMEN RAW 引擎（或同时选择 JPG 文件夹）。',
    );
  }, [currentGroup, handleUserToneChange, isAutoToning, toast, viewMode, lumenAvailable]);

  /**
   * 统一保存调色：**一条命令、两个落点**。
   * - 总是写 XMP（Lightroom / Capture One / Photoshop 互操作）；
   * - 引擎可用时同时写入 LUMEN RAW 编辑态并落盘 .lumen 工程；
   * - 引擎失败不回滚 XMP，只把 warning 如实提示出来。
   *
   * `auto` 区分两种来源：手动点「保存调色」沿用既有文案；自动保存的
   * 成败另有一套可见状态（面板状态位 + 常驻错误行），失败绝不静默。
   */
  const persistTone = useCallback(
    async (job: ToneSaveJob, auto: boolean) => {
      // 单飞：自动保存与手动保存共用同一把锁，避免并发写 XMP / .lumen。
      // 自动来源的新值按 groupId 入队，等当前这次落地后补写（不丢最后一次拖动）。
      if (saveInFlightRef.current) {
        if (auto) queuedAutoSaveRef.current.set(job.groupId, job);
        return;
      }
      saveInFlightRef.current = true;
      setIsSavingTone(true);
      /**
       * 状态归属必须在**写盘完成时**求值，不能在开始时拍快照：
       * 主切图路径是「先 flush 再切图」（guardToneLeave），开始时还是旧照片，
       * 完成时用户已经在看新照片，快照会把上一张的状态挂到新照片上。
       */
      const belongsToCurrentGroup = () =>
        job.groupId === currentGroupIdRef.current;
      if (auto && belongsToCurrentGroup()) {
        setAutoSaveStatus('saving');
        setAutoSaveError(null);
      }
      try {
        const report = await api.applyTone(job.path, job.tone);
        onGroupsPatched(job.groupId, {
          hasXmp: report.xmpWritten,
          tone: job.tone,
        });
        // 只在「写的仍是当前这张」时清分歧标记 / 刷新自动保存状态，
        // 避免 flush 上一张后把新照片的警告或状态盖掉。
        const stillCurrent = belongsToCurrentGroup();
        if (stillCurrent) {
          setToneDivergent(false);
          // 手动保存成功也要清掉上一次自动保存的常驻错误行。
          if (!auto) {
            setAutoSaveError(null);
            setAutoSaveStatus('idle');
          }
        }
        if (report.lumenApplied) {
          toast.success(
            auto
              ? '调色已自动保存：XMP 侧边栏 + LUMEN RAW 工程。'
              : report.projectPath
                ? '调色已保存：XMP 侧边栏 + LUMEN RAW 工程。'
                : '调色已保存：XMP 侧边栏 + LUMEN RAW。',
          );
          if (auto && stillCurrent) setAutoSaveStatus('saved');
        } else if (report.warnings.length > 0) {
          // XMP 写成功了，只是引擎那侧没成 —— 必须说清楚，别让用户以为两边都存了
          const reason = report.warnings[0];
          toast.error(
            auto
              ? `调色已自动保存到 XMP，但 LUMEN RAW 未同步：${reason}。可点「保存调色」重试。`
              : `XMP 已写入，但 LUMEN RAW 未同步：${reason}`,
          );
          if (auto && stillCurrent) {
            setAutoSaveStatus('error');
            setAutoSaveError(`LUMEN RAW 未同步：${reason}`);
          }
        } else {
          toast.success(
            auto
              ? '调色已自动保存到同名 .xmp 文件。'
              : '调色参数已写入同名 .xmp 文件。\nPhotoshop / ACR 打开时将自动载入。',
          );
          if (auto && stillCurrent) setAutoSaveStatus('saved');
        }
      } catch (err) {
        console.error('Failed to save tone:', err);
        const reason = String(err);
        if (auto) {
          // 失败不能静默：toast.error（role="alert" + assertive）+ 面板常驻错误行
          if (belongsToCurrentGroup()) {
            setAutoSaveStatus('error');
            setAutoSaveError(reason);
          }
          toast.error(
            `自动保存调色失败：${reason}。改动仍在内存中，可点「保存调色」重试。`,
          );
        } else {
          toast.error(`保存调色失败：${reason}`);
        }
      } finally {
        // 无论成功/失败/异常都必须复位，否则按钮会永久卡在「保存中…」。
        saveInFlightRef.current = false;
        setIsSavingTone(false);
        // 逐条补写排队的最新值：切图很快时可能同时压着两张照片的待写任务。
        const queued = queuedAutoSaveRef.current;
        const next = queued.entries().next();
        if (!next.done) {
          const [queuedId, queuedJob] = next.value;
          queued.delete(queuedId);
          void persistToneRef.current?.(queuedJob, true);
        }
      }
    },
    [onGroupsPatched, toast],
  );
  persistToneRef.current = persistTone;

  /** 手动保存：清掉待自动保存任务，立即写当前值（不新增第二个入口）。 */
  const handleSaveTone = useCallback(async () => {
    // 重入短路：一次保存还没落地时，再点（键盘/程序化触发）直接忽略。
    if (saveInFlightRef.current) return;
    if (!currentGroup) return;
    const toneToSave =
      toneMap[currentGroup.id] || currentGroup.tone || DEFAULT_TONE;
    const targetPath = groupPath(currentGroup);
    if (!targetPath) return;

    clearAutoSaveTimer();
    pendingAutoSaveRef.current = null;
    await persistTone(
      { groupId: currentGroup.id, path: targetPath, tone: toneToSave },
      false,
    );
  }, [currentGroup, toneMap, clearAutoSaveTimer, persistTone]);

  /**
   * 切图 / 卸载前 flush（issue #67）：400ms 窗口内的待写任务不能因为换照片
   * 或关应用而丢。任务固化在调度时，所以这里即使已经切到新照片，写的仍是上一张。
   */
  const prevGroupIdRef = useRef<string | undefined>(currentGroup?.id);
  useEffect(() => {
    if (prevGroupIdRef.current !== currentGroup?.id) {
      prevGroupIdRef.current = currentGroup?.id;
      // 先更新「当前照片」，再 flush 上一张：写盘完成时据此判断状态归属。
      currentGroupIdRef.current = currentGroup?.id;
      flushAutoSave();
      setAutoSaveStatus('idle');
      setAutoSaveError(null);
    }
  }, [currentGroup?.id, flushAutoSave]);
  useEffect(() => () => flushAutoSave(), [flushAutoSave]);

  /**
   * 打开调色面板时读回统一状态：生效值 + XMP 真值 + lumen 工程真值 + 是否分歧。
   * 引擎关闭时只读 XMP（零请求）。
   */
  useEffect(() => {
    if (!showTonalPanel || !currentGroup) {
      setToneDivergent(false);
      return;
    }
    const targetPath = groupPath(currentGroup);
    if (!targetPath) return;
    let active = true;
    api
      .getToneState(targetPath)
      .then((st) => {
        if (!active) return;
        setToneDivergent(st.divergent);
        // 只在宿主还没有本地改动时用真值回填，避免覆盖用户刚拖的滑杆
        if (!toneMap[currentGroup.id]) {
          handleToneChange(st.tone);
        }
      })
      .catch((e) => console.warn('读取调色状态失败:', e));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTonalPanel, currentGroup?.id]);

  /**
   * 应用 LUMEN RAW 内置预设（编辑态是进程内 session，后端保证 apply+save 同进程）。
   * 套完用统一读取把真实值拉回来，滑杆立刻反映。
   * 返回值 = 是否真的成功（early return / catch 均为 false）：TonalAdjuster 的
   * 预设下拉靠它决定要不要把名字标记为「已套用」—— 绝不先于事实显示。
   */
  const handleApplyLumenPreset = useCallback(
    async (name: string): Promise<boolean> => {
      if (!currentGroup) return false;
      const targetPath = groupPath(currentGroup);
      if (!targetPath) return false;
      try {
        await api.applyLumenPreset(targetPath, name, 100);
        const st = await api.getToneState(targetPath);
        onGroupsPatched(currentGroup.id, { tone: st.tone });
        handleToneChange(st.tone);
        setToneDivergent(st.divergent);
        toast.success(`已应用预设「${name}」。`);
        return true;
      } catch (err) {
        console.error('Failed to apply preset:', err);
        toast.error(`应用预设失败：${String(err)}`);
        return false;
      }
    },
    [currentGroup, handleToneChange, toast, onGroupsPatched],
  );

  /** 套用 AI 蒙版（GPU 版实测约 4s，toast 承担进度反馈）。 */
  const handleApplyLumenMask = useCallback(
    async (region: string, dehaze: number) => {
      if (!currentGroup) return;
      const targetPath = groupPath(currentGroup);
      if (!targetPath) return;
      // 后端拒绝（引擎未启用 / 非 GPU 版 / 区域非法）会走到这里。原实现没有
      // try/catch，Promise 拒绝变成 unhandled rejection：用户看不到任何提示，
      // 面板也停在半开状态。
      try {
        const result = await api.applyLumenMask(targetPath, region, {
          exposure: 0,
          highlights: 0,
          shadows: 0,
          dehaze,
          clarity: 0,
          saturation: 0,
          temperature: 0,
        });
        onMasksLoaded(result.masks);
        toast.success(
          `已套用「${region}」蒙版（${(result.elapsedMs / 1000).toFixed(1)}s）。`,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        toast.error(`蒙版应用失败：${reason}。请确认使用 GPU 版 LUMEN RAW。`);
      }
    },
    [currentGroup, toast, onMasksLoaded],
  );

  /** 读回工程里现有的 AI 蒙版（面板打开时）。 */
  useEffect(() => {
    if (!showTonalPanel || !currentGroup) {
      onMasksLoaded([]);
      return;
    }
    const targetPath = groupPath(currentGroup);
    if (!targetPath || !lumenCapsAiMasks) return;
    let active = true;
    api
      .listLumenMasks(targetPath)
      .then((m) => active && onMasksLoaded(m))
      // 读回失败不要静默吞掉：至少留一条 console.warn，比兄弟 getLumenCapabilities
      // /getToneState 都更不透明。完全静默会让「面板里没有蒙版」看起来像
      // 「这张图本来就没蒙版」，无法区分。
      .catch((e) => console.warn('listLumenMasks failed', e));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTonalPanel, currentGroup?.id, lumenCapsAiMasks]);

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