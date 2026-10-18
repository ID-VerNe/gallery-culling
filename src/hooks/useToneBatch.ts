/**
 * FR-07 套用调色到选中：**逐张写盘、逐张推进度、可取消、失败不连坐**。
 *
 * 为什么是前端逐张而不是一条 Rust 批量命令：
 * - `apply_tone_cmd` 已经是「XMP + 可选 LUMEN 工程」的唯一写入路径，逐张复用
 *   它意味着**不存在第二套调色写入实现**（引擎失败不回滚 XMP 的语义也只有一份）；
 * - 进度与取消点在前端循环里天然精确，不需要新增进度事件与取消命令；
 * - 每张一次 IPC 的开销（约 1ms）相比写盘（10-50ms）可忽略，真正的瓶颈是
 *   LUMEN 工程落盘，那是串行的，批量命令也省不掉。
 *
 * 与 `useBatchOps` 的三条约定保持一致：乐观更新、单张失败不中断、协作式取消。
 * 额外多一条：**成功的目标要清掉未保存的旧编辑** —— 否则 `toneMap` 里的旧值
 * 会遮蔽刚写入的基线，用户切过去看到的是套用前的调色。
 */
import { useCallback, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { groupPath } from '../utils/groupPath';
import { normalizeFilePath } from '../utils/pathNormalize';
import type { PhotoGroupInfo, ToneAdjustments } from '../types';

/** 一条失败记录：谁失败了、为什么。UI 直接照着念，不再二次解释。 */
export interface ToneBatchFailure {
  /** 照片显示名（文件名，不含目录） */
  name: string;
  /** 完整路径，供 tooltip / 日志 */
  path: string;
  reason: string;
}

export interface ToneBatchProgress {
  processed: number;
  total: number;
}

export interface UseToneBatchOptions {
  /** 当前筛选结果 —— 目标只从这里取，选中集里残留的旧 id 会被自然过滤。 */
  filteredGroups: PhotoGroupInfo[];
  selectedIds: Set<string>;
  /** 源照片：当前正在调色的那张。它若在选中里必须排除（套给自己是无意义写盘）。 */
  sourceGroup: PhotoGroupInfo | undefined;
  /** 要套用的调色值（面板当前显示值，可能含未保存编辑）。 */
  tone: ToneAdjustments | undefined;
  /** 写盘成功后的乐观更新。 */
  onGroupPatched: (id: string, patch: Partial<PhotoGroupInfo>) => void;
  /**
   * 丢弃这些目标照片的未保存编辑（`toneMap` 条目）。
   *
   * 只传**写盘成功**的 id：失败的目标磁盘没变，用户的编辑还该留着。
   * 一次批量只调一次，避免 N 次 setState。
   */
  onToneDiscarded: (ids: string[]) => void;
}

export interface ToneBatchResult {
  toneBatchProgress: ToneBatchProgress | null;
  toneBatchCancelling: boolean;
  /** 最近一次批量的真失败；null = 没跑过或全部成功。 */
  toneBatchFailures: ToneBatchFailure[] | null;
  /** 最近一次批量的非致命警告（XMP 成功、LUMEN 工程失败）。 */
  toneBatchWarnings: string[] | null;
  runApplyTone: (opts?: { writeLumen?: boolean }) => Promise<void>;
  /** 「跳过剩余」：置协作标志，当前这张写完即退出循环。 */
  skipRemaining: () => void;
}

/** 目标照片的显示名：优先 RAW（写盘路径也是 RAW 优先），退化到 JPG / baseName。 */
function displayName(g: PhotoGroupInfo): string {
  return g.raw?.name || g.jpg?.name || g.baseName;
}

export function useToneBatch({
  filteredGroups,
  selectedIds,
  sourceGroup,
  tone,
  onGroupPatched,
  onToneDiscarded,
}: UseToneBatchOptions): ToneBatchResult {
  const toast = useToast();
  const [progress, setProgress] = useState<ToneBatchProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [failures, setFailures] = useState<ToneBatchFailure[] | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  /** 协作式取消标志：读 ref 而不是 state，循环里才不会拿到陈旧闭包值。 */
  const cancelRef = useRef(false);
  /** 重入保护：一批还没落地时，再点一次不能开出第二批。 */
  const runningRef = useRef(false);

  const skipRemaining = useCallback(() => {
    cancelRef.current = true;
    setCancelling(true);
  }, []);

  const runApplyTone = useCallback(
    async (opts?: { writeLumen?: boolean }) => {
      if (runningRef.current) return;
      if (!tone) return;
      const writeLumen = opts?.writeLumen ?? false;

      const sourcePath = groupPath(sourceGroup);
      // 目标 = 选中 ∩ 当前筛选，且排除源本身。
      // 排除同时按 id 与归一化路径：同一张照片可能在两个集合里拿到不同写法的路径。
      const targets = filteredGroups.filter((g) => {
        if (!selectedIds.has(g.id)) return false;
        if (sourceGroup && g.id === sourceGroup.id) return false;
        const p = groupPath(g);
        if (sourcePath && p && normalizeFilePath(p) === normalizeFilePath(sourcePath)) {
          return false;
        }
        return true;
      });
      if (targets.length === 0) return;

      runningRef.current = true;
      cancelRef.current = false;
      setCancelling(false);
      setFailures(null);
      setWarnings(null);
      setProgress({ processed: 0, total: targets.length });

      const failed: ToneBatchFailure[] = [];
      /**
       * 警告按原因聚合：引擎未启用时 200 张会给出一模一样的警告，
       * 逐条攒下来只会得到 200 条噪音。计数后压成一句。
       */
      const warnCounts = new Map<string, number>();
      const succeeded: string[] = [];
      let ok = 0;

      try {
        for (let i = 0; i < targets.length; i++) {
          if (cancelRef.current) break;
          const g = targets[i];
          const path = groupPath(g);
          if (!path) {
            failed.push({
              name: displayName(g),
              path: '',
              reason: '没有可写入的文件（该分组缺少 RAW 与 JPG 路径）',
            });
            setProgress({ processed: i + 1, total: targets.length });
            continue;
          }
          try {
            const report = await api.applyTone(path, tone, writeLumen);
            onGroupPatched(g.id, { tone, hasXmp: report.xmpWritten });
            succeeded.push(g.id);
            ok++;
            // XMP 成功但引擎侧没成：不算失败（互操作底线已达成），但必须留档。
            if (!report.lumenApplied && report.warnings.length > 0) {
              for (const w of report.warnings) {
                warnCounts.set(w, (warnCounts.get(w) ?? 0) + 1);
              }
            }
          } catch (err) {
            console.error('Batch tone apply error:', err);
            failed.push({
              name: displayName(g),
              path,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          setProgress({ processed: i + 1, total: targets.length });
        }
      } finally {
        runningRef.current = false;
        setProgress(null);
        setCancelling(false);
      }

      // 成功的目标才丢弃旧编辑：失败的那几张磁盘没变，用户改动要留着。
      if (succeeded.length > 0) onToneDiscarded(succeeded);

      const warned = [...warnCounts].map(([reason, count]) =>
        count > 1 ? `${reason}（${count} 张）` : reason,
      );
      setFailures(failed.length > 0 ? failed : null);
      setWarnings(warned.length > 0 ? warned : null);

      const cancelled = cancelRef.current;
      const modeText = writeLumen ? 'XMP 与 LUMEN 工程' : 'XMP';
      if (failed.length > 0) {
        // error toast 是持久的（DISMISS_MS = 0），适合承载"哪几张失败了"。
        const head = failed
          .slice(0, 3)
          .map((f) => `· ${f.name}：${f.reason}`)
          .join('\n');
        const more = failed.length > 3 ? `\n…另有 ${failed.length - 3} 张` : '';
        toast.error(
          `套用调色完成：${ok} 张成功，${failed.length} 张失败。\n${head}${more}`,
        );
      } else if (cancelled) {
        toast.info(`已停止：${ok} 张已写入 ${modeText}。`);
      } else {
        toast.success(`已把当前调色套用到 ${ok} 张照片（${modeText}）。`);
      }
      if (warned.length > 0) {
        toast.info(
          `${warned.length} 张的 LUMEN 工程未更新（XMP 已写入）：${warned[0]}`,
        );
      }
    },
    [filteredGroups, selectedIds, sourceGroup, tone, onGroupPatched, onToneDiscarded, toast],
  );

  return {
    toneBatchProgress: progress,
    toneBatchCancelling: cancelling,
    toneBatchFailures: failures,
    toneBatchWarnings: warnings,
    runApplyTone,
    skipRemaining,
  };
}
