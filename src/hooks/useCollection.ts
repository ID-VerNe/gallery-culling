import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../components/Toast';
import { countByFilter, matchesFilter } from '../utils/filterMatch';
import { matchesParsedQuery, parseQuery } from '../utils/queryMatch';
import type { FilterMode, PhotoGroupInfo } from '../types';

/**
 * 照片集合：扫描结果、筛选、宫格搜索、当前选择、多选。
 *
 * 这里刻意**包含** `selectedIds`（宫格多选）而不把它留给批量操作 hook：
 * 多选本质是「选区」的一部分，切筛选时必须清空（否则批量写盘会作用在
 * 用户看不见的照片上）。让批量 hook 反过来从集合取选区，比让集合反过来
 * 依赖批量更符合数据流向。
 *
 * 坐标系说明：`filteredIndices` 把「可见列表里的位置」映射回
 * `filteredGroups` 的下标，所以选择、计数、导航都指向**稳定的工作集**，
 * 而不是「当前搜索恰好匹配到的东西」。
 */
export function useCollection() {
  const toast = useToast();

  const [groups, setGroups] = useState<PhotoGroupInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [compareIndex, setCompareIndex] = useState<number>(1);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  /**
   * B1：宫格多选集合（受控）。空集 = 沿用单选取值。
   * 有 ≥2 张时按 `1..5 / P / X` 走批量写盘（带确认与进度）。
   */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Grid search (progressive disclosure; owned here so the TopBar toggle and
  // the grid can share it across the tonal-panel swap).
  const [gridSearchOpen, setGridSearchOpen] = useState(false);
  const [gridSearch, setGridSearch] = useState('');
  const [gridSearchFocusToken, setGridSearchFocusToken] = useState(0);

  // Filtered list of groups — the app's current working set.
  const filteredGroups = useMemo(
    () => groups.filter((g) => matchesFilter(g, filterMode)),
    [groups, filterMode],
  );

  // M-14：每档计数。与 `filteredGroups` **共用同一个谓词**（`matchesFilter`），
  // 所以下拉里的 `(N)` 与实际切档后的张数不可能漂移——这正是把它们抽成
  // `utils/filterMatch` 的唯一原因。O(n) 单遍，万张规模亚毫秒级。
  const filterCounts = useMemo(() => countByFilter(groups), [groups]);

  /**
   * FR-06：搜索框升级为查询语法（`rating>=3 label:red -flag:reject`）。
   *
   * 解析放在 `filteredGroups` 之后而不是并进它：chips（固定档位）与语法是
   * **AND 关系**，chips 决定「工作集」，语法在这个工作集里再收窄。这样
   * `selectedIndex` 的坐标系仍是 `filteredGroups` 的下标，`filteredIndices`
   * 只负责「可见位置 → 工作集下标」的映射 —— 与升级前完全一致。
   */
  const queryParse = useMemo(() => parseQuery(gridSearch), [gridSearch]);

  // Search narrowing applied inside the filtered set.
  //
  // 裸词仍是文件名子串（`parseQuery` 把它变成 name/contains 词条），所以
  // 老用户的 `DSC0` 输入不需要改写就能继续工作。
  const filteredIndices = useMemo(() => {
    // 只在**既无词条也无错误**时短路（空查询是最常见的路径，省一次 map）。
    // 有错误时不短路：与短路的行为等价（都是放行全部），但短路会让
    // `matchesParsedQuery` 的错误分支变成死代码 —— 未来改错误策略时没有
    // 任何测试能守住它。多一次 map 换一条活路径，值得。
    if (queryParse.terms.length === 0 && queryParse.errors.length === 0) {
      return filteredGroups.map((_, i) => i);
    }
    return filteredGroups
      .map((g, i) => (matchesParsedQuery(g, queryParse) ? i : -1))
      .filter((i) => i >= 0);
  }, [filteredGroups, queryParse]);

  const visibleGroups = useMemo(
    () => filteredIndices.map((i) => filteredGroups[i]),
    [filteredIndices, filteredGroups],
  );

  const selectedVisibleIndex = useMemo(
    () => filteredIndices.indexOf(selectedIndex),
    [filteredIndices, selectedIndex],
  );

  // Keep the selection inside the working set. Switching from "全部照片" at
  // photo 500 to "仅已保留" with 3 matches used to leave selectedIndex at 500
  // and render a misleading "未加载照片" empty state.
  //
  // B4：光按**下标**裁剪会让"当前照片"无声消失（下标的含义在切换前后不同）。
  // 切档时先记下当前照片的 id，切完优先按 id 找回同一张；确实不在结果里时
  // 才退化到下标裁剪，并明确提示。
  const preferredSelectIdRef = useRef<string | null>(null);

  useEffect(() => {
    const max = filteredGroups.length;
    if (max === 0) {
      setSelectedIndex(0);
      setCompareIndex(0);
      preferredSelectIdRef.current = null;
      return;
    }
    const wanted = preferredSelectIdRef.current;
    preferredSelectIdRef.current = null;
    if (wanted) {
      const idx = filteredGroups.findIndex((g) => g.id === wanted);
      if (idx >= 0) {
        setSelectedIndex(idx);
        setCompareIndex((prev) => Math.min(prev, max - 1));
        return;
      }
      // 当前照片不在新筛选结果里 —— 明确告知，而不是静默跳走。
      toast.info('当前照片不在该筛选结果中，已切换到首张匹配。');
    }
    setSelectedIndex((prev) => Math.min(prev, max - 1));
    setCompareIndex((prev) => Math.min(prev, max - 1));
    // 仅在筛选结果集合变化时重算；`filteredGroups` 是 useMemo 派生，引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredGroups]);

  // Drop a selection that a new search no longer contains onto the first
  // visible item, so the counter and the highlight never disagree.
  useEffect(() => {
    if (gridSearch.trim() && filteredIndices.length > 0) {
      setSelectedIndex((prev) =>
        filteredIndices.includes(prev) ? prev : filteredIndices[0],
      );
      // N-04: the compare candidate has to be pulled into the visible set too,
      // otherwise the split view keeps rendering a photo the search excluded
      // and stops matching the grid it sits next to.
      setCompareIndex((prev) =>
        filteredIndices.includes(prev) ? prev : filteredIndices[0],
      );
    }
  }, [filteredIndices, gridSearch]);

  const currentGroup = filteredGroups[selectedIndex] || undefined;

  /**
   * B4：切筛选档位前记下"当前照片"的 id，切完由 effect 优先按 id 找回同一张。
   * 下标在切换前后含义不同，直接沿用会让当前照片无声消失。
   */
  const handleFilterChange = useCallback(
    (m: FilterMode) => {
      preferredSelectIdRef.current = filteredGroups[selectedIndex]?.id ?? null;
      // 切档后旧的选区多半已不在结果里，清空避免"看不见的选区"被批量写盘。
      setSelectedIds(new Set());
      setFilterMode(m);
    },
    [filteredGroups, selectedIndex],
  );

  // Selection navigation (aware of pinned compare mode)
  //
  // 「有基准且基准在左」的对比模式下，± 作用在**对比候选**上而不是当前照片 ——
  // 用户此时盯着的是右窗格。这三个 handler 因此需要 viewMode/pinnedId/
  // isPinnedOnLeft，故由调用方注入而非在本 hook 内判定。
  const handlePrev = useCallback(
    (isCompareNav: boolean) => {
      if (isCompareNav) {
        setCompareIndex((prev) => (prev > 0 ? prev - 1 : prev));
      } else {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
      }
    },
    [],
  );

  const handleNext = useCallback(
    (isCompareNav: boolean, total: number) => {
      if (isCompareNav) {
        setCompareIndex((prev) => (prev < total - 1 ? prev + 1 : prev));
      } else {
        setSelectedIndex((prev) => (prev < total - 1 ? prev + 1 : prev));
      }
    },
    [],
  );

  // Select photo from thumbnail list. `visibleIndex` is a position in the
  // currently rendered (searched) list; translate it back to the working set.
  const handleSelectPhoto = useCallback(
    (
      visibleIndex: number,
      opts: { isCompareNav: boolean; hasPinned: boolean; total: number },
    ) => {
      const idx = filteredIndices[visibleIndex] ?? visibleIndex;

      if (opts.isCompareNav) {
        setCompareIndex(idx);
      } else {
        setSelectedIndex(idx);
        if (opts.hasPinned === false) {
          setCompareIndex(Math.min(idx + 1, opts.total - 1));
        }
      }
    },
    [filteredIndices],
  );

  return {
    groups,
    filteredGroups,
    filterCounts,
    filteredIndices,
    visibleGroups,
    selectedVisibleIndex,
    selectedIndex,
    compareIndex,
    currentGroup,
    filterMode,
    /** FR-06：查询解析结果，供宫格显示「N 个条件 / 错误提示」。 */
    queryParse,
    selectedIds,
    gridSearch,
    gridSearchOpen,
    gridSearchFocusToken,
    handleFilterChange,
    handlePrev,
    handleNext,
    handleSelectPhoto,
    setGroups,
    setSelectedIndex,
    setCompareIndex,
    setSelectedIds,
    setFilterMode,
    setGridSearch,
    setGridSearchOpen,
    setGridSearchFocusToken,
    clearSelection: useCallback(() => setSelectedIds(new Set()), []),
  };
}