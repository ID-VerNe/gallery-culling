/**
 * 导出表单状态机的契约测试。
 *
 * 这里锁的是**能不能执行**的判断，不是视觉：
 *  - 目标目录 = 源目录必须拦下（`fs::copy` 同路径会截断原片，不可逆）；
 *  - 成片模式不能继承复制模式的「至少勾选一种类型」校验；
 *  - 质量输入允许中间态，但实际值必须落在 50–100；
 *  - 任一输入变化都要让 `resetSignal` 自增（容器靠它清掉上次的结果条）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';
import { useExportForm } from './useExportForm';
import type { CullFlag, PhotoGroupInfo } from '../types';

const file = (path: string) => ({
  name: path.split('/').pop() ?? '',
  extension: (path.split('.').pop() ?? '').toLowerCase(),
  path,
  size: 1024,
  mtime: 0,
});

const mk = (
  baseName: string,
  opts: { flag?: CullFlag; rating?: number; dir?: string } = {},
): PhotoGroupInfo => {
  const dir = opts.dir ?? 'D:/shoot/JPG';
  return {
    id: baseName,
    baseName,
    jpg: file(`${dir}/${baseName}.jpg`),
    raw: file(`D:/shoot/RAW/${baseName}.NEF`),
    status: 'COMPLETE',
    rating: opts.rating ?? 0,
    flag: opts.flag ?? 'none',
    hasXmp: false,
  };
};

/**
 * 覆盖四种范围组合：
 *  - A：pick + 0 星 → 只在 pick_or_rated / pick_only / all
 *  - B：none + 5 星 → 只在 pick_or_rated / star3_plus / all
 *  - C：none + 0 星 → 只在 all
 *  - D：reject + 3 星 → 只在 star3_plus（淘汰永不被「全部」带出）
 */
const groups: PhotoGroupInfo[] = [
  mk('A', { flag: 'pick' }),
  mk('B', { rating: 5 }),
  mk('C'),
  mk('D', { flag: 'reject', rating: 3 }),
];

const setup = (lumenAvailable = true, lumenDetail?: string) =>
  renderHook(() => useExportForm({ groups, lumenAvailable, lumenDetail }));

beforeEach(() => {
  vi.mocked(open).mockReset();
  vi.mocked(open).mockResolvedValue(null);
});

describe('初始值', () => {
  it('默认走原片复制，范围是最保守的非空集合', () => {
    const { result } = setup();
    expect(result.current.mode).toBe('copy');
    expect(result.current.filter).toBe('pick_or_rated');
    expect(result.current.includeRaw).toBe(true);
    expect(result.current.includeJpg).toBe(true);
    expect(result.current.renderFormat).toBe('jpg');
    expect(result.current.renderLongEdge).toBe(0);
    expect(result.current.qualityText).toBe('92');
    expect(result.current.quality).toBe(92);
  });

  it('空目标目录不可执行', () => {
    const { result } = setup();
    expect(result.current.canRun).toBe(false);
    expect(result.current.validation).toBe('请先选择导出目标文件夹。');
  });
});

describe('导出范围', () => {
  it('countsByFilter 与候选集一致，淘汰照片不进「全部」', () => {
    const { result } = setup();
    expect(result.current.countsByFilter).toEqual({
      pick_or_rated: 2,
      pick_only: 1,
      star3_plus: 2,
      all: 3,
    });
    expect(result.current.candidates.map((g) => g.baseName)).toEqual(['A', 'B']);
  });

  it('切换范围时候选集跟随', () => {
    const { result } = setup();
    act(() => result.current.setFilter('all'));
    expect(result.current.candidates.map((g) => g.baseName)).toEqual(['A', 'B', 'C']);
    act(() => result.current.setFilter('star3_plus'));
    expect(result.current.candidates.map((g) => g.baseName)).toEqual(['B', 'D']);
  });

  it('范围内无照片时不可执行', () => {
    const empty = renderHook(() =>
      useExportForm({ groups: [], lumenAvailable: true }),
    );
    act(() => empty.result.current.setTargetFolder('D:/out'));
    expect(empty.result.current.canRun).toBe(false);
    expect(empty.result.current.validation).toContain('没有照片');
  });
});

describe('目标目录护栏（原片不可被截断）', () => {
  it.each([
    ['D:/shoot/JPG', '正斜杠原样'],
    ['D:/shoot/JPG/', '尾斜杠'],
    ['d:/shoot/jpg', '全小写'],
    ['D:\\shoot\\JPG', '反斜杠'],
    ['D:\\shoot\\jpg\\', '反斜杠 + 尾斜杠 + 小写'],
  ])('目标 = JPG 源目录（%s，%s）→ 拦下', (path) => {
    const { result } = setup();
    act(() => result.current.setTargetFolder(path));
    expect(result.current.targetIsSourceDir).toBe(true);
    expect(result.current.canRun).toBe(false);
    expect(result.current.validation).toContain('不能是源照片所在目录');
  });

  it('目标 = RAW 源目录 → 同样拦下', () => {
    const { result } = setup();
    act(() => result.current.setTargetFolder('D:/shoot/RAW'));
    expect(result.current.targetIsSourceDir).toBe(true);
    expect(result.current.canRun).toBe(false);
  });

  it('目标与源无关 → 放行', () => {
    const { result } = setup();
    act(() => result.current.setTargetFolder('D:/out'));
    expect(result.current.targetIsSourceDir).toBe(false);
    expect(result.current.canRun).toBe(true);
    expect(result.current.validation).toBeNull();
  });

  it('空目标不算「等于源目录」（避免未填就报错）', () => {
    const { result } = setup();
    expect(result.current.targetIsSourceDir).toBe(false);
    expect(result.current.validation).not.toContain('源照片所在目录');
  });
});

describe('模式差异', () => {
  it('复制模式：两种类型都不勾选 → 拦下', () => {
    const { result } = setup();
    act(() => {
      result.current.setTargetFolder('D:/out');
      result.current.setIncludeRaw(false);
      result.current.setIncludeJpg(false);
    });
    expect(result.current.canRun).toBe(false);
    expect(result.current.validation).toContain('至少勾选一种');
  });

  it('成片模式：不继承「至少勾选一种类型」的校验', () => {
    const { result } = setup();
    act(() => {
      result.current.setTargetFolder('D:/out');
      result.current.setIncludeRaw(false);
      result.current.setIncludeJpg(false);
      result.current.setMode('render');
    });
    expect(result.current.canRun).toBe(true);
  });

  it('成片模式：引擎不可用时拦下并透传原因', () => {
    const { result } = setup(false, '未找到 lumen-cli.exe');
    act(() => {
      result.current.setTargetFolder('D:/out');
      result.current.setMode('render');
    });
    expect(result.current.canRun).toBe(false);
    expect(result.current.validation).toBe('LUMEN RAW 引擎不可用：未找到 lumen-cli.exe');
  });

  it('复制模式：引擎不可用不影响执行', () => {
    const { result } = setup(false);
    act(() => result.current.setTargetFolder('D:/out'));
    expect(result.current.canRun).toBe(true);
  });
});

describe('成片质量', () => {
  it.each([
    ['200', 100, '上界夹取'],
    ['10', 50, '下界夹取'],
    ['', 92, '清空回落默认'],
    ['   ', 92, '纯空白回落默认'],
    ['abc', 92, '非数字回落默认'],
    ['92.6', 93, '合法值四舍五入'],
    ['75', 75, '合法值原样'],
  ])('qualityText=%s → quality=%i（%s）', (text, expected) => {
    const { result } = setup();
    act(() => result.current.setQualityText(text));
    expect(result.current.qualityText).toBe(text);
    expect(result.current.quality).toBe(expected);
  });

  it('输入中间态不被立即改写（允许只敲一位数字）', () => {
    const { result } = setup();
    act(() => result.current.setQualityText('9'));
    // 文本保持原样，用户才能继续输入 "92"
    expect(result.current.qualityText).toBe('9');
    // 但实际值已经夹到合法区间
    expect(result.current.quality).toBe(50);
  });
});

describe('resetSignal（容器据此清空上次结果）', () => {
  it('任一输入变化都自增', () => {
    const { result } = setup();
    const start = result.current.resetSignal;

    act(() => result.current.setTargetFolder('D:/out'));
    const afterTarget = result.current.resetSignal;
    expect(afterTarget).toBeGreaterThan(start);

    act(() => result.current.setIncludeRaw(false));
    expect(result.current.resetSignal).toBeGreaterThan(afterTarget);

    act(() => result.current.setMode('render'));
    expect(result.current.resetSignal).toBeGreaterThan(afterTarget);
  });

  it('写入相同的值也自增（重新确认输入同样要清结果）', () => {
    const { result } = setup();
    const before = result.current.resetSignal;
    act(() => result.current.setTargetFolder(result.current.targetFolder));
    expect(result.current.resetSignal).toBe(before + 1);
  });

  it('纯派生计算不自增', () => {
    const { result } = setup();
    const before = result.current.resetSignal;
    // 触发一次重渲染：读派生值不产生副作用
    act(() => {
      void result.current.candidates;
      void result.current.canRun;
    });
    expect(result.current.resetSignal).toBe(before);
  });
});

describe('browseTarget', () => {
  it('选择目录后写入，并自增 resetSignal', async () => {
    const { result } = setup();
    vi.mocked(open).mockResolvedValueOnce('D:/picked');
    const before = result.current.resetSignal;

    await act(async () => {
      await result.current.browseTarget();
    });

    expect(result.current.targetFolder).toBe('D:/picked');
    expect(result.current.resetSignal).toBeGreaterThan(before);
  });

  it('用户取消选择（null）不覆盖已有输入', async () => {
    const { result } = setup();
    act(() => result.current.setTargetFolder('D:/keep'));
    vi.mocked(open).mockResolvedValueOnce(null);

    await act(async () => {
      await result.current.browseTarget();
    });

    expect(result.current.targetFolder).toBe('D:/keep');
  });
});
