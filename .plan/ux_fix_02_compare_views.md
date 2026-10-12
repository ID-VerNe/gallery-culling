# 三视口一致性复核报告：同一张照片在三个视图里是不是同一个事实

> 轨道：viewports / t2-viewports
> 范围：`PreviewViewport.tsx`（单图）、`SplitCompareViewport.tsx`（双图对比）、`BeforeAfterViewport.tsx`（本张前后对照）
> 方法：只读复核 `src/**`、`src-tauri/src/**`；所有结论均回源码验证，行号以当前工作树为准。
> 复核基准：`gallery-culling v1.1.1`，React 19 + Tailwind 3 + Vitest。

---

### M-01 「独立缩放」文案与 ± 按钮行为不一致

- **复核结论**：**成立**（核心成立；报告括号内「取左图比例」的措辞需修正，见「报告偏差」）

- **事实与根因**：
  - ± 按钮走 `zoomBy`（`src/components/SplitCompareViewport.tsx:74-87`）。`syncZoom === false` 分支（`:81-84`）对**左右两侧同时**套用同一个 `factor`：
    ```tsx
    } else {
      setLeftScale((s) => clamp(s));
      setRightScale((s) => clamp(s));
    }
    ```
    即使用户把两张图调成了不同比例，按一次「放大」两边会**同步乘同一系数**——独立缩放只在**滚轮/双击/拖拽**这三条路径成立（`handleWheel:97-101`、`handleDoubleClick:144-150`、`handleMouseMove:123-127` 都已按 `isLeft`/`activePane` 分流），唯独顶部工具栏的 ± 按钮没分流。**这是半成品：独立模式只做了交互层，没做工具栏层。**
  - 顶部读数（`:356-362`）与 ± 的 `disabled`（`:350`、`:365`）**恒取 `leftScale`**：
    ```tsx
    aria-label={`当前缩放 ${Math.round(leftScale * 100)}%`}
    ...
    {Math.round(leftScale * 100)}%
    ```
    于是独立模式下若右图是 250%、左图是 100%，读数显示 `100%`，而右图实际 250%。
  - 根因：`leftScale` 被当作「全局当前比例」使用，但独立模式下它只是左图的局部状态。同时 `activePane`（`:57`）在 `handleMouseUp` 里被清成 `null`（`:130-133`），无法充当「当前操作窗格」。

- **影响面**：
  - 触发路径：进入双图对比 → 点「独立缩放」→ 滚轮只放大其一 → 再点顶部 ±。
  - 频率：中。任何想做「同一点位、不同比例」比对细节的用户都会撞上。
  - 后果：**误导 + 低效**。用户以为在调右图，实际左图跟着动，破坏了独立模式存在的全部意义；读数在独立模式下不可信。属于「文案承诺了功能，功能只兑现一半」。

- **修复方案**：
  1. 状态模型（推荐）：把 `activePane` **改名为 `focusedPane`**，默认 `'left'`，语义定为「最近一次交互的窗格」，并**取消 `handleMouseUp` 里的置 `null`**（拖拽门控已由 `isDragging` 负责）：
     - `handleMouseDown`（`:105-111`）已经在设它 → 拖拽分流不改。
     - `handleWheel`、`handleDoubleClick` 中补 `setFocusedPane(isLeft ? 'left' : 'right')`。
  2. `zoomBy` 改为：
     ```tsx
     const zoomBy = useCallback((factor: number) => {
       const clamp = (s: number) => Math.min(Math.max(s * factor, MIN_SCALE), MAX_SCALE);
       if (syncZoom) {
         const next = clamp(leftScale);
         setLeftScale(next); setRightScale(next);   // 联动：以左为基准拉齐两图
       } else if (focusedPane === 'left') {
         setLeftScale(clamp);
       } else {
         setRightScale(clamp);
       }
     }, [syncZoom, leftScale, focusedPane]);
     ```
  3. 读数按模式显示：联动时显示单值；独立时显示「左/右」两值（或突出当前 `focusedPane`），消除 `leftScale` 的单义。
  4. ± 的 `disabled` 用与读数相同的「有效比例」；独立模式下给 `focusedPane` 的窗格加一层细描边/角标，让按钮目标可发现。
  5. `resetView`（`:59-64`）保持作用于两侧（复位本就该全清），无需改。
  - **关于「复用 activePane 还是新增状态」的结论**：可以复用，但必须让它**持久化且改名**。直接复用现名会让一个变量兼任「拖拽目标」与「按钮焦点」两种语义；改名 `focusedPane` + 默认 `'left'` 是最小且语义干净的路径。不建议新增第二份状态（三者会打架）。

- **风险评估**：
  - 风险等级：**低**。
  - 可能回归的相邻功能：**「钉基准 + 联动缩放 + 翻页」三态组合**——钉住左侧后翻页只换右图（`App.tsx:415/423`），此时 `focusedPane` 若停留在左图，± 会去动静止的基准图。**建议：翻页/切图后（`useEffect` on `leftGroup?.id,rightGroup?.id`，`SplitCompareViewport.tsx:70-72`）自动把 `focusedPane` 指向「当前可变的那一侧」**，或在独立模式下禁用对钉住侧的 ± 并给出 `title`。
  - 需产品决策：独立模式下 ± 的默认作用窗格（左 / 最近交互 / 未钉住侧）。
  - 回滚：改动集中在 `SplitCompareViewport.tsx` 单文件，`git checkout` 即回滚。

- **验证方法**：
  - 手工：① 关联动 → 滚轮只放大右图 → 断言左图比例不变、右图放大；② 点 ± → 断言只有右图变化、读数反映右图；③ 开联动 → ± → 两图同步；④ 钉左 + 翻页后按 ± → 断言作用于右图。
  - 可断言测试（新增 `SplitCompareViewport.test.tsx`，目前**该组件零测试覆盖**）：
    - `it('独立模式下 ± 只改变聚焦窗格')`：`syncZoom=false`，点击右窗格后点「放大」，断言右 `<img>` 的 `style.transform` 含 `scale(1.25)`、左仍是 `scale(1)`。**修复前该用例失败**（两侧都会变 1.25）。
    - `it('独立模式读数反映聚焦窗格')`：左右设为不同比例，断言读数文本等于聚焦侧。**修复前失败**（恒等于左）。

---

### M-02 对比视图不接 LUMEN 真实解码、不套调色滤镜

- **复核结论**：**成立**，且**影响被低估**（不止「显影不同」，RAW-only 照片在对比视图里**根本显示不出来**）

- **事实与根因**：
  - `renderPane`（`src/components/SplitCompareViewport.tsx:160-164`）直接取静态资源 URL：
    ```tsx
    const src = group?.jpg?.path ? api.toAssetUrl(group.jpg.path)
              : group?.raw?.path ? api.toAssetUrl(group.raw.path) : null;
    ```
    既无 `useLumenPreview`（RAW 真实解码），也无 `getToneFilterString`（调色滤镜），`<img>`（`:191-201`）也没有 `filter` 样式。
  - 单图视图两者都做（`src/components/PreviewViewport.tsx:141` 调 `useLumenPreview`；`:157-160` 生成 `toneFilter`；`:224` 应用到 `<img>`）。
  - 组件契约层面就缺料：`SplitCompareViewportProps`（`:18-30`）**没有 `tone`、没有 `lumenStatus`**；`App.tsx:995-1011` 也未传。
  - **RAW-only 硬故障**：`scanner.rs:355-359` 明确存在 `RawOnly` 分组（`jpg: None, raw: Some`）。此时 `src = api.toAssetUrl(raw.path)` 指向 `.NEF/.CR3` 等，WebView 的 `<img>` 无法解码 → **空白/破图**。单图视图在同条件下会走 `useLumenPreview` 渲染（`useLumenPreview.ts:48` 仅在 `hasJpg` 时才短路）。这是「显影不同」之上的**可用性缺陷**。
  - 另需注意：**`BeforeAfterViewport` 同样没有接 LUMEN**（`BeforeAfterViewport.tsx:106-110` 直接 `toAssetUrl`）。所以「缺 LUMEN 解码」是 **3 个视图里缺 2 个**，不是只有对比视图。

- **影响面**：
  - 触发路径：开启 `lumenEnabled` → 双图对比 → 任一侧为 RAW-only（配对模式下有 RAW 无同名 JPG 时）。
  - 频率：中低（取决于 RAW 工作流是否遗留无 JPG 的底片），但一旦命中就是**功能不可用**。
  - 后果：RAW-only → 破图（严重）；有 JPG/Raw 但已编辑调色 → 对比视图显示未调色的 JPG，与单图视图观感不一致（中等，误导）。

- **修复方案（含成本/语义评估 + 2~3 方案）**：
  - **成本实测（读码结论）**：
    - `useLumenPreview` 在 `hasJpg` 时**直接 return，零请求**（`useLumenPreview.ts:48`）。因此**Complete（有 JPG）分组在对比视图接入后不会产生任何额外解码**；只有 RAW-only 且引擎可用且 `lumenEnabled` 才会请求。
    - 两个 hook 实例 = 两份 `attemptsRef`（`useLumenPreview.ts:34`，各一个 `Map`），`MAX_ATTEMPTS = 2`（`:7`）**按实例计算**。最坏情况只在「同一张失败 RAW 同时落在左右」时出现 4 次 sidecar 调用，而 `App.tsx:225-231` 已明确避免左右同图，故实际每张仍 ≤2 次，与单图一致。
    - 内存：两张 1600px 宽位图在 WebView 中各约 7MB，共约 +7MB；preview 落盘由 sidecar 缓存（`LumenPreviewResult.cached`）。可接受。
    - 翻页延迟：钉基准时左图静止，翻页只换右图 → 每次翻页 **1 次**新解码，与单图等同；未钉基准时每页约 1 次。**结论：不要被「×2 解码」吓到，真实增量接近 0~1 次/页。**
    - `lumenGridThumbs`（`App.tsx:107-108`）只影响宫格缩略图，与本改动无耦合，可不动。
  - **方案 A（零成本，仅语义澄清）**：不动解码/滤镜，在窗格上打标「原图（未套用调色）」，并在 README/快捷键帮助里说明对比视图只比对原片。**取舍**：彻底不解决 RAW-only 破图；只消除「同图不同显影」的困惑。
  - **方案 B（全量对齐，推荐）**：给 `SplitCompareViewport` 新增 `lumenStatus` 与「按分组取 tone」的能力（`getTone?: (g: PhotoGroupInfo) => ToneAdjustments | undefined`，宿主传 `(g) => toneMap[g.id] || g.tone`），窗格内各起一个 `useLumenPreview(group, lumenStatus, width)`，并按单图同规则套 `getToneFilterString`（LUMEN 命中时不叠加 CSS filter，与 `PreviewViewport.tsx:157-160` 完全同构）。**取舍**：一致性与 RAW-only 可用性都解决，成本已证为低；语义上对比图 = 成品效果。
  - **方案 C（折中）**：接 LUMEN 解码（解决破图），但**默认不套调色**，窗格给一个「套用调色」小开关 + 「原图」徽章。**取舍**：兼顾「比对焦/表情」与「比成品」，但多一套 UI 状态，偏重。
  - **推荐 B**，理由：① 本轨道主题就是「同一张照片三个视图是同一个事实」，B 是唯一真正闭合的；② 对未调色照片 `getToneFilterString` 返回 `'none'`（`autoTone.ts:153-162`），视觉零副作用；③ 成本经复核确实低。若产品判定「对比视图的产品目的是比对焦与表情」，则退方案 C（而不是 A，因为 A 不修破图）。
  - 落点：`SplitCompareViewport.tsx`（接口 + `renderPane` + `<img> filter`）、`App.tsx:995-1011`（补传 `lumenStatus`、`getTone`）。

- **风险评估**：
  - 风险等级：**中**（引入网络/解码调用与新的宿主 props）。
  - 可能回归：① 与「统一调色真值」（tone 来源 `toneMap`/`group.tone`/lumen）耦合，需与状态真值轨道对齐来源，避免三处 tone 取值分叉；② RAW-only 首次进入对比视图会有一次等待（应复用单图视图已有的「正在渲染 RAW…」轻提示与 `lumenBroken` 静默降级语义）；③ 双 hook 实例的 `attemptsRef` 不共享，需接受「同一失败图可能被两侧各试一次」。
  - 需产品决策：对比视图是「比成品」还是「比对焦点/表情」——决定是否默认套滤镜。
  - 回滚：去掉新增 props 与 hook 调用即回到现状，改动不触碰后端。

- **验证方法**：
  - 手工：① 对一张 RAW-only 照片切到对比视图 → 修复前破图、修复后经 LUMEN 正常显示；② 对一张已调色照片比较单图 vs 对比 → 两者观感一致。
  - 可断言测试：
    - `it('RAW-only 分组在对比窗格走 lumen 预览 URL')`：mock `api.getLumenPreview` 返回 `previewPath`，断言窗格 `<img src>` 含该 asset URL。**修复前失败**（src 为 raw 路径）。
    - `it('对已调色分组两窗格都套用 tone filter')`：传 `getTone` 返回非零 tone，断言两个 `<img>.style.filter` 非 `none`。**修复前失败**（无 filter 属性）。
    - 回归：`it('有 JPG 时不触发 lumen 请求')`，断言 `getLumenPreview` 零调用。

---

### M-03 对比视图窗格空态是裸文案，未复用统一空态

- **复核结论**：**成立**

- **事实与根因**：
  - `renderPane` 空态（`src/components/SplitCompareViewport.tsx:166-172`）只是一行居中文本，无图标、无描述、无 CTA：
    ```tsx
    <div className="flex-1 bg-background-surface-hover flex items-center justify-center text-white/60 text-xs px-4 text-center">
      未选择对比照片
    </div>
    ```
  - 另两处已是「图标 + 标题 + 描述 + 可选 CTA」的完整结构：`PreviewViewport.tsx:162-185`、`BeforeAfterViewport.tsx:121-146`，且两处 JSX **逐字重复**（复制粘贴，而非抽成组件）。
  - 空态类型 `ViewportEmptyState` 定义在 `PreviewViewport.tsx:51-56`，`BeforeAfterViewport.tsx:18` 已 `import type` 复用类型，但组件实现没有复用。

- **影响面**：
  - 频率：高。双图对比在只有一张照片（或宫格未选）时是常见进入路径。
  - 后果：**困惑**。三视口里唯独对比视图的空态「不像系统 UI」，且未告知用户「怎么把一个照片放进窗格」；同时视觉上与另两处割裂。

- **修复方案（最小复用）**：
  1. 抽出共享展示组件 `ViewportEmptyStateView`（建议同文件导出或新建 `components/ViewportEmptyState.tsx`），props：`emptyState: ViewportEmptyState` + `variant?: 'full' | 'pane'`。`variant='pane'` 时：图标 `w-10 h-10`、`p-4`、描述单行、CTA 为内联文字按钮。
  2. 三个视图统一改用它：单图/前后照用 `full`，对比视图两侧用 `pane`。`ViewportEmptyState` 类型**无需改动**，直接复用。
  3. **窗格级文案（1/2 宽，措辞需更短）建议**：
     - 左侧：`title="左侧未选择"`，`description="从右侧宫格选一张作为基准"`
     - 右侧：`title="右侧未选择"`，`description="从右侧宫格选一张进行对比"`
     - CTA：**建议不给**（窗格内目前没有可靠的「打开宫格」句柄；全屏空态的 CTA 依赖宿主 `onAction`，窗格不具备）。若后续宿主提供聚焦宫格的 API，再加 `actionLabel="去宫格选择"`。
     - 理由：窗格只有半宽，长句会换行挤压；「怎么选」的信息用一句短描述即可，与全屏空态的 CTA 差异是合理的（动作归属宿主）。
  4. 注意：**抽取共享组件会同时触碰两个当前正常的视图**，必须回归它们的空态。

- **风险评估**：
  - 风险等级：**低**。
  - 可能回归：单图/前后照空态的样式与 CTA 行为（`App.tsx:894-916` 的 `viewportEmptyState` 三态：未加载 / 筛选为空 / 未选择）。抽取时保持 DOM 与类名不变最稳。
  - 需产品决策：窗格是否要 CTA（当前判断：不要）。
  - 回滚：单文件回滚；若只改对比视图内部（不抽组件）则零回归面。

- **验证方法**：
  - 手工：三视口分别在「未选照片」「筛选为空」下截图比对，应同构。
  - 可断言测试：`it('对比窗格空态含图标与标题文案')`，断言 `getByRole('img', {hidden})` 或图标 SVG 存在、文案为「左侧未选择」等。**修复前失败**（无图标、无标题节点）。

---

### M-11 左右窗格视觉对称，但左窗格点击是空实现

- **复核结论**：**成立**（「hover」一项需修正——窗格根本没有 hover 态，见「报告偏差」）

- **事实与根因**：
  - `App.tsx:1005`：`onSelectLeft={() => {}}`；`App.tsx:1006-1010`：`onSelectRight` 会 `setSelectedIndex(compareIndex)`。
  - `renderPane` 给两个窗格挂了同一个 `onClick={onSelect}`（`SplitCompareViewport.tsx:180`），视觉完全对称：同样的 `cursor-grab`/`cursor-grabbing`（`:187-189`）、同样的 `border-r`、同样的 `finger` 光标。**用户从 UI 上无法分辨哪个能点、哪个是死键。**
  - 追加隐患：`onClick` 在拖拽结束时同样触发（无位移阈值判断）。因此在**右窗格拖拽平移**会顺带 `setSelectedIndex(compareIndex)`，是**静默改选中项**的副作用；左窗格拖拽则无任何效果。这让不对称更糟。
  - 导航的真值来源其实是：宫格 `handleSelectPhoto`（`App.tsx:436-450`）与键盘/箭头 `handlePrev/handleNext`（`:414-432`）——**均按 `pinnedId + isPinnedOnLeft` 正确分流到 `compareIndex`**。窗格点击并非必要入口。

- **影响面**：
  - 频率：中（用户会本能地点窗格）。
  - 后果：**困惑 + 意外副作用**（拖拽改选中项）。

- **修复方案（二选一，推荐前者）**：
  1. **推荐：整体移除窗格级 `onClick`**（两窗格一致），并删除 `onSelectLeft`/`onSelectRight` 两个 props。
     - 依据：`App.tsx:414-450` 已确认选中由宫格与键盘驱动；移除后两侧**真正对称**，且顺带消除「拖拽右窗格改选中」的 bug。
     - 代价：右窗格点击不再跳转宫格选中。可接受——该行为此前还伴随拖拽误触；且右图内容可由 `D/→`（`App.tsx:422-432` 在钉左时推进 `compareIndex`）与宫格驱动。
     - 注意：`space`/`[`/`]`/`B` 的钉基准快捷键已可用（`useKeyboardShortcuts.ts:173-203`），窗格上也有显式「设为基准」按钮（`SplitCompareViewport.tsx:222-251`），基准操作不依赖点击。
  2. 备选（若产品坚持点窗格）：让两窗格**语义对称**——统一改成「点击把该窗格照片设为当前单图选中」（新增单一 prop `onActivateGroup(group)`，实现为 `setSelectedIndex(该组索引)`）。但会与钉基准模型（`App.tsx:415/423/440` 的三态）相互干扰，需额外定义「钉住时点左窗格」的语义，副作用面更大。**故不推荐。**
  - 结论：**去掉窗格级点击**更安全、副作用最小。

- **风险评估**：
  - 风险等级：**低**。
  - 可能回归：`onSelectRight` 目前的唯一作用是「点右图 → 宫格选中跳到右图」。移除后若用户依赖「点一下右图再按 P/1-5 给右图打分」，会失效——**但打分/标记当前作用于 `currentGroup`（`App.tsx:463-464` 默认参数）**，即选中项，而非窗格照片。这是一个既有的语义歧义点（在对比视图打分到底打给谁？），移除点击不会让它变差，但**建议同步核对**：`SplitCompareViewport` 里打分按钮传的是 `onRate(group, r)`（`:266`）、`onFlag(group, ...)`（`:288`）→ 作用于**窗格对应照片**，与键盘 `1-5/P/X` 作用于 `currentGroup` **不一致**。此项超出 M-11 范围，但同一修复窗口值得一并决策。
  - 需产品决策：窗格点击的预期语义（不点 / 选为当前 / 选为基准）。
  - 回滚：恢复 props 与 `onClick` 即回滚。

- **验证方法**：
  - 手工：① 点击左右窗格，断言选中项不变（修复后）；② 在右窗格拖拽平移，断言选中项不变（修复前会被改）。
  - 可断言测试：`it('拖拽右窗格不改变选中项')`：`mousedown/mousemove/mouseup` 于右窗格后断言 `onSelectRight` 从未被调用。**修复前失败**。

---

### L-01 「联动锁焦」是不可交互的静态徽章，却与旁边按钮同构

- **复核结论**：**成立**

- **事实与根因**：
  - `BeforeAfterViewport.tsx:226-233`：
    ```tsx
    <div className="flex items-center gap-1 px-2 py-0.5 bg-white/10 text-white border border-white/25 rounded text-[11px] font-medium"
         title="锁定同步缩放">
      <Link className="w-3 h-3" aria-hidden="true" />
      <span>联动锁焦</span>
    </div>
    ```
    是 `<div>`、**无 `onClick`、无 `aria-pressed`**；而同排的「调色面板」（`:215-224`）与「Luminar AI 修图」（`:200-212`）是同色系、同尺寸的可点按钮。视觉上无法区分「能点」与「只是标签」。
  - 行为侧：`BeforeAfterViewport` 的两张图**共用 `pos`/`scale`**（`:255-258`、`:279-284`），且滚轮/拖拽/双击处理器挂在**外层包裹 div**（`:238-247`）上 → 天然只能联动。「锁焦」描述的是硬编码现状，而非一个可切换状态。

- **影响面**：
  - 频率：低—中（本张前后对照是查看精修效果的常用视图）。
  - 后果：**困惑**（用户尝试点击解锁，无反应）；同时错失「同点位不同比例看细节」这一前后对照的核心价值。

- **修复方案**：
  - 若要做**真开关**，需要新增：
    - 4 个状态替换现有共享的 `scale`/`pos`：`beforeScale/beforePos`、`afterScale/afterPos`；
    - 1 个 `syncLock`（默认 `true`）；
    - `activePane`（哪侧接受手势）；
    - 把 `handleWheel/handleMouseDown/handleMouseMove/handleDoubleClick` 从外层包裹移到**各自窗格**，按 `activePane` 分流（对照 `SplitCompareViewport` 已有实现，可借其结构）。
    - **与现状冲突程度：中等**。共享模型在 `:256`、`:280` 各引用一次、手势在 `:239-244` 集中一处，改动量约 60–80 行；无隐藏耦合。徽章改为按钮时补 `aria-pressed`。
  - 若不做真开关，**降级为纯文本说明**：去掉 `bg-white/10`/`border`/`rounded`（或改为无交互的 caption 样式），`title` 改为「两图始终同步缩放」，避免伪装成按钮。
  - **推荐**：短期按**降级**处理（0.15 人天、零回归）；若「前后对照看细节」是真实高频场景，再排期实现真开关（0.75 人天）。理由：独立缩放在 before/after 场景确实有真实价值（同一细节两版对比），但优先级低于 M-01/M-02。

- **风险评估**：
  - 风险等级：**低**（降级）/ **中**（实现真开关，涉及手势与状态重排）。
  - 可能回归：实现真开关时，轮询/拖拽事件从外层下移到窗格，容易漏掉「空白区域拖动也能平移」的既有手感；`imageOrientation` 与 `filter` 需保留。
  - 需产品决策：是否需要独立缩放。
  - 回滚：单文件回滚。

- **验证方法**：
  - 降级：断言该节点不再是 `button`、无 `role`，或文案/样式已变更。`it('联动锁焦不再以按钮外观呈现')`。
  - 真开关：`it('关闭联动后拖拽仅移动 After 侧')` + `it('联动开启时两侧 transform 相同')`。**修复前失败**（无开关状态）。

---

## 三视口一致性矩阵

| 视口 | LUMEN 真实解码 | 调色滤镜 | edited（Luminar 成果） | 空态 | 缩放读数 | 点击语义 |
|---|---|---|---|---|---|---|
| `PreviewViewport`（单图） | ✅ `:141` | ✅ 且 LUMEN 命中时**不叠加**（`:157-160,224`） | ❌ **不显示** `edited`（`:149-153` 只用 jpg/raw） | ✅ 完整结构 `:162-185` | ✅ 单值 `:187` | 无窗格点击（overlay 走 prev/next） |
| `SplitCompareViewport`（双图） | ❌ **无** `:160-164` | ❌ **无**（无 `tone` prop） | ❌ 无 | ❌ 裸文案 `:166-172` | ❌ 恒 `leftScale` `:356-362` | ❌ 左空实现 / 右改选中 `App.tsx:1005-1010` |
| `BeforeAfterViewport`（前后） | ❌ **无** `:106-110` | ⚠️ 仅 After 侧 `:118-119,282` | ✅ 有则用 `edited` 作 After `:113-116` | ✅ 完整结构 `:121-146` | ✅ 单值 `:174-179` | 无窗格点击（双图共用 pos/scale） |

**一致性判定**：
- **LUMEN 解码**：3 个视口**仅 1 个**具备 → 最严重的不一致。
- **调色滤镜**：单图「有且防双develop」；前后照「只给 After」（符合其语义）；对比视图「完全没有」→ 不一致。
- **edited 图**：**三者各不相同**（单图不看、对比不看、前后照看）→ 不一致。
- **空态**：2 个统一、对比视图裸文案 → 不一致。
- **缩放读数**：对比视图在独立模式下不可信 → 不一致。
- **点击语义**：对比视图左右不对称 → 不一致。

---

## 优先级与依赖

| 项 | 优先级 | 依赖 | 说明 |
|---|---|---|---|
| M-02（接 LUMEN + 滤镜） | **P0**（含 RAW-only 破图） | 需 `App.tsx` 暴露 `lumenStatus` 与按组 `tone`；与「状态真值」轨道对齐 tone 来源 | 唯一修「功能不可用」的项，且同时把对比视图拉回与单图一致；`BeforeAfter` 的 LUMEN 缺失建议**同批**处理 |
| M-11（去掉窗格点击） | **P1** | 无 | 顺带修「拖拽改选中」；建议与「打分/标记作用于谁」的语义一并决策 |
| M-01（独立缩放） | **P1** | 与 M-11 同文件，建议同批改 | 单文件、低风险 |
| M-03（空态复用） | **P2** | 抽取共享组件会触碰另两视口 | 可先只改对比视图内部降风险 |
| Q3（`edited` 统一） | **P2** | 需产品定义「成品真值」 | 跨三视口的产品决策，非机械修复 |
| L-01（联动锁焦） | **P3** | 无 | 先降级；真开关看需求 |

**跨轨道依赖/协作点**：
- M-02 的 tone 来源与 `toneMap[currentGroup.id] || currentGroup.tone`（`App.tsx:549`）必须与「状态真值（t3）」保持同一真值源，否则会出现第 4 种显影结果。
- M-02 的 LUMEN 解码与 `attemptsRef`/缓存语义涉及「数据安全（t1）」的静默降级契约，改动须沿用「失败不弹窗、切图作废」既有约定。
- M-03 抽共享组件会同时改 `PreviewViewport` 与 `BeforeAfterViewport`，注意与「可访问性/文案（t5）」的文案一致性协作。

---

## 工作量估计（人天）

> 假设：单人、熟悉该模块；含必要单测；不含产品评审等待时间。

| 项 | 方案 | 估计 |
|---|---|---|
| M-01 | 状态改名 + ± 分流 + 读数 + 聚焦高亮 + 测试 | **0.5** |
| M-02 | 方案 B（全量对齐，含 App 传参、按组 tone、双 hook、破图修复、标签、测试） | **1.5** |
| M-02 | 仅方案 A（只打「未调色原图」标签） | 0.25 |
| M-03 | 抽共享空态组件 + 三视口接入 + 窗格文案 + 测试 | **0.5**（仅对比视图内部实现 0.25） |
| M-11 | 移除窗格点击 + 删 props + 测试 | **0.25** |
| L-01 | 降级为纯文本 | 0.15 |
| L-01 | 实现真独立缩放开关 | 0.75 |
| Q3 | `edited` 三视口统一（需产品决策后） | **1.0–2.0** |
| **合计** | **推荐路径（M-01 + M-02 方案B + M-03 + M-11 + L-01 降级）** | **≈ 2.9–3.0** |
| **合计** | 最小路径（M-01 + M-02 方案A + M-03 内部 + M-11 + L-01 降级） | **≈ 1.4** |
| **合计** | 全量（含 Q3 统一 + L-01 真开关） | **≈ 4.6–5.6** |

---

## 复核中发现的报告偏差

1. **M-01 措辞不精确**：报告称独立分支「取左图比例」——实际独立分支是**对两侧套用同一 `factor`**（`SplitCompareViewport.tsx:81-84`）；「以 `leftScale` 为基准」是**联动分支**的机制（`:77-80`）。**核心结论（文案与行为不符）成立，但归因需修正。**
2. **M-11「hover」不成立**：窗格类名中**没有任何 `hover:` 样式**（`SplitCompareViewport.tsx:187-189`）。两窗格并非「hover 也对称」，而是「根本没有 hover 反馈」——不一致程度比报告描述**更高**。建议改为「无任何悬停/可点性提示」。
3. **M-02 影响被低估**：报告只说「同张照片显影不同」。复核发现 RAW-only 分组（`scanner.rs:355-359`）在对比视图会**直接破图**（`toAssetUrl(raw.path)` 交给 `<img>`），属可用性缺陷；且 **LUMEN 解码缺失是 2/3 视口**（`BeforeAfterViewport.tsx:106-110` 同样没有），不止「对比 vs 单图」。
4. **M-03 表述需补充**：报告说另两视口「已统一为同一结构」——属实，但本质是**两份逐字复制的 JSX**（`PreviewViewport.tsx:162-185` 与 `BeforeAfterViewport.tsx:121-146`），并非共享组件。这既是 M-03 的修复机会，也是抽取时的回归风险点。
5. **新增发现（超出原报告）**：
   - 对比视图窗格 `onClick` 无位移阈值 → **拖拽平移右窗格会静默改变宫格选中项**（`SplitCompareViewport.tsx:180` + `App.tsx:1006-1010`）。
   - **打分/标记的作用对象在视口间不一致**：窗格按钮作用于「窗格照片」（`SplitCompareViewport.tsx:266,288`），键盘 `1-5/P/X` 作用于 `currentGroup`（`App.tsx:463-464` 默认参数）。建议纳入「同一事实」议题。
   - **单图视图不显示 `edited`**（`PreviewViewport.tsx:149-153`），故 `edited` 的不一致是**三向**而非「对比视图 vs 前后照」。这使 Q3 从「是否纳入」升级为「必须由产品定义成品真值」。
