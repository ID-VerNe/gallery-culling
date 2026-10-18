/**
 * FR-11：Lightroom 目录导入的入口与报告。
 *
 * 一个弹窗承担三件事：选文件、说清「能对上多少」、让用户决定要不要覆盖。
 *
 * 三条刻意设计：
 * - **覆盖默认关**。用户在 LR 里标的是一份判断，在本应用里标的也是一份；
 *   默认覆盖等于用旧判断盖掉新判断，且不可逆（没有导入前的快照）。
 * - **写入张数写在按钮上**（「导入 42 张」），勾选覆盖后这个数字会变 ——
 *   让用户在按下之前就知道会影响多少张。
 * - **未匹配列表默认收起但不隐藏入口**。LR 有、当前目录没有的照片很常见
 *   （整库几十万张），默认展开会把真正的信息淹掉；但完全不给入口，用户就
 *   无法回答「我明明在 LR 里标了」。
 */
import React, { useState } from 'react';
import { AlertTriangle, Database } from 'lucide-react';
import { Modal } from './Modal';
import { selectLrcatWrites } from '../utils/lrcatMatch';
import type { LrcatPlan } from '../utils/lrcatMatch';
import type { LrcatReadResult } from '../types';
import type { LrcatFailure, LrcatProgress } from '../hooks/useLrcatImport';

interface LrcatDialogProps {
  isOpen: boolean;
  onClose: () => void;
  reading: boolean;
  applying: boolean;
  report: LrcatReadResult | null;
  plan: LrcatPlan | null;
  progress: LrcatProgress | null;
  failures: LrcatFailure[] | null;
  cancelling: boolean;
  onPick: () => void;
  onApply: (overwrite: boolean) => void;
  onCancel: () => void;
}

function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 报告里的路径只留末两段：完整路径塞进弹窗会挤成一团。 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

export const LrcatDialog: React.FC<LrcatDialogProps> = ({
  isOpen,
  onClose,
  reading,
  applying,
  report,
  plan,
  progress,
  failures,
  cancelling,
  onPick,
  onApply,
  onCancel,
}) => {
  const [overwrite, setOverwrite] = useState(false);
  const [showUnmatched, setShowUnmatched] = useState(false);

  const writePlan = plan
    ? selectLrcatWrites(plan.items, overwrite)
    : { writes: [], skipped: 0 };
  const writeCount = writePlan.writes.length;
  const skippedCount = writePlan.skipped;
  const busy = reading || applying;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="导入 Lightroom 目录"
      subtitle="把 Lightroom 里的评级、旗标、色标对齐到当前文件夹的照片。只读，不改动 .lrcat。"
      icon={<Database className="w-4 h-4" aria-hidden="true" />}
      maxWidth="max-w-xl"
      disableClose={busy}
      footer={
        <div className="flex items-center gap-2 w-full">
          <button
            onClick={onPick}
            disabled={busy}
            className="focus-ring px-3 py-1.5 text-white/80 hover:text-white bg-background-surface-hover hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed rounded-md text-sm"
          >
            {reading ? '读取中…' : report ? '换一个目录…' : '选择目录…'}
          </button>
          <div className="ml-auto flex items-center gap-2">
            {applying && (
              <button
                onClick={onCancel}
                disabled={cancelling}
                className="focus-ring px-3 py-1.5 text-white/80 hover:text-white bg-background-surface-hover hover:bg-white/10 disabled:opacity-50 rounded-md text-sm"
              >
                {cancelling ? '取消中…' : '取消'}
              </button>
            )}
            <button
              onClick={onClose}
              disabled={busy}
              className="focus-ring px-3 py-1.5 text-white/80 hover:text-white bg-background-surface-hover hover:bg-white/10 disabled:opacity-50 rounded-md text-sm"
            >
              关闭
            </button>
            <button
              onClick={() => onApply(overwrite)}
              disabled={busy || writeCount === 0}
              className="focus-ring px-3 py-1.5 bg-white text-black hover:bg-white/90 disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed rounded-md text-sm font-medium"
              aria-label={`导入 ${writeCount} 张`}
            >
              {applying ? '导入中…' : `导入 ${writeCount} 张`}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 text-sm text-white/80">
        {!report ? (
          <p className="text-[12px] text-white/60 leading-relaxed">
            选一个 <span className="font-mono text-white/80">.lrcat</span> 文件。只对齐
            <span className="text-white/85">当前文件夹</span>
            里的照片，不会把整库搬过来；Lightroom 正在运行也能读（会复制一份副本）。
          </p>
        ) : (
          <>
            {/* 来源与规模 */}
            <div className="flex items-center gap-2 flex-wrap text-[12px] text-white/60">
              <span className="text-white/85" title={report.catalog}>
                {baseNameOf(report.catalog)}
              </span>
              <span aria-hidden="true">·</span>
              <span>库里 {report.total} 张</span>
              {report.skippedVirtual > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>跳过虚拟副本 {report.skippedVirtual} 张</span>
                </>
              )}
              {report.copied && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-200/90">Lightroom 正在运行，读的是副本</span>
                </>
              )}
            </div>

            {/* 匹配结果 */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-white/5 px-2 py-2">
                <div className="text-lg font-medium text-white">{plan?.items.length ?? 0}</div>
                <div className="text-[11px] text-white/50">能对上</div>
              </div>
              <div className="rounded-md bg-white/5 px-2 py-2">
                <div className="text-lg font-medium text-white">{plan?.missingInLr ?? 0}</div>
                <div className="text-[11px] text-white/50">LR 里没有</div>
              </div>
              <div className="rounded-md bg-white/5 px-2 py-2">
                <div className="text-lg font-medium text-white">{plan?.unmatched.length ?? 0}</div>
                <div className="text-[11px] text-white/50">当前目录没有</div>
              </div>
            </div>

            {/* 覆盖开关 */}
            <label className="flex items-start gap-2 text-[12px] text-white/70 cursor-pointer">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
                disabled={busy}
                className="mt-0.5 accent-white"
              />
              <span>
                覆盖已有判断
                <span className="block text-[11px] text-white/45 leading-snug">
                  不勾时只填空白（0 星、无旗标、无色标）；勾了按 Lightroom 的值改写。
                </span>
              </span>
            </label>

            <p className="text-[11px] text-white/50" role="status">
              将写入 {writeCount} 张
              {skippedCount > 0 && `，跳过 ${skippedCount} 张（已有判断 / 无值 / 值相同）`}。
            </p>

            {/* 进度 */}
            {progress && (
              <div className="space-y-1">
                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-white transition-[width] duration-150"
                    style={{ width: `${(progress.processed / Math.max(1, progress.total)) * 100}%` }}
                  />
                </div>
                <p className="text-[11px] text-white/50">
                  {progress.processed} / {progress.total}
                </p>
              </div>
            )}

            {/* 失败 */}
            {failures && failures.length > 0 && (
              <section
                aria-label="导入失败报告"
                className="rounded-md border border-red-400/30 bg-red-400/5 px-3 py-2 space-y-1"
              >
                <p className="text-[12px] text-red-200/90">{failures.length} 张写盘失败</p>
                <ul className="max-h-32 overflow-y-auto space-y-1 pr-1">
                  {failures.map((f) => (
                    <li key={f.path || f.name} className="text-[11px] font-mono text-white/70">
                      <span className="truncate" title={f.path}>
                        {f.name}
                      </span>
                      <span className="text-white/40"> — {f.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 未匹配（LR 有、当前目录没有） */}
            {plan && plan.unmatched.length > 0 && (
              <section className="space-y-1">
                <button
                  onClick={() => setShowUnmatched((v) => !v)}
                  className="focus-ring flex items-center gap-1 text-[11px] text-white/50 hover:text-white underline"
                  aria-expanded={showUnmatched}
                >
                  <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                  {showUnmatched ? '收起' : '查看'} Lightroom 有、当前目录没有的{' '}
                  {plan.unmatched.length} 张
                </button>
                {showUnmatched && (
                  <ul className="max-h-40 overflow-y-auto space-y-1 pr-1">
                    {plan.unmatched.map((p) => (
                      <li
                        key={p.path}
                        className="text-[11px] font-mono text-white/60 truncate"
                        title={p.path}
                      >
                        {shortPath(p.path)}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {plan && plan.byName > 0 && (
              <p className="text-[11px] text-white/45 leading-snug">
                其中 {plan.byName} 张是「同目录同名」对上的（LR 记的是另一种格式，例如 JPG 对 RAW）。
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
