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
import type { CullFlag, FilterMode, PhotoGroupInfo } from '../types';
import { parseQuery } from '../utils/queryMatch';

const file = (path: string) => ({
  name: path.split('/').pop() ?? '',
  extension: (path.split('.').pop() ?? '').toLowerCase(),
  path,
  size: 1024,
  mtime: 0,
});

const mk = (
  baseName: string,
  opts: { flag?: CullFlag; rating?: number; dir?: string; raw?: boolean; xmp?: boolean } = {},
): PhotoGroupInfo => {
  const dir = opts.dir ?? 'D:/shoot/JPG';
  const hasRaw = opts.raw !== false;
  return {
    id: baseName,
    baseName,
    jpg: file(`${dir}/${baseName}.jpg`),
    // raw 是**可选**字段：没有 RAW 的组必须真的不带这个键（而不是 null），
    // 否则 `g.raw ? …` 的判断与真实扫描结果不一致，「仅含 RAW」档会误收。
    ...(hasRaw ? { raw: file(`D:/shoot/RAW/${baseName}.NEF`) } : {}),
    status: hasRaw ? 'COMPLETE' : 'JPG_ONLY',
    rating: opts.rating ?? 0,
    flag: opts.flag ?? 'none',
    label: '', hasXmp: opts.xmp ?? false,
  };
};

/**
 * 覆盖四种范围组合 + 一种无 RAW：
 *  - A：pick + 0 星 → pick_or_rated / pick_only / raw_only / all
 *  - B：none + 5 星 → pick_or_rated / star3_plus / raw_only / all
 *  - C：none + 0 星 → raw_only / all
 *  - D：reject + 3 星 → **哪一档都不进**（淘汰是删除意图，任何范围档都不能
 *       把它带出去；rating 与 flag 独立，所以 star3_plus 也必须带淘汰守卫）
 *  - E：none + 0 星 + **无 RAW** → 只在 all（JPG-only 不进「含 RAW」）
 */
const groups: PhotoGroupInfo[] = [
  mk('A', { flag: 'pick' }),
  mk('B', { rating: 5 }),
  mk('C'),
  mk('D', { flag: 'reject', rating: 3 }),
  mk('E', { raw: false }),
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
  it('countsByFilter 与候选集一致，淘汰照片不进任何范围档', () => {
    const { result } = setup();
    expect(result.current.countsByFilter).toEqual({
      pick_or_rated: 2,
      pick_only: 1,
      // D 是 reject + 3 星：星级够但已被淘汰，不得计入
      star3_plus: 1,
      raw_only: 3,
      // 无查询、无 chips 时，「当前筛选结果」等价于「全部非淘汰」
      current_query: 4,
      all: 4,
    });
    expect(result.current.candidates.map((g) => g.baseName)).toEqual(['A', 'B']);
  });

  it('切换范围时候选集跟随', () => {
    const { result } = setup();
    act(() => result.current.setFilter('all'));
    expect(result.current.candidates.map((g) => g.baseName)).toEqual(['A', 'B', 'C', 'E']);
    act(() => result.current.setFilter('star3_plus'));
    // D 虽然 3 星，但是淘汰 —— 不得出现
    expect(result.current.candidates.map((g) => g.baseName)).toEqual(['B']);
  });

  it('「含 RAW」排除无 RAW 的组，也排除淘汰', () => {
    const { result } = setup();
    act(() => result.current.setFilter('raw_only'));
    // E 没有 RAW、D 是淘汰，两者都不该出现
    expect(result.current.candidates.map((g) => g.baseName)).toEqual(['A', 'B', 'C']);
  });

  it('jpgOnlyCount 数的是「没有 RAW 的候选」，并随范围变化', () => {
    const { result } = setup();
    // 默认 pick_or_rated：A、B 都有 RAW
    expect(result.current.jpgOnlyCount).toBe(0);
    act(() => result.current.setFilter('all'));
    // all：A B C E —— 只有 E 无 RAW
    expect(result.current.jpgOnlyCount).toBe(1);
    act(() => result.current.setFilter('raw_only'));
    // 「含 RAW」档下 jpgOnlyCount 自然一个都没有
    expect(result.current.jpgOnlyCount).toBe(0);
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

  it.each([
    ['200', '100'],
    ['10', '50'],
    ['', '92'],
  ])('qualityText=%s 失焦后规整为 %s 并给出说明', (text, shown) => {
    const { result } = setup();
    act(() => result.current.setQualityText(text));
    act(() => result.current.commitQuality());
    expect(result.current.qualityText).toBe(shown);
    // 静默改写不可接受：用户得知道是自己输错了还是程序改了
    expect(result.current.qualityNotice).toContain(`已调整为 ${shown}`);
  });

  it('合法值失焦不弹说明（每次都弹等于没弹）', () => {
    const { result } = setup();
    act(() => result.current.setQualityText('88'));
    act(() => result.current.commitQuality());
    expect(result.current.qualityText).toBe('88');
    expect(result.current.qualityNotice).toBeNull();
  });

  it('再次键入即清除上一条规整说明', () => {
    const { result } = setup();
    act(() => result.current.setQualityText('200'));
    act(() => result.current.commitQuality());
    expect(result.current.qualityNotice).not.toBeNull();
    act(() => result.current.setQualityText('9'));
    expect(result.current.qualityNotice).toBeNull();
  });
});

describe('expectedFileCount（组 ≠ 文件）', () => {
  it('复制模式按勾选类型逐组数文件，与结果条口径一致', () => {
    const { result } = setup();
    // 默认 pick_or_rated → A、B，各含 RAW + JPG → 4 个文件 / 2 组
    expect(result.current.candidates).toHaveLength(2);
    expect(result.current.expectedFileCount).toBe(4);

    act(() => result.current.setIncludeRaw(false));
    expect(result.current.expectedFileCount).toBe(2);

    act(() => result.current.setIncludeJpg(false));
    expect(result.current.expectedFileCount).toBe(0);
  });

  it('无 RAW 的组在只勾 RAW 时不产生文件', () => {
    const { result } = setup();
    act(() => result.current.setFilter('all'));
    // A B C E：E 无 RAW → 勾 RAW 时只算 A/B/C 各 1 个
    act(() => result.current.setIncludeJpg(false));
    expect(result.current.candidates).toHaveLength(4);
    expect(result.current.expectedFileCount).toBe(3);
  });

  it('带 XMP 侧车的组勾上 RAW 时算 3 个文件，取消 RAW 后侧车同步消失', () => {
    // 侧车（.xmp）只在勾 RAW 时才被复制 —— `export_items` 里 XMP 跟着 RAW 走。
    // footer 的「共 N 个文件」必须把第三个文件算进去，否则用户会以为只会多出 1 个。
    const withXmp = [mk('X', { rating: 5, xmp: true })];
    const { result } = renderHook(() =>
      useExportForm({ groups: withXmp, lumenAvailable: true }),
    );

    expect(result.current.candidates).toHaveLength(1);
    expect(result.current.expectedFileCount).toBe(3); // RAW + XMP + JPG

    act(() => result.current.setIncludeRaw(false));
    expect(result.current.expectedFileCount).toBe(1); // 只剩 JPG
  });

  it('成片模式一图一文件，等于候选组数', () => {
    const { result } = setup();
    act(() => result.current.setMode('render'));
    expect(result.current.expectedFileCount).toBe(result.current.candidates.length);
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

/**
 * `current_query` 档 —— 报告 §5.5 第 5 点：导出范围必须复用宫格的谓词，
 * 不能在导出侧再写一套筛选逻辑（两处漂移 = 导出了用户没看到的照片）。
 */
describe('导出范围「当前筛选结果」', () => {
  const setupQuery = (query: string, filterMode: FilterMode = 'all') =>
    renderHook(() =>
      useExportForm({
        groups,
        lumenAvailable: true,
        filterMode,
        queryParse: parseQuery(query),
      }),
    );

  it('无查询、无 chips 时等价于「全部非淘汰」', () => {
    const { result } = setupQuery('');
    act(() => result.current.setFilter('current_query'));

    // A/B/C/E，D 是淘汰
    expect(result.current.candidates.map((g) => g.baseName)).toEqual(['A', 'B', 'C', 'E']);
  });

  it('叠加查询语法后按语法收窄，且仍排除淘汰', () => {
    const { result } = setupQuery('rating>=3');
    act(() => result.current.setFilter('current_query'));

    // B(5★) 命中；D(3★) 被淘汰守卫排除
    expect(result.current.candidates.map((g) => g.baseName)).toEqual(['B']);
  });

  it('chips 与语法是交集（不是后者覆盖前者）', () => {
    const { result } = setupQuery('rating>=3', 'pick');
    act(() => result.current.setFilter('current_query'));

    // Pick 只有 A（0★），语法要求 ≥3★ → 空集
    expect(result.current.candidates).toEqual([]);
  });

  it('语法有错时候选归零，绝不按「放行全部」导出', () => {
    const { result } = setupQuery('ratng:3');
    act(() => result.current.setFilter('current_query'));

    expect(result.current.candidates).toEqual([]);
    expect(result.current.validation).not.toBeNull();
  });

  it('计数与候选来自同一份谓词', () => {
    const { result } = setupQuery('rating>=3');
    expect(result.current.countsByFilter.current_query).toBe(1);
    expect(result.current.countsByFilter.all).toBe(4);
  });
});
