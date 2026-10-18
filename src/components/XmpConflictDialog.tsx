/**
 * FR-08 冲突裁决：本地有未落盘的意图，磁盘也被外部改了 —— 必须由人选一边。
 *
 * 三种选法都在这一个弹窗里（报告 §5.7「保留本地 / 采用外部 / 逐张选择」）：
 * - **保留本地**：把未落盘的意图写进磁盘，覆盖外部改动；
 * - **采用外部**：丢掉本地意图，界面跟着磁盘走；
 * - **逐张选择**：每行一个二选一，上面的「全部…」只是批量设置同一批开关。
 *
 * 默认是**保留本地**，并且这个默认在每一行上都看得见 —— 用户的标记是他刚做的
 * 动作，默认丢掉它比默认保留它更伤人。但默认值不等于替用户决定：不点「应用」
 * 就一个字节都不写，取消/关窗都只是关掉。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { isColorLabel, LABEL_DOT_CLASS, labelName } from '../utils/labels';
import type {
  CullStateSnapshot,
  XmpConflictAction,
  XmpConflictChoice,
  XmpRefreshConflict,
} from '../types';

interface XmpConflictDialogProps {
  isOpen: boolean;
  conflicts: XmpRefreshConflict[];
  /** 正在提交：所有按钮禁用，避免重复写盘。 */
  busy?: boolean;
  onCancel: () => void;
  onApply: (choices: XmpConflictChoice[]) => void;
}

const DEFAULT_ACTION: XmpConflictAction = 'keep-local';

/** `★★★★☆`。用文字而不是图标：读屏能念、对齐也稳。 */
function stars(rating: number): string {
  const filled = Math.max(0, Math.min(5, rating));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** 三项标记的紧凑展示：星级 + 旗标 + 色标点。 */
const StateView: React.FC<{ state: CullStateSnapshot }> = ({ state }) => (
  <span className="flex items-center gap-2 flex-wrap">
    <span className="font-mono tracking-tight text-white/85">{stars(state.rating)}</span>
    {state.flag === 'pick' && <span className="text-emerald-300">保留</span>}
    {state.flag === 'reject' && <span className="text-rose-300">淘汰</span>}
    {isColorLabel(state.label) && (
      <span className="flex items-center gap-1 text-white/70">
        <span
          className={`w-2 h-2 rounded-full ${LABEL_DOT_CLASS[state.label]}`}
          aria-hidden="true"
        />
        {labelName(state.label)}标
      </span>
    )}
  </span>
);

/**
 * 选中状态按「路径 + 两侧的值」作键。
 *
 * 只按路径存会在两种情况下出错：列表里同一张的外部值被新的刷新换掉（旧选择
 * 配新值，等于用户裁决了他没看过的内容）；而只按数组下标存，则会在部分裁决
 * 失败、列表变短时把选择错位到别人头上。
 */
const sig = (s: CullStateSnapshot): string => `${s.rating}/${s.flag}/${s.label}`;
const rowKey = (c: XmpRefreshConflict): string =>
  `${c.path}\u0000${sig(c.local)}\u0000${sig(c.external)}`;

export const XmpConflictDialog: React.FC<XmpConflictDialogProps> = ({
  isOpen,
  conflicts,
  busy = false,
  onCancel,
  onApply,
}) => {
  const [selection, setSelection] = useState<Record<string, XmpConflictAction>>({});

  /**
   * 选择在**关闭时**清空，而不是打开时重置。
   *
   * 「打开时重置」有个隐蔽的时序坑：`isOpen` 从 false 变 true 的那一帧，重置
   * effect 是**被动副作用**，可能在用户点击之后才执行 —— 刚点的选择被无声抹掉。
   * 关闭时清空没有这个问题：弹窗开着时永远不会重置，重新打开时状态已经是空的
   * （首次挂载本来就是空对象）。
   */
  useEffect(() => {
    if (!isOpen) setSelection({});
  }, [isOpen]);

  const actionOf = (c: XmpRefreshConflict): XmpConflictAction =>
    selection[rowKey(c)] ?? DEFAULT_ACTION;

  const choices = useMemo<XmpConflictChoice[]>(
    () =>
      conflicts.map((c) => {
        const action = selection[rowKey(c)] ?? DEFAULT_ACTION;
        return action === 'use-external'
          ? { path: c.path, action, external: c.external }
          : { path: c.path, action };
      }),
    [conflicts, selection],
  );

  const setAll = (action: XmpConflictAction) => {
    const next: Record<string, XmpConflictAction> = {};
    for (const c of conflicts) next[rowKey(c)] = action;
    setSelection(next);
  };

  if (!isOpen || conflicts.length === 0) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="XMP 已被其他程序修改"
      maxWidth="max-w-2xl"
      disableClose={busy}
      icon={<AlertTriangle className="w-4 h-4 text-amber-400" aria-hidden="true" />}
      subtitle={
        '这些照片本地还有没写进磁盘的标记，磁盘上的内容也变了。' +
        '选一边，另一边会被丢弃 —— 不点「应用」不会写入任何东西。'
      }
      footer={
        <>
          <span className="mr-auto text-[11px] text-white/50">
            {conflicts.length} 张待裁决
          </span>
          <button
            onClick={onCancel}
            disabled={busy}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white/80 transition-transform disabled:opacity-40 disabled:cursor-not-allowed"
          >
            取消
          </button>
          <button
            onClick={() => onApply(choices)}
            disabled={busy}
            className="focus-ring px-3.5 py-1.5 rounded-md bg-white hover:bg-white/90 active:scale-[0.96] text-black font-medium shadow-sm transition-transform disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? '处理中…' : `应用 ${conflicts.length} 张`}
          </button>
        </>
      }
    >
      {/* 批量设置：只是把每行的开关一起拨到同一侧，不提交。 */}
      <div className="flex items-center gap-2 text-[11px] text-white/60">
        <span>全部设为</span>
        <button
          onClick={() => setAll('keep-local')}
          disabled={busy}
          className="focus-ring px-2 py-0.5 rounded bg-background-surface-hover hover:bg-white/10 text-white/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          全部保留本地
        </button>
        <button
          onClick={() => setAll('use-external')}
          disabled={busy}
          className="focus-ring px-2 py-0.5 rounded bg-background-surface-hover hover:bg-white/10 text-white/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          全部采用外部
        </button>
      </div>

      <ul className="flex flex-col gap-2">
        {conflicts.map((c) => {
          const name = baseNameOf(c.path);
          const action = actionOf(c);
          return (
            <li
              key={c.path}
              className="rounded-lg border border-border-default bg-background-base/60 px-3 py-2 flex flex-col gap-1.5"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="font-medium text-white truncate max-w-[16rem]"
                  title={c.path}
                >
                  {name}
                </span>
                <div
                  role="radiogroup"
                  aria-label={`${name} 的裁决`}
                  className="ml-auto flex items-center rounded-md bg-background-surface-hover p-0.5"
                >
                  {(
                    [
                      ['keep-local', '保留本地'],
                      ['use-external', '采用外部'],
                    ] as const
                  ).map(([value, text]) => (
                    <button
                      key={value}
                      role="radio"
                      aria-checked={action === value}
                      aria-label={`${name} ${text}`}
                      disabled={busy}
                      onClick={() =>
                        setSelection((prev) => ({ ...prev, [rowKey(c)]: value }))
                      }
                      className={`focus-ring px-2 py-0.5 rounded text-[11px] whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        action === value
                          ? 'bg-white text-black font-medium shadow-sm'
                          : 'text-white/60 hover:text-white hover:bg-white/10'
                      }`}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                <span className="text-white/45">本地（未写盘）</span>
                <StateView state={c.local} />
                <span className="text-white/45">磁盘</span>
                <StateView state={c.external} />
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
};
