/**
 * UX-14 / UX-15：扫描进度与失败态的顶栏呈现。
 *
 * 两条契约：
 * - UX-14 扫描中给出实时的「已发现 N 张」，而不是一个不动的转圈
 * - UX-15 失败原因常驻顶栏（role=alert）且可被用户主动忽略
 *
 * 此前失败只走一次 toast 就消失，批量扫描时用户同时盯着宫格与进度条，
 * 3 秒后已无从判断是哪一步坏了。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { mockInvokeCommand, mockInvokeError, resetInvokeMocks } from './test/setup';
import { TASK_CANCELLED_SENTINEL } from './services/taskApi';

beforeEach(() => {
  resetInvokeMocks();
  localStorage.clear();
});

/** App 启动时必然触发的一批只读命令，全部给无害返回值。 */
function mockBaseline() {
  mockInvokeCommand('get_settings_cmd', { defaultJpgFolder: '' });
  mockInvokeCommand('load_session_cmd', null);
  mockInvokeCommand('save_settings_cmd', true);
  mockInvokeCommand('save_session_cmd', true);
  mockInvokeCommand('get_thumbnail_cmd', 'D:/cache/thumb.jpg');
  mockInvokeCommand('probe_lumen_cmd', { available: false });
  mockInvokeCommand('get_tone_state_cmd', { tone: null });
}

/** 填入 JPG 路径并触发一次扫描。 */
async function scanWith(path: string) {
  const jpgInput = await screen.findByLabelText('JPG 照片文件夹路径');
  await userEvent.clear(jpgInput);
  await userEvent.type(jpgInput, path);
  await userEvent.click(screen.getByRole('button', { name: '扫描照片目录' }));
}

describe('顶栏扫描失败（UX-15）', () => {
  it('失败原因常驻顶栏并可被忽略', async () => {
    mockBaseline();
    mockInvokeError('scan_folders_cmd', new Error('路径不存在或无读取权限'));

    render(<App />);
    await scanWith('D:/nope');

    // 失败原因常驻，不随 toast 退场
    const alert = await screen.findByTestId('topbar-scan-error');
    expect(alert.textContent).toContain('路径不存在或无读取权限');

    // 失败态下扫描按钮禁用（避免连续点同一个坏路径）
    expect((screen.getByLabelText('扫描照片目录') as HTMLButtonElement).disabled).toBe(true);

    // 用户可主动忽略
    await userEvent.click(screen.getByRole('button', { name: '忽略扫描错误' }));
    await waitFor(() => expect(screen.queryByTestId('topbar-scan-error')).toBeNull());
    expect((screen.getByLabelText('扫描照片目录') as HTMLButtonElement).disabled).toBe(false);
  });

  it('重新扫描会清掉上一轮的失败文案', async () => {
    mockBaseline();
    let shouldFail = true;
    mockInvokeCommand('scan_folders_cmd', () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('第一次失败');
      }
      return { groups: [], total_count: 0 };
    });

    render(<App />);
    await scanWith('D:/shoot');

    expect((await screen.findByTestId('topbar-scan-error')).textContent).toContain('第一次失败');

    await userEvent.click(screen.getByRole('button', { name: '忽略扫描错误' }));
    await userEvent.click(screen.getByRole('button', { name: '扫描照片目录' }));
    await waitFor(() => expect(screen.queryByTestId('topbar-scan-error')).toBeNull());
  });

  it('用户主动取消不算失败（不产生常驻错误文案）', async () => {
    mockBaseline();
    // 后端以哨兵文案返回取消，与真实失败走同一通道。
    // 注意必须抛**裸字符串**：Tauri 的 invoke 在 Err(String) 时 reject 的是
    // 字符串本身，`String(new Error(sentinel))` 会变成 "Error: 任务已取消"
    // 从而绕不过 isTaskCancelled 的精确比对（这是真实链路，不是测试造���）。
    mockInvokeCommand('scan_folders_cmd', () => {
      throw TASK_CANCELLED_SENTINEL;
    });

    render(<App />);
    await scanWith('D:/shoot');

    await waitFor(() => expect(screen.queryByLabelText('正在扫描照片目录')).toBeNull());
    expect(screen.queryByTestId('topbar-scan-error')).toBeNull();
  });
});

describe('顶栏扫描进度（UX-14）', () => {
  it('扫描进行中按钮显示「扫描中…」而非照片数', async () => {
    mockBaseline();
    mockInvokeCommand('scan_folders_cmd', { groups: [], total_count: 0 });

    render(<App />);
    await scanWith('D:/shoot');

    // 扫描结束后按钮回到常态
    await waitFor(() => expect(screen.queryByLabelText('正在扫描照片目录')).toBeNull());
    expect(screen.getByText('扫描照片')).toBeTruthy();
  });
});