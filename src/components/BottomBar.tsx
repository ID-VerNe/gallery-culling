import React from 'react';
import { PhotoGroupInfo } from '../types';
import {
  ExternalLink,
  HardDrive,
  Keyboard,
  Redo2,
  Search,
  Sliders,
  Undo2,
} from 'lucide-react';
// 键位表单一归属（issue #51）：速查行按 id 从目录取，不在此另写一份文案。
import { BAR_SHORTCUT_IDS, findShortcut } from '../utils/shortcutCatalog';

/** 帮助 / 元数据入口的键帽也从目录派生（issue #61 起 `?` → `F1`、`M` → `G`）。 */
const HELP_KEYS = findShortcut('help')?.keys ?? 'F1';
const LENS_META_KEYS = findShortcut('lens-meta')?.keys ?? 'G';

interface BottomBarProps {
  currentGroup?: PhotoGroupInfo;
  currentIndex: number;
  totalCount: number;
  onOpenExternal: () => void;
  onOpenMetadataModal?: () => void;
  onOpenShortcutHelp?: () => void;
  /**
   * 宫格搜索是否正在收窄宫格列表。搜索只作用于宫格（给宫格做减法），
   * 中心视口与底栏仍锚定工作集；为真时把两个口径都摆出来，避免
   * `501/1200` 被误读成"搜索后的计数"。
   */
  searchActive?: boolean;
  /** 宫格搜索的命中数（用于「宫格筛选 X/Y」口径）。 */
  searchResultCount?: number;
  /**
   * 多步撤销/重做（FR-04）。`1..5/f/x/r` 按下即写 `.xmp`，键盘有
   * `Ctrl/Cmd+Z` 与 `Ctrl/Cmd+Shift+Z`，这里给鼠标用户同样的入口 —— 否则
   * "能回退"只对键盘用户成立。
   */
  onUndo?: () => void;
  /** 是否有可撤销的改动（驱动按钮可用态）。 */
  canUndo?: boolean;
  /** 下一条将被撤销的命令描述，如「淘汰 3 张」；空串表示栈空。 */
  undoSummary?: string;
  onRedo?: () => void;
  canRedo?: boolean;
  /** 下一条将被重做的命令描述。 */
  redoSummary?: string;
}

export const BottomBar: React.FC<BottomBarProps> = ({
  currentGroup,
  currentIndex,
  totalCount,
  onOpenExternal,
  onOpenMetadataModal,
  onOpenShortcutHelp,
  searchActive = false,
  searchResultCount = 0,
  onUndo,
  canUndo = false,
  undoSummary = '',
  onRedo,
  canRedo = false,
  redoSummary = '',
}) => {
  const humanIndex = totalCount > 0 ? currentIndex + 1 : 0;
  const counterText = searchActive
    ? `宫格筛选 ${searchResultCount}/${totalCount} · 当前 ${humanIndex}/${totalCount}`
    : totalCount > 0
    ? `${currentIndex + 1} / ${totalCount}`
    : '0 / 0';
  const counterLabel = searchActive
    ? `宫格筛选 ${searchResultCount}/${totalCount} 张，当前第 ${humanIndex} 张，共 ${totalCount} 张`
    : `当前第 ${humanIndex} 张，共 ${totalCount} 张`;

  return (
    <footer aria-label="状态栏：照片计数、快捷键提示与同步状态" className="h-9 bg-background-base border-t border-border-default flex items-center justify-between px-3 text-[11px] text-white/70 shrink-0 gap-3">
      {/* Left: Current File Info (Selectable text) */}
      <div className="flex items-center gap-3 select-text min-w-0">
        {currentGroup ? (
          <>
            <div className="flex items-center gap-1.5 font-mono tabular-nums text-white min-w-0">
              <span className="font-semibold truncate">{currentGroup.baseName}</span>
              <span className="text-white/60 shrink-0">
                ({currentGroup.status === 'COMPLETE'
                  ? 'JPG + RAW'
                  : currentGroup.status})
              </span>
            </div>

            {currentGroup.raw && (
              <span className="text-white/70 font-mono tabular-nums shrink-0 hidden sm:inline">
                RAW: {(currentGroup.raw.size / (1024 * 1024)).toFixed(1)} MB
              </span>
            )}
            {currentGroup.jpg && (
              <span className="text-white/70 font-mono tabular-nums shrink-0 hidden sm:inline">
                JPG: {(currentGroup.jpg.size / (1024 * 1024)).toFixed(1)} MB
              </span>
            )}
          </>
        ) : (
          <span>未加载照片</span>
        )}
      </div>

      {/* Center: Keyboard Cheat Sheet (abridged — full list behind F1) */}
      <div
        className="hidden md:flex items-center gap-2 text-white/70 select-none"
        role="group"
        aria-label="常用快捷键提示"
      >
        {/* issue #51：文案来自 `src/utils/shortcutCatalog.ts`，这里只按 id 取。
            36px 高 + md 断点的横向预算只够 6 条最高频项，其余交给 F1 帮助弹窗。 */}
        {BAR_SHORTCUT_IDS.map((id) => {
          const item = findShortcut(id);
          if (!item) return null;
          return (
            <React.Fragment key={id}>
              <KeyHint keys={item.keys} label={item.barLabel ?? item.label} tone={item.tone} />
              <Separator />
            </React.Fragment>
          );
        })}
        <button
          onClick={onOpenShortcutHelp}
          className="focus-ring flex items-center gap-1 hover:text-white transition-colors rounded px-0.5"
          title={`查看全部快捷键（${HELP_KEYS}）`}
          aria-label="查看全部快捷键"
        >
          <KeyCap>{HELP_KEYS}</KeyCap>
          <span>全部快捷键</span>
        </button>
      </div>

      {/* Right: Counter & Quick Open */}
      <div className="flex items-center gap-3 select-none shrink-0">
        {searchActive && (
          <span
            className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-white/80 shrink-0"
            title="宫格搜索只收窄宫格列表；中心视口与底栏仍按工作集计数"
          >
            <Search className="w-3 h-3" aria-hidden="true" />
            <span>宫格筛选中</span>
          </span>
        )}
        <div
          className="flex items-center gap-1 font-mono text-white/80 tabular-nums"
          role="status"
          aria-label={counterLabel}
        >
          <HardDrive className="w-3.5 h-3.5 text-white/50" aria-hidden="true" />
          <span>{counterText}</span>
        </div>

        <button
          onClick={onOpenMetadataModal}
          className="focus-ring hidden lg:flex items-center gap-1.5 px-2.5 py-1 bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white rounded-md font-medium press"
          title={`编辑镜头元数据（${LENS_META_KEYS}）`}
          aria-label="编辑镜头元数据"
        >
          <Sliders className="w-3 h-3" aria-hidden="true" />
          <span className="pb-[1px]">镜头信息</span>
        </button>

        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white disabled:bg-background-surface-hover disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium press"
          title={canUndo ? `撤销：${undoSummary} (Ctrl+Z)` : '没有可撤销的改动'}
          aria-label={canUndo ? `撤销：${undoSummary}` : '撤销（没有可撤销的改动）'}
        >
          <Undo2 className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="pb-[1px] shrink-0">撤销</span>
          {/* 摘要只在宽屏内联显示：底栏 36px 高、右侧还有计数与外部打开，
              窄屏放不下就把完整文案留给 title / aria-label。 */}
          {canUndo && undoSummary && (
            <span className="pb-[1px] hidden xl:inline text-white/55 max-w-[13rem] truncate">
              ：{undoSummary}
            </span>
          )}
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white disabled:bg-background-surface-hover disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium press"
          title={canRedo ? `重做：${redoSummary} (Ctrl+Shift+Z)` : '没有可重做的改动'}
          aria-label={canRedo ? `重做：${redoSummary}` : '重做（没有可重做的改动）'}
        >
          <Redo2 className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="pb-[1px] shrink-0">重做</span>
        </button>

        <button
          onClick={onOpenExternal}
          disabled={!currentGroup}
          className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-white/10 hover:bg-white/15 border border-white/20 text-white active:scale-[0.96] disabled:bg-background-surface-hover disabled:border-border-default disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium transition-transform"
          aria-label="在修图或外部程序中打开当前照片"
        >
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
          <span className="pb-[1px]">外部打开</span>
        </button>

        <button
          onClick={onOpenShortcutHelp}
          className="focus-ring md:hidden p-1 text-white/60 hover:text-white hover:bg-background-surface-hover rounded transition-colors"
          title={`查看全部快捷键（${HELP_KEYS}）`}
          aria-label="查看全部快捷键"
        >
          <Keyboard className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </footer>
  );
};

/* -------------------------------------------------------------------------- */

const Separator: React.FC = () => (
  <span className="text-white/30" aria-hidden="true">
    |
  </span>
);

const KeyCap: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] font-mono text-white/80">
    {children}
  </span>
);

const KeyHint: React.FC<{
  keys: string;
  label: string;
  tone?: 'emerald' | 'rose';
}> = ({ keys, label, tone }) => (
  <span className="flex items-center gap-1" data-shortcut-keys={keys}>
    <KeyCap>{keys}</KeyCap>
    <span
      className={
        tone === 'emerald'
          ? 'text-emerald-300 font-medium'
          : tone === 'rose'
          ? 'text-rose-300 font-medium'
          : undefined
      }
    >
      {label}
    </span>
  </span>
);
