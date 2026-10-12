import React from 'react';
import { PhotoGroupInfo } from '../types';
import {
  ExternalLink,
  HardDrive,
  Keyboard,
  Sliders,
} from 'lucide-react';

interface BottomBarProps {
  currentGroup?: PhotoGroupInfo;
  currentIndex: number;
  totalCount: number;
  onOpenExternal: () => void;
  onOpenMetadataModal?: () => void;
  onOpenShortcutHelp?: () => void;
}

export const BottomBar: React.FC<BottomBarProps> = ({
  currentGroup,
  currentIndex,
  totalCount,
  onOpenExternal,
  onOpenMetadataModal,
  onOpenShortcutHelp,
}) => {
  return (
    <footer className="h-9 bg-background-base border-t border-white/10 flex items-center justify-between px-3 text-[11px] text-white/70 shrink-0 gap-3">
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
        <KeyHint keys="A / D" label="切片" />
        <Separator />
        <KeyHint keys="C" label="对比" />
        <Separator />
        <KeyHint keys="Y" label="前后" />
        <Separator />
        <KeyHint keys="E" label="调色" />
        <Separator />
        <button
          onClick={onOpenMetadataModal}
          className="focus-ring flex items-center gap-1 hover:text-white transition-colors rounded px-0.5"
          title="编辑镜头元数据 (M)"
        >
          <KeyCap>M</KeyCap>
          <span>镜头信息</span>
        </button>
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
        <div
          className="flex items-center gap-1 font-mono text-white/80 tabular-nums"
          role="status"
          aria-label={`当前第 ${totalCount > 0 ? currentIndex + 1 : 0} 张，共 ${totalCount} 张`}
        >
          <HardDrive className="w-3.5 h-3.5 text-white/50" aria-hidden="true" />
          <span>{totalCount > 0 ? `${currentIndex + 1} / ${totalCount}` : '0 / 0'}</span>
        </div>

        <button
          onClick={onOpenMetadataModal}
          className="focus-ring hidden lg:flex items-center gap-1.5 px-2.5 py-1 bg-white/5 hover:bg-white/10 active:scale-[0.96] text-white rounded-md font-medium transition-colors"
          title="编辑镜头元数据 (M)"
          aria-label="编辑镜头元数据"
        >
          <Sliders className="w-3 h-3" aria-hidden="true" />
          <span className="pb-[1px]">镜头信息</span>
        </button>

        <button
          onClick={onOpenExternal}
          disabled={!currentGroup}
          className="focus-ring flex items-center gap-1.5 px-2.5 py-1 bg-white hover:bg-white/90 text-black active:scale-[0.96] disabled:bg-white/10 disabled:text-white/40 disabled:cursor-not-allowed rounded-md font-medium transition-transform shadow-sm"
          aria-label="在修图或外部程序中打开当前照片"
        >
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
          <span className="pb-[1px]">外部打开</span>
        </button>

        <button
          onClick={onOpenShortcutHelp}
          className="focus-ring md:hidden p-1 text-white/60 hover:text-white hover:bg-white/5 rounded transition-colors"
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
