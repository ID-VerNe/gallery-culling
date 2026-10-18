/**
 * FR-11 前端：Lightroom 目录导入。
 *
 * 分工：
 * - **读与值映射归 Rust**（`lrcat.rs`，只读 + 复制兜底 + 虚拟副本跳过）；
 * - **匹配与「该不该写」归 `utils/lrcatMatch`**（纯函数，逐条单测）；
 * - 本 hook 只管「问路径 → 读 → 匹配 → 逐张写盘 → 报结果」。
 *
 * 为什么逐张写而不是一条批量命令：写盘要复用 `update_rating_flag_cmd`，
 * 它是 XMP + 本地旗标存储的唯一写入路径（ADR-001/003）。另起一条批量命令
 * 等于让「导入进来的评级」和「手动按的评级」走两套落盘逻辑，迟早不一致。
 * 进度与取消点也因此天然精确。
 *
 * 两条静默规则与选片集一致：文件对话框取消不说；被互斥挡住要解释原因。
 */
import { useCallback, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { useTaskMutex } from './useTaskMutex';
import { groupPath } from '../utils/groupPath';
import { parentDirOf } from '../utils/pathNormalize';
import {
  planLrcatImport,
  selectLrcatWrites,
  type LrcatPlan,
} from '../utils/lrcatMatch';
import type { LrcatReadResult, PhotoGroupInfo } from '../types';

export interface LrcatProgress {
  processed: number;
  total: number;
}

/** 一张写失败：谁、为什么。UI 直接照着念。 */
export interface LrcatFailure {
  name: string;
  path: string;
  reason: string;
}

export interface UseLrcatImportOptions {
  /** 当前集合（匹配用）。 */
  groups: PhotoGroupInfo[];
  /** 写盘成功后的乐观更新（与手动评级同一条路径）。 */
  onGroupPatched: (id: string, patch: Partial<PhotoGroupInfo>) => void;
}

export interface LrcatApi {
  reading: boolean;
  applying: boolean;
  /** 读出来的原始结果；`null` = 没读或已关闭。 */
  report: LrcatReadResult | null;
  /** 匹配计划（报告与按钮文案都从它取数）。 */
  plan: LrcatPlan | null;
  progress: LrcatProgress | null;
  failures: LrcatFailure[] | null;
  cancelling: boolean;
  /** 选文件 + 读 + 匹配。返回是否读到了东西（取消 / 失败 → false）。 */
  pick: () => Promise<boolean>;
  /** 按「覆盖与否」写盘，返回真正写入的张数。 */
  apply: (overwrite: boolean) => Promise<number>;
  cancel: () => void;
  dismiss: () => void;
}

export function useLrcatImport({
  groups,
  onGroupPatched,
}: UseLrcatImportOptions): LrcatApi {
  const toast = useToast();
  const mutex = useTaskMutex();

  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [report, setReport] = useState<LrcatReadResult | null>(null);
  const [plan, setPlan] = useState<LrcatPlan | null>(null);
  const [progress, setProgress] = useState<LrcatProgress | null>(null);
  const [failures, setFailures] = useState<LrcatFailure[] | null>(null);
  const [cancelling, setCancelling] = useState(false);

  /** 重入保护：读与写各自挡连点。 */
  const busyRef = useRef(false);
  const cancelledRef = useRef(false);
  /** 上一次选的目录作为下次的起点。 */
  const lastPathRef = useRef<string | null>(null);

  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const onGroupPatchedRef = useRef(onGroupPatched);
  onGroupPatchedRef.current = onGroupPatched;

  const pick = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    const current = groupsRef.current;
    if (current.length === 0) {
      toast.info('先扫描一个目录再导入 —— 导入是把 LR 的评级对齐到当前照片。');
      return false;
    }

    let target: string | null;
    try {
      target = await api.selectLrcatPath(lastPathRef.current ?? undefined);
    } catch (err) {
      toast.error(`无法打开文件对话框：${String(err)}`);
      return false;
    }
    if (!target) return false;

    // 只读当前集合涉及的目录：LR 目录常有几万张，全量读回来既慢又没法用。
    // 后端按目录过滤，这里给的是去重后的父目录。
    const folders = new Set<string>();
    for (const g of current) {
      const raw = g.raw?.path;
      const jpg = g.jpg?.path;
      if (raw) folders.add(parentDirOf(raw));
      if (jpg) folders.add(parentDirOf(jpg));
    }

    busyRef.current = true;
    setReading(true);
    setFailures(null);
    try {
      const res = await api.readLrcat(target, [...folders]);
      lastPathRef.current = target;
      const next = planLrcatImport(current, res.photos);
      setReport(res);
      setPlan(next);
      if (res.photos.length === 0) {
        toast.info(
          '这个 Lightroom 目录里没有落在当前文件夹的照片。' +
            '导入只对齐当前扫描的目录，不会把整库搬过来。',
        );
      }
      return true;
    } catch (err) {
      console.error('read_lrcat_cmd failed:', err);
      toast.error(`读取 Lightroom 目录失败：${String(err)}`);
      return false;
    } finally {
      busyRef.current = false;
      setReading(false);
    }
  }, [toast]);

  const apply = useCallback(
    async (overwrite: boolean): Promise<number> => {
      if (busyRef.current) return 0;
      const currentPlan = plan;
      if (!currentPlan) return 0;
      if (!mutex.canStart('batch-write')) {
        toast.info(mutex.blockReason('batch-write') ?? '现在不能写盘。');
        return 0;
      }

      const { writes, skipped } = selectLrcatWrites(currentPlan.items, overwrite);
      if (writes.length === 0) {
        toast.info(
          skipped > 0
            ? `没有需要写入的照片：${skipped} 张已有判断（勾「覆盖」才会改）。`
            : '没有需要写入的照片。',
        );
        return 0;
      }

      busyRef.current = true;
      cancelledRef.current = false;
      setApplying(true);
      setCancelling(false);
      setFailures(null);
      setProgress({ processed: 0, total: writes.length });
      const release = mutex.begin('batch-write');

      const failed: LrcatFailure[] = [];
      let written = 0;
      try {
        for (let i = 0; i < writes.length; i += 1) {
          if (cancelledRef.current) break;
          const { group, photo } = writes[i];
          const path = groupPath(group);
          if (!path) {
            failed.push({
              name: group.baseName,
              path: '',
              reason: '这一组没有可写的文件路径',
            });
            setProgress({ processed: i + 1, total: writes.length });
            continue;
          }
          try {
            // coalesce=false：每张只改一次，没必要等 400ms 静默窗口。
            await api.updateRatingFlag(
              path,
              photo.rating,
              photo.flag,
              true,
              false,
              photo.label,
            );
            written += 1;
            onGroupPatchedRef.current(group.id, {
              rating: photo.rating,
              flag: photo.flag as PhotoGroupInfo['flag'],
              label: photo.label,
            });
          } catch (err) {
            failed.push({
              name: group.baseName,
              path,
              reason: String(err),
            });
          }
          setProgress({ processed: i + 1, total: writes.length });
        }
      } finally {
        release();
        busyRef.current = false;
        setApplying(false);
        setCancelling(false);
        setProgress(null);
      }

      if (failed.length > 0) {
        setFailures(failed);
        toast.error(`导入完成：写入 ${written} 张，失败 ${failed.length} 张。`);
      } else if (cancelledRef.current) {
        toast.info(`已取消：写入 ${written} 张，其余未处理。`);
      } else {
        toast.success(
          skipped > 0
            ? `已从 Lightroom 导入 ${written} 张（${skipped} 张已有判断，未覆盖）。`
            : `已从 Lightroom 导入 ${written} 张。`,
        );
        setReport(null);
        setPlan(null);
      }
      return written;
    },
    [mutex, plan, toast],
  );

  const cancel = useCallback(() => {
    if (!applying) return;
    cancelledRef.current = true;
    setCancelling(true);
  }, [applying]);

  const dismiss = useCallback(() => {
    if (applying) return;
    setReport(null);
    setPlan(null);
    setFailures(null);
  }, [applying]);

  return {
    reading,
    applying,
    report,
    plan,
    progress,
    failures,
    cancelling,
    pick,
    apply,
    cancel,
    dismiss,
  };
}
