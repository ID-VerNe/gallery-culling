import React from 'react';
import { PhotoGroupInfo, ToneAdjustments, type ColorLabel } from '../types';
import {
  Check,
  ExternalLink,
  HardDrive,
  Keyboard,
  Redo2,
  Search,
  Sliders,
  Star,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  Maximize,
} from 'lucide-react';
// 键位表单一归属（issue #51）：速查行按 id 从目录取，不在此另写一份文案。
import { BAR_SHORTCUT_IDS, findShortcut } from '../utils/shortcutCatalog';
import { LABEL_NAMES, isColorLabel } from '../utils/labels';
import { LabelDots } from './LabelDots';
import {
  STATUS_BAR,
  STATUS_BUTTON,
  STATUS_DIVIDER,
  STATUS_HINT,
  STATUS_ICON_BUTTON,
  STATUS_PANE,
  STATUS_STAR_BUTTON,
  STATUS_VALUE,
} from './viewportBarStyles';

/**
 * 状态栏里的一个窗格（issue #62）。
 *
 * 单图 / 前后对照只有 1 个；双图有 `L` / `R` 两个，各自绑定自己的 group 与
 * 动作回调，保证「给左图点红标不会误改右图」（SH-01 的窗格分流口径）。
 */
export interface StatusPane {
  /** 双图窗格标识；单图 / 前后对照留空。 */
  slot?: 'L' | 'R';
  group?: PhotoGroupInfo;
  /** 当前生效的调色（只用于曝光补偿读数）。 */
  tone?: ToneAdjustments;
  onRate: (rating: number) => void;
  onFlag: (flag: 'pick' | 'reject' | 'none') => void;
  onLabel?: (label: ColorLabel) => void;
}

/** 单图视口没有自己的缩放条，读数与按钮由状态栏承载（F-25 的可发现性不回退）。 */
export interface StatusZoom {
  label: string;
  atMin: boolean;
  atMax: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
}

interface BottomBarProps {
  /** 一个或多个窗格；空数组 = 未加载照片。 */
  panes?: StatusPane[];
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
  /** 单图缩放读数与按钮（双图 / 前后对照各自顶部已有控制条，不传）。 */
  zoom?: StatusZoom;
  /**
   * 多步撤销/重做（FR-04）。`1..5/p/x/6..9/0` 按下即写 `.xmp`，键盘有
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

/**
 * 窗口底部状态栏（issue #62）：三个视口共用的**唯一**状态栏。
 *
 * 文档流常驻、36px 一行、零遮挡。信息架构固定为
 * 身份 → 参数 → 评级 → 旗标 → 色标，右侧是计数与全局动作。
 * 窄窗按断点降级（参数 `lg`、双图参数 `xl`、体积/镜头/速查 `2xl`），
 * 不横向滚动。
 */
export const BottomBar: React.FC<BottomBarProps> = ({
  panes = [],
  currentGroup,
  currentIndex,
  totalCount,
  onOpenExternal,
  onOpenMetadataModal,
  onOpenShortcutHelp,
  searchActive = false,
  searchResultCount = 0,
  zoom,
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
  const twoPane = panes.length > 1;

  return (
    <footer
      aria-label="状态栏：照片参数与选片动作"
      data-status-bar
      className={STATUS_BAR}
    >
      {/* 左：窗格组（身份 → 参数 → 评级 → 旗标 → 色标） */}
      <div className="flex flex-1 items-center gap-2 min-w-0">
        {panes.length > 0 ? (
          panes.map((pane, index) => (
            <React.Fragment key={pane.slot ?? `pane-${index}`}>
              {index > 0 && <span className={STATUS_DIVIDER} aria-hidden="true" />}
              <StatusPaneView pane={pane} twoPane={twoPane} />
            </React.Fragment>
          ))
        ) : (
          <span className="text-white/50">未加载照片</span>
        )}
      </div>

      {/* 中：快捷键速查。36px 一行装不下参数 + 速查，`2xl` 以下只留「?」。 */}
      <div
        className="hidden 2xl:flex items-center gap-2 text-white/70 select-none shrink-0"
        role="group"
        aria-label="常用快捷键提示"
      >
        {/* issue #51：文案来自 `src/utils/shortcutCatalog.ts`，这里只按 id 取。 */}
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
          className={`${STATUS_BUTTON} px-0.5`}
          title="查看全部快捷键 (?)"
          aria-label="查看全部快捷键"
        >
          <KeyCap>?</KeyCap>
          <span>全部快捷键</span>
        </button>
      </div>

      {/* 右：缩放（单图）+ 计数 + 全局动作 */}
      <div className="flex items-center gap-2 select-none shrink-0">
        {zoom && (
          <div className="hidden xl:flex items-center gap-1" role="group" aria-label="缩放控制">
            <button type="button" onClick={zoom.onZoomOut} disabled={zoom.atMin} className={STATUS_ICON_BUTTON} aria-label="缩小">
              <ZoomOut className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <span
              className={`${STATUS_VALUE} text-[11px] min-w-[3.25rem] text-center`}
              aria-label={`当前缩放 ${zoom.label}${zoom.atMax ? '，已最大' : zoom.atMin ? '，已最小' : ''}`}
            >
              {zoom.label}
              {zoom.atMax ? '·最大' : zoom.atMin ? '·最小' : ''}
            </span>
            <button type="button" onClick={zoom.onZoomIn} disabled={zoom.atMax} className={STATUS_ICON_BUTTON} aria-label="放大">
              <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button type="button" onClick={zoom.onReset} className={STATUS_ICON_BUTTON} aria-label="重置缩放">
              <Maximize className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

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
          className="flex items-center gap-1 font-mono text-white/80 tabular-nums shrink-0"
          role="status"
          aria-label={counterLabel}
        >
          <HardDrive className="w-3.5 h-3.5 text-white/50" aria-hidden="true" />
          <span>{counterText}</span>
        </div>

        {currentGroup && onOpenMetadataModal && (
          <button
            onClick={onOpenMetadataModal}
            className={`${STATUS_BUTTON} hidden lg:flex`}
            title="编辑镜头元数据 (M)"
            aria-label="编辑镜头元数据"
          >
            <Sliders className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="pb-[1px] hidden 2xl:inline">镜头信息</span>
          </button>
        )}

        <button
          onClick={onUndo}
          disabled={!canUndo}
          className={`${STATUS_BUTTON} hidden lg:flex`}
          title={canUndo ? `撤销：${undoSummary} (Ctrl+Z)` : '没有可撤销的改动'}
          aria-label={canUndo ? `撤销：${undoSummary}` : '撤销（没有可撤销的改动）'}
        >
          <Undo2 className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="pb-[1px] shrink-0">撤销</span>
          {/* 禁用原因常驻：禁用按钮不可聚焦，title 拿不到。 */}
          {!canUndo && <span className="pb-[1px] text-white/40">：无</span>}
          {canUndo && undoSummary && (
            <span className="pb-[1px] hidden 2xl:inline text-white/50 max-w-[13rem] truncate">
              ：{undoSummary}
            </span>
          )}
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          className={`${STATUS_BUTTON} hidden lg:flex`}
          title={canRedo ? `重做：${redoSummary} (Ctrl+Shift+Z)` : '没有可重做的改动'}
          aria-label={canRedo ? `重做：${redoSummary}` : '重做（没有可重做的改动）'}
        >
          <Redo2 className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="pb-[1px] shrink-0">重做</span>
          {!canRedo && <span className="pb-[1px] text-white/40">：无</span>}
          {canRedo && redoSummary && (
            <span className="pb-[1px] hidden 2xl:inline text-white/50 max-w-[13rem] truncate">
              ：{redoSummary}
            </span>
          )}
        </button>

        {currentGroup && (
          <button
            onClick={onOpenExternal}
            className={STATUS_BUTTON}
            aria-label="在修图或外部程序中打开当前照片"
          >
            <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="pb-[1px] hidden xl:inline">外部打开</span>
          </button>
        )}

        <button
          onClick={onOpenShortcutHelp}
          className={STATUS_ICON_BUTTON}
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

const STATUS_TEXT: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className={STATUS_HINT}>{children}</span>
);

function statusText(status: PhotoGroupInfo['status']): string {
  return status === 'COMPLETE' ? 'JPG + RAW' : status;
}

function formatMb(size: number): string {
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 一个窗格的信息组。
 *
 * 断点策略：参数组单图 `lg`、双图 `xl`（双图宽度翻倍，`lg` 会挤爆 1024）；
 * 体积与镜头型号 `2xl`；旗标文字 `2xl`，以下只留图标但保留 `aria-label`。
 */
const StatusPaneView: React.FC<{ pane: StatusPane; twoPane: boolean }> = ({ pane, twoPane }) => {
  const { group, tone, slot, onRate, onFlag, onLabel } = pane;
  const paneName = slot ? (slot === 'L' ? '左窗格' : '右窗格') : '当前照片';
  const prefix = slot ? `${paneName}：` : '';
  const hasExif = Boolean(group?.exif);
  const exposure = tone?.exposure ?? 0;

  if (!group) {
    return (
      <div data-status-pane={slot ?? 'single'} className={STATUS_PANE}>
        <span className="text-white/50">未选择</span>
      </div>
    );
  }

  const exif = group.exif;
  const exifParts = exif
    ? [exif.focalLength, exif.aperture, exif.shutterSpeed, exif.iso].filter(Boolean)
    : [];

  return (
    <div
      data-status-pane={slot ?? 'single'}
      className={STATUS_PANE}
      role="group"
      aria-label={slot ? `${paneName} ${group.baseName}` : '当前照片'}
    >
      {/* A. 身份 */}
      <div data-status-group="identity" className="flex items-center gap-1.5 min-w-0">
        {slot && (
          <span className="shrink-0 rounded bg-white/10 px-1 py-0.5 text-[10px] font-semibold text-white/80">
            {slot}
          </span>
        )}
        <span className={`${STATUS_VALUE} font-semibold truncate max-w-[6rem] xl:max-w-[9rem]`}>
          {group.baseName}
        </span>
        <STATUS_TEXT>{statusText(group.status)}</STATUS_TEXT>
        <span className="hidden 2xl:flex items-center gap-1.5 shrink-0">
          {group.raw && <STATUS_TEXT>RAW {formatMb(group.raw.size)}</STATUS_TEXT>}
          {group.jpg && <STATUS_TEXT>JPG {formatMb(group.jpg.size)}</STATUS_TEXT>}
        </span>
      </div>

      {/* B. 拍摄参数 */}
      {hasExif && (
        <>
          <span className={STATUS_DIVIDER} aria-hidden="true" />
          <div
            data-status-group="params"
            className={`${twoPane ? 'hidden xl:flex' : 'hidden lg:flex'} items-center gap-1.5 whitespace-nowrap shrink-0`}
          >
            <STATUS_TEXT>{exifParts.join(' · ')}</STATUS_TEXT>
            {exif?.lensModel && (
              <span className="hidden 2xl:inline text-white/50 max-w-[11rem] truncate">
                {exif.lensModel}
              </span>
            )}
            {exposure !== 0 && (
              <span className={`${STATUS_VALUE} text-[10px]`}>
                EV {exposure > 0 ? '+' : ''}
                {exposure.toFixed(2)}
              </span>
            )}
          </div>
        </>
      )}

      {/* C. 评级 */}
      <span className={STATUS_DIVIDER} aria-hidden="true" />
      <div data-status-group="rating" className="flex items-center shrink-0" role="group" aria-label={`${prefix}照片星级打分`}>
        {[1, 2, 3, 4, 5].map((star) => {
          const active = star <= group.rating;
          return (
            <button
              key={star}
              type="button"
              onClick={() => onRate(star === group.rating ? 0 : star)}
              className={STATUS_STAR_BUTTON}
              aria-label={`${prefix}评 ${star} 星`}
              aria-pressed={star <= group.rating}
              title={`${star} 星（再点当前星级 = 清零）`}
            >
              <Star
                className={`w-3.5 h-3.5 ${active ? 'fill-amber-400 text-amber-400' : 'text-white/45'}`}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>

      {/* D. 旗标 */}
      <span className={STATUS_DIVIDER} aria-hidden="true" />
      <div data-status-group="flag" className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => onFlag(group.flag === 'pick' ? 'none' : 'pick')}
          className={`${STATUS_BUTTON} ${group.flag === 'pick' ? 'bg-emerald-600/25 text-emerald-300' : ''}`}
          aria-label={`${prefix}标记保留 (Pick)`}
          aria-pressed={group.flag === 'pick'}
        >
          <Check className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="pb-[1px] hidden 2xl:inline">保留</span>
        </button>
        <button
          type="button"
          onClick={() => onFlag(group.flag === 'reject' ? 'none' : 'reject')}
          className={`${STATUS_BUTTON} ${group.flag === 'reject' ? 'bg-rose-600/25 text-rose-300' : ''}`}
          aria-label={`${prefix}标记淘汰 (Reject)`}
          aria-pressed={group.flag === 'reject'}
        >
          <X className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="pb-[1px] hidden 2xl:inline">淘汰</span>
        </button>
      </div>

      {/* E. 色标 */}
      <span className={STATUS_DIVIDER} aria-hidden="true" />
      <div data-status-group="label" className="flex items-center gap-1 shrink-0">
        {onLabel && (
          <LabelDots
            label={group.label}
            onSelect={onLabel}
            scopeName={slot ? `${paneName} ${group.baseName}` : undefined}
          />
        )}
        <span className={`${STATUS_HINT} hidden xl:inline w-6 text-[10px]`}>
          {isColorLabel(group.label) ? LABEL_NAMES[group.label] : '—'}
        </span>
      </div>
    </div>
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
