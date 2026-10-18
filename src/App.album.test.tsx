/**
 * FR-10 App 集成：选片集的打开 / 保存入口真的接在应用上。
 *
 * 单元测试证明了转换层与 hook 的分支；这一层证明**它们真的接在一起**：
 * 点「选片集」能开弹窗、打开后宫格真的换了、顶栏真的标出「来自选片集」、
 * 选片集视图里改排序**不会**按旧目录重扫（那会把整本选片集冲掉）、
 * 扫描之后这个身份真的撤掉了。
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import App from './App';
import { invokeCalls, invokeCount, mockInvokeCommand } from './test/setup';
import type { AlbumOpenResult, FolderScanResult, PhotoGroupInfo } from './types';

const openMock = vi.mocked(openDialog);

const group = (id: string): PhotoGroupInfo => ({
  id,
  baseName: id,
  jpg: {
    name: `${id}.jpg`,
    extension: 'jpg',
    path: `D:/shoot/JPG/${id}.jpg`,
    size: 1024,
    mtime: 1,
  },
  status: 'JPG_ONLY',
  rating: 0,
  flag: 'none',
  label: '',
  hasXmp: false,
});

const scanResult: FolderScanResult = {
  groups: [group('IMG_0001')],
  totalCount: 1,
  jpgFolder: 'D:/shoot/JPG',
  rawFolder: '',
  isViewerMode: false,
};

const albumResult: AlbumOpenResult = {
  path: 'D:/shoot/pick.galleryalbum',
  entries: [
    {
      source: 'raw/DSC04339.ARW',
      path: 'D:/shoot/raw/DSC04339.ARW',
      exists: true,
      isRaw: true,
      size: 2048,
      mtime: 100,
      jpgPath: 'D:/shoot/jpg/DSC04339.JPG',
      jpgExists: true,
      jpgSize: 1024,
      jpgMtime: 99,
      hasXmp: true,
      tone: null,
      rating: 3,
      flag: 'pick',
      label: '',
    },
  ],
  missing: 0,
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
  mockInvokeCommand('get_tone_state_cmd', null);
  mockInvokeCommand('refresh_from_xmp_cmd', {
    checked: 0,
    unchanged: 0,
    baselined: 0,
    adopted: [],
    conflicts: [],
    failed: [],
  });
  mockInvokeCommand('open_album_cmd', albumResult);
  mockInvokeCommand('save_album_cmd', { path: 'D:/shoot/pick.galleryalbum', saved: 1 });
}

async function openAlbum() {
  render(<App />);
  // 等设置回填完成（扫描按钮可用 = settings 已到）
  const scanBtn = await screen.findByRole('button', { name: '扫描照片目录' });
  await waitFor(() => expect(scanBtn).toBeEnabled());

  fireEvent.click(screen.getByRole('button', { name: '选片集' }));
  openMock.mockResolvedValueOnce('D:/shoot/pick.galleryalbum');
  fireEvent.click(await screen.findByRole('button', { name: '打开选片集' }));
}

describe('App —— 选片集', () => {
  it('打开后集合换成选片集里的照片，顶栏标出来源', async () => {
    mockStartup();
    await openAlbum();

    // 宫格出现选片集里的那张（DSC04339），而不是扫描结果里的 IMG_0001。
    // 同一张会在宫格、底栏、视口各出现一次，所以用 findAll。
    expect((await screen.findAllByText('DSC04339')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('IMG_0001')).toHaveLength(0);
    expect(screen.getByText('选片集 pick.galleryalbum')).toBeInTheDocument();
  });

  it('选片集视图里改排序是本地排序，**不会**按旧目录重扫', async () => {
    mockStartup();
    await openAlbum();
    await screen.findAllByText('DSC04339');

    const scansBefore = invokeCount('scan_folders_cmd');
    fireEvent.change(screen.getByLabelText('照片排序方式'), { target: { value: 'filename' } });
    // 给可能（错误地）发起的扫描一点时间
    await new Promise((r) => setTimeout(r, 50));

    expect(invokeCount('scan_folders_cmd')).toBe(scansBefore);
    // 排序确实生效了（排序 select 的值变了）
    expect(screen.getByLabelText('照片排序方式')).toHaveValue('filename');
  });

  it('扫描之后选片集身份被撤掉（顶栏不再声称来自选片集）', async () => {
    mockStartup();
    await openAlbum();
    await screen.findByText('选片集 pick.galleryalbum');

    fireEvent.click(screen.getByRole('button', { name: '扫描照片目录' }));
    await waitFor(() =>
      expect(screen.queryByText('选片集 pick.galleryalbum')).not.toBeInTheDocument(),
    );
    // 扫描结果回来了
    expect((await screen.findAllByText('IMG_0001')).length).toBeGreaterThan(0);
  });

  it('打开选片集发出的是 open_album_cmd，路径就是对话框选中的那个', async () => {
    mockStartup();
    await openAlbum();
    await screen.findAllByText('DSC04339');
    const calls = invokeCalls('open_album_cmd');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ path: 'D:/shoot/pick.galleryalbum' });
  });

  it('有人缺相机参数时，EXIF 查询说出缺几张（而不是安静地漏掉）', async () => {
    mockStartup();
    const base = albumResult.entries[0];
    mockInvokeCommand('open_album_cmd', {
      ...albumResult,
      entries: [
        { ...base, exif: { iso: '800' } },
        {
          ...base,
          source: 'raw/DSC2.ARW',
          path: 'D:/shoot/raw/DSC2.ARW',
          jpgPath: 'D:/shoot/jpg/DSC2.JPG',
          exif: { iso: '800' },
        },
        // 缺配对 JPG，主路径也读不出 → 没有相机参数的那一张
        {
          ...base,
          source: 'raw/DSC3.ARW',
          path: 'D:/shoot/raw/DSC3.ARW',
          jpgPath: null,
          jpgExists: false,
          exif: null,
        },
      ],
    });
    await openAlbum();
    await screen.findAllByText('DSC04339');

    // 弹窗开着时 `isDialogOpen` 会拦掉所有单键快捷键，先关掉再按 `/`。
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    // `/` 是打开宫格搜索的约定键位
    fireEvent.keyDown(window, { key: '/' });
    fireEvent.change(await screen.findByLabelText('按查询条件筛选照片'), {
      target: { value: 'iso:800' },
    });

    expect(await screen.findByText(/1 张没有相机参数/)).toBeTruthy();
  });
});
