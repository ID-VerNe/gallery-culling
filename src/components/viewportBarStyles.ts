/**
 * 主视口底部快捷条（bar）的统一造型契约（issue #12）。
 *
 * 两个视口（单图 `PreviewViewport`、前后对照 `BeforeAfterViewport`）的底栏
 * 曾经各写一份 class 串，于是同一种缺陷复制了两遍。这里收敛成唯一归属，
 * 并且**把几何冻结写进注释**：
 *
 * ## 为什么几何必须冻结
 *
 * #10 的版本在 `group-hover/bar:` 里同时改 `px-*` / `py-*` / `pr-*`，标签用
 * `w-0 → w-auto`。真浏览器实测：悬停让外接盒 497px → 753px（+51.5%），
 * 左边界从 x=351.5 移到 x=223.4。盒子会「长大」，指针停在边缘就会反复
 * 掉进/掉出 `:hover` —— **自激闪烁**，用户看到的就是这个。
 *
 * 所以本模块的硬规则：
 *
 * 1. **`group-hover/bar:` / `group-focus-within/bar:` 只许改颜色、透明度、
 *    阴影、滤镜**。padding / width / height / gap / scale 一个都不许进变体。
 *    要动外观，先换一个不触发重排的属性。
 * 2. **文字标签占的槽位宽度恒定**（`.bar-label`，见 index.css），折叠只把
 *    `opacity` 与 `translate` 收起来。这样「展开」不会让盒子变宽。
 * 3. **命中层比底板大**（`BAR_HIT_AREA`）：指针在底板边缘 ±12/±8px 内都算
 *    「在里面」，进一步消除边缘抖动。
 * 4. 静息态**无底色**：底板透明、只有图标（F-02：核心动词常驻可见，
 *    但视觉重量降到最低，不压照片）。
 *
 * 标签必须带 `whitespace-nowrap`：`w-0 overflow-hidden` 只压宽度、不禁止换行，
 * 中文会被断成竖排方块（实测静息态按钮高 87px 就是这么来的）。
 *
 * 这些不变量的机器检查在 `PreviewViewport.test.tsx` /
 * `BeforeAfterViewport.test.tsx` 的「底栏几何冻结」组里。
 */

/** 底栏外框：尺寸恒定。悬停只淡入底板，不碰任何几何属性。 */
export const BAR_PLATE =
  'group/bar absolute bottom-4 left-1/2 -translate-x-1/2 ' +
  'flex items-center gap-3 rounded-lg px-3 py-1 ' +
  'border border-white/0 ' +
  'group-hover/bar:border-white/15 group-focus-within/bar:border-white/15 ' +
  'group-hover/bar:bg-background-base/90 group-focus-within/bar:bg-background-base/90 ' +
  'group-hover/bar:shadow-2xl group-focus-within/bar:shadow-2xl ' +
  'backdrop-blur-xl ' +
  // 只过渡可合成/不重排的属性：颜色、边框、阴影。（padding 已从几何里消失。）
  'transition-[background-color,border-color,box-shadow] duration-150';

/**
 * 悬停热区：比可视底板四周各外扩一圈的透明层。
 *
 * 它本身不画任何东西、也不改尺寸；只是为了「指针接近底板就算悬停」，
 * 让边缘不再有机会在 hover / 非 hover 之间来回跳。尺寸写死成 class，
 * 不随状态变化。
 */
export const BAR_HIT_AREA =
  'absolute -inset-x-3 -inset-y-2 ' +
  'bg-transparent ' +
  'group-hover/bar:bg-white/[0.03] group-focus-within/bar:bg-white/[0.03] ' +
  'rounded-xl pointer-events-auto ' +
  'transition-[background-color] duration-150';

/** 分组分隔线：padding 常驻（`pr-3`），展开只让右键线变色。 */
export const BAR_DIVIDER =
  'flex items-center gap-1 pr-3 border-r border-white/0 ' +
  'group-hover/bar:border-white/15 group-focus-within/bar:border-white/15 ' +
  'transition-[border-color] duration-150';

/** 不含分隔线的普通分组（末组用）。 */
export const BAR_GROUP = 'flex items-center gap-1';

/**
 * 按钮里的文字标签。
 *
 * 宽度由 `.bar-label`（`min-width` + `white-space: nowrap`）常驻撑开，
 * 折叠只收 `opacity` 与 4px 的 `translate` —— 两者都不改布局。
 */
export const BAR_LABEL =
  'bar-label whitespace-nowrap text-xs ' +
  'opacity-0 -translate-x-1 ' +
  'group-hover/bar:opacity-100 group-focus-within/bar:opacity-100 ' +
  'group-hover/bar:translate-x-0 group-focus-within/bar:translate-x-0 ' +
  'transition-[opacity,transform] duration-150';

/** 带标签的按钮：图标 + 文字，padding 恒定。 */
export const BAR_BUTTON =
  'focus-ring flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold ' +
  'active:scale-[0.96] transition-colors';

/**
 * 星标按钮。
 *
 * 原先挂 `hover:scale-125`：16px 图标在 24px 的 `.tap-target` 盒里放大到 20px，
 * 相邻星标的命中区互相侵吞（第三处微抖动）。改为只换色 —— 命中区恒为 24px。
 */
export const BAR_STAR_BUTTON =
  'focus-ring tap-target p-1 rounded-sm transition-colors';
