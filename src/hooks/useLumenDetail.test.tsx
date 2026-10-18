/**
 * FR-05：RAW 全分辨率细节（1:1 对焦检查）的加载契约。
 *
 * 这个 hook 的全部价值同样在「什么时候**不**发请求」：
 *  - 不按 Z 就不发（6–8 秒 + 761MB 不能自己发生）；
 *  - JPG 分组不发（原图本身就是全分辨率）；
 *  - 引擎不可用不发（静默退回预览）；
 *  - 连点只发一次（后端并发上限 1，堆积只会换来一串 E_BUSY）；
 *  - 换图后旧结果必须丢弃（不能把 A 的细节贴到 B 上）。
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useLumenDetail } from './useLumenDetail';
import { LUMEN_UNAVAILABLE } from './useLumenStatus';
import {
  invokeCount,
  invokeCalls,
  lastInvokeArgs,
  mockInvokeCommand,
  mockInvokeError,
  setInvokeHandler,
} from '../test/setup';
import type { LumenStatus, PhotoGroupInfo } from '../types';

const available: LumenStatus = {
  available: true,
  enabled: true,
  pinnedVersion: '1.6.0',
  foundVersion: '1.6.0',
  detail: 'ok',
};

function photo(id: string, overrides: Partial<PhotoGroupInfo> = {}): PhotoGroupInfo {
  return {
    id,
    baseName: id,
    raw: {
      name: `${id}.ARW`,
      extension: 'ARW',
      path: `D:/shoot/${id}.ARW`,
      size: 1,
      mtime: 0,
    },
    status: 'RAW_ONLY',
    rating: 0,
    flag: 'none',
    label: '',
    hasXmp: false,
    ...overrides,
  };
}

const detailOk = {
  detailPath: 'D:/cache/gallery/lumen/abc_detail_lumen.jpg',
  cached: false,
  elapsedMs: 6500,
};

describe('useLumenDetail —— 什么时候不发请求', () => {
  it('不调用 request 就零请求（6-8 秒的等待不能自己发生）', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      await Promise.resolve();
    });

    expect(invokeCount('lumen_detail_cmd')).toBe(0);
    expect(result.current.url).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('有 JPG 的分组零请求：JPG 原图本身就是全分辨率', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const withJpg = photo('a', {
      jpg: { name: 'a.jpg', extension: 'jpg', path: 'D:/shoot/a.jpg', size: 1, mtime: 0 },
      status: 'COMPLETE',
    });
    const { result } = renderHook(() => useLumenDetail(withJpg, available));

    await act(async () => {
      result.current.request();
    });

    expect(invokeCount('lumen_detail_cmd')).toBe(0);
    expect(result.current.url).toBeNull();
  });

  it('引擎不可用零请求（静默退回预览，不弹错）', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const { result } = renderHook(() => useLumenDetail(photo('a'), LUMEN_UNAVAILABLE));

    await act(async () => {
      result.current.request();
    });

    expect(invokeCount('lumen_detail_cmd')).toBe(0);
    expect(result.current.failed).toBe(false);
  });

  it('没有 RAW 路径的分组零请求', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const noRaw = photo('a', { raw: undefined, status: 'JPG_ONLY' });
    const { result } = renderHook(() => useLumenDetail(noRaw, available));

    await act(async () => {
      result.current.request();
    });

    expect(invokeCount('lumen_detail_cmd')).toBe(0);
  });
});

describe('useLumenDetail —— 请求与就绪', () => {
  it('request 之后拿到 asset URL，loading 归位', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });

    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(result.current.url).toBe(`asset://localhost/${detailOk.detailPath}`);
    expect(result.current.loading).toBe(false);
    expect(result.current.failed).toBe(false);
  });

  it('带上调色 recipe：改了色必须重新出细节', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const recipe = { adjustments: { exposure: 0.5 } };
    const { result } = renderHook(() => useLumenDetail(photo('a'), available, recipe));

    await act(async () => {
      result.current.request();
    });

    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(lastInvokeArgs('lumen_detail_cmd')?.recipe).toBe(JSON.stringify(recipe));
  });

  it('已就绪后再 request 不发第二次（幂等）', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });
    await waitFor(() => expect(result.current.url).not.toBeNull());

    await act(async () => {
      result.current.request();
      result.current.request();
    });

    expect(invokeCount('lumen_detail_cmd')).toBe(1);
  });

  it('同一 tick 内连点两次只发一次（后端并发上限 1）', async () => {
    // 手动控制完成时机：第一次还在飞的时候连点，不能变成两次请求。
    let release: ((v: unknown) => void) | null = null;
    setInvokeHandler((cmd) => {
      if (cmd !== 'lumen_detail_cmd') return undefined;
      return new Promise((res) => {
        release = res;
      });
    });

    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
      result.current.request();
      result.current.request();
    });

    expect(invokeCount('lumen_detail_cmd')).toBe(1);

    await act(async () => {
      release?.(detailOk);
    });
    await waitFor(() => expect(result.current.url).not.toBeNull());
    // 关键：第一次完成后**不能**因为排队位里还留着同一张而再发一次
    // （守卫去掉时这条会红 —— 只断言"release 之前是 1 次"抓不住）。
    expect(invokeCount('lumen_detail_cmd')).toBe(1);
  });

  it('缓存命中也是就绪（cached=true 不影响 URL）', async () => {
    mockInvokeCommand('lumen_detail_cmd', { ...detailOk, cached: true, elapsedMs: 3 });
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });

    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(result.current.loading).toBe(false);
  });
});

describe('useLumenDetail —— 串行队列', () => {
  it('A 在飞时请求 B：等 A 完成才发 B，不并发', async () => {
    const releases: Array<(v: unknown) => void> = [];
    setInvokeHandler((cmd) => {
      if (cmd !== 'lumen_detail_cmd') return undefined;
      return new Promise((res) => {
        releases.push(res);
      });
    });

    const { result, rerender } = renderHook(
      ({ group }) => useLumenDetail(group, available),
      { initialProps: { group: photo('a') } },
    );

    await act(async () => {
      result.current.request();
    });
    expect(invokeCount('lumen_detail_cmd')).toBe(1);

    // 切到 B 并请求：B 必须排队（后端同一时刻只允许一张）
    rerender({ group: photo('b') });
    await act(async () => {
      result.current.request();
    });
    expect(invokeCount('lumen_detail_cmd')).toBe(1);

    // A 完成 → 队列里的 B 自动发出
    await act(async () => {
      releases[0]?.({ ...detailOk, detailPath: 'D:/cache/a_detail_lumen.jpg' });
    });
    await waitFor(() => expect(invokeCount('lumen_detail_cmd')).toBe(2));

    const paths = invokeCalls('lumen_detail_cmd').map((c) => c.args?.filePath);
    expect(paths).toEqual(['D:/shoot/a.ARW', 'D:/shoot/b.ARW']);
  });

  it('排队时连点同一张不会堆出多个任务（只保留最新一条）', async () => {
    const releases: Array<(v: unknown) => void> = [];
    setInvokeHandler((cmd) => {
      if (cmd !== 'lumen_detail_cmd') return undefined;
      return new Promise((res) => {
        releases.push(res);
      });
    });

    const { result, rerender } = renderHook(
      ({ group }) => useLumenDetail(group, available),
      { initialProps: { group: photo('a') } },
    );

    await act(async () => {
      result.current.request();
    });

    rerender({ group: photo('b') });
    await act(async () => {
      result.current.request();
      result.current.request();
      result.current.request();
    });

    await act(async () => {
      releases[0]?.(detailOk);
    });
    await waitFor(() => expect(invokeCount('lumen_detail_cmd')).toBe(2));

    // 再放行 B，确认没有第三个任务冒出来
    await act(async () => {
      releases[1]?.({ ...detailOk, detailPath: 'D:/cache/b_detail_lumen.jpg' });
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeCount('lumen_detail_cmd')).toBe(2);
  });
});

describe('useLumenDetail —— 换图与失败', () => {
  it('换图立即清空旧 URL（不能把 A 的细节贴到 B 上）', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const { result, rerender } = renderHook(
      ({ group }) => useLumenDetail(group, available),
      { initialProps: { group: photo('a') } },
    );

    await act(async () => {
      result.current.request();
    });
    await waitFor(() => expect(result.current.url).not.toBeNull());

    rerender({ group: photo('b') });

    expect(result.current.url).toBeNull();
    expect(result.current.failed).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('换图后旧请求返回：丢弃，不污染新图', async () => {
    let release: ((v: unknown) => void) | null = null;
    setInvokeHandler((cmd) => {
      if (cmd !== 'lumen_detail_cmd') return undefined;
      return new Promise((res) => {
        release = res;
      });
    });

    const { result, rerender } = renderHook(
      ({ group }) => useLumenDetail(group, available),
      { initialProps: { group: photo('a') } },
    );

    await act(async () => {
      result.current.request();
    });

    rerender({ group: photo('b') });

    await act(async () => {
      release?.({ ...detailOk, detailPath: 'D:/cache/a_detail_lumen.jpg' });
    });

    expect(result.current.url).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('失败置 failed，且不自动重试', async () => {
    mockInvokeError('lumen_detail_cmd', new Error('sidecar 挂了'));
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.url).toBeNull();
    expect(result.current.loading).toBe(false);

    // 等一会儿确认没有重试风暴
    await new Promise((r) => setTimeout(r, 20));
    expect(invokeCount('lumen_detail_cmd')).toBe(1);
  });

  it('失败后再按 Z 会重试一次（不是永久放弃）', async () => {
    mockInvokeError('lumen_detail_cmd', new Error('第一次失败'));
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });
    await waitFor(() => expect(result.current.failed).toBe(true));

    mockInvokeCommand('lumen_detail_cmd', detailOk);
    await act(async () => {
      result.current.request();
    });

    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(invokeCount('lumen_detail_cmd')).toBe(2);
    expect(result.current.failed).toBe(false);
  });

  it('detailPath 为 null（引擎中途失效）：按失败处理，退回预览', async () => {
    mockInvokeCommand('lumen_detail_cmd', {
      detailPath: null,
      cached: false,
      elapsedMs: 0,
    });
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.url).toBeNull();
  });

  it('E_BUSY 不当成渲染失败：busy 单独一档（忙 ≠ 图坏了）', async () => {
    mockInvokeError('lumen_detail_cmd', new Error('E_BUSY: 正在生成另一张的 1:1 细节'));
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(false);
    expect(result.current.busy).toBe(true);
    expect(result.current.url).toBeNull();
  });

  it('busy 之后重新 request 会清掉 busy 标记', async () => {
    mockInvokeError('lumen_detail_cmd', new Error('E_BUSY: 正在生成另一张的 1:1 细节'));
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    mockInvokeCommand('lumen_detail_cmd', detailOk);
    await act(async () => {
      result.current.request();
    });

    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(result.current.busy).toBe(false);
  });
});

describe('useLumenDetail —— 坏缓存回退', () => {
  it('markBroken 清掉 URL 并置 failed（视口据此回落预览，不永久破图）', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });
    await waitFor(() => expect(result.current.url).not.toBeNull());

    act(() => result.current.markBroken());

    expect(result.current.url).toBeNull();
    expect(result.current.failed).toBe(true);
  });

  it('markBroken 之后再 request 能重新生成（不是永久放弃）', async () => {
    mockInvokeCommand('lumen_detail_cmd', detailOk);
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });
    await waitFor(() => expect(result.current.url).not.toBeNull());
    act(() => result.current.markBroken());

    await act(async () => {
      result.current.request();
    });

    await waitFor(() => expect(result.current.url).not.toBeNull());
    expect(invokeCount('lumen_detail_cmd')).toBe(2);
    expect(result.current.failed).toBe(false);
  });
});

describe('useLumenDetail —— 按路径认领', () => {
  it('切走再切回同一张：那次请求的结果仍然有效（不是按全局代际作废）', async () => {
    let release: ((v: unknown) => void) | null = null;
    setInvokeHandler((cmd) => {
      if (cmd !== 'lumen_detail_cmd') return undefined;
      return new Promise((res) => {
        release = res;
      });
    });

    const { result, rerender } = renderHook(
      ({ group }) => useLumenDetail(group, available),
      { initialProps: { group: photo('a') } },
    );

    await act(async () => {
      result.current.request();
    });

    // 切走 → 再切回（分两次 act，确保换图 effect 真的跑过）
    await act(async () => {
      rerender({ group: photo('b') });
    });
    await act(async () => {
      rerender({ group: photo('a') });
    });

    await act(async () => {
      release?.({ ...detailOk, detailPath: 'D:/cache/a_detail_lumen.jpg' });
    });

    await waitFor(() =>
      expect(result.current.url).toContain('a_detail_lumen.jpg'),
    );
    // 中途切走没有触发任何额外请求
    expect(invokeCount('lumen_detail_cmd')).toBe(1);
  });
});

describe('useLumenDetail —— 取消', () => {
  /** 手动控时的渲染：模拟一次 6–8 秒的 photo.export（可多次放行）。 */
  function manualRender() {
    const releases: Array<(v: unknown) => void> = [];
    setInvokeHandler((cmd) => {
      if (cmd !== 'lumen_detail_cmd') return undefined;
      return new Promise((res) => {
        releases.push(res);
      });
    });
    return (v: unknown = detailOk, i = 0) => releases[i]?.(v);
  }

  it('取消立刻结束等待（不必等 6–8 秒渲染完）', async () => {
    manualRender();
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });
    expect(result.current.loading).toBe(true);

    act(() => result.current.cancel());

    expect(result.current.loading).toBe(false);
    // 后端仍在跑，但前端不该报错：这不是失败。
    expect(result.current.failed).toBe(false);
  });

  it('取消后在飞的结果不采用：URL 仍为空、不置 failed', async () => {
    const release = manualRender();
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });
    act(() => result.current.cancel());

    await act(async () => {
      release();
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.url).toBeNull();
    expect(result.current.failed).toBe(false);
    expect(result.current.loading).toBe(false);
    // 那张图仍会落缓存 —— 但没有第二个请求。
    expect(invokeCount('lumen_detail_cmd')).toBe(1);
  });

  it('取消连排队位一起清：不再发第二个请求', async () => {
    const release = manualRender();
    const { result, rerender } = renderHook(
      ({ group }) => useLumenDetail(group, available),
      { initialProps: { group: photo('a') } },
    );

    await act(async () => {
      result.current.request();
    });

    // B 排在 A 后面
    await act(async () => {
      rerender({ group: photo('b') });
    });
    await act(async () => {
      result.current.request();
    });
    expect(invokeCount('lumen_detail_cmd')).toBe(1);

    act(() => result.current.cancel());

    await act(async () => {
      release();
    });
    await new Promise((r) => setTimeout(r, 0));

    // A 完成时排队位已被清空 → B 不会被发出去
    expect(invokeCount('lumen_detail_cmd')).toBe(1);
    expect(result.current.url).toBeNull();
  });

  it('取消后马上再按 Z：重新认领在飞的那张，不当成重复点击', async () => {
    const release = manualRender();
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });
    act(() => result.current.cancel());
    expect(result.current.loading).toBe(false);

    // 反悔：同一张再按 Z。绝不能静默无效 8 秒（键像是坏了）。
    await act(async () => {
      result.current.request();
    });
    expect(result.current.loading).toBe(true);
    expect(invokeCount('lumen_detail_cmd')).toBe(1); // 没有重复渲染

    await act(async () => {
      release();
    });
    await waitFor(() => expect(result.current.url).not.toBeNull());
  });

  it('取消后再请求另一张：cancelled 不是永久锁', async () => {
    const release = manualRender();
    const { result, rerender } = renderHook(
      ({ group }) => useLumenDetail(group, available),
      { initialProps: { group: photo('a') } },
    );

    await act(async () => {
      result.current.request();
    });
    act(() => result.current.cancel());

    await act(async () => {
      rerender({ group: photo('b') });
    });
    await act(async () => {
      result.current.request();
    });

    // A 还在飞 → B 排队；A 回来后 B 必须真的发出去
    await act(async () => {
      release({ ...detailOk, detailPath: 'D:/cache/a_detail_lumen.jpg' });
    });
    await waitFor(() => expect(invokeCount('lumen_detail_cmd')).toBe(2));

    expect(
      invokeCalls('lumen_detail_cmd').map((c) => c.args?.filePath),
    ).toEqual(['D:/shoot/a.ARW', 'D:/shoot/b.ARW']);
  });

  it('取消 → 在飞的那张跑完 → 再按 Z 仍能出图（取消不是永久锁）', async () => {
    const release = manualRender();
    const { result } = renderHook(() => useLumenDetail(photo('a'), available));

    await act(async () => {
      result.current.request();
    });
    act(() => result.current.cancel());
    await act(async () => {
      release();
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.url).toBeNull(); // 取消的那次确实被丢弃了

    // 取消标记若不复位，这里的结果会被继续丢弃 —— Z 变成永久死键。
    await act(async () => {
      result.current.request();
    });
    await waitFor(() => expect(invokeCount('lumen_detail_cmd')).toBe(2));
    await act(async () => {
      release(detailOk, 1);
    });
    await waitFor(() => expect(result.current.url).not.toBeNull());
  });
});
