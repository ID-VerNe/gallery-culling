import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import type { PhotoGroupInfo, ToneAdjustments } from '../types';

/**
 * 调色自动保存的静默窗口（issue #67）。
 *
 * 与 `.plan/adr-002-write-coalescing.md` 的 400ms 合并窗口取同一时长：
 * 连续拖动期间只折叠成一次写盘。ADR-002 的 Coalescer 只服务评级/旗标/色标，
 * 调色还带 `.lumen` 工程写入，语义不同，因此折叠发生在调用侧而不是第二套后端队列。
 */
export const TONE_AUTOSAVE_DEBOUNCE_MS = 400;

/** 一次待落盘的调色任务：拍照/路径/值在**调度时**固化，切图后仍能正确写回。 */
export interface ToneSaveJob {
  groupId: string;
  path: string;
  tone: ToneAdjustments;
}

/**
 * 调色写盘管线（issue #113：自 `useToneEditing` 按管线拆出）。
 *
 * 拥有：静默窗口计时器、单飞锁、按 groupId 的待补写队列、自动保存可见状态。
 * 内存编辑态（`toneMap`）仍由门面 `useToneEditing` 持有；门面负责判定
 * 「何时调度」（`autoSaveEnabled` + path 存在），这里只管「调度后如何落盘」。
 */
export function useToneAutoSave(opts: {
  currentGroup: PhotoGroupInfo | undefined;
  /** 写盘成功且仍在当前照片时通知门面（门面清分歧标记）。 */
  onPersistSuccess?: () => void;
  onGroupsPatched: (id: string, patch: Partial<PhotoGroupInfo>) => void;
}) {
  const { currentGroup, onPersistSuccess, onGroupsPatched } = opts;
  const toast = useToast();

  /** 调色保存进行中：禁用保存按钮并挡住重入，避免连点写两次 XMP/工程。 */
  const [isSavingTone, setIsSavingTone] = useState(false);
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
  const currentGroupIdRef = useRef<string | undefined>(currentGroup?.id);
  /** 真正写盘的单飞函数（定义在下方，供计时器与 flush 回调调用）。 */
  const persistToneRef = useRef<((job: ToneSaveJob, auto: boolean) => Promise<void>) | null>(
    null,
  );

  /** 清掉待写盘计时器（手动保存 / flush 会接管这次任务）。 */
  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

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
          onPersistSuccess?.();
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
    [onGroupsPatched, onPersistSuccess, toast],
  );
  persistToneRef.current = persistTone;

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
   * 调度一次写盘：400ms 静默窗口后落盘。
   *
   * 同一照片连续改动会重置计时器，只落盘最后一次；写盘期间的新改动进
   * `queuedAutoSaveRef`，当前这次落地后再补写最新值，不丢最后一次拖动。
   */
  const scheduleAutoSave = useCallback(
    (job: ToneSaveJob) => {
      pendingAutoSaveRef.current = job;
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
    [clearAutoSaveTimer],
  );

  /**
   * 手动保存：清掉待自动保存任务，立即写给定任务（不新增第二个入口）。
   * 写盘进行中再点直接忽略（与既有「重入短路」一致）。
   */
  const saveToneNow = useCallback(
    async (job: ToneSaveJob) => {
      if (saveInFlightRef.current) return;
      clearAutoSaveTimer();
      pendingAutoSaveRef.current = null;
      await persistTone(job, false);
    },
    [clearAutoSaveTimer, persistTone],
  );

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

  return {
    isSavingTone,
    autoSaveStatus,
    autoSaveError,
    flushAutoSave,
    scheduleAutoSave,
    saveToneNow,
  };
}
