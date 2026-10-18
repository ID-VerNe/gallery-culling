/**
 * FR-09 互斥表：**对称、自反、可解释**。
 *
 * 这些测试锁的不是某次点击，而是表本身的性质。互斥表最容易出的错不是「漏了一条
 * 规则」，而是「A 挡 B、B 不挡 A」—— 那样两个入口的可用性会互相矛盾，用户看到
 * 一个能点、一个不能点，而底层其实是同一种冲突。
 */
import { describe, it, expect } from 'vitest';
import {
  ACTIVITIES,
  ACTIVITY_LABELS,
  BLOCKED_BY,
  blockersOf,
  blockReason,
  canStart,
  type TaskActivity,
} from './taskMutex';

const ALL = ACTIVITIES;

describe('taskMutex —— 表结构', () => {
  it('每种活动都在表里，且没有多余条目', () => {
    expect(Object.keys(BLOCKED_BY).sort()).toEqual([...ALL].sort());
  });

  it('没有任何活动阻塞自己（自阻会让任务永远起不来）', () => {
    for (const a of ALL) {
      expect(BLOCKED_BY[a], `${a} 不应阻塞自己`).not.toContain(a);
    }
  });

  it('互斥关系必须对称：A 挡 B 当且仅当 B 挡 A', () => {
    const asymmetric: string[] = [];
    for (const a of ALL) {
      for (const b of ALL) {
        if (a === b) continue;
        const ab = BLOCKED_BY[a].includes(b);
        const ba = BLOCKED_BY[b].includes(a);
        if (ab !== ba) asymmetric.push(`${a} -> ${b}=${ab}, ${b} -> ${a}=${ba}`);
      }
    }
    expect(asymmetric).toEqual([]);
  });

  it('表里引用的活动都存在（拼错一个名字等于这条规则静默失效）', () => {
    for (const a of ALL) {
      for (const b of BLOCKED_BY[a]) {
        expect(ALL, `${a} 引用了未知活动 ${b}`).toContain(b);
      }
    }
  });

  it('缩略图可与扫描并行，但被导出/渲染阻塞（磁盘争用）', () => {
    expect(BLOCKED_BY.thumbnail).not.toContain('scan');
    expect(BLOCKED_BY.thumbnail).toContain('export');
    expect(BLOCKED_BY.thumbnail).toContain('render');
  });

  it('渲染与 AI 互斥：两者共用 LUMEN 常驻进程的编辑态', () => {
    expect(BLOCKED_BY.render).toContain('ai');
    expect(BLOCKED_BY.ai).toContain('render');
  });

  it('每种活动都有中文标签（原因文案不能露出内部 id）', () => {
    for (const a of ALL) {
      const label = ACTIVITY_LABELS[a];
      expect(label).toBeTruthy();
      // 标签不能等于活动 id 本身，否则文案会变成「正在 scan」。
      expect(label).not.toBe(a);
    }
  });
});

describe('taskMutex —— 判定与原因', () => {
  it('没有活跃任务时任何活动都能开始', () => {
    for (const a of ALL) {
      expect(canStart(a, [])).toBe(true);
      expect(blockReason(a, [])).toBeNull();
    }
  });

  it('导出进行中：扫描被挡，原因说清是谁在占', () => {
    expect(canStart('scan', ['export'])).toBe(false);
    expect(blockReason('scan', ['export'])).toBe('正在导出照片，暂时不能扫描照片。');
  });

  it('非互斥组合放行：扫描 + 缩略图可以同时跑', () => {
    expect(canStart('scan', ['thumbnail'])).toBe(true);
    expect(canStart('thumbnail', ['scan'])).toBe(true);
  });

  it('多个阻塞者按表顺序列出，不重复', () => {
    expect(blockersOf('scan', ['export', 'render', 'ai', 'export'])).toEqual([
      'export',
      'render',
      'ai',
    ]);
    expect(blockReason('scan', ['export', 'render'])).toBe(
      '正在导出照片、渲染导出，暂时不能扫描照片。',
    );
  });

  it('自己已在跑时也算阻塞：同一任务不能开两份', () => {
    expect(canStart('export', ['export'])).toBe(false);
    expect(blockReason('export', ['export'])).toBe(
      '正在导出照片，暂时不能导出照片。',
    );
  });

  it('活跃集合里混入未知值时忽略，不影响判定', () => {
    expect(canStart('scan', ['export', 'nope' as TaskActivity])).toBe(false);
    expect(canStart('scan', ['nope' as TaskActivity])).toBe(true);
  });

  it('原因文案以句号结尾，动词短语可读', () => {
    const reason = blockReason('batch-write', ['scan']);
    expect(reason).toBe('正在扫描照片，暂时不能批量写盘。');
  });
});
