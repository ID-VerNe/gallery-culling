import React, { useEffect, useState } from 'react';
import { Star, Check, X, Pin, Target } from 'lucide-react';
import { PhotoGroupInfo } from '../types';
import { api } from '../services/api';
import { LABEL_DOT_CLASS, LABEL_NAMES, isColorLabel } from '../utils/labels';
import { GRID_THUMB_WIDTH, type ThumbnailLoader } from './thumbnailLoader';

/** Stable, valid HTML id for a grid option, derived from the group id. */
export function makeOptionId(groupId: string): string {
  return `grid-opt-${groupId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export interface GridPhotoCellProps {
  group: PhotoGroupInfo;
  index: number;
  total: number;
  columns: 3 | 4;
  /**
   * 子格子高度（px）：由 `ThumbnailGrid` 的 `GRID_CELL_HEIGHT[columns]` 传入。
   * 与 `gridRowHeight` 同源（父侧一张表算两处），保持强绑定不靠子回引父文件
   * 的静态常量导入，避免 `ThumbnailGrid ↔ GridPhotoCell` 循环依赖。
   */
  cellHeight: number;
  isSelected: boolean;
  isPinned: boolean;
  /** 该格是否是对比候选（钉左基准时的右视口照片）。 */
  isCandidate?: boolean;
  /** B1：点击回调，携带事件以便识别 Ctrl/Shift 修饰键。 */
  onClick: (e: React.MouseEvent) => void;
  /** B6：该格写盘失败、尚未同步到 XMP。 */
  isUnsynced?: boolean;
  /** B6：点击"未同步"角标重试。 */
  onRetrySync?: (group: PhotoGroupInfo) => void;
  /** 见 ThumbnailGridProps.lumenThumbnails */
  lumenThumbnails?: boolean;
  /** 缩略图加载器（去重 + 缓存），模块级单例（issue #107）。 */
  loader: ThumbnailLoader;
}

export const GridPhotoCell: React.FC<GridPhotoCellProps> = ({
  group,
  index,
  total,
  columns,
  cellHeight,
  isSelected,
  isPinned,
  isCandidate = false,
  onClick,
  isUnsynced = false,
  onRetrySync,
  lumenThumbnails = false,
  loader,
}) => {
  // 三态：`null` 加载中 · `undefined` 两条路都失败 · 字符串 有图。
  // 之前用 null 同时表示"加载中"和"失败"，回落也失败时格子会永远显示加载中。
  const [thumbSrc, setThumbSrc] = useState<string | null | undefined>(null);
  // PB-3：按下即时反馈。原实现只有 onMouseDown preventDefault + onClick 选中，
  // 按住期间零响应（用户感知「点了没反应」）。onPointerDown 立即加 pressed 态，
  // pointerUp/Leave 复位 —— 选中态仍在 onClick 落定，避免与点击解耦。
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    let active = true;
    const targetPath = group.jpg?.path || group.raw?.path;
    if (!targetPath) return;

    // 走带去重/缓存的 loader：并发与滚动回来的重复请求共享同一 Promise，不再重复 IPC。
    const { thumbnail, lumenPreview } = loader;

    // 兜住「回落也失败」的错误：磁盘/权限问题会让两条路同时失败，没有 catch 的话
    // 格子会永远停在"加载中"（这正是本模块要避免的整屏空洞）。失败态用 undefined。
    const loadFallback = () =>
      thumbnail(targetPath, GRID_THUMB_WIDTH)
        .then((url) => {
          if (active) setThumbSrc(url);
        })
        .catch(() => {
          if (active) setThumbSrc(undefined);
        });

    if (lumenThumbnails && group.raw?.path) {
      // 引擎路径：RAW 由 LUMEN RAW 真实解码渲染（200px）。
      // 无预览或抛错都静默回落到内嵌缩略图 —— 引擎抖动不该让宫格出现空洞。
      lumenPreview(group.raw.path, GRID_THUMB_WIDTH)
        .then((previewPath) => {
          if (active) setThumbSrc(api.toAssetUrl(previewPath));
        })
        .catch(loadFallback);
    } else {
      loadFallback();
    }

    return () => {
      active = false;
    };
  }, [group.jpg?.path, group.raw?.path, lumenThumbnails, loader]);

  const flagBorder =
    group.flag === 'pick'
      ? 'border-emerald-500/40'
      : group.flag === 'reject'
      ? 'border-rose-500/40'
      : 'border-border-default';

  // One sentence that tells a screen-reader user everything the cell shows.
  const description = [
    `第 ${index + 1} / ${total} 张`,
    group.baseName,
    group.rating > 0 ? `${group.rating} 星` : '未打分',
    group.flag === 'pick' ? '已保留' : group.flag === 'reject' ? '已淘汰' : null,
    isColorLabel(group.label) ? `色标${LABEL_NAMES[group.label]}` : null,
    group.raw ? '含 RAW' : null,
    group.hasXmp ? '含 XMP' : null,
    group.tone ? '已调色' : null,
    group.edited ? '含精修成果' : null,
    isPinned ? '已设为对比基准' : null,
    isCandidate && !isPinned ? '当前对比候选' : null,
  ]
    .filter(Boolean)
    .join('，');

  return (
    <div
      role="option"
      aria-selected={isSelected}
      aria-setsize={total}
      aria-posinset={index + 1}
      aria-label={description}
      id={makeOptionId(group.id)}
      // L-07：焦点模型收口为「容器 aria-activedescendant」一套。单元格**不再**
      // 可聚焦（原先 tabIndex={-1} 会被 mousedown 抢焦点，导致焦点离开 listbox、
      // activedescendant 契约失效）；同时在 mousedown 上 preventDefault，
      // 阻止点击把焦点从容器移走 —— 点击后方向键仍能继续导航。
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onClick={onClick}
      className={`relative rounded-lg flex flex-col overflow-hidden cursor-pointer transition-[border-color,transform] border text-left bg-background-surface-hover hover:bg-white/10 ${
        pressed ? 'scale-[0.985]' : ''
      } ${
        isPinned
          ? 'border-white/90 ring-1 ring-inset ring-white/90'
          : isSelected
          ? 'border-white/60 ring-1 ring-inset ring-white/60'
          : isCandidate
          ? 'border-sky-400/60 ring-1 ring-inset ring-sky-400/40'
          : `hover:border-white/30 ${flagBorder}`
      }`}
      style={{ height: `${cellHeight}px` }}
    >
      {/* Thumbnail Container */}
      <div className="relative flex-1 bg-background-base overflow-hidden flex items-center justify-center p-0.5">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt=""
            width={columns === 3 ? 128 : 88}
            height={columns === 3 ? 128 : 88}
            style={{ imageOrientation: 'from-image' }}
            className="w-full h-full object-contain pointer-events-none"
            loading="lazy"
          />
        ) : thumbSrc === undefined ? (
          <div
            className="text-[10px] text-white/60 font-mono"
            title="缩略图不可用：引擎与内嵌预览都读取失败"
            role="img"
            aria-label="缩略图不可用"
          >
            无预览
          </div>
        ) : (
          <div role="status" aria-label="缩略图加载中" className="text-[10px] text-white/60 font-mono">加载中</div>
        )}

        {/* Top-Right Index */}
        <div className="absolute top-1 right-1 bg-background-base/75 backdrop-blur px-1 py-[2px] rounded text-[10px] font-mono text-white/80 tabular-nums">
          #{index + 1}
        </div>

        {/* B6：写盘失败 = 持久「未同步」角标（不随 toast 消失），点击可重试 */}
        {isUnsynced && onRetrySync && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetrySync(group);
            }}
            className="focus-ring absolute top-6 right-1 bg-rose-500/90 hover:bg-rose-500 text-white rounded px-1 min-h-6 text-[10px] font-medium shadow-sm"
            title="未同步到 XMP 侧边栏，点击重试"
            aria-label="未同步到 XMP 侧边栏，点击重试同步"
          >
            未同步
          </button>
        )}

        {/* Top-Left: Pinned / Pick / Reject badge + 色标色点 */}
        <div className="absolute top-1 left-1 flex items-center gap-1">
          {isPinned ? (
            <div className="bg-white text-black rounded px-1 py-[2px] flex items-center gap-0.5 text-[10px] font-medium">
              <Pin className="w-2.5 h-2.5 fill-black" aria-hidden="true" />
              <span>基准</span>
            </div>
          ) : group.flag === 'pick' ? (
            <div
              className="bg-emerald-500/15 border border-emerald-500/30 text-emerald-500 rounded p-0.5"
              aria-label="已标记保留"
              role="img"
            >
              <Check className="w-2.5 h-2.5 stroke-[3]" aria-hidden="true" />
            </div>
          ) : group.flag === 'reject' ? (
            <div
              className="bg-rose-500/15 border border-rose-500/30 text-rose-500 rounded p-0.5"
              aria-label="已标记淘汰"
              role="img"
            >
              <X className="w-2.5 h-2.5 stroke-[3]" aria-hidden="true" />
            </div>
          ) : null}

          {/* 色标色点：与旗标角标并排，而不是替换它 —— 红标和淘汰是两回事 */}
          {isColorLabel(group.label) && (
            <span
              className={`w-2.5 h-2.5 rounded-full ring-1 ring-black/50 shadow-sm ${LABEL_DOT_CLASS[group.label]}`}
              role="img"
              aria-label={`色标：${LABEL_NAMES[group.label]}`}
              title={`色标：${LABEL_NAMES[group.label]}`}
            />
          )}
        </div>

        {/* Bottom-Right Rating */}
        {group.rating > 0 && (
          <div className="absolute bottom-1 right-1 bg-background-base/85 backdrop-blur px-1 py-[2px] rounded flex items-center text-[10px] text-amber-300 font-medium gap-0.5 tabular-nums border border-border-default">
            <Star
              className="w-2.5 h-2.5 fill-amber-400 text-amber-400"
              aria-hidden="true"
            />
            <span>{group.rating}</span>
          </div>
        )}

        {/* Bottom-Left: 对比候选（与「基准」是不同角色，样式刻意区分） */}
        {isCandidate && !isPinned && (
          <div
            className="absolute bottom-1 left-1 bg-sky-500/20 border border-sky-400/50 text-sky-200 rounded px-1 py-[2px] flex items-center gap-0.5 text-[10px] font-medium"
            role="img"
            aria-label="当前对比候选"
          >
            <Target className="w-2.5 h-2.5" aria-hidden="true" />
            <span>候选</span>
          </div>
        )}
      </div>

      {/* Bottom Minimal File Stem & Badges */}
      <div className="px-1.5 py-1 bg-background-base border-t border-border-default flex items-center justify-between text-[10px] font-mono shrink-0 gap-1">
        <span
          className="text-white/80 truncate min-w-0"
          title={group.baseName}
        >
          {group.baseName}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {group.raw && (
            <span
              className="text-[9px] tracking-[0.02em] text-white font-medium"
              title="RAW 原片"
              aria-hidden="true"
            >
              R
            </span>
          )}
          {group.hasXmp && (
            <span
              className="text-[9px] tracking-[0.02em] text-amber-400 font-medium"
              title="包含 XMP 调色/标记"
              aria-hidden="true"
            >
              X
            </span>
          )}
          {group.tone && (
            <span
              className="text-[9px] tracking-[0.02em] text-emerald-400 font-medium"
              title="已调色"
              aria-hidden="true"
            >
              T
            </span>
          )}
          {group.edited && (
            <span
              className="text-[9px] tracking-[0.02em] text-purple-400 font-medium"
              title="包含精修成果 (Luminar AI)"
              aria-hidden="true"
            >
              E
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
