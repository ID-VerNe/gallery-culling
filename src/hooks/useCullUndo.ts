import { useCallback, useRef, useState } from 'react';
import type { CullCommand } from '../utils/cullCommand';

/**
 * 撤销栈深度上限。报告 FR-04 的验收线是「≥20 步」，取 50 是为了留余量：
 * 一次批量操作只占一步，50 步足以覆盖一整轮初选（报告 5.3 建议的环形缓冲也是 50）。
 */
export const MAX_UNDO_STEPS = 50;

interface UndoView {
  canUndo: boolean;
  canRedo: boolean;
  /** 下一条将被撤销的命令描述（驱动底栏按钮文案）。 */
  undoSummary: string;
  redoSummary: string;
}

export interface UseCullUndoResult extends UndoView {
  /**
   * 记录一条**已完成**的命令。必须在乐观更新**之前**调用 —— 命令里带着
   * `before`，晚一步就只能拿到新值。
   */
  push: (command: CullCommand) => void;
  /** 弹出最近一条并转入重做栈；空栈返回 null。 */
  undo: () => CullCommand | null;
  /** 弹出重做栈顶并压回撤销栈；空栈返回 null。 */
  redo: () => CullCommand | null;
  /**
   * 只看不取：撤销前的冲突检查要先知道命令内容，但检查没通过时命令必须
   * 留在栈里（用户取消确认后还能再撤）。
   */
  peekUndo: () => CullCommand | null;
  peekRedo: () => CullCommand | null;
  /** 丢弃两个栈（换目录 / 重新扫描时用：旧命令指向的照片可能已不在列表里）。 */
  clear: () => void;
}

const EMPTY_VIEW: UndoView = {
  canUndo: false,
  canRedo: false,
  undoSummary: '',
  redoSummary: '',
};

/**
 * FR-04 多步撤销的命令栈。
 *
 * 三条语义，任一条改坏都会让「撤销」变成不可信的操作：
 *
 * 1. **批量算一步**。命令带多个条目，撤销一次整批回退。旧实现逐张压栈，
 *    200 张批量只留下最后 5 张，用户按 5 次 Ctrl+Z 也退不回整批。
 * 2. **撤销可重做**。撤销是把命令挪到重做栈，不是丢弃；只有**新操作**才清空
 *    重做栈（分支后不能重做旧路径）。
 * 3. **同照片连续改动合并**。连按 `1..5` 时用户想要的是「撤销这轮改动」，
 *    不是退一格。合并只在栈顶且**双方都是单条目**时发生 —— 批量命令不参与，
 *    否则「撤销批量」会被后一次单张操作悄悄改写。
 *
 * 栈存在 ref 里而不是 state：撤销是命令式操作，返回值要能同步拿到；state 只
 * 镜像「按钮能不能点 / 按钮写什么」，避免每次按键都重建整条命令数组。
 */
export function useCullUndo(): UseCullUndoResult {
  const undoRef = useRef<CullCommand[]>([]);
  const redoRef = useRef<CullCommand[]>([]);
  const [view, setView] = useState<UndoView>(EMPTY_VIEW);

  const sync = useCallback(() => {
    const undo = undoRef.current;
    const redo = redoRef.current;
    setView({
      canUndo: undo.length > 0,
      canRedo: redo.length > 0,
      undoSummary: undo.length > 0 ? undo[undo.length - 1].summary : '',
      redoSummary: redo.length > 0 ? redo[redo.length - 1].summary : '',
    });
  }, []);

  const push = useCallback(
    (command: CullCommand) => {
      // 空命令（例如批量目标全被过滤掉）不占步，也不该清空重做栈。
      if (command.items.length === 0) return;

      const stack = undoRef.current;
      const top = stack[stack.length - 1];
      const mergeable =
        top !== undefined &&
        top.items.length === 1 &&
        command.items.length === 1 &&
        top.items[0].id === command.items[0].id;

      if (mergeable) {
        // 保留这轮最早的 before，换成最新的 after：撤销回到「改之前」。
        stack[stack.length - 1] = {
          summary: command.summary,
          items: [{ ...top.items[0], after: command.items[0].after }],
        };
      } else {
        stack.push(command);
        if (stack.length > MAX_UNDO_STEPS) stack.shift();
      }

      redoRef.current = [];
      sync();
    },
    [sync],
  );

  const undo = useCallback((): CullCommand | null => {
    const command = undoRef.current.pop() ?? null;
    if (command) redoRef.current.push(command);
    sync();
    return command;
  }, [sync]);

  const redo = useCallback((): CullCommand | null => {
    const command = redoRef.current.pop() ?? null;
    if (command) undoRef.current.push(command);
    sync();
    return command;
  }, [sync]);

  const clear = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
    setView(EMPTY_VIEW);
  }, []);

  const peekUndo = useCallback((): CullCommand | null => {
    const stack = undoRef.current;
    return stack.length > 0 ? stack[stack.length - 1] : null;
  }, []);

  const peekRedo = useCallback((): CullCommand | null => {
    const stack = redoRef.current;
    return stack.length > 0 ? stack[stack.length - 1] : null;
  }, []);

  return { ...view, push, undo, redo, peekUndo, peekRedo, clear };
}
