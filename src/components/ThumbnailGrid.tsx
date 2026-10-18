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
import { useGridKeyboard } from '../hooks/useGridKeyboard';
import { LABEL_DOT_CLASS, LABEL_NAMES, isColorLabel } from '../utils/labels';
import { QUERY_EXAMPLES, type QueryParseResult } from '../utils/queryMatch';

/**
 * 宫格子格子的高度（px）。
 *
 * **强绑定**：`GridPhotoCell` 的 `style.height` 直接用 `GRID_CELL_HEIGHT[columns]`；
 * 行容器（`grid gap-1.5 pb-1.5`）再贡献 `GRID_ROW_GAP_BOTTOM` 的底部内边距。
 * 两者相加即虚拟化要用的精确行高 `gridRowHeight()`。**改动任一高度（或 Tailwind
 * 的 `pb-*`）都必须同步改这里**，否则每行会产生固定偏差（1 万张 / 3 列累计
 * ≈ 6666px 的滚动漂移、scrollToIndex 落点偏移）。
 */
const GRID_CELL_HEIGHT: Record<3 | 4, number> = { 3: 132, 4: 110 };

/** 行容器 `pb-1.5` = 0.375rem = 6px（Tailwind 类无法被 JS 读取，只能写死并注释）。 */
const GRID_ROW_GAP_BOTTOM = 6;

/** 稳定的空集合引用：避免每次渲染新建 Set 让依赖抖动。 */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/** 同理，`queryParse` 缺省时的空错误列表 —— 每次 `?? []` 都会新建数组。 */
const EMPTY_STRINGS: readonly string[] = [];

/**
 * 虚拟化的精确估算行高 = 子格子高度 + 行容器底部内边距（3 列 138 / 4 列 116）。
 *
 * 行容器挂了 `measureElement`，实测尺寸会覆盖本估算值 —— 所以本值只是"首帧尚未
 * 测量"时的占位，真正的抗漂移来自自测。导出仅为让回归测试能断言这两个数字。
 */
export function gridRowHeight(columns: 3 | 4): number {
  return GRID_CELL_HEIGHT[columns] + GRID_ROW_GAP_BOTTOM;
}

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
  /** G-03：宿主重置筛选（筛选态非搜索态且结果为空时，空状态用它提供出口）。 */
  onFilterReset?: () => void;
  /** Filter applied by the grid, owned by the app shell. */
  searchQuery?: string;
  searchOpen?: boolean;
  /** Incremented each time the shell asks to focus the search field. */
  searchFocusToken?: number;
  onSearchQueryChange?: (value: string) => void;
  onSearchOpenChange?: (open: boolean) => void;
  /**
   * FR-06：查询解析结果（由 `useCollection` 提供，与过滤共用同一份解析）。
   *
   * 宫格只负责**呈现**条件数与错误，不自己再解析一遍 —— 两处解析必然漂移，
   * 而漂移的表现是「提示说 2 个条件，实际筛出的是另 2 个条件的结果」。
   */
  queryParse?: QueryParseResult;
  /** Total photos loaded, before the grid's own search is applied. */
  totalLoaded?: number;
  /**
   * 宫格缩略图也走 LUMEN RAW 渲染（设置里的开关）。
   * 只在引擎握手成功时为 true —— 不可用时保持 EXIF 内嵌缩略图这条零成本路径。
   */
  lumenThumbnails?: boolean;
  /**
   * B1 多选：当前选中的照片 id 集合（受控）。
   * 未提供 `onSelectionChange` 时退回既有单选行为（独立编译/测试仍可用）。
   */
  selectedIds?: Set<string>;
  /** B1 多选变化回调（Ctrl/Cmd 点选、Shift 范围、Ctrl+A、方向键重置为单选）。 */
  onSelectionChange?: (ids: Set<string>) => void;
  /** B6 写盘失败、尚未同步到 XMP 的照片 id（持久角标 + 重试入口）。 */
  unsyncedIds?: Set<string>;
  /** B6 点击"未同步"角标时的重试回调。 */
  onRetrySync?: (group: PhotoGroupInfo) => void;
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
  onFilterReset,
  onSearchOpenChange,
  queryParse,
  totalLoaded,
  lumenThumbnails = false,
  selectedIds,
  onSelectionChange,
  unsyncedIds,
  onRetrySync,
}) => {
  const [columns, setColumns] = useState<3 | 4>(3);
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 多选受控：宿主提供了回调才启用；否则保持既有单选语义。
  const multiSelectEnabled = !!onSelectionChange;

  /**
   * 键盘导航 + 多选点击合在一个 hook：三者共享 Shift 锚点与当前选区，
   * 拆到两个 hook 会引入跨 hook 的状态同步 bug。
   */
  const {
    activeIds,
    activeGroup,
    handleCellClick,
    handleListKeyDown,
    handleSearchKeyDown,
  } = useGridKeyboard({
    groups,
    columns,
    selectedIndex,
    onSelect,
    onSelectionChange,
    multiSelectEnabled,
    selectedIds: selectedIds ?? EMPTY_ID_SET,
    onSearchQueryChange,
    onSearchOpenChange,
  });

  // 每个宫格实例持有一份缩略图去重/缓存（滚动回来命中、并发共享），卸载即释放。
  // 用惰性初始化的 ref 而不是 useState：不需要触发重渲染，且实例稳定。
  const loaderRef = useRef<ThumbnailLoader | null>(null);
  if (!loaderRef.current) loaderRef.current = createThumbnailLoader();
  const loader = loaderRef.current;

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



  // Split groups into rows for multi-column layout
  const rows = useMemo(() => {
    const res: PhotoGroupInfo[][] = [];
    for (let i = 0; i < groups.length; i += columns) {
      res.push(groups.slice(i, i + columns));
    }
    return res;
  }, [groups, columns]);

  // Virtualizer for multi-column rows.
  // 行高用精确值（不再是 140/118 的估算），并配合行容器上的 measureElement
  // 自测：估算只保证首帧不跳，实测保证对后续样式改动免疫。见 gridRowHeight()。
  const rowHeight = gridRowHeight(columns);
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
  const isSearchFiltering = searchQuery.trim().length > 0;
  const isEmpty = groups.length === 0;

  // FR-06：查询状态。`queryParse` 缺省（独立使用本组件的测试）时全部为空。
  const queryErrors = queryParse?.errors ?? EMPTY_STRINGS;
  const queryTermCount = queryParse?.terms.length ?? 0;
  const queryPending = queryParse?.pending.length ?? 0;

  // B7：虚拟化会把滚出窗口的行整行卸载，`aria-activedescendant` 随即指向不存在
  // 的节点、读屏静默。这里在选中行未被渲染时补一个视觉隐藏的 `role="option"`
  // 幽灵节点，保证引用始终可解析（比改成 roving tabindex 改动面小得多）。
  const virtualRows = gridVirtualizer.getVirtualItems();
  const selectedRowIndex =
    selectedIndex >= 0 ? Math.floor(selectedIndex / columns) : -1;
  const selectedRowRendered =
    selectedRowIndex < 0 ||
    virtualRows.some((v) => v.index === selectedRowIndex);

  return (
    <div className="h-full w-full flex flex-col bg-background-base border-l border-default select-none">
      {/* Top Header & Column Switcher */}
      <div className="px-2.5 py-1 bg-background-base border-b border-default flex items-center justify-between text-xs text-white/80 shrink-0 gap-2 min-h-9">
        {/* B8：命中数是"状态"，加 role=status/aria-live 让读屏在搜索收窄时播报。 */}
        <span
          role="status"
          aria-live="polite"
          className="font-medium text-[11px] text-white/80 font-mono whitespace-nowrap"
        >
          宫格列表{' '}
          <span className="tabular-nums">
            ({isSearchFiltering ? `${groups.length}/${totalLoaded ?? groups.length}` : groups.length})
          </span>
          {/* G-02：多选时选区规模此前**完全没有**可见呈现（selectedIds.size
              从不渲染）—— 用户不知道"批量评级会作用到几张"，只能靠逐个高亮去数。
              与命中数同处一个 live region，一起播报。 */}
          {multiSelectEnabled && activeIds.size > 0 && (
            <span className="ml-1.5 text-white/60">· 已选 {activeIds.size}</span>
          )}
        </span>

        <div className="flex items-center gap-1">
          {/* Search toggle (progressive disclosure) */}
          {onSearchOpenChange && (
            <button
              onClick={() => onSearchOpenChange(!searchOpen)}
              className={`focus-ring flex items-center gap-1 px-1.5 min-h-7 rounded text-[10px] transition-colors ${
                searchOpen
                  ? 'bg-white text-black font-medium'
                  : 'text-white/60 hover:text-white hover:bg-white/10'
              }`}
              title="按条件筛选 (快捷键 /)"
              aria-label="按条件筛选照片"
              aria-pressed={searchOpen}
            >
              <Search className="w-3 h-3" aria-hidden="true" />
              <span>搜索</span>
            </button>
          )}

          <div className="flex items-center bg-background-base p-0.5 rounded-lg border border-default">
            <button
              onClick={() => setColumns(3)}
              className={`focus-ring flex items-center gap-1 px-2 min-h-7 rounded text-[10px] transition-colors ${
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
              className={`focus-ring flex items-center gap-1 px-2 min-h-7 rounded text-[10px] transition-colors ${
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
        <div className="px-2 py-1.5 border-b border-default bg-background-base shrink-0">
          <div className="flex items-center gap-1.5 bg-background-surface-hover rounded-md px-2 py-1 focus-within:bg-white/10 transition-colors">
            <Search className="w-3 h-3 text-white/40 shrink-0" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange?.(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="筛选：rating>=3 label:red -flag:reject"
              aria-label="按查询条件筛选照片"
              aria-describedby="grid-query-hint"
              className="focus-ring bg-transparent border-none outline-none text-white w-full min-w-0 text-[11px]"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchQueryChange?.('')}
                className="focus-ring tap-target text-white/40 hover:text-white p-0.5 rounded shrink-0"
                aria-label="清空搜索"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* FR-06 状态行：错误 / 示例 / 条件数。
              刻意不做成红色输入框：语法门槛是这条需求的主要风险，报错要像
              「提示」而不是「拒绝」，用户才不会因为怕报错而不去用语法。 */}
          <div id="grid-query-hint" className="mt-1 min-h-[15px] text-[10px] leading-[15px]">
            {queryErrors.length > 0 ? (
              <span className="text-amber-400/90" title={queryErrors.join('\n')}>
                {queryErrors[0]}
                {queryErrors.length > 1 && `（另有 ${queryErrors.length - 1} 处）`}
              </span>
            ) : searchQuery.trim() === '' ? (
              <span className="flex items-center gap-1 flex-wrap text-white/35">
                <span>试试：</span>
                {QUERY_EXAMPLES.map((example) => (
                  <button
                    key={example}
                    onClick={() => onSearchQueryChange?.(example)}
                    className="focus-ring font-mono px-1.5 rounded bg-white/5 hover:bg-white/10 text-white/60 transition-colors"
                  >
                    {example}
                  </button>
                ))}
              </span>
            ) : queryPending > 0 ? (
              <span className="text-white/40">输入中…</span>
            ) : queryTermCount > 0 ? (
              <span className="text-white/45">
                {queryTermCount} 个条件 · 匹配 {groups.length} 张
              </span>
            ) : null}
          </div>
        </div>
      )}

      {/* Badge legend — stated once, where the badges are.
          G-12：图例是给眼睛看的速查表。单元格级徽章已 aria-hidden，图例若不排除，
          SR 会逐格重复播报「R RAW X XMP T 调色 E 精修」，噪音极大。
          标 aria-label 让读屏把它当一整块说明，而不是逐个 span 念。 */}
      {!isEmpty && (
        <div
          role="note"
          aria-label="角标图例：R 表示 RAW 原片，X 表示已有 XMP 侧边栏，T 表示已调色，E 表示有精修成果"
          className="px-2.5 py-1 border-b border-default flex items-center gap-2 text-[9px] text-white/60 shrink-0 flex-wrap"
        >
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
          onResetFilter={onFilterReset}
        />
      ) : (
        <div
          ref={parentRef}
          className="flex-1 overflow-y-auto p-2"
          role="listbox"
          aria-label={`宫格照片列表，共 ${groups.length} 张`}
          // 多选能力必须对 AT 可见：SR 默认按单选播报，不声明这个属性，
          // 用户根本不知道 Ctrl/Shift 点选与 Ctrl+A 可用。
          aria-multiselectable={multiSelectEnabled}
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
            {virtualRows.map((virtualRow) => {
              const rowGroups = rows[virtualRow.index] || [];

              return (
                <div
                  key={virtualRow.index}
                  // N-10：把行交给虚拟化器实测（配合 data-index）。**刻意不再写死
                  // height**：写死会让 offsetHeight 永远等于估算值，measureElement
                  // 量到的就是它自己算的，自测退化为空转、样式改动仍会错位。交给内容
                  // 决定高度后，实测值才能真正纠正估算。
                  ref={gridVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  role="presentation"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className={`grid gap-1.5 pb-1.5 ${
                    columns === 3 ? 'grid-cols-3' : 'grid-cols-4'
                  }`}
                >
                  {rowGroups.map((group, colIdx) => {
                    const itemIndex = virtualRow.index * columns + colIdx;
                    // 高亮真值 = 当前照片(selectedIndex) ∪ 批量选区(selectedIds)。
                    //
                    // 二者不可互斥：键盘导航(a/d/←/→)只更新 selectedIndex、不碰
                    // selectedIds。若集合非空就完全以集合为准，用户点过任意缩略图后
                    // 宫格高亮会永久停在旧格 —— 底栏与主视口已切到下一张，宫格却指着
                    // 上一张，**用户看到的选中格与实际被评级的照片不是同一张**。
                    const isSelected =
                      itemIndex === selectedIndex || activeIds.has(group.id);
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
                        onClick={(e) => handleCellClick(e, itemIndex)}
                        isUnsynced={unsyncedIds?.has(group.id) ?? false}
                        onRetrySync={onRetrySync}
                        lumenThumbnails={lumenThumbnails}
                        loader={loader}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
          {/* B7 幽灵 option：选中行滚出虚拟窗口时，保证 aria-activedescendant 仍可解析。
              aria-selected="true" 在高亮真值改为「selectedIndex ∪ selectedIds」并集
              之后是**正确**的：幽灵代表的就是当前照片，而当前照片恒在高亮集合内。
              （原审计担心的「ghost 说选中但实际未选中」是旧的互斥语义下的现象，
              并集语义下不成立。） */}
          {!selectedRowRendered && activeGroup && (
            <div
              role="option"
              id={makeOptionId(activeGroup.id)}
              aria-selected="true"
              aria-label={`第 ${selectedIndex + 1} / ${groups.length} 张，${activeGroup.baseName}`}
              className="sr-only"
            />
          )}
        </div>
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */

const EmptyGridState: React.FC<{
  isSearchFiltering: boolean;
  onClearSearch: () => void;
  onResetFilter?: () => void;
}> = ({ isSearchFiltering, onClearSearch, onResetFilter }) => (
  <div role="status" aria-live="polite" className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10 gap-3">
    <div className="w-12 h-12 rounded-xl bg-background-surface-hover border border-default flex items-center justify-center">
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
    {isSearchFiltering ? (
      <button
        onClick={onClearSearch}
        className="focus-ring px-3 py-1 rounded-md bg-background-surface-hover hover:bg-white/10 text-white text-[11px] transition-colors"
      >
        清空搜索
      </button>
    ) : (
      onResetFilter && (
        <button
          onClick={onResetFilter}
          className="focus-ring px-3 py-1 rounded-md bg-background-surface-hover hover:bg-white/10 text-white text-[11px] transition-colors"
        >
          重置筛选
        </button>
      )
    )}
  </div>
);

/* -------------------------------------------------------------------------- */

/** Stable, valid HTML id for a grid option, derived from the group id. */
function makeOptionId(groupId: string): string {
  return `grid-opt-${groupId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/* -------------------------------------------------------------------------- */

/** 宫格缩略图统一按 200px 请求（与后端默认一致）。 */
const THUMB_WIDTH = 200;

/**
 * 缩略图请求的进程内「并发去重 + 结果缓存」。
 *
 * 每个进入虚拟窗口的格子都在挂载时请求缩略图；快速滚动/来回滚动会大量卸载与重挂，
 * 同一文件被反复请求。这把「同一路径 + 同宽度」收敛成一个 Promise：
 *  - **并发命中**：多个格子共享同一个 inflight Promise，只发一次 IPC；
 *  - **完成命中**：结果留在 cache，滚回来直接命中，不再发 IPC。
 *
 * 失败**不缓存**，并从 inflight 移除 —— 否则一次磁盘抖动会让该图永远空白、无法重试。
 * 作用域为 `ThumbnailGrid` 实例（useRef 持有），随组件卸载释放，避免跨会话陈旧。
 *
 * 键用 `宽度|路径`：`group.jpg?.path` / `raw.path` 稳定，适合做键（见 §4 (b)）。
 */
interface ThumbnailLoader {
  /** EXIF 内嵌/缩放缩略图，resolve 已 `convertFileSrc` 的 URL。 */
  thumbnail: (path: string, width: number) => Promise<string>;
  /** LUMEN 预览路径；无预览视为失败（不缓存），触发调用方的内嵌回落。 */
  lumenPreview: (path: string, width: number) => Promise<string>;
}

/** 通用去重器：命中缓存直接返回；命中 inflight 复用；否则发起并登记。 */
function dedupeAsync<T>(
  cache: Map<string, T>,
  inflight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = run().then(
    (value) => {
      inflight.delete(key);
      cache.set(key, value);
      return value;
    },
    (err) => {
      // 失败不缓存：移除 inflight 以便后续重挂能重试。
      inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, p);
  return p;
}

function createThumbnailLoader(): ThumbnailLoader {
  const thumbCache = new Map<string, string>();
  const thumbInflight = new Map<string, Promise<string>>();
  const lumenCache = new Map<string, string>();
  const lumenInflight = new Map<string, Promise<string>>();

  return {
    thumbnail: (path, width) =>
      dedupeAsync(thumbCache, thumbInflight, `${width}|${path}`, () =>
        api.getThumbnail(path, width),
      ),
    lumenPreview: (path, width) =>
      dedupeAsync(lumenCache, lumenInflight, `${width}|${path}`, async () => {
        const r = await api.getLumenPreview(path, { width });
        // 无预览路径 = 本次拿不到（引擎忙/失败），当作失败：不缓存、走内嵌回落。
        if (!r.previewPath) throw new Error('lumen preview unavailable');
        return r.previewPath;
      }),
  };
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
  /** B1：点击回调，携带事件以便识别 Ctrl/Shift 修饰键。 */
  onClick: (e: React.MouseEvent) => void;
  /** B6：该格写盘失败、尚未同步到 XMP。 */
  isUnsynced?: boolean;
  /** B6：点击"未同步"角标重试。 */
  onRetrySync?: (group: PhotoGroupInfo) => void;
  /** 见 ThumbnailGridProps.lumenThumbnails */
  lumenThumbnails?: boolean;
  /** 缩略图加载器（去重 + 缓存），由 ThumbnailGrid 实例持有。 */
  loader: ThumbnailLoader;
}

const GridPhotoCell: React.FC<GridPhotoCellProps> = ({
  group,
  index,
  total,
  columns,
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

  useEffect(() => {
    let active = true;
    const targetPath = group.jpg?.path || group.raw?.path;
    if (!targetPath) return;

    // 走带去重/缓存的 loader：并发与滚动回来的重复请求共享同一 Promise，不再重复 IPC。
    const { thumbnail, lumenPreview } = loader;

    // 兜住「回落也失败」的错误：磁盘/权限问题会让两条路同时失败，没有 catch 的话
    // 格子会永远停在"加载中"（这正是本模块要避免的整屏空洞）。失败态用 undefined。
    const loadFallback = () =>
      thumbnail(targetPath, THUMB_WIDTH)
        .then((url) => {
          if (active) setThumbSrc(url);
        })
        .catch(() => {
          if (active) setThumbSrc(undefined);
        });

    if (lumenThumbnails && group.raw?.path) {
      // 引擎路径：RAW 由 LUMEN RAW 真实解码渲染（200px）。
      // 无预览或抛错都静默回落到内嵌缩略图 —— 引擎抖动不该让宫格出现空洞。
      lumenPreview(group.raw.path, THUMB_WIDTH)
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
      : 'border-default';

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
      onClick={onClick}
      className={`relative rounded-lg flex flex-col overflow-hidden cursor-pointer transition-[border-color,transform] border text-left bg-background-surface-hover hover:bg-white/10 ${
        isPinned
          ? 'border-white/90 ring-1 ring-inset ring-white/90'
          : isSelected
          ? 'border-white/60 ring-1 ring-inset ring-white/60'
          : isCandidate
          ? 'border-sky-400/60 ring-1 ring-inset ring-sky-400/40'
          : `hover:border-white/30 ${flagBorder}`
      }`}
      style={{ height: `${GRID_CELL_HEIGHT[columns]}px` }}
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
        <div className="absolute top-1 right-1 bg-background-base/75 backdrop-blur px-1 py-[2px] rounded text-[9px] font-mono text-white/80 tabular-nums">
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
            className="absolute top-6 right-1 bg-rose-500/90 hover:bg-rose-500 text-white rounded px-1 min-h-6 text-[8px] font-medium shadow-sm"
            title="未同步到 XMP 侧边栏，点击重试"
            aria-label="未同步到 XMP 侧边栏，点击重试同步"
          >
            未同步
          </button>
        )}

        {/* Top-Left: Pinned / Pick / Reject badge + 色标色点 */}
        <div className="absolute top-1 left-1 flex items-center gap-1">
          {isPinned ? (
            <div className="bg-white text-black rounded px-1 py-[2px] flex items-center gap-0.5 text-[9px] font-medium">
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
          <div className="absolute bottom-1 right-1 bg-background-base/85 backdrop-blur px-1 py-[2px] rounded flex items-center text-[10px] text-amber-300 font-medium gap-0.5 tabular-nums border border-default">
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
      <div className="px-1.5 py-1 bg-background-base border-t border-default flex items-center justify-between text-[10px] font-mono shrink-0 gap-1">
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
