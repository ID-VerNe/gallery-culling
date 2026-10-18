import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import type { LumenStatus, PhotoGroupInfo } from '../types';

export interface UseLumenDetailResult {
  /** 全分辨率细节图的 asset URL；null = 还没生成 / 不适用 / 失败 */
  url: string | null;
  loading: boolean;
  /** 真渲染失败（sidecar 挂了 / 输出缺失）—— UI 应说明「已退回预览图」 */
  failed: boolean;
  /** 后端忙（另一张正在渲染）。与 failed 分开：忙 ≠ 图坏了 */
  busy: boolean;
  /** 触发当前照片的 1:1 细节渲染。幂等：已就绪 / 已在队列里都不重复发。 */
  request: () => void;
  /**
   * 取消等待。
   *
   * 只停前端：后端那张已经在解码（`photo.export` 是阻塞子进程，进程级
   * kill 要改掉 `exec_and_classify` 的阻塞模型，风险大于收益）。用户可见
   * 的诉求是「别把我卡在等待里」—— 异步 + 队列已经做到，取消再让提示消失。
   * 那张图仍会跑完并落缓存，下次按 Z 直接命中。
   */
  cancel: () => void;
  /**
   * `<img onError>`：细节图加载失败（缓存文件被删 / 写坏了）。
   *
   * 必须单独一格：视口层原来的 `markBroken` 只在「LUMEN 预览成功过」时
   * latch，而细节图可能是**唯一**成功的渲染（预览失败但导出成功）。不接
   * 这一格的话，坏缓存会让 `<img>` 永久破图。
   */
  markBroken: () => void;
}

/**
 * RAW 全分辨率细节（1:1 对焦检查）的加载器。
 *
 * 为什么是**显式触发**而不是「放大超过 2.5× 自动加载」：单张 6–8 秒、
 * 峰值 761MB（24MP 实测，报告 §5.4）。自动等待会毁掉浏览手感 —— 用户
 * 只是滚轮放大看一眼构图，不该被 8 秒的转圈卡住。
 *
 * 队列语义（三个都必须，少一个就会在快速翻图时炸）：
 *  - **单飞**：同一时刻只有一个请求在飞（后端并发上限 1，堆三个只会拿到
 *    两个 E_BUSY）；
 *  - **最新优先**：排队位置只留一条，后来的覆盖先来的 —— 翻 20 张不该
 *    积压 2 分钟；
 *  - **按路径认领**：结果只贴给「请求时那张正好还是当前这张」的情况。
 *    用路径比对而不是全局代际 —— 切走再切回同一张时，那次请求仍然有效。
 *
 * JPG 分组 / 引擎不可用一律零请求：前者原图本身就是全分辨率，后者静默
 * 退回 1600 预览（`rawOnly` 占位由视口层负责）。
 */
export function useLumenDetail(
  group: PhotoGroupInfo | undefined,
  status: LumenStatus,
  recipe?: unknown,
): UseLumenDetailResult {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const groupId = group?.id;
  const rawPath = group?.raw?.path;
  const hasJpg = Boolean(group?.jpg?.path);
  const available = status.available;

  // 异步回调里必须读**最新**的 group/recipe：闭包会捕获渲染那一刻的旧值，
  // 快速翻图时就会拿 A 的路径去请求 B。
  const liveRef = useRef({ rawPath, hasJpg, available, recipe });
  liveRef.current = { rawPath, hasJpg, available, recipe };

  const urlRef = useRef<string | null>(null);
  /** 排队位置：只留最新一条（不是数组 —— 数组会在翻图时堆成 2 分钟）。 */
  const pendingRef = useRef<string | null>(null);
  /** 正在飞的那一张（挡住同一 tick 的重复点击 —— 那时排队位已被清空）。 */
  const inflightRef = useRef<string | null>(null);
  /** 用户点了取消：在飞的结果不再采用。 */
  const cancelledRef = useRef(false);
  const runningRef = useRef(false);
  /** 递归 drain 需要先有引用（useCallback 里拿不到自己的 const）。 */
  const drainRef = useRef<() => Promise<void>>(async () => {});

  const drain = useCallback(async () => {
    if (runningRef.current) return;
    const job = pendingRef.current;
    if (!job) return;
    pendingRef.current = null;

    runningRef.current = true;
    inflightRef.current = job;
    setLoading(true);

    /** 结果只属于「现在正在看的那张」—— 用路径比对而不是全局代际：
     *  切走再切回同一张时，那次请求的结果仍然是有效的。 */
    const stillWanted = () => liveRef.current.rawPath === job;

    try {
      const res = await api.getLumenDetail(job, liveRef.current.recipe);
      if (!stillWanted() || cancelledRef.current) return; // 切走了 / 用户取消

      if (res.detailPath) {
        const next = api.toAssetUrl(res.detailPath);
        urlRef.current = next;
        setUrl(next);
        setFailed(false);
        setBusy(false);
      } else {
        // 引擎在请求过程中失效：与渲染失败同档（都退回 1600 预览）。
        setFailed(true);
      }
    } catch (e) {
      if (!stillWanted() || cancelledRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith('E_BUSY')) {
        // 单窗口下这不该发生；真出现了也不该说「图坏了」。
        setBusy(true);
      } else {
        setFailed(true);
      }
    } finally {
      runningRef.current = false;
      inflightRef.current = null;
      if (stillWanted()) setLoading(false);
      // 排队里有更新的任务 → 接着发（此时后端已释放单飞标记）。
      if (pendingRef.current) void drainRef.current();
    }
  }, []);

  drainRef.current = drain;

  // 换图：立即作废 URL 与排队位。**不动 runningRef / inflightRef** ——
  // 旧请求还在飞，提前放开会让新请求与它并发，撞上后端的 E_BUSY。
  useEffect(() => {
    urlRef.current = null;
    pendingRef.current = null;
    setUrl(null);
    setFailed(false);
    setBusy(false);
    setLoading(false);
  }, [groupId]);

  const request = useCallback(() => {
    const live = liveRef.current;
    if (!live.rawPath || live.hasJpg || !live.available) return;
    if (urlRef.current) return; // 已就绪

    // 同一张正在渲染：刚被取消过就**重新认领**这次结果，否则是重复点击。
    // 不重新认领的话，「取消 → 马上再按 Z」会静默无效 8 秒 —— 那比不提供
    // 取消更让人困惑（键像是坏了）。
    if (inflightRef.current === live.rawPath) {
      if (cancelledRef.current) {
        cancelledRef.current = false;
        setLoading(true);
      }
      return;
    }
    if (pendingRef.current === live.rawPath) return; // 已在队列

    cancelledRef.current = false;
    pendingRef.current = live.rawPath;
    setBusy(false);
    setFailed(false);
    void drainRef.current();
  }, []);

  const cancel = useCallback(() => {
    // 只停前端：后端那张已经在解码了（见接口注释）。它跑完仍会落缓存，
    // 所以下次按 Z 是命中而不是重新等 6–8 秒。
    cancelledRef.current = true;
    pendingRef.current = null; // 排队里的也一并取消
    setLoading(false);
    setBusy(false);
  }, []);

  const markBroken = useCallback(() => {
    // 清掉 URL 让视口回落到 1600 预览；failed 让 UI 说明原因。
    urlRef.current = null;
    setUrl(null);
    setFailed(true);
  }, []);

  return { url, loading, failed, busy, request, cancel, markBroken };
}
