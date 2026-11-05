/**
 * 更新 hook 的状态机用例（issue #43-PA/PB）。
 *
 * 关键事实：Windows 上 `downloadAndInstall` 启动安装器后直接 `process::exit(0)`，
 * **Promise 永不 resolve**（`tauri-plugin-updater/src/updater.rs:862-876`）。
 * 所以这里刻意让假实现的 Promise 挂住不结束：终态必须由 `Finished` 事件驱动，
 * 不能依赖 await 之后那行代码。
 */
import { act, renderHook } from '@testing-library/react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';
import { UPDATE_ENDPOINT, UPDATE_SKIP_KEY } from '../utils/updateSkip';
import { UPDATE_PENDING_KEY } from '../utils/updatePending';
import { useAutoUpdate } from './useAutoUpdate';

/**
 * Toast 被收集而不是渲染（issue #49-PB）：
 * 升级结果提示是「用户必须看到」的那一层兜底，必须在 hook 层就能断言。
 */
const toastHarness = vi.hoisted(() => {
  const success: string[] = [];
  const error: string[] = [];
  const info: string[] = [];
  // **同一个对象**：真实 provider 的 api 是 useMemo 出来的稳定引用，
  // 每次返回新对象会让 effect 反复重跑，掩盖真实的启动判定语义。
  const api = {
    success: (message: string) => success.push(message),
    error: (message: string) => error.push(message),
    info: (message: string) => info.push(message),
  };
  return { calls: { success, error, info }, api };
});
const toastCalls = toastHarness.calls;

vi.mock('../components/Toast', () => ({
  useToast: () => toastHarness.api,
}));

type DownloadEventLike =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

const neverResolves = () => new Promise<void>(() => {});

/** 造一个假 Update；`hang` 模拟 Windows 的「装完即退出、Promise 不 resolve」。 */
function fakeUpdate(
  version: string,
  options: { hang?: boolean; fail?: boolean } = {},
): Update {
  const { hang = true, fail = false } = options;
  return {
    version,
    body: `更新说明 v${version}`,
    downloadAndInstall: vi.fn(
      async (
        onEvent?: (event: DownloadEventLike) => void,
        _options?: { restartAfterInstall?: boolean },
      ): Promise<void> => {
        // 真实实现的下载是异步的；先让出一个微任务，好让调用方看到 downloading 态。
        await Promise.resolve();
        onEvent?.({ event: 'Started', data: { contentLength: 100 } });
        onEvent?.({ event: 'Progress', data: { chunkLength: 100 } });
        if (fail) throw new Error('网络不可达');
        onEvent?.({ event: 'Finished' });
        if (hang) return neverResolves();
      },
    ),
  } as unknown as Update;
}

/** 推进 1.5s 的启动探测窗口。 */
async function advanceStartupCheck() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  toastCalls.success.length = 0;
  toastCalls.error.length = 0;
  toastCalls.info.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutoUpdate —— 启动探测与跳过判定', () => {
  it('没有跳过记录时，发现新版本就弹窗', async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();
    expect(result.current.pendingVersion).toBe('2.0.6');
    expect(result.current.checkState.status).toBe('idle');
  });

  it('同版本已跳过：启动时不再弹窗，但仍能读出被跳过的版本', async () => {
    localStorage.setItem(
      UPDATE_SKIP_KEY,
      JSON.stringify({
        version: '2.0.6',
        endpoint: UPDATE_ENDPOINT,
        skippedAt: '2026-11-04T00:00:00.000Z',
      }),
    );
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();
    expect(result.current.pendingVersion).toBeNull();
    expect(result.current.skippedVersion).toBe('2.0.6');
  });

  it('远端版本提升：跳过标记自动失效，重新弹窗', async () => {
    localStorage.setItem(
      UPDATE_SKIP_KEY,
      JSON.stringify({
        version: '2.0.6',
        endpoint: UPDATE_ENDPOINT,
        skippedAt: '2026-11-04T00:00:00.000Z',
      }),
    );
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.7'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();
    expect(result.current.pendingVersion).toBe('2.0.7');
  });

  it('探测失败保持静默（启动路径不给用户制造噪音）', async () => {
    vi.mocked(check).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();
    expect(result.current.pendingVersion).toBeNull();
    expect(result.current.checkState.status).toBe('idle');
  });
});

describe('useAutoUpdate —— 安装终态（Windows 上 Promise 不 resolve）', () => {
  it('Finished 之后进入「安装中」终态：无百分比、按钮不可点、不会复位', async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    act(() => {
      result.current.install();
    });
    expect(result.current.phase).toBe('downloading');

    await settle();
    expect(result.current.phase).toBe('installing');
    expect(result.current.updateBusy).toBe(true);
    expect(result.current.updateStatus).toContain('正在安装，完成后会自动启动');
    expect(result.current.updateStatus).not.toContain('%');

    // Promise 永远不 resolve —— 状态必须保持终态，不能回到 idle
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.phase).toBe('installing');
  });

  it('下载失败：进入 failed 并给出可操作文案，弹窗保持可见', async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6', { fail: true }));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    act(() => {
      result.current.install();
    });
    await settle();

    expect(result.current.phase).toBe('failed');
    expect(result.current.updateBusy).toBe(false);
    expect(result.current.error).toContain('网络不可达');
    expect(result.current.error).toContain('请检查网络后重试');
    expect(result.current.pendingVersion).toBe('2.0.6');
  });
});

describe('useAutoUpdate —— 持久标记只由「本次暂不更新」写入', () => {
  it('勾选后点「本次暂不更新」：写 gc:update:skip', async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    act(() => {
      result.current.setSkipChecked(true);
    });
    act(() => {
      result.current.later();
    });

    const stored = JSON.parse(localStorage.getItem(UPDATE_SKIP_KEY) ?? 'null');
    expect(stored).toEqual(
      expect.objectContaining({ version: '2.0.6', endpoint: UPDATE_ENDPOINT }),
    );
    expect(result.current.pendingVersion).toBeNull();
    expect(result.current.skippedVersion).toBe('2.0.6');
  });

  it('勾选后按 X / Esc（onClose）：绝不写盘', async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    act(() => {
      result.current.setSkipChecked(true);
    });
    act(() => {
      result.current.dismiss();
    });

    expect(localStorage.getItem(UPDATE_SKIP_KEY)).toBeNull();
    expect(result.current.pendingVersion).toBeNull();
    expect(result.current.skippedVersion).toBeNull();
  });

  it('没勾选就点「本次暂不更新」：也不写盘（只影响本次）', async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    act(() => {
      result.current.later();
    });

    expect(localStorage.getItem(UPDATE_SKIP_KEY)).toBeNull();
    expect(result.current.skippedVersion).toBeNull();
  });

  it('弹窗把 X / Esc 绑到 dismiss、次按钮绑到 later（两条关闭路径不许串线）', async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    const element = result.current.dialog;
    expect(element.props.onClose).toBe(result.current.dismiss);
    expect(element.props.onLater).toBe(result.current.later);
  });

  it('跳过后的下一次启动：同版本不弹（持久标记真的生效）', async () => {
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const first = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();
    act(() => {
      first.result.current.setSkipChecked(true);
    });
    act(() => {
      first.result.current.later();
    });
    first.unmount();

    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const second = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();
    expect(second.result.current.pendingVersion).toBeNull();
    expect(second.result.current.skippedVersion).toBe('2.0.6');
  });
});

describe('useAutoUpdate —— 主动检查与撤销', () => {
  it('跳过态下手动检查：显示「已跳过」而不弹窗，入口没被永久堵死', async () => {
    localStorage.setItem(
      UPDATE_SKIP_KEY,
      JSON.stringify({
        version: '2.0.6',
        endpoint: UPDATE_ENDPOINT,
        skippedAt: '2026-11-04T00:00:00.000Z',
      }),
    );
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    await act(async () => {
      await result.current.checkNow();
    });

    expect(result.current.checkState).toMatchObject({ status: 'skipped', version: '2.0.6' });
    expect(result.current.pendingVersion).toBeNull();
  });

  it('撤销跳过：清记录并立刻重新弹窗', async () => {
    localStorage.setItem(
      UPDATE_SKIP_KEY,
      JSON.stringify({
        version: '2.0.6',
        endpoint: UPDATE_ENDPOINT,
        skippedAt: '2026-11-04T00:00:00.000Z',
      }),
    );
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();
    await act(async () => {
      await result.current.checkNow();
    });

    act(() => {
      result.current.restoreSkipped();
    });

    expect(localStorage.getItem(UPDATE_SKIP_KEY)).toBeNull();
    expect(result.current.skippedVersion).toBeNull();
    expect(result.current.pendingVersion).toBe('2.0.6');
  });

  it('手动检查失败要有反馈（与启动时的静默策略不同）', async () => {
    vi.mocked(check).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    await act(async () => {
      await result.current.checkNow();
    });

    expect(result.current.checkState).toMatchObject({
      status: 'error',
      error: expect.stringContaining('offline'),
    });
  });
});

describe('useAutoUpdate —— 安装器重启交接（issue #49-PA）', () => {
  it('downloadAndInstall 第二参是 restartAfterInstall: false（关掉模板的 /R）', async () => {
    vi.mocked(getVersion).mockResolvedValue('2.0.5');
    const update = fakeUpdate('2.0.6');
    vi.mocked(check).mockResolvedValue(update);
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    act(() => {
      result.current.install();
    });
    await settle();

    const call = vi.mocked(update.downloadAndInstall).mock.calls[0];
    expect(call?.[1]).toEqual({ restartAfterInstall: false });
  });

  it('开始安装就写 gc:update:pending（当前版本 + 目标版本）', async () => {
    vi.mocked(getVersion).mockResolvedValue('2.0.5');
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    act(() => {
      result.current.install();
    });
    await settle();

    const stored = JSON.parse(localStorage.getItem(UPDATE_PENDING_KEY) ?? 'null');
    expect(stored).toEqual(
      expect.objectContaining({ fromVersion: '2.0.5', targetVersion: '2.0.6' }),
    );
  });

  it('下载就失败：清掉待定记录，避免下次启动误报「升级未完成」', async () => {
    vi.mocked(getVersion).mockResolvedValue('2.0.5');
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6', { fail: true }));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    act(() => {
      result.current.install();
    });
    await settle();

    expect(result.current.phase).toBe('failed');
    expect(localStorage.getItem(UPDATE_PENDING_KEY)).toBeNull();
  });
});

describe('useAutoUpdate —— 下次启动的升级结果兜底（issue #49-PB）', () => {
  it('已成目标版本：给成功提示并清除记录', async () => {
    localStorage.setItem(
      UPDATE_PENDING_KEY,
      JSON.stringify({
        fromVersion: '2.0.4',
        targetVersion: '2.0.5',
        startedAt: '2026-11-05T00:00:00.000Z',
      }),
    );
    vi.mocked(getVersion).mockResolvedValue('2.0.5');
    const { result } = renderHook(() => useAutoUpdate());
    await settle();

    expect(result.current.currentVersion).toBe('2.0.5');
    expect(toastCalls.success).toContain('已升级到 v2.0.5');
    expect(toastCalls.error).toEqual([]);
    expect(localStorage.getItem(UPDATE_PENDING_KEY)).toBeNull();
  });

  it('仍是旧版本：错误 toast 常驻，文案给出下一步怎么办', async () => {
    localStorage.setItem(
      UPDATE_PENDING_KEY,
      JSON.stringify({
        fromVersion: '2.0.4',
        targetVersion: '2.0.6',
        startedAt: '2026-11-05T00:00:00.000Z',
      }),
    );
    vi.mocked(getVersion).mockResolvedValue('2.0.5');
    const { result } = renderHook(() => useAutoUpdate());
    await settle();

    expect(result.current.currentVersion).toBe('2.0.5');
    expect(toastCalls.success).toEqual([]);
    expect(toastCalls.error).toHaveLength(1);
    expect(toastCalls.error[0]).toContain('上次升级未完成');
    expect(toastCalls.error[0]).toContain('v2.0.6');
    expect(toastCalls.error[0]).toContain('设置 → 关于');
    expect(localStorage.getItem(UPDATE_PENDING_KEY)).toBeNull();
  });

  it('启动判定只看「挂载时已有」的记录：本次会话写入的不能被自己清掉', async () => {
    // 模拟真实世界里的极短窗口：getVersion 还没回来，用户就已经点了安装。
    let resolveVersion!: (version: string) => void;
    vi.mocked(getVersion).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveVersion = resolve;
      }),
    );
    vi.mocked(check).mockResolvedValue(fakeUpdate('2.0.6'));
    const { result } = renderHook(() => useAutoUpdate());
    await advanceStartupCheck();

    act(() => {
      result.current.install();
    });
    await settle();

    await act(async () => {
      resolveVersion('2.0.5');
    });
    await settle();

    // 记录必须还在：它是「下一次启动」才该判定的东西。
    expect(localStorage.getItem(UPDATE_PENDING_KEY)).not.toBeNull();
    expect(toastCalls.error).toEqual([]);
  });

  it('没有待定记录时两条路径都不打扰用户', async () => {
    vi.mocked(getVersion).mockResolvedValue('2.0.5');
    renderHook(() => useAutoUpdate());
    await settle();

    expect(toastCalls.success).toEqual([]);
    expect(toastCalls.error).toEqual([]);
  });
});
