import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { computeAutoTone, DEFAULT_TONE, toneEquals } from '../utils/autoTone';
import { groupPath } from '../utils/groupPath';
import type { PhotoGroupInfo, ToneAdjustments, ViewMode } from '../types';

/**
 * 调色编辑态：内存中的调色值、面板开关、离开保护、保存与 AI 蒙版。
 *
 * 关键不变量：
 * - 编辑只落在 `toneMap`（内存），**不**同步写 `groups[].tone`。后者是
 *   「磁盘真值」的基线，一旦被编辑覆盖，"是否有未保存改动"就无从判断。
 *   保存成功时才把基线更新为新值，dirty 随之清零。
 * - 面板可见性是**派生值**（用户意图 && 当前有可调对象），不是意图本身。
 *   此前显示层只读意图，于是筛选变空时会出现「按钮说开着、屏幕显示着宫格」。
 * - 离开（切图 / 关面板 / 换筛选）前若 dirty，先确认，绝不静默丢改动。
 */
export function useToneEditing(opts: {
  currentGroup: PhotoGroupInfo | undefined;
  viewMode: ViewMode;
  lumenAvailable: boolean;
  lumenCapsAiMasks: boolean | undefined;
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

  const handleToneChange = useCallback(
    (newTone: ToneAdjustments) => {
      if (!currentGroup) return;
      setToneMap((prev) => ({ ...prev, [currentGroup.id]: newTone }));
    },
    [currentGroup],
  );

  const handleResetTone = useCallback(() => {
    if (!currentGroup) return;
    setToneMap((prev) => ({ ...prev, [currentGroup.id]: { ...DEFAULT_TONE } }));
  }, [currentGroup]);

  /** C3：调色是否有未保存改动（当前编辑值 ≠ 磁盘基线）。 */
  const toneDirty =
    !!currentGroup &&
    !!currentTone &&
    !toneEquals(currentTone, currentGroup.tone ?? DEFAULT_TONE);

  /** C3：丢弃当前照片的未保存编辑，回到磁盘基线。 */
  const discardToneEdits = useCallback(() => {
    if (!currentGroup) return;
    setToneMap((prev) => {
      const next = { ...prev };
      delete next[currentGroup.id];
      return next;
    });
  }, [currentGroup]);

  /**
   * C3：离开保护。切图 / 关面板前若存在未保存改动，先弹确认，避免静默丢失。
   * 用户选"放弃改动"才真正执行离开动作（并丢弃内存中的编辑）。
   */
  const guardToneLeave = useCallback(
    (run: () => void) => {
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
    [toneDirty, discardToneEdits],
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
      handleToneChange(result);
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
  }, [currentGroup, handleToneChange, isAutoToning, toast, viewMode, lumenAvailable]);

  /**
   * 统一保存调色：**一条命令、两个落点**。
   * - 总是写 XMP（Lightroom / Capture One / Photoshop 互操作）；
   * - 引擎可用时同时写入 LUMEN RAW 编辑态并落盘 .lumen 工程；
   * - 引擎失败不回滚 XMP，只把 warning 如实提示出来。
   */
  const handleSaveTone = useCallback(async () => {
    // 重入短路：一次保存还没落地时，再点（键盘/程序化触发）直接忽略。
    if (isSavingTone) return;
    if (!currentGroup) return;
    const toneToSave =
      toneMap[currentGroup.id] || currentGroup.tone || DEFAULT_TONE;
    const targetPath = groupPath(currentGroup);
    if (!targetPath) return;

    setIsSavingTone(true);
    try {
      const report = await api.applyTone(targetPath, toneToSave);
      onGroupsPatched(currentGroup.id, {
        hasXmp: report.xmpWritten,
        tone: toneToSave,
      });
      setToneDivergent(false);
      if (report.lumenApplied) {
        toast.success(
          report.projectPath
            ? '调色已保存：XMP 侧边栏 + LUMEN RAW 工程。'
            : '调色已保存：XMP 侧边栏 + LUMEN RAW。',
        );
      } else if (report.warnings.length > 0) {
        // XMP 写成功了，只是引擎那侧没成 —— 必须说清楚，别让用户以为两边都存了
        toast.error(`XMP 已写入，但 LUMEN RAW 未同步：${report.warnings[0]}`);
      } else {
        toast.success('调色参数已写入同名 .xmp 文件。\nPhotoshop / ACR 打开时将自动载入。');
      }
    } catch (err) {
      console.error('Failed to save tone:', err);
      toast.error(`保存调色失败：${String(err)}`);
    } finally {
      // 无论成功/失败/异常都必须复位，否则按钮会永久卡在「保存中…」。
      setIsSavingTone(false);
    }
  }, [currentGroup, toneMap, toast, isSavingTone, onGroupsPatched]);

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
   */
  const handleApplyLumenPreset = useCallback(
    async (name: string) => {
      if (!currentGroup) return;
      const targetPath = groupPath(currentGroup);
      if (!targetPath) return;
      try {
        await api.applyLumenPreset(targetPath, name, 100);
        const st = await api.getToneState(targetPath);
        onGroupsPatched(currentGroup.id, { tone: st.tone });
        handleToneChange(st.tone);
        setToneDivergent(st.divergent);
        toast.success(`已应用预设「${name}」。`);
      } catch (err) {
        console.error('Failed to apply preset:', err);
        toast.error(`应用预设失败：${String(err)}`);
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
    handleResetTone,
    discardToneEdits,
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