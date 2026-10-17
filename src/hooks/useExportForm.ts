/**
 * 导出弹窗的**表单状态机**（state + 派生 + 校验，不含运行与文案）。
 *
 * 边界：
 *  - 这里只管「用户填了什么」以及「这些填写能不能执行」；
 *  - 运行进度、取消、结果提示归 `useExportRun`；
 *  - 句子怎么拼归 `exportMessages`，这里只调用它的校验入口。
 *
 * 为什么不把 `validation` 留在组件里：按钮的 `disabled` 与「点了按钮后的提示」
 * 必须来自同一个判断，否则会出现「按钮可点但点了报错」或反过来的割裂。
 */
import { useCallback, useMemo, useState } from 'react';
import { api } from '../services/api';
import type { ExportMode, PhotoGroupInfo, RenderFormat } from '../types';
import { buildValidationMessage } from '../components/export/exportMessages';
import {
  DEFAULT_EXPORT_FILTER,
  EXPORT_FILTERS,
  resolveExportFilter,
  type ExportFilterValue,
} from '../components/export/exportFilters';
import {
  DEFAULT_RENDER_QUALITY,
  RENDER_QUALITY_MAX,
  RENDER_QUALITY_MIN,
  clampQuality,
} from '../components/export/exportConfig';
import { normalizeDir, parentDirOf } from '../utils/pathNormalize';

export interface UseExportFormOptions {
  groups: PhotoGroupInfo[];
  /** LUMEN 引擎是否可用 —— 成片模式的硬前置。 */
  lumenAvailable: boolean;
  /** 引擎不可用时的具体原因，透传给校验文案。 */
  lumenDetail?: string;
}

export interface ExportForm {
  // —— 模式 ——
  mode: ExportMode;
  setMode: (m: ExportMode) => void;

  // —— 目标目录 ——
  targetFolder: string;
  setTargetFolder: (v: string) => void;
  browseTarget: () => Promise<void>;

  // —— 复制选项（仅 copy 模式生效）——
  includeRaw: boolean;
  setIncludeRaw: (v: boolean) => void;
  includeJpg: boolean;
  setIncludeJpg: (v: boolean) => void;

  /**
   * 覆盖目标目录中的同名文件。两种模式共用，默认 `false`。
   *
   * 默认关是刻意的：不覆盖是保护用户已有文件的正确默认。但**没有**这个开关时，
   * 「调色 → 导出 → 再调 → 再导出」这条成片工作流的第二次导出会全部 skipped，
   * 用户拿到的仍是上一版，且界面没有任何办法让他覆盖。默认安全 ≠ 只能安全。
   */
  overwrite: boolean;
  setOverwrite: (v: boolean) => void;

  // —— 导出范围 ——
  filter: ExportFilterValue;
  setFilter: (v: ExportFilterValue) => void;
  /** 每个范围下的候选数量，供单选项的计数徽标使用。 */
  countsByFilter: Record<ExportFilterValue, number>;

  // —— 成片选项（仅 render 模式生效）——
  renderFormat: RenderFormat;
  setRenderFormat: (v: RenderFormat) => void;
  renderLongEdge: number;
  setRenderLongEdge: (v: number) => void;
  /** 输入框的原始文本：允许清空和中间态（如只敲了 "9"）。 */
  qualityText: string;
  setQualityText: (v: string) => void;
  /** 夹取后的实际质量 —— 运行与摘要都以它为准。 */
  quality: number;
  /**
   * 失焦时把输入框文本规整为夹取后的值（输入 200 → 显示 100）。
   *
   * 不做实时改写是刻意的：用户输入「9」想打「92」时，实时夹到 50 会把中间态打掉。
   * 也不自增 `resetSignal` —— 这是对同一次输入的收尾，不是新的输入。
   */
  commitQuality: () => void;
  /**
   * 质量被规整时的说明（如「已调整为 50（允许 50–100）」）。
   *
   * 静默改写输入框是不行的：用户会以为是自己输错了、或者程序乱改。`null`
   * 表示这次失焦没有发生规整。下一次键入即清除。
   */
  qualityNotice: string | null;

  // —— 派生 ——
  candidates: PhotoGroupInfo[];
  /**
   * 本次预计真正落盘的**文件**数。
   *
   * 为什么需要它：`candidates` 数的是照片**组**，而结果条的「已导出 N 个」
   * 数的是**文件** —— 复制模式下一组可能产出 RAW + XMP + JPG 三个文件。
   * 只显示组数时，「预计 11 组」和「已导出 18 个」永远对不上，用户无法验算。
   *
   * 口径与后端 `export_items` 完全一致：勾了 RAW 且该组有 RAW 计 1，RAW 旁
   * 有 XMP 再计 1，勾了 JPG 且该组有 JPG 计 1。成片模式一图一文件，等于候选数。
   */
  expectedFileCount: number;
  targetIsSourceDir: boolean;
  /**
   * 候选里**仅含 JPG**（没有 RAW）的组数。
   *
   * 供成片设置提示「二次压缩」：这类组只能拿 JPG 当渲染源，再输出 JPEG 就是
   * 压第二次。数「没有 RAW 的组」而不是「有 RAW 的组」—— 只有前者才会真正
   * 吃到二次压缩，混拍场景下提示的数字才对得上用户看到的候选。
   */
  jpgOnlyCount: number;
  /** 表单层面的阻断原因；`null` 表示可以执行。 */
  validation: string | null;
  /** 表单层面是否可执行（不含「正在运行」，由容器再叠加）。 */
  canRun: boolean;

  /**
   * 输入每变化一次自增。容器监听它清空上一次的结果提示，
   * 这样 hook 既不用持有结果状态，容器也不用维护「哪些字段算输入」的依赖数组。
   */
  resetSignal: number;
}

/**
 * 把 setter 包成「写入值 + 通知重置」。
 *
 * `useState` 的 setter 引用恒定，所以这里返回的包装器也恒定 —— 传给子组件不会
 * 引起无谓重渲染。用统一包装而不是在每个 setter 里手写 `bump()`，是为了让
 * 「新增字段」这件事在结构上就带上重置语义，不靠人记得补。
 */
function useBumpingSetter<T>(
  setValue: (v: T) => void,
  bump: () => void,
): (v: T) => void {
  return useCallback(
    (v: T) => {
      setValue(v);
      bump();
    },
    [setValue, bump],
  );
}

export function useExportForm({
  groups,
  lumenAvailable,
  lumenDetail,
}: UseExportFormOptions): ExportForm {
  const [mode, setModeRaw] = useState<ExportMode>('copy');
  const [targetFolder, setTargetFolderRaw] = useState('');
  const [includeRaw, setIncludeRawRaw] = useState(true);
  const [includeJpg, setIncludeJpgRaw] = useState(true);
  const [overwrite, setOverwriteRaw] = useState(false);
  const [filter, setFilterRaw] = useState<ExportFilterValue>(DEFAULT_EXPORT_FILTER);
  const [renderFormat, setRenderFormatRaw] = useState<RenderFormat>('jpg');
  const [renderLongEdge, setRenderLongEdgeRaw] = useState(0);
  const [qualityText, setQualityTextRaw] = useState(String(DEFAULT_RENDER_QUALITY));
  const [qualityNotice, setQualityNotice] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  const bump = useCallback(() => setResetSignal((n) => n + 1), []);

  const setMode = useBumpingSetter(setModeRaw, bump);
  const setTargetFolder = useBumpingSetter(setTargetFolderRaw, bump);
  const setIncludeRaw = useBumpingSetter(setIncludeRawRaw, bump);
  const setIncludeJpg = useBumpingSetter(setIncludeJpgRaw, bump);
  const setOverwrite = useBumpingSetter(setOverwriteRaw, bump);
  const setFilter = useBumpingSetter(setFilterRaw, bump);
  const setRenderFormat = useBumpingSetter(setRenderFormatRaw, bump);
  const setRenderLongEdge = useBumpingSetter(setRenderLongEdgeRaw, bump);
  /** 键入即清掉上一条规整说明 —— 那句话只对「刚刚那一次失焦」成立。 */
  const setQualityText = useBumpingSetter(
    useCallback((v: string) => {
      setQualityTextRaw(v);
      setQualityNotice(null);
    }, []),
    bump,
  );

  // `resolveExportFilter` 返回配置表里的常量引用，所以下面这层 useMemo 依赖是稳定的。
  const activeFilter = resolveExportFilter(filter);
  const candidates = useMemo(
    () => groups.filter(activeFilter.test),
    [groups, activeFilter],
  );

  const countsByFilter = useMemo(() => {
    const counts = {} as Record<ExportFilterValue, number>;
    for (const f of EXPORT_FILTERS) counts[f.value] = groups.filter(f.test).length;
    return counts;
  }, [groups]);

  /** 仅含 JPG 的候选组数（成片模式的二次压缩提示用）。 */
  const jpgOnlyCount = useMemo(
    () => candidates.reduce((n, g) => (g.raw ? n : n + 1), 0),
    [candidates],
  );

  /**
   * 预计落盘文件数 —— 逐条对齐后端 `export_items` 的复制逻辑：
   * 勾 RAW 且该组有 RAW → 1；该 RAW 旁存在 XMP → 再 +1；勾 JPG 且该组有 JPG → +1。
   *
   * 成片模式一图一文件，等于候选组数（渲不出的是 failed，不在预计量里承诺）。
   */
  const expectedFileCount = useMemo(() => {
    if (mode !== 'copy') return candidates.length;
    return candidates.reduce((n, g) => {
      const raw = includeRaw && g.raw ? 1 : 0;
      const xmp = includeRaw && g.raw && g.hasXmp ? 1 : 0;
      const jpg = includeJpg && g.jpg ? 1 : 0;
      return n + raw + xmp + jpg;
    }, 0);
  }, [mode, candidates, includeRaw, includeJpg]);

  /**
   * 目标目录 = 任一候选的源目录 → 必须拦下（`fs::copy` 同路径会截断原片）。
   * 用 `some` 早退，且不预先建 Set：候选量级在千张以内，可读性优先。
   */
  const targetIsSourceDir = useMemo(() => {
    const target = targetFolder.trim();
    if (!target) return false;
    const normalizedTarget = normalizeDir(target);
    return candidates.some((g) =>
      [g.jpg?.path, g.raw?.path].some(
        (p) => p != null && normalizeDir(parentDirOf(p)) === normalizedTarget,
      ),
    );
  }, [candidates, targetFolder]);

  /** 空串 / 纯空白回落到默认值；其余交给 `clampQuality` 夹到 50–100。 */
  const quality =
    qualityText.trim() === ''
      ? DEFAULT_RENDER_QUALITY
      : clampQuality(Number(qualityText));

  const validation = useMemo(
    () =>
      buildValidationMessage({
        mode,
        targetFolder,
        targetIsSourceDir,
        candidateCount: candidates.length,
        includeRaw,
        includeJpg,
        lumenAvailable,
        lumenDetail,
      }),
    [
      mode,
      targetFolder,
      targetIsSourceDir,
      candidates.length,
      includeRaw,
      includeJpg,
      lumenAvailable,
      lumenDetail,
    ],
  );

  const browseTarget = useCallback(async () => {
    const selected = await api.selectFolderDialog(targetFolder);
    // 用户取消选择时返回 null：不能把空值写回去覆盖已有输入。
    if (selected) setTargetFolder(selected);
  }, [targetFolder, setTargetFolder]);

  // 依赖 `quality`：每次夹取结果变化，commit 都要写回最新值。
  const commitQuality = useCallback(() => {
    const normalized = String(quality);
    setQualityTextRaw(normalized);
    // 只有真的改了才算「规整」。原样提交不弹提示 —— 每次都弹等于没弹。
    const unchanged = qualityText.trim() !== '' && normalized === qualityText.trim();
    setQualityNotice(
      unchanged
        ? null
        : `已调整为 ${quality}（允许 ${RENDER_QUALITY_MIN}–${RENDER_QUALITY_MAX}）`,
    );
  }, [quality, qualityText]);

  return {
    mode,
    setMode,
    targetFolder,
    setTargetFolder,
    browseTarget,
    includeRaw,
    setIncludeRaw,
    includeJpg,
    setIncludeJpg,
    overwrite,
    setOverwrite,
    filter,
    setFilter,
    countsByFilter,
    renderFormat,
    setRenderFormat,
    renderLongEdge,
    setRenderLongEdge,
    qualityText,
    setQualityText,
    quality,
    commitQuality,
    qualityNotice,
    candidates,
    expectedFileCount,
    targetIsSourceDir,
    jpgOnlyCount,
    validation,
    canRun: validation === null,
    resetSignal,
  };
}
