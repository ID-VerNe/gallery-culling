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
 * 4. 静息态**无底色**：底板透明（F-02：核心动词常驻可见，但视觉重量
 *    降到最低，不压照片）。
 *
 * 标签必须带 `whitespace-nowrap`：`w-0 overflow-hidden` 只压宽度、不禁止换行，
 * 中文会被断成竖排方块（实测静息态按钮高 87px 就是这么来的）。
 *
 * 这些不变量的机器检查在 `PreviewViewport.test.tsx` /
 * `BeforeAfterViewport.test.tsx` 的「底栏几何冻结」组里。
 *
 * ## 视觉层级：整条 bar 淡入淡出（issue #14）
 *
 * #12 修完几何后发现「隐藏了跟没隐藏一模一样」：它只把**文字**收成
 * `opacity-0`，图标与底板盒子仍常驻绘制。几何冻结不该以牺牲层级为代价，
 * 所以这里把「隐藏」提升到整条 bar 一级：
 *
 * - 底板：底色 / 边框 / 阴影随悬停淡入（已有，不变）；
 * - 整条 bar：静息 `translate-y-1` 下沉 4px，悬停 `translate-y-0` 浮现。
 *   `translate` 走合成层，**不进几何**，所以上面第 1 条依然成立；
 * - 图标：静息 `opacity-45`，悬停 `opacity-100`（`.bar-icons`）。不是 0 ——
 *   F-02 要求核心动词可发现，全隐会把旧缺陷改回来；
 * - 三者共用一条 `ease-out` 曲线，不做错峰，避免「底板先亮、图标后亮」。
 *
 * 不支持 `prefers-reduced-motion` 的浏览器以外，降级规则写在 `index.css`
 * 的 `.bar-icons` 与 `@media (prefers-reduced-motion: reduce)` 里。
 *
 * ## 为什么 `group/bar` 必须挂在**包裹层**上（issue #14 根因）
 *
 * Tailwind 的命名组变体编译成后代选择器：`.group\/bar:hover .group-hover\/bar\:x`。
 * 后代组合器要求祖先**严格位于**后代之前，元素永远不可能是自己的祖先。原先
 * `group/bar` 与 `group-hover/bar:*` 同时写在底板上，于是那 8 条变体规则
 * **一条都命中不了** —— 而且在 jsdom（不跑层叠）与 `className` 断言里完全
 * 看不出来，真浏览器里表现为「底板永远不亮、位移永远不下沉」。
 *
 * 现在由 `BAR_GROUP_HOST` 这个**纯定位、不绘制**的包裹层持有 `group/bar`，
 * 底板成为它的后代，变体才能生效。包裹层不设尺寸（内容撑开），因此几何
 * 冻结依旧成立。
 */

/**
 * 底栏分组宿主（issue #14）：只负责持有 `group/bar` 与定位，**不绘制任何东西**。
 *
 * 它必须真的包住底板 —— 这正是上面「后代组合器」那条根因的修复点。
 * 尺寸交给内容撑开，所以不会有新的几何来源。
 */
export const BAR_GROUP_HOST =
  'group/bar absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none';

/** 底栏外框：尺寸恒定。悬停淡入底板 + 回正位移，不碰任何几何属性。 */
export const BAR_PLATE =
  'relative ' +
  'flex items-center gap-3 rounded-lg px-3 py-1 ' +
  'border border-white/0 ' +
  // 浮起：位移不重排，跟底色一起走同一条曲线（issue #14）。
  'translate-y-1 group-hover/bar:translate-y-0 group-focus-within/bar:translate-y-0 ' +
  'group-hover/bar:border-white/15 group-focus-within/bar:border-white/15 ' +
  'group-hover/bar:bg-background-base/90 group-focus-within/bar:bg-background-base/90 ' +
  'group-hover/bar:shadow-2xl group-focus-within/bar:shadow-2xl ' +
  'backdrop-blur-xl ' +
  // 只过渡可合成/不重排的属性：颜色、边框、阴影、位移。（padding 已从几何里消失。）
  'transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out';

/**
 * 悬停热区：比可视底板四周各外扩一圈的透明层。
 *
 * 它本身不画任何东西、也不改尺寸；只是为了「指针接近底板就算悬停」，
 * 让边缘不再有机会在 hover / 非 hover 之间来回跳。尺寸写死成 class，
 * 不随状态变化。
 *
 * issue #14：**纯透明**。原先悬停时自绘 `bg-white/[0.03]`，那是悬停瞬间
 * 多出来的一层亮面，观感上就是「闪一下」。命中层只负责判 hit，不该有形。
 */
export const BAR_HIT_AREA =
  'absolute -inset-x-3 -inset-y-2 ' +
  'bg-transparent ' +
  // PA-8（issue #18）：命中层纯透明、不绘制，不该带圆角——`rounded-xl` 让它在
  // 悬停瞬间多出一层「形」，与「命中层不该有形」的注释自相矛盾。去掉圆角，
  // 它只负责把 hit 判定外扩一圈，视觉重量恒为 0。
  'pointer-events-auto';

/** 分组分隔线：padding 常驻（`pr-3`），展开只让右键线变色。 */
export const BAR_DIVIDER =
  'flex items-center gap-1 pr-3 border-r border-white/0 ' +
  'group-hover/bar:border-white/15 group-focus-within/bar:border-white/15 ' +
  'transition-[border-color] duration-200 ease-out';

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
  'transition-[opacity,transform] duration-200 ease-out';

/**
 * 图标不透明度（issue #14）：`.bar-icons` 是常驻组件类，规则在 `index.css`。
 *
 * 静息 45%、悬停 100%。**刻意不是 0**：整条 bar 在静息时仍要有可发现性
 * （F-02 的核心动词不能被这次改回退）。
 */
export const BAR_ICONS = 'bar-icons';

/** 带标签的按钮：图标 + 文字，padding 恒定。 */
export const BAR_BUTTON =
  'focus-ring flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold ' +
  'active:scale-[0.96] press';

/**
 * 纯图标按钮（缩放 / 重置等）：图标明暗跟着整条 bar 走。
 *
 * 原先它们自带 `text-white/60 hover:text-white`，跟 `.bar-icons` 的
 * 不透明度叠在一起会出现「悬停后只有这一颗更亮」的断层。
 */
export const BAR_ICON_BUTTON =
  'focus-ring tap-target p-1.5 ' +
  'text-white/60 hover:text-white hover:bg-white/10 ' +
  'active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed ' +
  'rounded-md transition-colors';

/**
 * 星标按钮。
 *
 * 原先挂 `hover:scale-125`：16px 图标在 24px 的 `.tap-target` 盒里放大到 20px，
 * 相邻星标的命中区互相侵吞（第三处微抖动）。改为只换色 —— 命中区恒为 24px。
 */
export const BAR_STAR_BUTTON =
  'focus-ring tap-target p-1 rounded-sm transition-colors';
