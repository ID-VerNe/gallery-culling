import React from 'react';
import { PhotoGroupInfo } from '../types';
import {
  ExternalLink,
  HardDrive,
  Keyboard,
  Search,
  Sliders,
  Undo2,
} from 'lucide-react';

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
   * 单步撤销（L-11）。`1..5/p/x/0` 按下即写 `.xmp`，键盘有 `Ctrl/Cmd+Z`，
   * 这里给鼠标用户同一个入口 —— 否则"能退一步"只对键盘用户成立。
   */
  onUndo?: () => void;
  /** 是否有可撤销的改动（驱动按钮可用态）。 */
  canUndo?: boolean;
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
    <footer className="h-9 bg-background-base border-t border-default flex items-center justify-between px-3 text-[11px] text-white/70 shrink-0 gap-3">
      {/* Left: Current File Info (Selectable text) */}
      <div className="flex items-center gap-3 select-text min-w-0">
        {currentGroup ? (
          <>
            <div className="flex items-center gap-1.5 font-mono text-white min-w-0">
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

      {/* Center: Keyboard Cheat Sheet (abridged — full list behind "?") */}
      <div
        className="hidden md:flex items-center gap-2 text-white/70 select-none"
        role="group"
        aria-label="常用快捷键提示"
      >
        <KeyHint keys="1~5" label="打分" />
        <Separator />
        <KeyHint keys="P" label="保留" tone="emerald" />
        <Separator />
        <KeyHint keys="X" label="淘汰" tone="rose" />
        <Separator />
        {/* A2：与帮助弹窗统一叫法 —— "切片"含义不明，实为上一张/下一张。 */}
        <KeyHint keys="A / D" label="上一张 / 下一张" />
        <Separator />
        <KeyHint keys="C" label="对比" />
        <Separator />
        <KeyHint keys="Y" label="前后" />
        <Separator />
        <KeyHint keys="E" label="调色" />
        {/* A6：镜头元数据入口只保留底栏右侧那一处，撤掉此处重复入口。 */}
        <Separator />
        <button
          onClick={onOpenShortcutHelp}
          className="focus-ring flex items-center gap-1 hover:text-white transition-colors rounded px-0.5"
          title="查看全部快捷键 (?)"
          aria-label="查看全部快捷键"
        >
          <KeyCap>?</KeyCap>
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
          className="focus-ring hidden lg:flex items-center gap-1.5 px-2.5 py-1 bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white rounded-md font-medium transition-colors"
          title="编辑镜头元数据 (M)"
          aria-label="编辑镜头元数据"
        >
          <Sliders className="w-3 h-3" aria-hidden="true" />
          <span className="pb-[1px]">镜头信息</span>
        </button>

        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-background-surface-hover hover:bg-white/10 active:scale-[0.96] text-white disabled:bg-background-surface-hover disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium transition-colors"
          title={canUndo ? '撤销上一处星级/标记改动 (Ctrl+Z)' : '没有可撤销的改动'}
          aria-label="撤销上一处星级或标记改动"
        >
          <Undo2 className="w-3 h-3" aria-hidden="true" />
          <span className="pb-[1px]">撤销</span>
        </button>

        <button
          onClick={onOpenExternal}
          disabled={!currentGroup}
          className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-white/10 hover:bg-white/15 border border-white/20 text-white active:scale-[0.96] disabled:bg-background-surface-hover disabled:border-default disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium transition-transform"
          aria-label="在修图或外部程序中打开当前照片"
        >
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
          <span className="pb-[1px]">外部打开</span>
        </button>

        <button
          onClick={onOpenShortcutHelp}
          className="focus-ring md:hidden p-1 text-white/60 hover:text-white hover:bg-background-surface-hover rounded transition-colors"
          title="查看全部快捷键 (?)"
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
  <span className="flex items-center gap-1">
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
