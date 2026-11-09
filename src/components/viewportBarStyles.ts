/**
 * 窗口底部状态栏的造型契约（issue #62，替代 #10 → #12 → #14 → #47 的悬浮方案）。
 *
 * ## 为什么不再悬浮
 *
 * #12/#14/#47 在「悬浮底板 + 手柄」上连续修了三轮几何与可见性：#47 把静息态
 * 整条 `translate-y` 移出视口，屏幕上只剩一根 48×4px 的 `BAR_HANDLE`。用户重启
 * 应用后的直接观感是「状态菜单栏消失了」（issue #62）。这条路线从根上就要求
 * 用户先发现一个手柄才能用到核心动词，违反了「必要信息不得依赖 hover」。
 *
 * 现在底栏是**文档流里的窗口底部状态栏**：
 *
 * 1. `STATUS_BAR` 只挂在 App 的 `<footer>` 上，`shrink-0`，照片区 `flex-1`
 *    在它上方结束 —— 不允许 `absolute` / `fixed` / `translate-y` / `opacity-0`。
 * 2. 所有必要状态（星级、旗标、色标、禁用原因）**常驻可见**，没有
 *    `group-hover` / `group-focus-within` 变体，也没有零宽槽位。
 * 3. 宽度由断点控制（`hidden lg:flex` / `hidden xl:flex` / `hidden 2xl:flex`，
 *    速查用 `min-[1800px]:flex`），不横向滚动：宁可少显示，也不让用户先滚动再找。
 * 4. 三个视口共用同一个 `BottomBar`；双图用 `L` / `R` 分组区分窗格。
 *
 * 机器检查在 `BottomBar.test.tsx`（常驻/分组顺序/双窗格/禁用原因）与
 * `PreviewViewport.test.tsx` / `BeforeAfterViewport.test.tsx` /
 * `SplitCompareViewport.test.tsx`（视口内不得残留悬浮底栏）里。
 *
 * ## 旧锚点
 *
 * `BAR_PLATE` / `BAR_HANDLE` / `BAR_GROUP_HOST` / `BAR_LABEL` / `BAR_ICONS` 已删除。
 * `data-bar-handle` 随之消失；e2e 的 #46/#47 回归保护改成语义等价的
 * 「按钮中心命中自身 + 底栏不遮挡照片区」（见 `src/devtools/e2eRunner.ts`）。
 */

/**
 * 状态栏外框：36px 高、文档流、窗口最底部。
 *
 * `shrink-0` 保证它不被 `flex-1` 的照片区压缩；`overflow-hidden` 只在横向
 * 兜底，不使用 `overflow-x-auto`（横滚与本单的「一眼读到」冲突）。
 */
export const STATUS_BAR =
  'h-9 shrink-0 w-full overflow-hidden ' +
  'flex items-center gap-3 px-3 ' +
  'border-t border-border-default bg-background-base ' +
  'text-[11px] leading-none text-white/70';

/**
 * 状态栏里的一个窗格组（单图只有一个；双图左右各一个）。
 *
 * `overflow-hidden` 是 issue #99 的兜底：分组内部再怎么压缩，内容也不许溢出到
 * 相邻区域 —— 文件头注释要求「不横向滚动」「宁可少显示」，宁可裁掉尾部也不叠字。
 */
export const STATUS_PANE = 'flex items-center gap-3 min-w-0 overflow-hidden';

/**
 * 承载可变长文本（文件名 / 状态 / 体积 / EXIF）的分组几何契约（issue #99）。
 *
 * `min-w-0` 允许它比内容窄（参与收缩），`overflow-hidden` 把超出的
 * `whitespace-nowrap` 文本裁在自己盒子里 —— 这两条缺一不可：只有 `min-w-0`
 * 而没有裁切时，被压扁的分组里 nowrap 文本会溢出盒子、与相邻组文本叠成一团
 * （#99 的根因）。窄窗真正该少显示的组由调用点的断点类 `hidden lg:flex` 整组隐藏。
 */
export const STATUS_GROUP_TEXT = 'items-center gap-1.5 min-w-0 overflow-hidden';

/** 组与组之间的 1px 竖线；纯装饰，调用点 `aria-hidden`。 */
export const STATUS_DIVIDER = 'h-3.5 w-px shrink-0 bg-white/15';

/** 数值文本：等宽数字，避免 1/250 与 100% 的宽度跳动。 */
export const STATUS_VALUE = 'font-mono tabular-nums text-white/90';

/** 次级说明（状态、单位、禁用原因）。 */
export const STATUS_HINT = 'text-white/50 whitespace-nowrap';

/**
 * 带文字的按钮（撤销 / 重做 / 外部打开 / 镜头信息）。
 *
 * 禁用原因常驻在按钮文本里（`撤销：无`），不依赖 `title` —— 禁用按钮不可
 * 聚焦，`title` 键盘与读屏都拿不到（WCAG 2.1 AA / 导出域既有规则）。
 */
export const STATUS_BUTTON =
  'focus-ring flex items-center gap-1 h-6 px-1.5 rounded ' +
  'text-[11px] font-medium text-white/70 hover:text-white hover:bg-white/10 ' +
  'disabled:text-white/40 disabled:cursor-not-allowed ' +
  'transition-colors';

/** 纯图标按钮（缩放 / 复位 / 帮助）。 */
export const STATUS_ICON_BUTTON =
  'focus-ring tap-target p-1 rounded-md ' +
  'text-white/60 hover:text-white hover:bg-white/10 ' +
  'disabled:text-white/40 disabled:cursor-not-allowed transition-colors';

/**
 * 星标按钮：命中盒恒为 18/24px（`p-0.5` → `p-1`），不做 hover 放大。
 * 放大过的星标会互相侵吞命中区（#12 的微抖动教训）。
 */
export const STATUS_STAR_BUTTON = 'focus-ring tap-target p-0.5 lg:p-1 rounded-sm transition-colors';

/** 色点按钮（色点本身仍用 `LABEL_DOT_CLASS` 真值）。 */
export const STATUS_DOT_BUTTON =
  'focus-ring tap-target p-1 rounded-full transition-colors ring-offset-0';
