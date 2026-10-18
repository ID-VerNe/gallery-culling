/**
 * L-11 集成回归：星级/旗标改动可一步回退。
 *
 * `1..5` / `p` / `x` / `0` 都是"按下即写 .xmp"，修复前**没有任何撤销入口** ——
 * 一次误触（例如焦点落在下拉/按钮上时）就把磁盘上的评级改掉了，用户只能手改
 * 侧边栏或回 Lightroom 改回来。
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { invokeCount, lastInvokeArgs, mockInvokeCommand } from './test/setup';
import type { FolderScanResult, PhotoGroupInfo, ToneState } from './types';
import { DEFAULT_TONE } from './utils/autoTone';

const group: PhotoGroupInfo = {
  id: 'g1',
  baseName: 'IMG_0001',
  jpg: {
    name: 'IMG_0001.jpg',
    extension: 'jpg',
    path: 'D:/shoot/JPG/IMG_0001.jpg',
    size: 1024,
    mtime: 0,
  },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  label: '', hasXmp: false,
};

const scanResult: FolderScanResult = {
  groups: [group],
  totalCount: 1,
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

function mockStartup(groups: PhotoGroupInfo[] = [group]) {
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
  mockInvokeCommand('scan_folders_cmd', {
    ...scanResult,
    groups,
    totalCount: groups.length,
  });
  mockInvokeCommand('load_session_cmd', null);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('get_tone_state_cmd', toneState);
  mockInvokeCommand('update_rating_flag_cmd', true);
  // 默认磁盘与我们以为的一致；需要冲突的用例自己覆盖这一条。
  mockInvokeCommand('check_cull_state_cmd', []);
}

async function scanOne(groups: PhotoGroupInfo[] = [group]) {
  mockStartup(groups);
  render(<App />);
  const scanBtn = await screen.findByRole('button', { name: /扫描照片目录/ });
  await waitFor(() => expect(scanBtn).toBeEnabled());
  fireEvent.click(scanBtn);
  await screen.findByText(/扫描完成/);
}

/** 三张不同起点的照片：撤销时能凭写回的 rating 分辨回退到哪一层。 */
const trio: PhotoGroupInfo[] = [1, 2, 3].map((rating, i) => {
  const name = `IMG_000${i + 1}`;
  return {
    ...group,
    id: `g${i + 1}`,
    baseName: name,
    rating,
    jpg: {
      name: `${name}.jpg`,
      extension: 'jpg',
      path: `D:/shoot/JPG/${name}.jpg`,
      size: 1024,
      mtime: 0,
    },
  };
});

const rateCalls = () => invokeCount('update_rating_flag_cmd');

describe('L-11 —— 撤销：键盘', () => {
  it('打分后 Ctrl+Z 把 XMP 写回旧值', async () => {
    await scanOne();

    fireEvent.keyDown(document.body, { key: '3' });
    await waitFor(() => expect(rateCalls()).toBe(1));
    // 单张按键走合并（FR-03）：连击由后端折叠，参数必须是 true
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({
      rating: 3,
      coalesce: true,
    });

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(rateCalls()).toBe(2));
    // 撤销是一次确定的回填，不走合并
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({
      rating: 0,
      coalesce: false,
    });
    await waitFor(() => expect(screen.getByText(/已撤销「/)).toBeInTheDocument());
  });

  it('连按 1..5 后撤销回到这轮起点，而不是上一步', async () => {
    await scanOne();

    fireEvent.keyDown(document.body, { key: '1' });
    fireEvent.keyDown(document.body, { key: '3' });
    fireEvent.keyDown(document.body, { key: '5' });
    await waitFor(() => expect(rateCalls()).toBe(3));

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(rateCalls()).toBe(4));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 0 });
  });

  it('没有可撤销的操作时给出提示，且不发写盘请求', async () => {
    await scanOne();

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(screen.getByText(/没有可撤销的操作/)).toBeInTheDocument());
    expect(rateCalls()).toBe(0);
  });

  it('输入框内的 Ctrl+Z 仍是原生「撤销输入」，不触发照片撤销', async () => {
    await scanOne();

    // 先制造一次可撤销的改动
    fireEvent.keyDown(document.body, { key: '4' });
    await waitFor(() => expect(rateCalls()).toBe(1));

    // 打开宫格搜索框并聚焦，在其中按 Ctrl+Z
    fireEvent.click(screen.getByRole('button', { name: '按条件筛选照片' }));
    const input = screen.getByRole('textbox', { name: '按查询条件筛选照片' });
    input.focus();
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });

    // 没有新的写盘 → 说明撤销没有抢走输入框的原生 Ctrl+Z
    await new Promise((r) => setTimeout(r, 30));
    expect(rateCalls()).toBe(1);
  });
});

describe('L-11 —— 撤销：鼠标入口', () => {
  it('底栏「撤销」按钮在无可撤销时禁用，改动后可用并能撤销', async () => {
    await scanOne();

    const undoBtn = () => screen.getByRole('button', { name: /^撤销/ });
    expect(undoBtn()).toBeDisabled();

    fireEvent.keyDown(document.body, { key: '2' });
    await waitFor(() => expect(rateCalls()).toBe(1));
    await waitFor(() => expect(undoBtn()).toBeEnabled());

    fireEvent.click(undoBtn());

    await waitFor(() => expect(rateCalls()).toBe(2));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 0 });
    await waitFor(() => expect(undoBtn()).toBeDisabled());
  });

  it('旗标改动（X 淘汰）同样可撤销', async () => {
    await scanOne();

    fireEvent.keyDown(document.body, { key: 'x' });
    await waitFor(() => expect(rateCalls()).toBe(1));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ flag: 'reject' });

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(rateCalls()).toBe(2));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ flag: 'none' });
  });
});

describe('FR-04 —— 多步撤销与重做', () => {
  it('改三张不同照片后 Ctrl+Z 逐层回退（不是只退最近一步）', async () => {
    await scanOne(trio);

    // 三张的起点分别是 1 / 2 / 3 星，撤销时凭写回的 rating 分辨回了哪一层。
    fireEvent.keyDown(document.body, { key: '4' });
    await waitFor(() => expect(rateCalls()).toBe(1));

    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    fireEvent.keyDown(document.body, { key: '5' });
    await waitFor(() => expect(rateCalls()).toBe(2));

    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    fireEvent.keyDown(document.body, { key: '4' });
    await waitFor(() => expect(rateCalls()).toBe(3));

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(rateCalls()).toBe(4));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 3 });

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(rateCalls()).toBe(5));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 2 });

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(rateCalls()).toBe(6));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 1 });

    // 三层都退完了：按钮回到禁用态。
    await waitFor(() => expect(screen.getByRole('button', { name: /^撤销/ })).toBeDisabled());
  });

  it('Ctrl+Shift+Z 重做：把新值再写一遍', async () => {
    await scanOne(trio);

    fireEvent.keyDown(document.body, { key: '5' }); // g1: 1 → 5
    await waitFor(() => expect(rateCalls()).toBe(1));

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(rateCalls()).toBe(2));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 1 });

    fireEvent.keyDown(document.body, { key: 'Z', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(rateCalls()).toBe(3));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({
      rating: 5,
      coalesce: false,
    });
  });

  it('Ctrl+Y 同样触发重做（Windows 习惯）', async () => {
    await scanOne(trio);

    fireEvent.keyDown(document.body, { key: '4' });
    await waitFor(() => expect(rateCalls()).toBe(1));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(rateCalls()).toBe(2));

    fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true });
    await waitFor(() => expect(rateCalls()).toBe(3));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({ rating: 4 });
  });

  it('撤销后做了新操作，重做栈清空（分支后不能重做旧路径）', async () => {
    await scanOne(trio);

    fireEvent.keyDown(document.body, { key: '5' });
    await waitFor(() => expect(rateCalls()).toBe(1));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(rateCalls()).toBe(2));

    const redoBtn = () => screen.getByRole('button', { name: /^重做/ });
    expect(redoBtn()).toBeEnabled();

    fireEvent.keyDown(document.body, { key: '2' });
    await waitFor(() => expect(rateCalls()).toBe(3));

    await waitFor(() => expect(redoBtn()).toBeDisabled());
  });

  it('底栏把命令写成可读摘要，而不是只有「撤销」两个字', async () => {
    await scanOne();

    fireEvent.keyDown(document.body, { key: 'x' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '撤销：标记为淘汰' })).toBeEnabled(),
    );

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '重做：标记为淘汰' })).toBeEnabled(),
    );
  });
});

describe('FR-04 —— 撤销前的磁盘冲突检查', () => {
  it('磁盘被别的程序改过时先弹确认；取消则一个字节都不写，命令仍在栈里', async () => {
    await scanOne();
    mockInvokeCommand('check_cull_state_cmd', [
      { path: 'D:/shoot/JPG/IMG_0001.jpg', detail: '星级：磁盘 5，预期 0' },
    ]);

    fireEvent.keyDown(document.body, { key: '3' });
    await waitFor(() => expect(rateCalls()).toBe(1));

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/张照片的 XMP 已被其他程序修改/)).toBeTruthy();
    expect(within(dialog).getByText(/星级：磁盘 5，预期 0/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rateCalls()).toBe(1);

    // 命令没被 pop：再按一次 Ctrl+Z 仍会走到同一个确认框。
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    const again = await screen.findByRole('dialog');
    fireEvent.click(within(again).getByRole('button', { name: '仍要撤销' }));

    await waitFor(() => expect(rateCalls()).toBe(2));
    expect(lastInvokeArgs('update_rating_flag_cmd')).toMatchObject({
      rating: 0,
      coalesce: false,
    });
  });

  it('磁盘一致时不弹确认，直接撤销', async () => {
    await scanOne();

    fireEvent.keyDown(document.body, { key: '4' });
    await waitFor(() => expect(rateCalls()).toBe(1));

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(rateCalls()).toBe(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
