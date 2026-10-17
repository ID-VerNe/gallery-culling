/**
 * 导出结果的**唯一文案来源**（纯函数，无 React 依赖）。
 *
 * 两条硬约束（来自导出是最高危写入路径）：
 *  1. 部分失败绝不能伪装成成功 —— 标题、`failed` 标记、失败数位置都由这里统一决定；
 *  2. 取消 ≠ 失败，且不能出现「已导出 N 个」这类会被误读为已落盘的措辞。
 *
 * 一次导出有**两个**出口，都在这里产出，容器只负责分发：
 *  - `message` + `failed` → 弹窗内的结果条（`role=status` / `role=alert`）；
 *  - `toast` → 弹窗外层的全局提示（取消时为空，与既有行为一致）。
 * 让两者共用同一批句子，才不会出现「结果条说成功、Toast 说失败」的分裂。
 */
import type { ExportMode, ExportOutcome } from '../../types';
import { EXPORT_MODES } from './exportConfig';

/** 全局 Toast 的载荷；`kind` 决定用成功态还是错误态呈现。 */
export interface ExportToast {
  kind: 'success' | 'error';
  text: string;
}

export interface ExportResultMessage {
  /** 结果条正文。 */
  message: string;
  /** 结果条是否走警示态。 */
  failed: boolean;
  /** 全局 Toast；取消时为空（取消不弹 Toast，结果条已足够说明）。 */
  toast: ExportToast | null;
}

/** 失败明细最多展示 3 条，超出用「等」收尾，避免结果条撑爆。 */
const FAILURE_DETAIL_LIMIT = 3;

/**
 * 把一次导出结果拼成给用户看的一句话。
 *
 * copy 模式的输出必须与既有文案逐字兼容（现有测试锁死了这些句子）：
 *  - `导出完成：已导出 3 个。（目标：D:/out）`
 *  - `导出未完全成功：失败 1 个 · 已导出 2 个 · 跳过 1 个（目标已存在同名文件）。`
 *  - `已取消导出：目标目录未产生任何文件。（目标：D:/out）`
 */
export function buildOutcomeMessage(args: {
  mode: ExportMode;
  outcome: ExportOutcome;
  targetFolder: string;
}): ExportResultMessage {
  const spec = EXPORT_MODES[args.mode];
  const { outcome, targetFolder } = args;

  // 取消优先判定：后端 all-or-nothing，取消即目标目录零成片。
  // 不弹 Toast —— 弹窗里的结果条已经把话说全了，再弹一次是噪音。
  if (outcome.cancelled) {
    return {
      message: `已取消导出：目标目录未产生${spec.cancelObject}。（目标：${targetFolder}）`,
      failed: false,
      toast: null,
    };
  }

  const failedCount = outcome.failed.length;
  const parts: string[] = [];
  // 失败数放最前，让用户第一眼看到这次没完全成功。
  if (failedCount > 0) parts.push(`失败 ${failedCount} ${spec.unit}`);
  parts.push(`${spec.exportedVerb} ${outcome.exported} ${spec.unit}`);
  if (outcome.skipped > 0) {
    parts.push(`跳过 ${outcome.skipped} ${spec.unit}（${spec.skipNote}）`);
  }
  const summary = parts.join(' · ');

  const detail =
    failedCount > 0
      ? ` 失败原因：${outcome.failed
          .slice(0, FAILURE_DETAIL_LIMIT)
          .map((f) => `${f.path}（${f.reason}）`)
          .join('；')}${failedCount > FAILURE_DETAIL_LIMIT ? ' 等' : ''}`
      : '';

  return {
    message: `${failedCount > 0 ? spec.partialTitle : spec.successTitle}：${summary}。${detail}（目标：${targetFolder}）`,
    failed: failedCount > 0,
    // 部分失败：措辞只否定「完全」二字，别让用户以为一张都没导出。
    toast:
      failedCount > 0
        ? {
            kind: 'error',
            text: `${spec.partialTitle}：失败 ${failedCount} ${spec.unit}，成功 ${outcome.exported} ${spec.unit}`,
          }
        : { kind: 'success', text: `${summary}，目标：${targetFolder}` },
  };
}

export interface ExportValidationInput {
  mode: ExportMode;
  targetFolder: string;
  targetIsSourceDir: boolean;
  candidateCount: number;
  includeRaw: boolean;
  includeJpg: boolean;
  /** 只有成片模式关心；复制模式传什么都不影响结果。 */
  lumenAvailable: boolean;
  lumenDetail?: string;
}

/**
 * 运行前的单一校验入口。返回 `null` 表示可以执行，否则返回阻断原因。
 *
 * 顺序刻意固定：先目标、再范围、最后模式专属项 —— 用户总是先看到最上游的问题。
 * 注意：LUMEN 不可用虽然在这里返回原因，但 UI 由 `LumenGateNotice` 常驻展示，
 * 不把它塞进结果条（否则 `role=alert` 会与结果区抢同一个语义）。
 */
export function buildValidationMessage(input: ExportValidationInput): string | null {
  if (!input.targetFolder.trim()) return '请先选择导出目标文件夹。';
  if (input.targetIsSourceDir) {
    return '导出目标不能是源照片所在目录，请另选一个目标文件夹';
  }
  if (input.candidateCount === 0) {
    return '当前导出范围内没有照片，请先给照片打星或标记保留。';
  }
  if (input.mode === 'copy' && !input.includeRaw && !input.includeJpg) {
    return '请至少勾选一种要复制的文件类型。';
  }
  if (input.mode === 'render' && !input.lumenAvailable) {
    return `LUMEN RAW 引擎不可用：${
      input.lumenDetail?.trim() || '未检测到可用的 lumen-cli'
    }`;
  }
  return null;
}
