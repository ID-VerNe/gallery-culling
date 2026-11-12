import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Check,
  X,
  Columns3,
  Columns4,
  Search,
  Images,
} from 'lucide-react';
import { PhotoGroupInfo } from '../types';
import { useGridKeyboard } from '../hooks/useGridKeyboard';
import { QUERY_EXAMPLES, type QueryParseResult } from '../utils/queryMatch';
import { GridPhotoCell, makeOptionId } from './GridPhotoCell';
import { getSharedThumbnailLoader } from './thumbnailLoader';

// issue #116：IO 层与 Cell 已移出本文件；旧导入路径经 re-export 保持兼容。
export { GRID_THUMB_WIDTH, resetThumbnailLoaderForTest } from './thumbnailLoader';
export type { ThumbnailLoader } from './thumbnailLoader';

/**
 * 宫格子格子的高度（px）。
 *
 * **强绑定**（issue #116）：`GridPhotoCell` 的 `style.height` 回到本表的
 * `GRID_CELL_HEIGHT[columns]` —— Cell 侧通过父级传入的 `cellHeight` prop
 * 拿到该值，不直接 import 本常量，避免 `ThumbnailGrid ↔ GridPhotoCell`
 * 循环依赖。行容器（`grid gap-1.5 pb-1.5`）再贡献 `GRID_ROW_GAP_BOTTOM`
 * 的底部内边距，两者相加即虚拟化要用的精确行高 `gridRowHeight()`。
 * **改动任一高度（或 Tailwind 的 `pb-*`）都必须同步改这里**，否则每行会
 * 产生固定偏差（1 万张 / 3 列累计 ≈ 6666px 的滚动漂移、scrollToIndex 落点偏移）。
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
  /**
   * 查询用到了 EXIF 条件，而集合里有 **N 张** 读不出相机参数。
   *
   * 不提示的话，`iso:800` 会安静地漏掉这些照片 —— 用户会以为自己没拍过
   * ISO 800，而不是「这几张没有 EXIF」。后端优先读配对 JPG（0.14 ms/张），
   * 所以正常情况这里是 0；非 0 意味着缺配对 JPG 或文件读不出。
   */
  queryExifMissing?: number;
  /** Total photos loaded, before the grid's own search is applied. */
  totalLoaded?: number;
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
  queryExifMissing = 0,
  totalLoaded,
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

  // issue #107：缩略图去重/缓存是模块级单例（非实例级）。宫格在切调色面板时
  // 整树卸载（useSidebarCrossFade），实例级缓存随卸载释放 — 切回后可见格子
  // 全部重发 IPC。模块级让「同批不变再发」跨卸载存活；进程重启自然清零。
  const loader = getSharedThumbnailLoader();

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
  // 全选态按「当前筛选后的集合」判定，避免旧筛选残留的 id 让计数虚高。
  const allSelected = !isEmpty && groups.every((g) => activeIds.has(g.id));

  // FR-06：查询状态。`queryParse` 缺省（独立使用本组件的测试）时全部为空。
  const queryErrors = queryParse?.errors ?? EMPTY_STRINGS;
  const queryTermCount = queryParse?.terms.length ?? 0;
  const queryPending = queryParse?.pending.length ?? 0;

  // issue #200：精修筛选的快捷入口。
  //
  // 用查询串实现（而不是新增一个独立的 state）是刻意的：筛选条件最终必须和
  // 查询框里的文字一致，否则会出现「按钮说只看未修、输入框里写着 retouched」
  // 这种自相矛盾的状态，而且导出时按 `current_query` 复制条件也会漏掉它。
  // 因此这里只是「往查询串里加/删一个词」的语法糖。
  // 归一成「正向/取反」两种，`retouch` 单数别名与手打的 `-retouch` 也算同一档 ——
  // 否则用户手写 `retouch` 时按钮不高亮，看起来像没生效。
  const retouchFilterOf = (token: string): 'yes' | 'no' | null => {
    let t = token.toLowerCase();
    let negated = false;
    if (t.startsWith('-')) {
      negated = true;
      t = t.slice(1);
    }
    // 也要认 `retouched:yes` / `retouched:no` / `-retouched:no` —— 解析器接受这些
    // 写法，按钮若不认，用户手写一遍就会看到「结果变了但按钮没亮」。
    const m = /^(retouch|retouched)(?::(yes|no|true|false|1|0))?$/.exec(t);
    if (!m) return null;
    const positive = !m[2] || m[2] === 'yes' || m[2] === 'true' || m[2] === '1';
    if (!positive) negated = !negated;
    return negated ? 'no' : 'yes';
  };
  const activeRetouchFilter =
    searchQuery
      .trim()
      .split(/\s+/)
      .map(retouchFilterOf)
      .find((f) => f !== null) ?? null;
  const toggleRetouchFilter = (want: 'yes' | 'no') => {
    const kept = searchQuery
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => retouchFilterOf(t) === null);
    if (activeRetouchFilter !== want) kept.push(want === 'yes' ? 'retouched' : '-retouched');
    onSearchQueryChange?.(kept.join(' '));
    // 筛选生效但查询框关着 → 用户看不到「为什么少了这么多张」，顺手展开。
    onSearchOpenChange?.(true);
  };

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
    <div className="h-full w-full flex flex-col bg-background-base border-l border-border-default select-none">
      {/* Top Header & Column Switcher */}
      <div className="px-2.5 py-1 bg-background-base border-b border-border-default flex items-center justify-between text-xs text-white/80 shrink-0 gap-3 min-h-9 min-w-0">
        {/* B8：命中数是"状态"，加 role=status/aria-live 让读屏在搜索收窄时播报。 */}
        <span
          role="status"
          aria-live="polite"
          className="font-medium text-[11px] text-white/80 font-mono truncate min-w-0"
        >
          宫格列表{' '}
          <span className="tabular-nums">
            ({isSearchFiltering ? `${groups.length}/${totalLoaded ?? groups.length}` : groups.length})
          </span>
          {/* G-02：多选时选区规模此前**完全没有**可见呈现（selectedIds.size
              从不渲染）—— 用户不知道"批量评级会作用到几张"，只能靠逐个高亮去数。
              与命中数同处一个 live region，一起播报。 */}
          {multiSelectEnabled && activeIds.size > 0 && (
            <span className="ml-1 tabular-nums text-white/50">· 已选 {activeIds.size}</span>
          )}
        </span>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* issue #79：多选的可见入口。此前只能靠 Ctrl+A 或鼠标框选，
              左手用户在界面上找不到「全选 / 清除」；入口常驻在格头，
              并用可读名称 + aria-pressed/aria-keyshortcuts 暴露给读屏，
              不只依赖 title。 */}
          {multiSelectEnabled && !isEmpty && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => onSelectionChange?.(new Set(groups.map((g) => g.id)))}
                className={`focus-ring flex items-center gap-1 px-1.5 min-h-7 rounded text-[10px] transition-colors shrink-0 whitespace-nowrap ${
                  allSelected
                    ? 'bg-white text-black font-medium'
                    : 'text-white/60 hover:text-white hover:bg-white/10'
                }`}
                title="全选当前宫格（Ctrl+A）"
                aria-label="全选宫格照片"
                aria-pressed={allSelected}
                aria-keyshortcuts="Control+A"
              >
                <Check className="w-3 h-3" aria-hidden="true" />
                <span className="whitespace-nowrap">全选</span>
              </button>
              <button
                onClick={() => onSelectionChange?.(new Set())}
                disabled={activeIds.size === 0}
                className="focus-ring flex items-center gap-1 px-1.5 min-h-7 rounded text-[10px] text-white/60 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent shrink-0 whitespace-nowrap"
                aria-label="清除宫格多选"
              >
                <X className="w-3 h-3" aria-hidden="true" />
                <span className="whitespace-nowrap">清除</span>
              </button>
            </div>
          )}

          {/* issue #200：精修状态快捷筛选。用户的原话是「想一眼知道哪张修过、
              哪张没修」，所以入口必须常驻在格头，而不是藏在查询语法里。 */}
          {onSearchQueryChange && !isEmpty && (
            <div className="flex items-center bg-background-base p-0.5 rounded-md border border-border-default shrink-0">
              <button
                onClick={() => toggleRetouchFilter('no')}
                className={`focus-ring flex items-center gap-1 px-1.5 min-h-7 rounded text-[10px] transition-colors shrink-0 whitespace-nowrap ${
                  activeRetouchFilter === 'no'
                    ? 'bg-amber-400 text-black font-medium'
                    : 'text-white/60 hover:text-white hover:bg-white/10'
                }`}
                title="只看还没进 Photoshop / ACR 精修的照片（查询语法：-retouched）"
                aria-label="只看未精修的照片"
                aria-pressed={activeRetouchFilter === 'no'}
              >
                未修
              </button>
              <button
                onClick={() => toggleRetouchFilter('yes')}
                className={`focus-ring flex items-center gap-1 px-1.5 min-h-7 rounded text-[10px] transition-colors shrink-0 whitespace-nowrap ${
                  activeRetouchFilter === 'yes'
                    ? 'bg-amber-400 text-black font-medium'
                    : 'text-white/60 hover:text-white hover:bg-white/10'
                }`}
                title="只看已进 Photoshop / ACR 精修的照片（查询语法：retouched）"
                aria-label="只看已精修的照片"
                aria-pressed={activeRetouchFilter === 'yes'}
              >
                已修
              </button>
            </div>
          )}

          {/* Search toggle (progressive disclosure) */}
          {onSearchOpenChange && (
            <button
              onClick={() => onSearchOpenChange(!searchOpen)}
              className={`focus-ring flex items-center gap-1 px-1.5 min-h-7 rounded text-[10px] transition-colors shrink-0 whitespace-nowrap ${
                searchOpen
                  ? 'bg-white text-black font-medium'
                  : 'text-white/60 hover:text-white hover:bg-white/10'
              }`}
              title="按条件筛选 (快捷键 Ctrl+F)"
              aria-label="按条件筛选照片"
              aria-pressed={searchOpen}
            >
              <Search className="w-3 h-3" aria-hidden="true" />
            </button>
          )}

          <div className="flex items-center bg-background-base p-0.5 rounded-md border border-border-default shrink-0">
            <button
              onClick={() => setColumns(3)}
              className={`focus-ring flex items-center gap-1 px-2 min-h-7 rounded text-[10px] transition-colors shrink-0 whitespace-nowrap ${
                columns === 3
                  ? 'bg-white text-black font-medium shadow-sm'
                  : 'text-white/60 hover:text-white'
              }`}
              title="一行 3 张缩略图"
              aria-label="切换为一行 3 张缩略图"
              aria-pressed={columns === 3}
            >
              <Columns3 className="w-3 h-3" aria-hidden="true" />
            </button>
            <button
              onClick={() => setColumns(4)}
              className={`focus-ring flex items-center gap-1 px-2 min-h-7 rounded text-[10px] transition-colors shrink-0 whitespace-nowrap ${
                columns === 4
                  ? 'bg-white text-black font-medium shadow-sm'
                  : 'text-white/60 hover:text-white'
              }`}
              title="一行 4 张缩略图"
              aria-label="切换为一行 4 张缩略图"
              aria-pressed={columns === 4}
            >
              <Columns4 className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {/* Search field — only present while open, so the grid keeps its width */}
      {searchOpen && (
        <div className="px-2 py-1.5 border-b border-border-default bg-background-base shrink-0">
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
            ) : queryExifMissing > 0 ? (
              <span
                className="text-amber-400/80"
                title="缺少配对 JPG，或文件里的 EXIF 读不出来"
              >
                {queryExifMissing} 张没有相机参数，iso / 快门等条件不会命中它们
              </span>
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
          aria-label="角标图例：R 表示 RAW 原片，X 表示已有 XMP 侧边栏，T 表示已调色，E 表示有精修成果，黄底「已修」表示已进 Photoshop / Camera Raw 精修"
          className="px-2.5 py-1 border-b border-border-default flex items-center gap-2 text-[10px] text-white/60 shrink-0 flex-wrap"
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
          {/* 与单元格里的实心琥珀块同款：图例存在的意义就是「照着找」，
              样式不一致反而会让人对不上号。 */}
          <span className="flex items-center gap-1">
            <span className="bg-amber-400 text-black rounded px-1 py-[1px] text-[9px] font-semibold leading-none">
              已修
            </span>
            进过 PS / ACR
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
                        cellHeight={GRID_CELL_HEIGHT[columns]}
                        isSelected={isSelected}
                        isPinned={isPinned}
                        isCandidate={isCandidate}
                        onClick={(e) => handleCellClick(e, itemIndex)}
                        isUnsynced={unsyncedIds?.has(group.id) ?? false}
                        onRetrySync={onRetrySync}
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
    <div className="w-12 h-12 rounded-xl bg-background-surface-hover border border-border-default flex items-center justify-center">
      <Images className="w-6 h-6 text-white/50" aria-hidden="true" />
    </div>
    <div>
      <p className="text-xs font-medium text-white mb-1">
        {isSearchFiltering ? '没有匹配的照片' : '当前筛选下没有照片'}
      </p>
      <p className="text-[11px] leading-snug text-white/60 max-w-[15rem]">
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
