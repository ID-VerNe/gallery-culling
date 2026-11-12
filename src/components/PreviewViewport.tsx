import React from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, Sparkles, Wand2 } from 'lucide-react';
import { PhotoGroupInfo, ToneAdjustments, LumenStatus } from '../types';
import { getToneFilterString } from '../utils/autoTone';
import { isFitScale } from '../utils/viewportZoom';
import { useZoomPan } from '../hooks/useZoomPan';
import { useViewportImage } from '../hooks/useViewportImage';
import { useLumenDetail } from '../hooks/useLumenDetail';
import { LUMEN_UNAVAILABLE } from '../hooks/useLumenStatus';
import { ViewportEmptyStateView } from './ViewportEmptyState';
import { ExifCapsule } from './ExifCapsule';
import { RawRenderingBanner } from './RawRenderingBanner';
import { rawOnlyEmptyState } from '../utils/viewportRawCopy';

/**
 * 单图视口上交给宿主状态栏的缩放面（issue #62）。
 *
 * 缩放状态仍归视口自己（双栏 / 前后对照各有自己的顶部控制条，`Z` 该切哪个
 * 说不清），宿主只拿到这三个稳定入口，用来把读数与按钮画在窗口底栏里。
 */
export interface PreviewZoomApi {
  scale: number;
  zoomBy: (factor: number) => void;
  reset: () => void;
}

interface PreviewViewportProps {
  group?: PhotoGroupInfo;
  tone?: ToneAdjustments;
  isHoldOriginal?: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** 状态栏缩放组（issue #62）：视口把缩放面交给宿主，读数和按钮画在底栏。 */
  onZoomApi?: (api: PreviewZoomApi | null) => void;
  /**
   * Receives the rendered <img> so the shell can sample the histogram for
   * auto-tone. Previously the shell did `querySelector('img[alt=...]')`,
   * which breaks as soon as two photos share a basename (F-15).
   */
  onImageElement?: (el: HTMLImageElement | null) => void;
  /** Copy and action for the "nothing to show" state, decided by the shell. */
  emptyState?: ViewportEmptyState;
  /** LUMEN RAW 引擎握手状态；可用时 RAW 走真实解码预览。 */
  lumenStatus?: LumenStatus;
  /** 渲染中的宽边（默认 1600，宿主侧上限）。 */
  lumenPreviewWidth?: number;
  /**
   * 1:1 的触发通道：视口把自己的 toggle 注册进这个 ref，App 的全局快捷键
   * 只负责把 `Z` 映射过来。缩放状态属于视口，不能提到 App（否则双栏/前后
   * 对照各有一份，`Z` 该切哪个就说不清了）。
   */
  oneToOneRef?: React.MutableRefObject<() => void>;
}

/** Everything the viewports need to render a meaningful empty state. */
export interface ViewportEmptyState {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const PreviewViewport: React.FC<PreviewViewportProps> = ({
  group,
  tone,
  isHoldOriginal = false,
  onPrev,
  onNext,
  onZoomApi,
  onImageElement,
  lumenStatus,
  lumenPreviewWidth = 1600,
  oneToOneRef,
  emptyState = {
    title: '未加载照片',
    description: '请选择存放 JPG 的文件夹用于浏览与选片；RAW 文件夹可选。',
  },
}) => {
  // 缩放/平移机器（绝对系拖拽、命中光标缩放、夹紧、换图复位）。
  const zoom = useZoomPan(group?.id, onImageElement);

  /**
   * 把缩放面交给宿主状态栏（issue #62）。
   *
   * 卸载时发 `null`，否则宿主会留着一个指向已卸载视口的按钮组 —— 双图 /
   * 前后对照根本没有这条缩放组，残影会让「点不动」看起来像 bug。
   */
  const zoomApi = useMemo<PreviewZoomApi>(
    () => ({ scale: zoom.scale, zoomBy: zoom.zoomBy, reset: zoom.reset }),
    [zoom.scale, zoom.zoomBy, zoom.reset],
  );
  useEffect(() => {
    onZoomApi?.(zoomApi);
  }, [onZoomApi, zoomApi]);
  useEffect(
    () => () => {
      onZoomApi?.(null);
    },
    [onZoomApi],
  );

  // 图片源解析（LUMEN 预览 + 失败 latch + C2 口径，三视口共用）。
  const image = useViewportImage(group, lumenStatus ?? LUMEN_UNAVAILABLE, lumenPreviewWidth);

  // FR-05：RAW-only 的全分辨率细节（按 Z 才请求，6–8 秒/张）。
  const detail = useLumenDetail(group, lumenStatus ?? LUMEN_UNAVAILABLE);
  /**
   * PB-10：上一次按 Z 的落点是 1:1 还是适应（同一个键来回切）。
   *
   * 不能记下 1:1 的比例再拿当前 scale 跟它比 —— 固定窗口（`|差| < 0.02`）
   * 会把「离开了一格又落回窗口内」读成「还在 1:1」，精确相等又会让 1:1
   * 只在当前值恰好等于它时成立，而重算 1:1 与「已经在 1:1」在数值上不可区分。
   * 记模式是唯一自洽的：1:1 的落点就是 `zoom.oneToOne()`，离开 1:1 的
   * 每个入口（滚轮 / 拖拽 / 双击 / 复位 / 换图）都会把模式打回适应。
   */
  const oneToOneModeRef = useRef(false);

  /**
   * 等在飞的细节图时，「这次请求是不是为了进 1:1」。
   *
   * 请求与模式是两件事：等图的 6–8 秒里用户可能滚轮 / 拖拽 / 换图离开，
   * 也可能按 Z 放弃（PB-10 的 C1 场景）。图加载完时若不再是要进 1:1，
   * **什么都不做**——直接 `zoom.oneToOne()` 会把用户已经调好的画面掰回去。
   */
  const pendingOneToOneRef = useRef(false);
  /**
   * 上面那个「等细节到位再切」的意图，**这一次请求**还算不算数。
   *
   * `pendingOneToOneRef` 只回答「按过 Z 还没有结果」，会被「再按一次收回」
   * 与离开 1:1 清掉；`wantOneToOneRef` 只在「按 Z 请求」时置位、在结果到达时
   * 消费。两者分开是因为 `src` 从预览换成细节时 React 复用同一个 `<img>`
   * 节点，**不保证**再送一次 `onLoad`：到达结算走的是结果到达的 effect，
   * 而 onLoad 那条路可能根本不来。`want` 回答「这次请求还算不算数」，模式位
   * 回答「画面现在是不是 1:1」—— 混成一个的话，图到了、也切到了 1:1，下一次
   * 按 Z 却会当成「再进一次 1:1」。
   */
  const wantOneToOneRef = useRef(false);

  // 等图期间「撤销进 1:1」的唯一出口：取消（按钮与再按 Z 都落到这里）、
  // 判失败。
  //
  // 它同时也退出 1:1：进 1:1 时画面**当场**就切成细节的落点（图还没到，
  // 先按预览算），所以取消之后画面仍停在放大状态。不把模式一起打回去的话，
  // 下一次按 Z 走的是「已在 1:1 → 复位」，`enterOneToOne` 根本不执行、在飞
  // 的那次不会被认领，图到了也没有人采用（真机 e2e 的 D13/D14）。
  //
  // 反过来，**结果到达时不能调它**：那时模式刚被置成真，进来就是一次
  // `zoomReset()`，等于在到达的当帧把刚切上的 1:1 撤掉。
  const zoomReset = zoom.reset;
  const zoomOneToOne = zoom.oneToOne;
  const zoomLeave = zoom.setOneToOneLeaveListener;

  const abandonPendingOneToOne = useCallback(() => {
    if (oneToOneModeRef.current) zoomReset();
    oneToOneModeRef.current = false;
    pendingOneToOneRef.current = false;
    wantOneToOneRef.current = false;
  }, [zoomReset]);

  /**
   * 进 1:1 的唯一入口：按 Z 与双击都落在这里。
   * JPG 分组原图就是全分辨率，不需要（也不该）花 6–8 秒渲染。
   *
   * `fallback` 只在算不出 1:1（预览还没布局）时兜底，见 `zoom.oneToOne`。
   */
  const enterOneToOne = useCallback(
    (fallback?: number) => {
      const showDetail = () => {
        if (zoomOneToOne(fallback) !== null) oneToOneModeRef.current = true;
      };
      if (group?.jpg?.path || detail.url) {
        showDetail();
        return;
      }
      // RAW-only 且还没细节：先请求，等图真正加载完再切（onLoad 里接手）。
      pendingOneToOneRef.current = true;
      wantOneToOneRef.current = true;
      // 先请求**再**结算落点：`detail.request()` 是同步的，取消后马上再按 Z
      // 会让 hook 重新认领在飞的那张 —— 复用它上面已经拿到的一次 setLoading
      // 重渲染。顺序反过来的话，这一帧的渲染可能带着 cancel() 留下的
      // `loading=false` 落到 DOM 上（15ms 真实计时器静默吞掉一次 setState）。
      detail.request();
      // 一张照片可能早就被别处请求过（缓存在飞）。这时 onLoad 也会来，
      // 但不能把「这一帧什么都不做」当成默认 —— 算得出落点就先切过去，
      // 等到手的也只是同一个落点。算不出来（预览还没布局）才交给 onLoad。
      showDetail();
    },
    [zoomOneToOne, group, detail],
  );

  const toggleOneToOne = useCallback(() => {
    // 已在 1:1 → 回适应（同一个键来回切，与双击的「适应 ↔ 放大」同构）。
    if (oneToOneModeRef.current) {
      // 回适应同样是一次「不再等」：放着 pending 的话，图一到，结果到达的
      // effect 会把画面从适应拽回细节落点 —— 用户刚按了「退出 1:1」，画面
      // 却在 6–8 秒后自己放大。
      pendingOneToOneRef.current = false;
      wantOneToOneRef.current = false;
      zoomReset();
      oneToOneModeRef.current = false;
      return;
    }

    // 正在等这次请求的图：再按一次 = 收回请求，图到了也不要再切过去。
    if (pendingOneToOneRef.current) {
      abandonPendingOneToOne();
      return;
    }

    enterOneToOne();
  }, [enterOneToOne, abandonPendingOneToOne]);

  // 任何非 Z 的离开 1:1 都会让模式打回适应，否则下一次按 Z 会复位到一个
  // 用户早就离开的画面；等图的请求同样作废。
  useEffect(() => {
    zoomLeave(() => {
      oneToOneModeRef.current = false;
      pendingOneToOneRef.current = false;
      wantOneToOneRef.current = false;
    });
  }, [zoomLeave]);

  // 换图：`resetKey` 变化已经把画面复位了（并在离开 1:1 的监听里清掉了
  // 等图标志），这里只补模式位。不能调 `abandonPendingOneToOne`：它会顺手
  // `zoom.reset()`，等于在复位效果里再 set 一次同样的值，多一轮渲染。
  useEffect(() => {
    oneToOneModeRef.current = false;
    pendingOneToOneRef.current = false;
    wantOneToOneRef.current = false;
  }, [group?.id]);


  // 结果到达就切：不能只指望 `src` 换成细节时 `<img onLoad>` 会再来一次。
  // 布局还没起来（真机上早于 onLoad）时算不出落点，那就**什么都别消费**，
  // 留给 onLoad 接手 —— 先清标志再算落点，会让 onLoad 看到一个「没人等」的
  // pending，图到了却停在适应。
  useEffect(() => {
    if (!wantOneToOneRef.current || !detail.url) return;
    const land = zoomOneToOne();
    if (land === null) return;
    // 落点已经结算，这里**只**清两个等图标志，绝不能走
    // `abandonPendingOneToOne` —— 它见到模式为真就会 `zoom.reset()`，等于
    // 在结果到达的当帧把刚切上的 1:1 撤掉。模式标记也不能跟着 `want` 一起
    // 清：`want` 回答的是「这次请求还算不算数」，模式回答的是「画面现在是
    // 不是 1:1」；混成一个的话，图到了、也确实切到了 1:1，下一次按 Z 却会
    // 当成「再进一次 1:1」。
    oneToOneModeRef.current = true;
    pendingOneToOneRef.current = false;
    wantOneToOneRef.current = false;
    // 刻意不依赖 `abandonPendingOneToOne`：它的身份随 `zoom` 变化，而
    // `zoom.reset()` 会换掉 `zoom.scale` 的对象身份 —— 依赖它等于让这个
    // 「结果到了」的 effect 在每次复位后重跑。
  }, [detail.url, zoomOneToOne]);

  useEffect(() => {
    if (!detail.failed) return;
    abandonPendingOneToOne();
  }, [detail.failed, abandonPendingOneToOne]);

  // 把 toggle 注册给全局快捷键（Z）。视口不在时（双栏 / 前后对照）清空，
  // 避免 `Z` 打到已经卸载的视口上。
  useEffect(() => {
    if (!oneToOneRef) return;
    oneToOneRef.current = toggleOneToOne;
    return () => {
      oneToOneRef.current = () => {};
    };
  }, [oneToOneRef, toggleOneToOne]);

  // 双击与 Z 同构：适应 → 1:1（必要时先请求细节），1:1 → 适应。落点走同一组
  // 入口，读数才一致；否则双击在 RAW 上会跳到一个「适应 × 2.5」的假放大。
  // 算不出 1:1（预览还没布局）时退到「适应 × DOUBLE_CLICK_SCALE」，仍是放大。
  const zoomDoubleClickScale = zoom.bind.doubleClickScale;
  const handleDoubleClick = useCallback(() => {
    const target = zoomDoubleClickScale();
    if (isFitScale(target)) {
      zoom.reset();
      oneToOneModeRef.current = false;
      return;
    }
    enterOneToOne(target);
  }, [zoomDoubleClickScale, zoom, enterOneToOne]);

  if (!group) {
    return <ViewportEmptyStateView emptyState={emptyState} />;
  }

  // A LUMEN render is already tone-mapped: never stack the CSS tone filter on it
  // (that would develop the image twice). 细节图同样是 LUMEN 渲染的成品。
  const usingDetail = Boolean(detail.url);
  const displaySrc = detail.url ?? image.src;
  const toneFilter = image.lumenActive || usingDetail
    ? 'none'
    : getToneFilterString(isHoldOriginal ? undefined : tone);

  // C1/C2：RAW-only 解码中 → 走主视图显示「正在渲染 RAW…」横幅；失败/未启用 → 明确占位而非破图。
  if (!displaySrc && !(image.rawOnly && image.loading)) {
    const engineAvailable = lumenStatus?.available === true;
    return (
      <ViewportEmptyStateView
        emptyState={
          image.rawOnly
            ? rawOnlyEmptyState({ engineAvailable })
            : emptyState
        }
      />
    );
  }

  return (
    <div
      ref={zoom.containerRef}
      data-viewport-photo
      onWheel={zoom.bind.onWheel}
      onPointerDown={zoom.bind.onPointerDown}
      onPointerMove={zoom.bind.onPointerMove}
      onPointerUp={zoom.bind.onPointerUp}
      onPointerCancel={zoom.bind.onPointerUp}
      onDoubleClick={handleDoubleClick}
      className={`relative flex-1 bg-background-base overflow-hidden flex items-center justify-center select-none ${
        zoom.isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
    >
      {/* Zoomable Image */}
      {/* 可见性留调用侧：Preview 保留 !lumenActive（LUMEN 命中后不再提示）。 */}
      {image.loading && !image.lumenActive && <RawRenderingBanner />}

      {/* FR-05：1:1 细节是 6–8 秒的操作，必须说清楚在做什么（不能只有转圈）。 */}
      {detail.loading && (
        <div
          role="status"
          className="absolute top-14 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-background-base/90 backdrop-blur-md pl-3.5 pr-1.5 py-1 rounded-md text-xs font-semibold text-sky-300 border border-sky-500/40 pointer-events-none"
        >
          正在生成 1:1 细节…（6–8 秒，可继续浏览其它照片）
          {/* 出口标准要求「渲染中可取消」：取消只让提示消失，渲染会跑完并落缓存。
              不再等待 = 这一次按 Z 的意图作废，结果到了也不切 1:1。 */}
          <button
            type="button"
            onClick={() => {
              detail.cancel();
              abandonPendingOneToOne();
            }}
            title="只是不再等待；渲染会继续跑完并落缓存，下次按 Z 直接命中"
            className="pointer-events-auto px-2 py-0.5 rounded text-[11px] font-semibold text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          >
            取消
          </button>
        </div>
      )}
      {detail.busy && (
        <div
          role="status"
          className="absolute top-14 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-amber-300 border border-amber-500/40 pointer-events-none"
        >
          另一张的 1:1 细节正在生成，请稍候再按 Z
        </div>
      )}
      {detail.failed && (
        <div
          role="status"
          className="absolute top-14 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-rose-300 border border-rose-500/40 pointer-events-none"
        >
          细节渲染失败，已退回预览图
        </div>
      )}

      {displaySrc && (
        <img
          ref={zoom.imageRef}
          src={displaySrc}
          alt={group.baseName}
          draggable={false}
          // 自动调色会对这张图做 canvas 采样（getImageData）。asset:// 是跨源
          // 资源，不带 crossOrigin 时 canvas 被污染、采样必抛 SecurityError
          // （表现为「自动按钮无反应」，2026-10-15 真窗口 e2e 复现）。asset 协议
          // 对全部响应返回 Access-Control-Allow-Origin（tauri 2.11.5
          // protocol/asset.rs），可安全启用。
          crossOrigin="anonymous"
          onLoad={() => {
            // 细节图加载完才知道真实像素宽：此刻才能算 1:1。
            // 结果到达的 effect 已经先试过一次（缓存命中时比布局早），到这里
            // 只剩「那次没算出来」与「还没到」两种。两条路径共用同一个出口，
            // 否则 onLoad 不来的那一次会让 pending 永远挂住。
            if (!pendingOneToOneRef.current) return;
            abandonPendingOneToOne();
            if (zoom.oneToOne() !== null) oneToOneModeRef.current = true;
          }}
          onError={() => {
            // 细节图加载失败（缓存被删/写坏）与预览图加载失败是两条路径：
            // 前者可能根本没走过预览成功，不能靠 image.markBroken 的 latch。
            if (usingDetail) detail.markBroken();
            else image.markBroken();
          }}
          style={{
            transform: zoom.transform,
            transition: zoom.transition,
            imageOrientation: 'from-image',
            filter: toneFilter,
          }}
          className="max-h-full max-w-full object-contain pointer-events-none origin-center"
        />
      )}

      {/* 左上角状态角标：已精修（issue #200）与「含成品」并排成竖列。
          两者都是「这张图被外部工具动过」的事实，同时成立时必须都看得见，
          所以共用一个定位容器，而不是各自 absolute 抢同一个坐标。 */}
      {(group.retouched || group.edited) && (
        <div className="absolute top-3 left-3 flex flex-col items-start gap-1 pointer-events-none">
          {group.retouched && (
            <div
              className="bg-amber-400 text-black px-2 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1 shadow-sm"
              role="img"
              aria-label="已进 Photoshop / Camera Raw 精修"
              title="已进 Photoshop / Camera Raw 精修"
            >
              <Wand2 className="w-3 h-3" aria-hidden="true" />
              <span>已修</span>
            </div>
          )}
          {group.edited && (
            <div
              className="bg-purple-500/15 border border-purple-500/30 text-purple-300 backdrop-blur-md px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1"
              title="包含精修成果 (Luminar AI)"
            >
              <Sparkles className="w-3 h-3" aria-hidden="true" />
              <span>含成品</span>
            </div>
          )}
        </div>
      )}

      {/* Hold Original Indicator — static, no pulsing animation (F-20) */}
      {isHoldOriginal && (
        <div
          role="status"
          className="absolute top-4 left-1/2 -translate-x-1/2 bg-background-base/90 backdrop-blur-md px-3.5 py-1.5 rounded-md text-xs font-semibold text-amber-300 border border-amber-500/40 flex items-center gap-2 pointer-events-none"
        >
          <span>正在查看原片（松开 V 键恢复）</span>
        </div>
      )}

      <ExifCapsule exif={group.exif} />

      {/* Navigation Overlay Buttons — opaque enough to read over any photo */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onPrev();
        }}
        className="focus-ring absolute left-3 top-1/2 -translate-y-1/2 p-3 bg-background-base/70 hover:ring-1 hover:ring-white/25 active:scale-[0.96] text-white rounded-full press backdrop-blur-sm pointer-events-auto"
        title="上一张 (A)"
        aria-label="上一张照片（快捷键 A）"
      >
        <ChevronLeft className="w-6 h-6" aria-hidden="true" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onNext();
        }}
        className="focus-ring absolute right-3 top-1/2 -translate-y-1/2 p-3 bg-background-base/70 hover:ring-1 hover:ring-white/25 active:scale-[0.96] text-white rounded-full press backdrop-blur-sm pointer-events-auto"
        title="下一张 (D)"
        aria-label="下一张照片（快捷键 D）"
      >
        <ChevronRight className="w-6 h-6" aria-hidden="true" />
      </button>

      {/* 选片动词（星级 / 旗标 / 色标）已迁到窗口底部常驻状态栏
          （issue #62）：视口里不再有悬浮底板、手柄或 hover 才显现的分组。 */}

    </div>
  );
};
