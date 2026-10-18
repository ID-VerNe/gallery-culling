/**
 * FR-06 查询式筛选的 App 层接线。
 *
 * 纯逻辑（解析 / 匹配 / 性能）在 `utils/queryMatch.test.ts` 覆盖。这里只验证
 * 三件必须在整体 App 里才成立的事：
 *
 * 1. 查询真的收窄了宫格（不是只更新了提示文案）；
 * 2. chips 档位与语法是 **AND**，不是「后者覆盖前者」；
 * 3. 语法写错时宫格不清空 —— 这是产品性不变量，比「报错准不准」更重要。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { mockInvokeCommand } from './test/setup';
import type { CullFlag, FolderScanResult, PhotoGroupInfo, ToneState } from './types';
import { DEFAULT_TONE } from './utils/autoTone';

function mkGroup(baseName: string, rating: number, flag: CullFlag): PhotoGroupInfo {
  return {
    id: baseName.toLowerCase(),
    baseName,
    jpg: {
      name: `${baseName}.jpg`,
      extension: 'jpg',
      path: `D:/shoot/JPG/${baseName}.jpg`,
      size: 1024,
      mtime: 0,
    },
    status: 'JPG_ONLY',
    rating,
    flag,
    label: '',
    hasXmp: false,
  };
}

// 5 张：3 星以上 3 张（A/B/D），Pick 2 张（A/D），淘汰 1 张（C）。
const allGroups: PhotoGroupInfo[] = [
  mkGroup('DSC_1001', 5, 'pick'),
  mkGroup('DSC_1002', 3, 'none'),
  mkGroup('DSC_2001', 0, 'reject'),
  mkGroup('DSC_2002', 4, 'pick'),
  mkGroup('DSC_3001', 0, 'none'),
];

const scanResult: FolderScanResult = {
  groups: allGroups,
  totalCount: allGroups.length,
  jpgFolder: 'D:/shoot/JPG',
  rawFolder: '',
  isViewerMode: false,
};

const toneState: ToneState = {
  tone: { ...DEFAULT_TONE },
  xmpTone: { ...DEFAULT_TONE },
  lumenTone: null,
  divergent: false,
  lumenAvailable: false,
};

function mockStartup() {
  mockInvokeCommand('get_settings_cmd', {
    defaultJpgFolder: 'D:/shoot/JPG',
    defaultRawFolder: '',
    photoshopPath: '',
    thumbnailWidth: 200,
    sortOrder: 'time_filename',
    lumenEnabled: false,
    lumenCliPath: '',
    lumenGridThumbnails: false,
    lumenExpectAi: false,
  });
  mockInvokeCommand('save_settings_cmd', true);
  mockInvokeCommand('save_session_cmd', true);
  mockInvokeCommand('scan_folders_cmd', scanResult);
  mockInvokeCommand('load_session_cmd', null);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('get_tone_state_cmd', toneState);
}

async function scanFive() {
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);
  await screen.findByText(/扫描完成/);
}

/**
 * 打开宫格查询框（幂等：已经开着就直接返回）。
 *
 * 这里手写轮询而不是用 `findByRole`：切档之后 `fireEvent` 的 `act` 尚未退出，
 * 嵌套在 `waitFor` 里的 act 看不到新节点，而让出事件循环（`setTimeout`）
 * 之后同步查询就能命中。`findByRole` 在这个场景会白等满 1 秒。
 */
async function openQuery(): Promise<HTMLInputElement> {
  const existing = screen.queryAllByRole('textbox', { name: '按查询条件筛选照片' });
  if (existing.length === 1) return existing[0] as HTMLInputElement;

  fireEvent.click(screen.getByRole('button', { name: '按条件筛选照片' }));
  for (let i = 0; i < 20; i++) {
    const found = screen.queryAllByRole('textbox', { name: '按查询条件筛选照片' });
    if (found.length === 1) return found[0] as HTMLInputElement;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('查询框没有打开');
}

/**
 * 宫格实际渲染出的张数。
 *
 * 必须限定在 `listbox` 内数：顶栏筛选下拉的 `<option>` 也是 `role="option"`，
 * 全局数会把它们算进来。宫格为空时 `listbox` 本身不渲染，此时返回 0。
 */
const gridCount = () => {
  const grid = screen.queryByRole('listbox');
  return grid ? within(grid).queryAllByRole('option').length : 0;
};

describe('FR-06 —— 查询语法收窄宫格', () => {
  it('rating>=3 只留下 3 星以上的 3 张', async () => {
    mockStartup();
    await scanFive();
    expect(gridCount()).toBe(5);

    fireEvent.change(await openQuery(), { target: { value: 'rating>=3' } });

    await waitFor(() => expect(gridCount()).toBe(3));
    expect(screen.getByText(/1 个条件 · 匹配 3 张/)).toBeInTheDocument();
  });

  it('flag:reject 只留下淘汰的那 1 张', async () => {
    mockStartup();
    await scanFive();

    fireEvent.change(await openQuery(), { target: { value: 'flag:reject' } });

    await waitFor(() => expect(gridCount()).toBe(1));
  });

  it('取反排除淘汰后剩 4 张', async () => {
    mockStartup();
    await scanFive();

    fireEvent.change(await openQuery(), { target: { value: '-flag:reject' } });

    await waitFor(() => expect(gridCount()).toBe(4));
  });

  it('裸词仍按文件名子串匹配（升级前的肌肉记忆继续工作）', async () => {
    mockStartup();
    await scanFive();

    fireEvent.change(await openQuery(), { target: { value: 'DSC_1' } });

    await waitFor(() => expect(gridCount()).toBe(2));
  });
});

describe('FR-06 —— chips 与语法叠加', () => {
  it('chips 选「仅已保留」再叠加 rating>=3，结果是两者的交集', async () => {
    mockStartup();
    await scanFive();

    // chips：Pick 有 A/D 两张
    fireEvent.change(screen.getByRole('combobox', { name: '照片筛选过滤' }), {
      target: { value: 'pick' },
    });
    await waitFor(() => expect(gridCount()).toBe(2));

    await waitFor(() => expect(gridCount()).toBe(2));

    // 语法：rating>=3 在 Pick 集合里仍是 A/D → 2 张；
    // 若实现成「语法覆盖 chips」，结果会是全集的 3 张（A/B/D）。
    fireEvent.change(await openQuery(), { target: { value: 'rating>=3' } });
    await waitFor(() => expect(gridCount()).toBe(2));

    // 换一个只命中非 Pick 的条件，验证交集真的在收缩
    fireEvent.change(await openQuery(), { target: { value: 'rating:3' } });
    await waitFor(() => expect(gridCount()).toBe(0));
  });
});

describe('FR-06 —— 语法写错时不把宫格清空', () => {
  it('未知字段只提示，仍显示全部 5 张', async () => {
    mockStartup();
    await scanFive();

    fireEvent.change(await openQuery(), { target: { value: 'ratng:3' } });

    // 提示出现
    await waitFor(() => expect(screen.getByText(/未知字段「ratng」/)).toBeInTheDocument());
    // 宫格没有被清空
    expect(gridCount()).toBe(5);
  });

  it('数值字段给非数字同样只提示', async () => {
    mockStartup();
    await scanFive();

    fireEvent.change(await openQuery(), { target: { value: 'iso:abc' } });

    await waitFor(() =>
      expect(screen.getByText(/「iso」需要一个数字，例如 iso>=3200/)).toBeInTheDocument(),
    );
    expect(gridCount()).toBe(5);
  });

  it('一半对一半错时，错的那条不生效但也不清空宫格', async () => {
    mockStartup();
    await scanFive();

    // terms=1（rating>=3）、errors=1（ratng 未知）→ 走错误放行分支，全放行。
    // 若实现成「有错就清空」，这条会变成 0 张。
    fireEvent.change(await openQuery(), { target: { value: 'rating>=3 ratng:1' } });

    await waitFor(() => expect(screen.getByText(/未知字段「ratng」/)).toBeInTheDocument());
    expect(gridCount()).toBe(5);
  });

  it('值还没打完（iso:）算「输入中」，不报错也不筛空', async () => {
    mockStartup();
    await scanFive();

    fireEvent.change(await openQuery(), { target: { value: 'iso:' } });

    await waitFor(() => expect(screen.getByText('输入中…')).toBeInTheDocument());
    expect(gridCount()).toBe(5);
  });
});
