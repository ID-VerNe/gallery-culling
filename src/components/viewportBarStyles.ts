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
 * 3. **底板上不许盖自动命中层**（issue #46）：`pointer-events` 可继承，底板
 *    一旦是 `none`，内部按钮全是 `none`；而绝对定位 + `pointer-events-auto`
 *    的透明层会绘制在按钮之上、把点击接走。原先的 `BAR_HIT_AREA` 已删除。
 * 4. 静息态**整条移出视口**（issue #47）：只收文字会让容器、图标与标签槽位
 *    继续遮挡照片下沿。收起用 `translate` + `opacity`，不碰几何。
 *
 * 标签必须带 `whitespace-nowrap`：`w-0 overflow-hidden` 只压宽度、不禁止换行，
 * 中文会被断成竖排方块（实测静息态按钮高 87px 就是这么来的）。
 *
 * 这些不变量的机器检查在 `PreviewViewport.test.tsx` /
 * `BeforeAfterViewport.test.tsx` 的「底栏几何冻结」组里。
 *
 * ## 视觉层级：整条 bar 收起（issue #14 → #47）
 *
 * #12 修完几何后发现「隐藏了跟没隐藏一模一样」：它只把**文字**收成
 * `opacity-0`，图标与底板盒子仍常驻绘制。#14 把不透明度压到 45% 仍然不够：
 * 容器、图标、标签预留槽位都还在画面上（实测静息外接盒 887.09px 常驻）。
 * #47 把收起提升到容器级：
 *
 * - 整条底板：静息 `translate-y-[calc(100% + 1rem)]` + `opacity-0`，悬停 /
 *   聚焦回 `translate-y-0` + `opacity-100`。**为什么用 transform**：底板是
 *   宿主里的绝对定位浮层，位移只走合成层、不参与文档流，照片不重排、不跳动；
 *   `display:none` / 卸载会让 `:focus-within` 与 Tab 失去落脚点，`height:0`
 *   会触发重排。`calc(100% + 1rem)` 把 `bottom-4` 留的 1rem 也一并移出视口。
 * - 展开手柄 `BAR_HANDLE`：静息时唯一留在屏幕上的痕迹（约 48×4px），指针
 *   悬停或 Tab 聚焦它就唤回整条。它只是揭示手柄，不绑动作。
 * - 图标静息 45% 的规则（`.bar-icons`）保留，但整条已不可见，它只在过渡
 *   瞬间起作用，不再承担「让用户看见底栏」的职责。
 *
 * `prefers-reduced-motion` 的降级写在 `index.css`：只把过渡时长压到 0，
 * **不能**取消位移本身（否则透明底板会停在原地挡住点击）。
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

/**
 * 底栏外框：尺寸恒定，静息整条移出视口（issue #47）。
 *
 * `pointer-events-auto` 是 issue #46 的修复：`pointer-events` 会继承，底板
 * 一旦 `none`，内部所有按钮都收不到点击。静息时底板整体在视口外，因此不会
 * 挡住照片的点击。
 */
export const BAR_PLATE =
  'relative ' +
  'flex items-center gap-3 rounded-lg px-3 py-1 ' +
  'border border-white/0 ' +
  // issue #46：底板自己接点击，内部按钮继承 auto。
  'pointer-events-auto ' +
  // issue #47：收起 = 整条位移出视口 + 透明。calc(100% + 1rem) 连 bottom-4
  // 留的 1rem 一起移出；位移不参与文档流，照片不重排。
  'translate-y-[calc(100%_+_1rem)] opacity-0 ' +
  'group-hover/bar:translate-y-0 group-focus-within/bar:translate-y-0 ' +
  'group-hover/bar:opacity-100 group-focus-within/bar:opacity-100 ' +
  'group-hover/bar:border-white/15 group-focus-within/bar:border-white/15 ' +
  'group-hover/bar:bg-background-base/90 group-focus-within/bar:bg-background-base/90 ' +
  'group-hover/bar:shadow-2xl group-focus-within/bar:shadow-2xl ' +
  'backdrop-blur-xl ' +
  // 只过渡可合成/不重排的属性：颜色、边框、阴影、位移、透明度。
  'transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 ease-out';

/**
 * 展开手柄（issue #47）：静息时唯一留在屏幕上的底栏痕迹。
 *
 * 约 48×4px 的细条，`pointer-events-auto` 且可聚焦（调用点 `tabIndex={0}`
 * + `aria-label`）。指针悬停或 Tab 聚焦它，宿主 `group/bar` 的 `:hover` /
 * `:focus-within` 就把整条底板唤回，F-02 的「核心动词可发现」不回退。
 *
 * 它是**揭示手柄**而不是动作按钮：不绑 `onClick`，避免做成「点了不知道
 * 干嘛」的伪按钮。DOM 顺序必须放在底板之前 —— 底板展开后绘制在它之上，
 * 不会出现细条压在按钮上的观感。
 */
export const BAR_HANDLE =
  'absolute bottom-0 left-1/2 -translate-x-1/2 ' +
  'focus-ring h-1 w-12 rounded-full ' +
  'bg-white/25 ' +
  'pointer-events-auto ' +
  'group-hover/bar:opacity-0 group-focus-within/bar:opacity-0 ' +
  'transition-opacity duration-200 ease-out';

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
