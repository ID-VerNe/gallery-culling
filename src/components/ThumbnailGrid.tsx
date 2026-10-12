import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Star,
  Check,
  X,
  Columns3,
  Columns4,
  Pin,
  Search,
  Images,
  Target,
} from 'lucide-react';
import { PhotoGroupInfo } from '../types';
import { api } from '../services/api';

interface ThumbnailGridProps {
  groups: PhotoGroupInfo[];
  selectedIndex: number;
  pinnedId?: string | null;
  /**
   * 对比候选（split 且钉左基准时，右视口正在显示的那张）。
   * 与 `pinnedId`（基准）是两个不同的角色标记，可落在不同格子上。
   */
  candidateId?: string | null;
  onSelect: (index: number) => void;
  /** Filter applied by the grid, owned by the app shell. */
  searchQuery?: string;
  searchOpen?: boolean;
  /** Incremented each time the shell asks to focus the search field. */
  searchFocusToken?: number;
  onSearchQueryChange?: (value: string) => void;
  onSearchOpenChange?: (open: boolean) => void;
  /** Total photos loaded, before the grid's own search is applied. */
  totalLoaded?: number;
  /**
   * 宫格缩略图也走 LUMEN RAW 渲染（设置里的开关）。
   * 只在引擎握手成功时为 true —— 不可用时保持 EXIF 内嵌缩略图这条零成本路径。
   */
  lumenThumbnails?: boolean;
}

export const ThumbnailGrid: React.FC<ThumbnailGridProps> = ({
  groups,
  selectedIndex,
  pinnedId,
  candidateId,
  onSelect,
  searchQuery = '',
  searchOpen = false,
  searchFocusToken = 0,
  onSearchQueryChange,
  onSearchOpenChange,
  totalLoaded,
  lumenThumbnails = false,
}) => {
  const [columns, setColumns] = useState<3 | 4>(3);
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 面板互换（调色面板 → 宫格）时旧 DOM 被卸载，焦点会退回 body。
  // 与既有的"搜索打开时聚焦输入框"合成一个 effect：搜索框优先，否则在
  // 焦点无主时把焦点移入 listbox（parentRef，它已是 tabIndex=0 的宿主）。
  // 与 Modal 的初始焦点不同：这里不做 Tab 陷阱、不归还焦点。
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      return;
    }
    const ae = document.activeElement;
    if (ae && ae !== document.body) return; // 已被主动聚焦，别抢
    parentRef.current?.focus({ preventScroll: true });
  }, [searchOpen, searchFocusToken]);

  // Escape inside the search field collapses it again.
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onSearchQueryChange?.('');
      onSearchOpenChange?.(false);
    }
  };

  // Split groups into rows for multi-column layout
  const rows = useMemo(() => {
    const res: PhotoGroupInfo[][] = [];
    for (let i = 0; i < groups.length; i += columns) {
      res.push(groups.slice(i, i + columns));
    }
    return res;
  }, [groups, columns]);

  // Virtualizer for multi-column rows
  const rowHeight = columns === 3 ? 140 : 118;
  const gridVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
  });

  // Scroll active item into view
  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex < groups.length) {
      const rowIndex = Math.floor(selectedIndex / columns);
      gridVirtualizer.scrollToIndex(rowIndex, {
        align: 'auto',
        behavior: 'auto',
      });
    }
  }, [selectedIndex, columns, groups.length, gridVirtualizer]);

  // Roving-tabindex listbox keyboard model: Up/Down/Home/End move the
  // selection, Left/Right stay bound to the global prev/next photo.
  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (groups.length === 0) return;
    const last = groups.length - 1;
    let next = selectedIndex;

    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(selectedIndex + 1, last);
        break;
      case 'ArrowUp':
        next = Math.max(selectedIndex - 1, 0);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'PageDown':
        next = Math.min(selectedIndex + columns * 3, last);
        break;
      case 'PageUp':
        next = Math.max(selectedIndex - columns * 3, 0);
        break;
      default:
        return;
    }

    e.preventDefault();
    onSelect(next);
  };

  const isSearchFiltering = searchQuery.trim().length > 0;
  const isEmpty = groups.length === 0;

  return (
    <div className="h-full w-full flex flex-col bg-background-base border-l border-white/10 select-none">
      {/* Top Header & Column Switcher */}
      <div className="px-2.5 py-1 bg-background-base border-b border-white/10 flex items-center justify-between text-xs text-white/80 shrink-0 gap-2 min-h-9">
        <span className="font-medium text-[11px] text-white/80 font-mono whitespace-nowrap">
          宫格列表{' '}
          <span className="tabular-nums">
            ({isSearchFiltering ? `${groups.length}/${totalLoaded ?? groups.length}` : groups.length})
          </span>
        </span>

        <div className="flex items-center gap-1">
          {/* Search toggle (progressive disclosure) */}
          {onSearchOpenChange && (
            <button
              onClick={() => onSearchOpenChange(!searchOpen)}
              className={`focus-ring flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                searchOpen
                  ? 'bg-white text-black font-medium'
                  : 'text-white/60 hover:text-white hover:bg-white/10'
              }`}
              title="按文件名搜索 (快捷键 /)"
              aria-label="按文件名搜索"
              aria-pressed={searchOpen}
            >
              <Search className="w-3 h-3" aria-hidden="true" />
              <span>搜索</span>
            </button>
          )}

          <div className="flex items-center bg-background-base p-0.5 rounded-lg border border-white/10">
            <button
              onClick={() => setColumns(3)}
              className={`focus-ring flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                columns === 3
                  ? 'bg-white text-black font-medium shadow-sm'
                  : 'text-white/60 hover:text-white'
              }`}
              title="一行 3 张缩略图"
              aria-label="切换为一行 3 张缩略图"
              aria-pressed={columns === 3}
            >
              <Columns3 className="w-3 h-3" aria-hidden="true" />
              <span>3列</span>
            </button>
            <button
              onClick={() => setColumns(4)}
              className={`focus-ring flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                columns === 4
                  ? 'bg-white text-black font-medium shadow-sm'
                  : 'text-white/60 hover:text-white'
              }`}
              title="一行 4 张缩略图"
              aria-label="切换为一行 4 张缩略图"
              aria-pressed={columns === 4}
            >
              <Columns4 className="w-3 h-3" aria-hidden="true" />
              <span>4列</span>
            </button>
          </div>
        </div>
      </div>

      {/* Search field — only present while open, so the grid keeps its width */}
      {searchOpen && (
        <div className="px-2 py-1.5 border-b border-white/10 bg-background-base shrink-0">
          <div className="flex items-center gap-1.5 bg-white/5 rounded-md px-2 py-1 focus-within:bg-white/10 transition-colors">
            <Search className="w-3 h-3 text-white/40 shrink-0" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange?.(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="输入文件名片段…"
              aria-label="按文件名搜索照片"
              className="focus-ring bg-transparent border-none outline-none text-white w-full min-w-0 text-[11px]"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchQueryChange?.('')}
                className="focus-ring text-white/40 hover:text-white p-0.5 rounded shrink-0"
                aria-label="清空搜索"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Badge legend — stated once, where the badges are */}
      {!isEmpty && (
        <div className="px-2.5 py-1 border-b border-white/10 flex items-center gap-2 text-[9px] text-white/60 shrink-0 flex-wrap">
          <span className="flex items-center gap-0.5">
            <span className="font-medium text-white">R</span>RAW
          </span>
          <span className="flex items-center gap-0.5">
            <span className="font-medium text-amber-400">X</span>XMP
          </span>
          <span className="flex items-center gap-0.5">
            <span className="font-medium text-emerald-400">T</span>调色
          </span>
          <span className="flex items-center gap-0.5">
            <span className="font-medium text-purple-400">E</span>精修
          </span>
        </div>
      )}

      {/* Virtualized Grid List */}
      {isEmpty ? (
        <EmptyGridState
          isSearchFiltering={isSearchFiltering}
          onClearSearch={() => {
            onSearchQueryChange?.('');
            onSearchOpenChange?.(false);
          }}
        />
      ) : (
        <div
          ref={parentRef}
          className="flex-1 overflow-y-auto p-2"
          role="listbox"
          aria-label={`宫格照片列表，共 ${groups.length} 张`}
          aria-activedescendant={
            selectedIndex >= 0 && groups[selectedIndex]
              ? makeOptionId(groups[selectedIndex].id)
              : undefined
          }
          tabIndex={0}
          onKeyDown={handleListKeyDown}
        >
          <div
            role="presentation"
            style={{
              height: `${gridVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {gridVirtualizer.getVirtualItems().map((virtualRow) => {
              const rowGroups = rows[virtualRow.index] || [];

              return (
                <div
                  key={virtualRow.index}
                  role="presentation"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className={`grid gap-1.5 pb-1.5 ${
                    columns === 3 ? 'grid-cols-3' : 'grid-cols-4'
                  }`}
                >
                  {rowGroups.map((group, colIdx) => {
                    const itemIndex = virtualRow.index * columns + colIdx;
                    const isSelected = itemIndex === selectedIndex;
                    const isPinned = pinnedId === group.id;
                    const isCandidate =
                      candidateId != null && candidateId === group.id;

                    return (
                      <GridPhotoCell
                        key={group.id}
                        group={group}
                        index={itemIndex}
                        total={groups.length}
                        columns={columns}
                        isSelected={isSelected}
                        isPinned={isPinned}
                        isCandidate={isCandidate}
                        onSelect={() => onSelect(itemIndex)}
                        lumenThumbnails={lumenThumbnails}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const EmptyGridState: React.FC<{
  isSearchFiltering: boolean;
  onClearSearch: () => void;
}> = ({ isSearchFiltering, onClearSearch }) => (
  <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10 gap-3">
    <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center">
      <Images className="w-6 h-6 text-white/50" aria-hidden="true" />
    </div>
    <div>
      <p className="text-xs font-medium text-white mb-1">
        {isSearchFiltering ? '没有匹配的照片' : '当前筛选下没有照片'}
      </p>
      <p className="text-[11px] leading-relaxed text-white/60 max-w-[15rem]">
        {isSearchFiltering
          ? '换一个文件名片段试试，或清空搜索。'
          : '调整顶部筛选条件，或先给照片打星 / 标记保留。'}
      </p>
    </div>
    {isSearchFiltering && (
      <button
        onClick={onClearSearch}
        className="focus-ring px-3 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white text-[11px] transition-colors"
      >
        清空搜索
      </button>
    )}
  </div>
);

/* -------------------------------------------------------------------------- */

/** Stable, valid HTML id for a grid option, derived from the group id. */
function makeOptionId(groupId: string): string {
  return `grid-opt-${groupId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

interface GridPhotoCellProps {
  group: PhotoGroupInfo;
  index: number;
  total: number;
  columns: 3 | 4;
  isSelected: boolean;
  isPinned: boolean;
  /** 该格是否是对比候选（钉左基准时的右视口照片）。 */
  isCandidate?: boolean;
  onSelect: () => void;
  /** 见 ThumbnailGridProps.lumenThumbnails */
  lumenThumbnails?: boolean;
}

const GridPhotoCell: React.FC<GridPhotoCellProps> = ({
  group,
  index,
  total,
  columns,
  isSelected,
  isPinned,
  isCandidate = false,
  onSelect,
  lumenThumbnails = false,
}) => {
  // 三态：`null` 加载中 · `undefined` 两条路都失败 · 字符串 有图。
  // 之前用 null 同时表示"加载中"和"失败"，回落也失败时格子会永远显示加载中。
  const [thumbSrc, setThumbSrc] = useState<string | null | undefined>(null);

  useEffect(() => {
    let active = true;
    const targetPath = group.jpg?.path || group.raw?.path;
    if (!targetPath) return;

    if (lumenThumbnails && group.raw?.path) {
      // 引擎路径：RAW 由 LUMEN RAW 真实解码渲染（200px）。
      // 任何失败都静默回落到内嵌缩略图 —— 引擎抖动不该让宫格出现空洞。
      api
        .getLumenPreview(group.raw.path, { width: 200 })
        .then((r) => {
          if (!active) return;
          if (r.previewPath) setThumbSrc(api.toAssetUrl(r.previewPath));
          // 回落也必须兜住错误：磁盘/权限问题会让两条路同时失败，
          // 没有 catch 的话格子会永远停在"加载中"（这正是本模块要避免的空洞）
          else
            api
              .getThumbnail(targetPath, 200)
              .then((url) => active && setThumbSrc(url))
              // 回落也失败（磁盘只读/权限不足，与引擎死亡同源）：进入失败态，
              // 不能停在"加载中"——那正是本模块要避免的整屏空洞。
              .catch(() => active && setThumbSrc(undefined));
        })
        .catch(() => {
          api
            .getThumbnail(targetPath, 200)
            .then((url) => {
              if (active) setThumbSrc(url);
            })
            .catch(() => {
              if (active) setThumbSrc(undefined);
            });
        });
    } else {
      api
        .getThumbnail(targetPath, 200)
        .then((url) => {
          if (active) {
            setThumbSrc(url);
          }
        })
        .catch(() => {
          if (active) setThumbSrc(undefined);
        });
    }

    return () => {
      active = false;
    };
  }, [group.jpg?.path, group.raw?.path, lumenThumbnails]);

  const flagBorder =
    group.flag === 'pick'
      ? 'border-emerald-500/40'
      : group.flag === 'reject'
      ? 'border-rose-500/40'
      : 'border-white/10';

  // One sentence that tells a screen-reader user everything the cell shows.
  const description = [
    `第 ${index + 1} / ${total} 张`,
    group.baseName,
    group.rating > 0 ? `${group.rating} 星` : '未打分',
    group.flag === 'pick' ? '已保留' : group.flag === 'reject' ? '已淘汰' : null,
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
      onClick={onSelect}
      className={`relative rounded-lg flex flex-col overflow-hidden cursor-pointer transition-[border-color,transform] border text-left bg-white/5 hover:bg-white/10 ${
        isPinned
          ? 'border-white/90 ring-1 ring-inset ring-white/90'
          : isSelected
          ? 'border-white/60 ring-1 ring-inset ring-white/60'
          : isCandidate
          ? 'border-sky-400/60 ring-1 ring-inset ring-sky-400/40'
          : `hover:border-white/30 ${flagBorder}`
      }`}
      style={{ height: columns === 3 ? '132px' : '110px' }}
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
          <div className="text-[10px] text-white/60 font-mono">加载中</div>
        )}

        {/* Top-Right Index */}
        <div className="absolute top-1 right-1 bg-background-base/75 backdrop-blur px-1 py-[2px] rounded text-[9px] font-mono text-white/80 tabular-nums">
          #{index + 1}
        </div>

        {/* Top-Left: Pinned / Pick / Reject badge */}
        {isPinned ? (
          <div className="absolute top-1 left-1 bg-white text-black rounded px-1 py-[2px] flex items-center gap-0.5 text-[9px] font-medium">
            <Pin className="w-2.5 h-2.5 fill-black" aria-hidden="true" />
            <span>基准</span>
          </div>
        ) : group.flag === 'pick' ? (
          <div
            className="absolute top-1 left-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-500 rounded p-0.5"
            aria-label="已标记保留"
            role="img"
          >
            <Check className="w-2.5 h-2.5 stroke-[3]" aria-hidden="true" />
          </div>
        ) : group.flag === 'reject' ? (
          <div
            className="absolute top-1 left-1 bg-rose-500/15 border border-rose-500/30 text-rose-500 rounded p-0.5"
            aria-label="已标记淘汰"
            role="img"
          >
            <X className="w-2.5 h-2.5 stroke-[3]" aria-hidden="true" />
          </div>
        ) : null}

        {/* Bottom-Right Rating */}
        {group.rating > 0 && (
          <div className="absolute bottom-1 right-1 bg-background-base/85 backdrop-blur px-1 py-[2px] rounded flex items-center text-[10px] text-amber-300 font-medium gap-0.5 tabular-nums border border-white/10">
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
            className="absolute bottom-1 left-1 bg-sky-500/20 border border-sky-400/50 text-sky-200 rounded px-1 py-[2px] flex items-center gap-0.5 text-[9px] font-medium"
            role="img"
            aria-label="当前对比候选"
          >
            <Target className="w-2.5 h-2.5" aria-hidden="true" />
            <span>候选</span>
          </div>
        )}
      </div>

      {/* Bottom Minimal File Stem & Badges */}
      <div className="px-1.5 py-1 bg-background-base border-t border-white/10 flex items-center justify-between text-[10px] font-mono shrink-0 gap-1">
        <span
          className="text-white/80 truncate min-w-0"
          title={group.baseName}
        >
          {group.baseName}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {group.raw && (
            <span
              className="text-[9px] text-white font-medium"
              title="RAW 原片"
              aria-hidden="true"
            >
              R
            </span>
          )}
          {group.hasXmp && (
            <span
              className="text-[9px] text-amber-400 font-medium"
              title="包含 XMP 调色/标记"
              aria-hidden="true"
            >
              X
            </span>
          )}
          {group.tone && (
            <span
              className="text-[9px] text-emerald-400 font-medium"
              title="已调色"
              aria-hidden="true"
            >
              T
            </span>
          )}
          {group.edited && (
            <span
              className="text-[9px] text-purple-400 font-medium"
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
