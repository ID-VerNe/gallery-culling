# 状态真值单一化与焦点不丢失 —— 独立复核报告

- **轨道**：t3-state-truth（状态真值单一化与焦点不丢失：屏幕上任何一处显示的"当前状态"都必须同源）
- **项目**：`C:/Users/VerNe/Downloads/Documents/gallery-flask`（gallery-culling v1.1.1）
- **技术栈**：Tauri 2.0 + React 19 + TypeScript + Tailwind 3 + @tanstack/react-virtual；测试 Vitest + @testing-library/react
- **窗口约束**：`src-tauri/tauri.conf.json:16-19` 默认 1400×900，minWidth 960 / minHeight 640
- **调查性质**：**只读**。本次仅阅读源码，未修改任何现有文件；唯一写入的是本报告。
- **复核范围**：`src/App.tsx`、`src/components/{Modal,SettingsModal,TopBar,ThumbnailGrid,TonalAdjuster,BottomBar,PreviewViewport,BeforeAfterViewport}.tsx`、`src/hooks/{useLumenStatus,useKeyboardShortcuts}.ts`、`src/types/index.ts`、`src/test/setup.ts`
- **方法**：逐条回源码验证报告结论，允许推翻；结论标注成立性并附 `path:line`。测试基座只 mock `@tauri-apps/api/core` 的 `invoke`（`src/test/setup.ts`），因此可用「命令名 + 参数」做负向断言。

---

## 结论速览

| 编号 | 主题 | 复核结论 | 关键位置 |
|---|---|---|---|
| M-04 | 面板互换焦点丢失 + 触发按钮缺 `aria-controls/aria-expanded` | **成立**（`/` 路径已被部分缓解） | `App.tsx:1014`、`TopBar.tsx:289-304` |
| M-06 | 设置本地态 + 静默丢弃；握手状态行与未保存勾选自相矛盾 | **成立** | `SettingsModal.tsx:30,51-59,73-85,194-204` |
| M-07 | 宫格搜索只作用宫格 → 宫格/中心视口/底栏三处事实不一致 | **成立** | `App.tsx:185-188,214,1058-1059`、`BottomBar.tsx:99-106`、`ThumbnailGrid.tsx:132-133,142-143,335` |
| M-10 | `showTonalPanel && currentGroup` 造成按钮按下态与面板不同源 | **成立** | `App.tsx:1014,940`、`TopBar.tsx:292-300` |
| （专） | 索引一致性：pinned 分支缺"同图保护"、候选无宫格高亮 | **发现新缺陷** | `App.tsx:217-260,436-450` |

---

### M-04 面板互换后焦点退回 body（+ 触发按钮缺少展开语义）

- **复核结论**：**成立**。侧栏是两个组件的二选一渲染，两者都没有初始焦点接管；`E` 键切换时旧的聚焦元素被整棵卸载，焦点回退 `body`。触发按钮确实只有 `aria-pressed`，没有 `aria-controls`/`aria-expanded`。
  - `App.tsx:1014`：`{showTonalPanel && currentGroup ? (<TonalAdjuster .../>) : (<ThumbnailGrid .../>)}`
  - 全库焦点接管仅存在于 `Modal.tsx:42-60`（grep `initialFocus|restoreFocus|useFocus|aria-controls|aria-expanded` 的结果只有 Modal 的 `restoreFocusRef`）。
  - **补充**：报告的覆盖面偏窄——同一块面板有 **3 个**触发按钮，全部只有 `aria-pressed`：`TopBar.tsx:289-304`、`PreviewViewport.tsx:402-408`、`BeforeAfterViewport.tsx:216-220`。修复不能只改 TopBar。
  - **细化**：报告称"两者都无焦点接管"正确，但焦点丢失只发生在 **E 键 / 按钮切到调色面板**这条路径。`/` 搜索路径（`App.tsx:864-869` → `setShowTonalPanel(false)` + token+1）会因为 `ThumbnailGrid.tsx:56-58` 在 `searchOpen` 时主动 focus 搜索框而**不会**丢焦点。所以准确表述是「切到调色面板时丢失；切回宫格时 `/` 路径已自愈，其它路径未自愈」。

- **事实与根因**：
  1. 宫格里可聚焦的宿主是 `ThumbnailGrid.tsx:254-266` 的 listbox（`tabIndex={0}`）；格子 `GridPhotoCell` 的根节点 `tabIndex={-1}`（`ThumbnailGrid.tsx:466`），鼠标点击也会把焦点落在它上面。
  2. 按 `E`：`useKeyboardShortcuts.ts:224-230` → `handleToggleTonalPanel`（`App.tsx:535-537`）只翻转 `showTonalPanel`。
  3. React 在同一 commit 中卸载旧面板、挂载新面板。被聚焦的 DOM 被移除 → 浏览器把 `document.activeElement` 置为 `body`。此时**没有任何代码把焦点移入新面板**（`TonalAdjuster.tsx:211-217` 的根 `role="region"` 甚至没有 `tabIndex`）。
  4. 反向（调色面板 → 宫格）同理：`TonalAdjuster` 的关闭按钮（`TonalAdjuster.tsx:224-231`）或某个滑杆被聚焦时按 E，面板卸载后焦点回 body；宫格 listbox 不会自动接管。
  5. 触发按钮语义不足：`TopBar.tsx:299` 只有 `aria-pressed={showTonalPanel}`，没有 `aria-controls`（缺失可关联的面板 id）和 `aria-expanded`。对"展开/收起一块区域"的披露按钮，WAI-ARIA 推荐的是 `aria-expanded` + `aria-controls`。

- **影响面**：
  - 触发条件：任意一次面板互换（E / 顶部"调色"按钮 / 视口内"调色"按钮 / 调色面板内 X）。
  - 用户后果：键盘与读屏用户失去当前位置——下次 Tab 从文档最头顶端开始，需要在 40+ 个控件里重新导航回去；读屏不会播报"已进入调色面板"。鼠标用户体感弱，但键盘党（本产品主打的单手选片流）每次切面板都被打断。
  - 快捷键本身不受影响（`useKeyboardShortcuts` 监听 `window`，`body` 不是 `INPUT/TEXTAREA`），所以**功能不坏、可访问性与焦点连续性坏**。

- **修复方案**：

  **方案 A（推荐）：抽出可复用的「面板初始焦点」hook，面板互换时把焦点"转移"到新面板；不抽 Modal 的"归还"逻辑。**
  Modal（`Modal.tsx:44-61`）与面板互换是两种不同语义，不能整套复用：
  - 模态：**移入 + 归还 + Tab 陷阱**（关闭后回到触发按钮，因为触发按钮还在）。
  - 面板互换：**转移**（旧聚焦元素已被卸载，无处可还）+ **不锁 Tab**（面板不是模态，Tab 必须能继续在整页移动）。
  因此只把 Modal 的"移入"一半抽象出来即可：

  ```ts
  // src/hooks/usePanelInitialFocus.ts（新增）
  import { useEffect, type RefObject } from 'react';

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * 非模态面板的初始焦点：面板每次挂载时，若当前焦点"无主"（body / 已被卸载），
   * 就把焦点移入面板容器（或首个可交互元素）。
   * - 不做 Tab 陷阱（与 Modal 的关键差异）；
   * - 不归还焦点（互换场景没有可归还的宿主）；
   * - 若挂载时已有别的元素主动聚焦（如搜索框），不抢占。
   */
  export function usePanelInitialFocus(
    containerRef: RefObject<HTMLElement>,
    prefersContainer = true,
  ): void {
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const ae = document.activeElement;
      if (ae && ae !== document.body) return; // 已被主动聚焦，别抢
      const target = prefersContainer
        ? container
        : container.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus({ preventScroll: true });
      // 仅挂载时执行；此处有意用空依赖
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
  }
  ```

  落地：
  - `TonalAdjuster.tsx`：给根节点 `role="region"` 加 `ref`、`tabIndex={-1}`、`id="tonal-adjuster-panel"`；调用 `usePanelInitialFocus(ref, true)`（聚焦容器，让读屏播报 region 名，再 Tab 进滑杆）。**不要**默认聚焦第一个滑杆——滑杆获得焦点后方向键会被占用，反而妨碍用户先浏览。
  - `ThumbnailGrid.tsx`：给 listbox 加 `ref`；调用前加守卫——`if (searchOpen) return;`（搜索框优先，见下）。聚焦对象为 listbox（它已是 `tabIndex={0}`）。**务必与 `ThumbnailGrid.tsx:56-58` 的搜索聚焦 effect 协调**：两个 effect 同在网格组件内，`searchOpen` 时必须让搜索框赢。最稳妥是把两段合成一个：

    ```ts
    useEffect(() => {
      if (searchOpen) { searchInputRef.current?.focus(); return; } // 搜索优先
      const ae = document.activeElement;
      if (ae && ae !== document.body) return;
      listRef.current?.focus({ preventScroll: true });
    }, [searchOpen, searchFocusToken]);
    ```
  - `TopBar.tsx:289-304`、`PreviewViewport.tsx:402-408`、`BeforeAfterViewport.tsx:216-220` 三个按钮：`aria-pressed` → 改为 `aria-expanded={showTonalPanel}` 并加 `aria-controls="tonal-adjuster-panel"`（保留 `aria-pressed` 亦可，但对披露模式 `aria-expanded` 才是正解）。

  **方案 B（备选）：保留"用户意图位置"**——记录宫格中最后聚焦的格子 id，切回时用 `gridVirtualizer.scrollToIndex` + 聚焦该格。实现更重（要跨卸载保存位置），且 `ThumbnailGrid.tsx:88-96` 已经会把选中项滚入视野，收益有限。不推荐。

- **风险评估**：
  - 风险等级：**低**。
  - 可能回归的相邻状态：
    - 应用启动瞬间宫格 listbox 被自动聚焦，会不会让用户"来不及"看首屏？影响极小（listbox 非输入框，快捷键照常）。若产品不接受，可加一个 `autoFocusOnce` 门闩，仅从第二次挂载起生效。
    - `ThumbnailGrid` 每次从调色面板切回都会重新挂载，`usePanelInitialFocus` 会再次聚焦 listbox → 这正是期望行为（回到宫格焦点）。但如果将来在 `ThumbnailGrid` 中新增了会抢焦的 effect（如内联重命名输入框），需按"搜索框优先"的同一模式加守卫。
  - 需产品决策：切回宫格时聚焦 listbox（推荐）还是聚焦搜索框？
  - 回滚方式：删除 hook 与三处调用、把三个按钮的 `aria-expanded/aria-controls` 还原为 `aria-pressed`。

- **验证方法**（可执行步骤 + 可断言测试）：
  1. 手动：鼠标点一张缩略图 → 按 `E` → 断言 `document.activeElement` 落在 `#tonal-adjuster-panel` 内（修复前应为 `document.body`）。
  2. 手动：在调色面板 Tab 到"保存调色" → 按 `E` → 断言焦点回到宫格 listbox；且 Tab 能继续在整页移动（未被陷阱困住）。
  3. 可断言测试（新增 `src/components/TonalAdjuster.test.tsx` 用例）：
     ```ts
     // 修复前应失败：把焦点放在面板外的按钮上，卸载该按钮并挂载 TonalAdjuster，
     // 断言 focus 进入面板。
     it('挂载调色面板时，若焦点无主则移入面板', () => {
       document.body.innerHTML = '';
       const outside = document.createElement('button');
       outside.textContent = 'x';
       document.body.appendChild(outside);
       outside.focus();
       outside.remove();                       // 模拟互换时旧元素被卸载
       render(<TonalAdjuster tone={DEFAULT_TONE} onChange={() => {}} onSave={async () => {}} onClose={() => {}} />);
       expect(document.activeElement?.closest('#tonal-adjuster-panel')).not.toBeNull();
     });
     ```
  4. a11y 断言：`expect(toggle).toHaveAttribute('aria-expanded', 'true')` 与 `toHaveAttribute('aria-controls', 'tonal-adjuster-panel')`（修复前 `aria-controls` 为 `null`）。
  5. 反向回归：`/` 路径下焦点应在搜索框而非 listbox（复用现有 `ThumbnailGrid` 测试）。

---

### M-06 设置弹窗：本地态静默丢弃 + 握手状态行与未保存勾选矛盾

- **复核结论**：**成立**（两处均成立）。
  - 本地态：`SettingsModal.tsx:30` `useState<AppSettings|null>`；`:51-59` 打开时 `api.getSettings().then(setSettings)`。
  - 静默丢弃：`:73-85` `handleSave` 才 `api.saveSettings`；`:96-101` 取消按钮直接 `onClose`；`Modal.tsx:129-135` 的 X 也是 `onClose`；`Modal.tsx:67-72` 的 Esc 也是 `onClose`。三者都不做脏检查。
  - 矛盾：`:194` 用**本地**（可能未保存）的 `settings.lumenEnabled` 决定是否渲染状态行，但 `:200-202` 的文本来自 `lumenStatus` 属性——而该属性是 `App.tsx:87` `useLumenStatus(settings?.lumenEnabled ?? false)` 的结果，基于 App 里**已保存**的 settings。于是"本地刚勾上、尚未保存"时，勾选框已 checked，状态行却显示的是关闭态文案（=`LUMEN_UNAVAILABLE.detail`，`useLumenStatus.ts:6-12` "未启用 LUMEN RAW 引擎"）。同理 `capabilities`（`App.tsx:91-105`，仅当握手成功才探测）也是旧的，`:251-259` 的 GPU 警告用的是过期能力。

- **事实与根因**：
  - 组件内自持一份 `settings`，与 App 的 `settings`（真值）形成**两份状态**。`handleSave` 是二者唯一的同步点（经由 `onSettingsSaved` → `App.tsx:1078` `setSettings(s)`）。
  - 关闭路径完全绕过 `handleSave` → 修改蒸发，且**不提示**。
  - 状态行把"UI 门控"（本地勾选）与"数据来源"（磁盘探测）分别绑定到两份状态上，天然会打架。

- **影响面**：
  - 触发条件：在设置里改了任意字段后按 Esc / 点 X / 点「取消」。
  - 用户后果：① 用户以为改了缩略图宽度/引擎路径，实际没生效，下次打开又变回去，属于**数据丢失**类缺陷；② 勾上引擎后立刻看到"未启用 LUMEN RAW 引擎"，用户会怀疑功能坏了或反复重勾。

- **修复方案**：

  **路线 (a)（推荐）：脏检查 + 关闭确认，保留显式保存语义。**
  - 在 `SettingsModal` 内记录基线快照：`const loadedRef = useRef<AppSettings|null>(null)`，在 `:51-59` 加载成功后 `loadedRef.current = snapshot`（`api.getSettings` 返回的对象）。
  - `AppSettings` 九个字段全是原始类型（`types/index.ts:50-64`），浅比较即可：
    ```ts
    const isDirty = settings != null && loadedRef.current != null &&
      (Object.keys(settings) as (keyof AppSettings)[])
        .some((k) => settings[k] !== loadedRef.current![k]);
    ```
  - 内部包一个 `requestClose`：`if (isDirty) setConfirmOpen(true); else onClose();`，把 `Modal` 的 `onClose`、取消按钮、X 全部指向 `requestClose`（X 由 Modal 内部调用传入的 `onClose`，会自动生效）。确认交互复用既有 `ConfirmDialog`（`App.tsx:1103-1116` 已用它做更新提示），文案如"放弃未保存的更改？"。
  - 成本：约 0.5 天代码 + 0.5 天测试。**与 `handleSave` 关系**：完全保留，`handleSave` 仍是唯一写入点，`onSettingsSaved` 仍在保存成功后触发一次。
  - 副作用：`onSettingsSaved` 的调用时机不变 → `App.tsx:1078` `setSettings` 只在点保存时发生 → `useLumenStatus`（`App.tsx:87`）与 `lumenGridThumbs`（`:107-108`）的翻转时机不变，零额外副作用。
  - 注意：现有测试 `SettingsModal.test.tsx:206-214`「取消按钮不保存」在**未修改**时仍成立（脏检查为 false 直接 close），不会红。

  **路线 (b)：即改即存（每个字段 onChange 直接 `saveSettings` + `onSettingsSaved`）。**
  - 成本更高：要为文本/数字输入加 debounce（否则每敲一个字符就一次 IPC 落盘）；要移除/改造「保存设置」「取消」两个按钮（`取消`语义消失），触及 `:73-85`、`:94-111`；`handleSave` 退化为"完成/关闭"。约 1.5–2 天。
  - **特别评估（任务明确要求）——"每拨一次缩略图宽度滑杆是否触发 LUMEN 重新握手"：不会。**
    - `App.tsx:87` `useLumenStatus(settings?.lumenEnabled ?? false)` 传入的是**布尔原始值**；`useLumenStatus.ts:24-50` 的 effect 依赖是 `[enabled]`，React 按值比较。改 `thumbnailWidth` 不改变 `lumenEnabled` → **effect 不重跑 → 零握手请求**。
    - 真正会被 (b) 放大的副作用是：① **勾选 `lumenEnabled` 本身**会立即触发一次握手（1500ms 后，`useLumenStatus.ts:30-45`），用户反复勾会反复探测；② `settings.lumenGridThumbnails` 一变，`App.tsx:107-108` `lumenGridThumbs` 立刻翻转，`ThumbnailGrid.tsx:387-436` 每个格子的 effect 依赖 `lumenThumbnails`，会立即触发一轮 `get_lumen_preview_cmd`/`get_thumbnail_cmd`（视觉上被弹窗遮住，但请求真实发生）；③ 文本字段每敲一键一次 `save_settings_cmd`。
  - 产品语义：即改即存适合"开关类"设置（引擎开关、宫格渲染），不适合"路径/尺寸"类字段——后者用户常需要试错后再确认。

  **推荐**：以 **(a)** 为主。若产品希望保留"开关立即生效"的爽感，用混合方案：开关类（`lumenEnabled`/`lumenGridThumbnails`/`lumenExpectAi`）即改即存并配轻量 debounce，路径/尺寸仍走显式保存 + 脏检查。混合方案成本约 2.5 天，需产品拍板。

  **另外（独立于 a/b，必须修）**：把状态行的"门控"与"数据源"统一到同一份真值。
  - 由 App 透传一份 `savedLumenEnabled`（= App 的 `settings?.lumenEnabled`）进 `SettingsModal`。
  - 渲染规则：当 `savedLumenEnabled || settings.lumenEnabled` 时显示状态行；当 `settings.lumenEnabled !== savedLumenEnabled` 时，在文本后追加"（保存后生效）"。这样"本地勾上但引擎还没探测"不再冒出与勾选矛盾的死文案。
  - `:251-259` 的 GPU 警告同理：以 `savedLumenEnabled` 为门控（能力探测只对已保存配置有意义）。

- **风险评估**：
  - 风险等级：**低**（路线 a）／**中**（路线 b）。
  - 可能回归的相邻状态：
    - 路线 b 下，即改即存把 `App.tsx:1078` 的 `setSettings` 变成高频调用。已核对：**不会**因非 `lumenEnabled` 字段触发握手；但会因 `lumenGridThumbnails` 触发宫格缩略图重取，需实测确认抖动可接受。
    - 路线 a 下，`ConfirmDialog` 会成为第二个弹窗；要确认它与 `Modal` 的焦点/Esc 叠加无冲突（`ConfirmDialog` 是否基于 `Modal` 需在实现时确认）。
  - 需产品决策：是否允许"放弃修改"（路线 a 默认允许）；开关类是否即改即存（混合方案）。
  - 回滚方式：还原取消/X/Esc 到直接 `onClose`，删除 `loadedRef`/`isDirty`/`ConfirmDialog` 接线；状态行门控还原为本地 `settings.lumenEnabled`。

- **验证方法**：
  1. 手动：改缩略图宽度 → 按 Esc → 断言出现"放弃未保存的更改？"；选"继续编辑"则弹窗仍在且值保留，选"放弃"则关闭且再次打开恢复旧值。
  2. 手动：勾上"启用 LUMEN RAW 引擎"（此前未保存）→ 断言状态行不再显示与勾选矛盾的死文案，而是"（保存后生效）"。
  3. 可断言测试（新增用例，**修复前应失败**）：
     ```ts
     it('改动后取消：应提示而不是静默丢弃', async () => {
       const { user, onClose } = setup({ lumenEnabled: false });
       await waitFor(() => expect(engineToggle()).toBeEnabled());
       await user.click(engineToggle());                 // 变脏
       await user.click(screen.getByRole('button', { name: '取消' }));
       expect(onClose).not.toHaveBeenCalled();           // 应弹确认，而非直接关
       expect(screen.getByText(/放弃未保存/)).toBeInTheDocument();
     });

     it('未保存的引擎勾选不再与握手状态行自相矛盾', async () => {
       setup({ lumenEnabled: false }, { ...okStatus, available: false, detail: '未启用 LUMEN RAW 引擎' });
       const { user } = setup({ lumenEnabled: false }, { ...okStatus, available: false, detail: '未启用 LUMEN RAW 引擎' });
       await waitFor(() => expect(engineToggle()).toBeEnabled());
       await user.click(engineToggle());
       expect(screen.queryByText('未启用 LUMEN RAW 引擎')).toBeNull();  // 修复前会命中
     });
     ```
  4. 回归：`SettingsModal.test.tsx:206-214`「取消按钮不保存」在未改脏时仍绿。
  5. 副作用断言（若走路线 b）：改 `thumbnailWidth` 后 `invokeCount('lumen_status_cmd')` 应保持 0。

---

### M-07 宫格搜索只在宫格生效：三处（实为四处）同屏事实不一致

- **复核结论**：**成立**。命中 0 时"宫格说没有、中心视口仍显示一张、底栏仍报全集计数"三处并存；此外宫格自己的表头计数与宫格正文也可能与底栏不一致。
  - `App.tsx:185-188` `visibleGroups`（搜索收窄后）→ 只喂给宫格（`:1035`）。
  - `App.tsx:214` `currentGroup = filteredGroups[selectedIndex]`（**未**参与搜索）→ 喂给中心视口（`:959`）。
  - `App.tsx:1058-1059` `currentIndex={selectedIndex}` `totalCount={filteredGroups.length}`（**未**参与搜索）→ 底栏（`BottomBar.tsx:99-106`）。

- **事实与根因（完整调用链）**：
  1. **搜索态**：`App.tsx:62` `gridSearch`。
  2. **映射**：`App.tsx:177-183` `filteredIndices` = `filteredGroups` 中匹配 `baseName.includes(q)` 的下标数组；`:185-188` `visibleGroups = filteredIndices.map(i => filteredGroups[i])`。
  3. **宫格链路**：`visibleGroups` → `ThumbnailGrid` 的 `groups` prop（`App.tsx:1035`）→
     - `ThumbnailGrid.tsx:132` `isSearchFiltering = searchQuery.trim().length > 0`；`:133` `isEmpty = groups.length === 0`；
     - `:245-252` 当 `isEmpty` 渲染 `EmptyGridState`；`:335` 文案 `isSearchFiltering ? '没有匹配的照片' : '当前筛选下没有照片'` → **命中 0 时显示"没有匹配的照片"**。
     - 表头计数 `:139-144`：过滤中显示 `${groups.length}/${totalLoaded}`（=`0/1200`）。
  4. **中心视口链路**：`App.tsx:214` `currentGroup = filteredGroups[selectedIndex] || undefined` → `PreviewViewport` 的 `group`（`:959`）。空态判定 `viewportEmptyState`（`:894-916`）只看 `groups.length` 与 `filteredGroups.length`，**完全不看 `gridSearch`**；命中 0 时 `filteredGroups` 非空 → 返回 `"未选择照片"` 分支，最终视口正常渲染该照片。→ **中心显示一张未参与搜索的照片**。
  5. **底栏链路**：`App.tsx:1056-1063` → `BottomBar.tsx:99-106` 渲染 `${currentIndex+1} / ${totalCount}` = `501 / 1200`（`aria-label` 同源）→ **底栏按全集计数**。
  6. **关键的既有救援 effect**：`App.tsx:206-212`
     ```ts
     useEffect(() => {
       if (gridSearch.trim() && filteredIndices.length > 0) {
         setSelectedIndex((prev) => filteredIndices.includes(prev) ? prev : filteredIndices[0]);
       }
     }, [filteredIndices, gridSearch]);
     ```
     它在**命中 > 0** 时会把 `selectedIndex` 拖进结果集（于是中心视口"跟着搜索走"），但**命中 = 0** 时条件 `filteredIndices.length > 0` 为假 → 不救援 → `selectedIndex` 停留在原处 → 中心显示非匹配照片。这也解释了为什么问题是"0 命中时最刺眼"。
  7. **摘要**：同一时刻屏幕上同时出现 `宫格表头 0/1200`、`宫格正文 "没有匹配的照片"`、`中心视口 照片 #501`、`底栏 501/1200` 四个互相矛盾的事实。

- **影响面**：
  - 触发条件：打开宫格搜索输入任一匹配数为 0 的片段（或先选中靠后的照片再搜索）。
  - 用户后果：用户以为"没有匹配"，却看到大图仍在；底栏"501/1200"让人以为搜索没生效；无法判断搜索到底有没有起作用，进而怀疑筛选/选中本身。属于典型的"同屏多个真值"。

- **修复方案（两案对比）**：

  **方案 A：中心视口与底栏跟随搜索。**
  - 改动面（大）：
    - `selectedIndex` 的语义必须保持为 `filteredGroups` 的工作集下标（评级/旗标/调色/会话持久化都依赖它，见 `App.tsx:827-833` 的 `saveSession(jpgFolder, rawFolder, selectedIndex, sortOrder)`）。
    - 于是中心视口要改成派生：`currentGroup = searchActive && selectedVisibleIndex < 0 ? undefined : filteredGroups[selectedIndex]`；底栏 `currentIndex` 要换成 `selectedVisibleIndex`，`totalCount` 换成 `visibleGroups.length`。
    - `handlePrev/handleNext`（`App.tsx:414-432`）必须在搜索激活时沿 `filteredIndices` 顺序移动，否则会在非匹配照片间"跳空"。
    - `handleSelectPhoto`（`:436-450`）已经把可见下标翻译回工作集下标（`:438` `filteredIndices[visibleIndex]`），这部分可复用，但 split 模式下的 `compareIndex` 分支（`:441,445`）也要同步换成可见序。
    - `App.tsx:206-212` 的救援 effect 需要重写成"命中 0 时把中心置空"；`:198-202` 的钳制 effect 依赖 `filteredGroups.length`，与搜索集不同步，也要一起改。
    - 涉及 `selectedIndex`/`compareIndex`/`selectedVisibleIndex` 三套下标，**改动面大、回归风险高**，且会与"搜索仅用于宫格收窄"的产品初衷冲突。
  - 成本：约 2.5–3 天（含回归测试）。

  **方案 B（推荐）：保持搜索只作用于宫格，但把口径显式标注，消除"无声矛盾"。**
  - 改动面（小、局部）：
    - `BottomBar` 增加两个可选 prop：`searchActive: boolean`、`searchResultCount: number`。当 `searchActive` 时，计数器渲染为 `宫格筛选 ${searchResultCount}/${totalCount} · 当前 ${currentIndex+1}/${totalCount}`，或至少加一个"宫格筛选中"徽标，避免用户把 `501/1200` 误读成搜索后的计数。
    - 中心视口在搜索激活且当前照片不在结果集时，展示一条轻量提示（如视口角落"当前照片未参与宫格搜索"），而不是沉默。`viewportEmptyState`（`:894-916`）增加一个 `searchNoMatchNearest` 分支或仅加角标提示。
    - 命中 0 的特殊处理二选一：(i) 仍旧显示当前照片 + 角标；(ii) 命中 0 时中心也切空态。**推荐 (i)**，因为搜索是"给宫格做减法"，不该连带把用户的当前检视对象拿走；关键是**说清楚**。
    - **不需要**改 `selectedIndex` 语义、`selectedVisibleIndex`、`handleSelectPhoto`、`filteredIndices`、`App.tsx:198-212` 两个 effect。这正是 B 的核心优势。
  - 成本：约 0.5–1 天。

  **推荐 B**。理由：搜索的定义（`App.tsx:174-176` 注释）就是"对工作集做宫格层收窄"，选中/中心/底栏锚定的是**工作集**而非搜索集；A 会把"工作集"和"搜索集"两套语义揉进 `selectedIndex`，正面撞上全项目最脆弱的索引联动。B 用一句标注消除矛盾，性价比最高。

- **风险评估**：
  - 风险等级：**低**（B）／**高**（A）。
  - 可能回归的相邻状态（若误选 A）：会话恢复（`load_session_cmd`，`App.tsx:331-338`）下标错位、`saveSession` 写入搜索集下标、`compareIndex` 语义分叉、`App.tsx:198-212` 两个 effect 互相打架。
  - 需产品决策：命中 0 时中心是否保留当前照片（推荐保留 + 标注）。
  - **改动后必须同步调整的 effect**（题面要求的"哪些既有 effect 依赖要同步"）：
    - 选 B：**无需**改动 `App.tsx:198-212`、`:206-212`、`:827-833` 的任何依赖；只在渲染层加 prop。这是 B 被推荐的核心理由。
    - 选 A：必须同步改 `:198-202`（依赖从 `filteredGroups.length` 改为搜索感知的上界）、`:206-212`（改为命中 0 时置空）、`:827-833`（决定持久化的是工作集下标还是搜索集下标——这会直接改变 `.session` 文件语义，需迁移考虑）。
  - 回滚方式：移除新增 prop 与角标，恢复 `BottomBar.tsx:99-106` 原渲染。

- **验证方法**：
  1. 手动：加载 1200 张 → 选中第 501 张 → 打开搜索输入不存在的片段 → 断言：宫格显示"没有匹配的照片"，中心视口出现"当前照片未参与宫格搜索"角标，底栏显示"宫格筛选 0/1200"而非 `501 / 1200`。
  2. 可断言测试（新增，**修复前应失败**）：
     ```ts
     it('搜索命中 0 时底栏口径与宫格一致（不谎报全集计数）', async () => {
       // 铺 groups 1200 条、搜索 'zzzz-no-match'
       // 断言 BottomBar role=status 的 aria-label 含 "宫格筛选 0"
       expect(screen.getByRole('status')).toHaveAttribute(
         'aria-label', expect.stringContaining('宫格筛选 0'),
       ); // 修复前是 "当前第 501 张，共 1200 张"
     });
     ```
  3. 回归：搜索命中 > 0 时，点击结果项应仍能正确选中（`handleSelectPhoto` 的 `filteredIndices` 翻译，`App.tsx:438`），中心与宫格高亮一致。

---

### M-10 侧栏可见性与按钮按下态不同源

- **复核结论**：**成立**。`App.tsx:1014` 用 `showTonalPanel && currentGroup` 决定渲染，而按钮按下态只读 `showTonalPanel`（`:940` → `TopBar.tsx:299`）。
  - `App.tsx:214` `currentGroup = filteredGroups[selectedIndex] || undefined`；筛选变空 → `undefined`。
  - `App.tsx:1014` 条件含 `&& currentGroup` → 渲染 `ThumbnailGrid`（回落到宫格）。
  - `App.tsx:940` `showTonalPanel={showTonalPanel}`（未与 `currentGroup` 相与）→ `TopBar.tsx:292-300` 仍走 `bg-white text-black` 高亮 + `aria-pressed=true`。
  - 同类按钮还有 `PreviewViewport.tsx:408` 与 `BeforeAfterViewport.tsx:220`（分别由 `App.tsx:970`、`:988` 传 `isTonalPanelOpen={showTonalPanel}`）——它们同样不同源。

- **事实与根因**：
  - `showTonalPanel` 是**用户意图**，`currentGroup` 是**当前是否有可调对象**；可见性 = 两者与。但 UI 只把意图当成了真值，导致"按钮说开着、屏幕显示着宫格"。
  - 二次伤害：此时点按钮 → `handleToggleTonalPanel`（`:535-537`）把 `showTonalPanel` 由 true 翻 false，屏幕**无任何变化**（还是宫格），用户以为按钮失灵；再点一次才把自己"打开"到仍然不可见的状态。

- **影响面**：
  - 触发条件：调色面板开着时，切换到匹配数为 0 的筛选（如从"全部照片"切到"仅已保留"且无 pick）。
  - 用户后果：按钮状态与屏幕不一致；`E` 键第一次按下"看似无效"；读屏会播报 `aria-pressed=true` 却没有可交互的调色区域。

- **修复方案**：

  **方案 A（推荐）：派生单真值 `tonalPanelVisible`，显示层统一用它。**
  ```ts
  // App.tsx（在 currentGroup 定义之后）
  const tonalPanelVisible = showTonalPanel && !!currentGroup;
  ```
  - 渲染：`:1014` 改为 `{tonalPanelVisible ? <TonalAdjuster/> : <ThumbnailGrid/>}`。
  - 传参：`:940` `showTonalPanel={tonalPanelVisible}`、`:970`/`:988` `isTonalPanelOpen={tonalPanelVisible}`。
  - **保留 `showTonalPanel` 作为用户意图**：当筛选回到有照片时，面板**自动恢复**（意图未被清除）。这正是"单真值"的价值——`showTonalPanel` 语义单一（意图），`tonalPanelVisible` 派生自事实。
  - 处理"空态下 E 键像失灵"：`TopBar.tsx:289-304` 等三个按钮在 `!currentGroup` 时置 `disabled` 并给 `title="当前筛选没有照片"`，把 no-op 讲清楚（可由 App 透传一个 `tonalToggleDisabled={!currentGroup}`）。这一步可选但推荐。

  **方案 B：用 effect 复位 `showTonalPanel`。**
  ```ts
  useEffect(() => { if (!currentGroup) setShowTonalPanel(false); }, [currentGroup]);
  ```
  - 语义差异：一旦筛选变空，意图被**清除**；用户切回有照片的筛选后，面板**不会**自动回来，需再按 E。
  - 竞态：effect 在 commit 后运行 → 会多一帧"按钮 true、面板不显示"的中间态（虽然很短）；且把"意图"和"事实"继续混在一个 state 里，未来再加类似的空态门控还会重演。
  - 不推荐。

  **推荐 A**。产品语义上，"用户把调色面板打开着、临时切到空筛选、再切回来 → 面板回来"更符合"我还在调色"的心智；而 B 会静默丢弃意图。A 也天然是"单真值"（一处派生，处处引用），没有额外的状态写入。

- **风险评估**：
  - 风险等级：**低**。
  - 可能回归的相邻状态 / **必须同步的 effect 依赖**（题面要求）：
    - `App.tsx:648-670`（`getToneState`）与 `:724-739`（`listLumenMasks`）当前依赖 `[showTonalPanel, currentGroup?.id]` 并在体内 `if (!showTonalPanel || !currentGroup) { ... return; }`。改成派生后，**建议把依赖里的 `showTonalPanel` 换成 `tonalPanelVisible`**（保持"渲染什么、依赖什么"一致）；由于体内已同时检查 `currentGroup`，行为等价，但可避免将来误改。**切勿**出现"渲染用派生、effect 用原始、且不再检查 currentGroup"的组合。
    - 若采用 A 且保留 `showTonalPanel` 意图，`:648-670` 在筛选清空时会因 `!currentGroup` 提前返回并 `setToneDivergent(false)`——与现状一致，无回归。
  - 需产品决策：切回有照片的筛选时，面板是否自动恢复（A=是，B=否）。
  - 回滚方式：把 `tonalPanelVisible` 换回 `showTonalPanel` 用于渲染与传参。

- **验证方法**：
  1. 手动：开调色面板 → 切到无匹配的筛选 → 断言宫格显示、"调色"按钮**未**高亮（`aria-pressed/aria-expanded=false`）→ 切回"全部照片" → 断言面板自动恢复且按钮高亮。
  2. 可断言测试（新增，**修复前应失败**）：
     ```ts
     it('筛选变空时调色按钮不再保持按下态', async () => {
       // render <App/>，mock 扫描返回若干照片；按 E 开面板；切 filter 到 pick（0 匹配）
       expect(screen.getByRole('button', { name: /轻量调色预检面板/ }))
         .toHaveAttribute('aria-pressed', 'false'); // 修复前为 'true'
     });
     ```
  3. 回归：`App.tsx:648-670` 的"打开面板读回调色真值"在正常（有 currentGroup）路径仍触发一次 `get_tone_state_cmd`。

---

### 索引一致性专项复核（对应必答问题 4）

对 `filterMode × gridSearch × pinnedId` 三态组合下的 `selectedIndex` / `compareIndex` / `leftCompareGroup` / `rightCompareGroup`（`App.tsx:217-260`）逐一推演，发现 **2 个可复现缺陷**（报告未单列，归入"新发现"）：

**缺陷 1 —— 同图保护只存在于"无基准"分支，`pinnedId` 非空时可左右显示同一张。**
- `App.tsx:224-231` 的同图回退守卫只在 `if (!pinnedId)` 分支（`:233-239`）之前计算，但 `isPinnedOnLeft` 的两个分支（`:245-259`）**没有**再做同图判断。
- 可复现序列（固定右基准）：① 按 `C` 进对比；② 按 `]`（`handleTogglePinRight`，`:273-280`）把右侧钉为基准 → `pinnedId = 右侧.id`、`isPinnedOnLeft=false`；③ 反复按 `D`：`handleNext`（`:422-432`）在 `pinnedId && isPinnedOnLeft===false` 时走 else 分支移动 `selectedIndex`；④ 当 `selectedIndex` 走到基准照片所在下标时，`leftCompareGroup = filteredGroups[selectedIndex]` 与 `rightCompareGroup = pinnedGroup` 指向同一张 → **左右同为基准图**。
- 可复现序列（固定左基准）：① 按 `B` 钉左（`:305-312`，`pinnedId = filteredGroups[selectedIndex].id`）；② 在 split 下点宫格里的**同一张**（或反复按 `D` 走 `compareIndex`）→ `handleSelectPhoto`（`:441`）把 `compareIndex` 设为该下标 → `rightCompareGroup = filteredGroups[compareIndex]` 等于 `leftCompareGroup` → 同图。
- 根因：同图守卫写了两次不足以覆盖三分支，实际只覆盖了 `!pinnedId`。

**缺陷 2 —— pinned-left 模式下点击宫格不会移动高亮，候选照片在宫格中无任何视觉标记。**
- `handleSelectPhoto`（`:436-450`）在 `viewMode==='split' && pinnedId && isPinnedOnLeft` 分支里只 `setCompareIndex(idx)`（`:441`），**不动** `selectedIndex`。
- 而宫格高亮唯一来源是 `selectedVisibleIndex = filteredIndices.indexOf(selectedIndex)`（`:190-193` → `App.tsx:1036`），格子 `isSelected` 由它决定（`ThumbnailGrid.tsx:296`）。
- 于是：钉左基准后，用户点击任意缩略图，**被点的那格不高亮**（候选无标记），高亮仍停在基准格；`prev/next`（`:415-419,423-427`）走的也是 `compareIndex`，高亮同样不动。右视口在变，宫格纹丝不动 → "选中项与宫格高亮不一致"。
- `pinnedId` 只用于 `isPinned` 标记（`ThumbnailGrid.tsx:297,508-512`），无法承担"候选"标记。

**其余组合（未发现新缺陷，但记录行为）：**
- 基准图被搜索过滤掉：`App.tsx:242-243` `pinnedGroup = filteredGroups.find(g => g.id === pinnedId) || leftBase`。`find` 失败 → 回退 `leftBase`（= 当前选中）。此时 `isLeftPinned` 仍为 `true`（`:249`），左视口被 SplitCompareViewport 标为"基准"，但显示的其实是当前选中照片 → **基准被静默替换为当前照片，UI 仍宣称它是基准**。这是"基准图被过滤掉后行为异常"的确认（与缺陷 1 同源，属同一处逻辑的两种表现）。
- `filterMode` 变化会重建 `filteredGroups`，而 `selectedIndex`/`compareIndex` 是**位置**不是 id；`App.tsx:198-202` 只做上界钳制，不重定位到同一张。切筛选后"选中项跳到别的照片"是既有行为，非本次新发现，但值得产品知晓。
- `gridSearch` 命中 0 时 `App.tsx:190-193` 的 `indexOf` 返回 `-1` → 宫格无高亮；此时宫格本身为空，无可见矛盾。
- `App.tsx:206-212` 的救援 effect **只调整 `selectedIndex`，不调整 `compareIndex`**：搜索激活时右侧候选（`filteredGroups[compareIndex]`）可能是不在搜索结果里的照片，中心对比与宫格筛选不同步（可与 M-07 一并处理或在方案 B 的标注里覆盖）。

- **修复建议（缺陷 1）**：把 `App.tsx:217-260` 里 `!pinnedId` 分支的同图守卫**提升到 useMemo 顶部统一执行**：先算出 `left`/`right`，再在返回前做一次 `if (right?.id === left?.id && filteredGroups.length > 1) right = <neighbour>`；对 pinned 分支同样适用。
- **修复建议（缺陷 2）**：在 pinned-left split 模式，让宫格同时反映"候选"：给 `ThumbnailGrid` 增加 `candidateId`（= `rightCompareGroup.id`）并渲染第二重标记；或（更彻底）让 `handleSelectPhoto` 在该模式下**同时**更新 `selectedIndex`（把"选中"与"候选"统一）。二者需产品在"候选是否算选中"上拍板。
- **风险评估**：等级 **中**。`App.tsx:217-260` 与 `:436-450` 是全项目索引联动最密集处；任何改动都要回归对比、swap、pin 的四种组合与 `App.tsx:198-212` 两个 effect。
- **验证方法**：
  ```ts
  it('pin 右基准后前进到基准下标，不应左右同图', () => {
    // 构造 5 组，进 split，] 钉右，连续 onNext 直到 selectedIndex===基准下标
    expect(leftCompareGroup.id).not.toBe(rightCompareGroup.id);
  });
  it('pin 左基准时点击宫格，被点格子应获得可见标记', () => {
    // 点击后断言被点格 isSelected 或 isCandidate 为真
  });
  ```

---

## 新发现

以下问题在复核过程中发现，报告未覆盖（或仅作为"待查"提及而未定性）：

1. **M-04 覆盖面**：调色面板的触发按钮共 **3 个**（`TopBar.tsx:289-304`、`PreviewViewport.tsx:402-408`、`BeforeAfterViewport.tsx:216-220`），**全部**只有 `aria-pressed`、都缺 `aria-controls/aria-expanded`。修复必须三处同改（报告只提 TopBar）。
2. **对比同图缺陷**（缺陷 1）：`pinnedId` 非空时左右可显示同一张照片，因同图守卫只覆盖无基准分支（`App.tsx:233-239` vs `245-259`）。
3. **钉左模式候选无宫格高亮**（缺陷 2）：`handleSelectPhoto` 只更新 `compareIndex`，宫格高亮只看 `selectedIndex`，用户点击无反馈（`App.tsx:441` + `:1036`）。
4. **基准被静默替换**：基准图被筛选/搜索排除后，`App.tsx:243` 回退到当前选中，但 `isLeftPinned` 仍为 `true`（`:249`），UI 谎称其为基准。
5. **宫格表头与底栏计数双口径**：`ThumbnailGrid.tsx:139-144` 已在过滤时显示 `${visible}/${totalLoaded}`，而 `BottomBar.tsx:105` 显示 `selectedIndex+1 / filteredGroups.length`——即使命中 > 0 两者也不一致（报告只描述了 0 命中场景）。
6. **救援 effect 不覆盖 `compareIndex`**：`App.tsx:206-212` 只救 `selectedIndex`，split 对比的候选可能落在搜索结果之外。
7. **`useKeyboardShortcuts` 的 Ctrl/Cmd+F 未拦截浏览器查找的兜底**：`:79-86` 里 `/` 与 Ctrl/Cmd+F 都调 `onFocusSearch`，在浏览器内 `Ctrl+F` 仍可能同时唤起原生查找（Tauri WebView 通常无此条，风险低，仅记录）。

## 优先级与依赖

- **P0（阻塞一致性，先做）**：M-10（改动最小、却直接影响"同一状态两处显示"的定义）、M-07 方案 B（消除最刺眼的同屏矛盾）。
- **P1**：M-04（焦点连续性 + a11y 语义，影响键盘主流程）；M-06 路线 a + 状态行单真值（数据丢失类）。
- **P2**：索引一致性缺陷 1（同图）——建议紧跟 M-07 一起动 `App.tsx:217-260`，避免二次触碰索引区；缺陷 2（候选高亮）需产品先定"候选是否算选中"。
- **依赖关系**：
  - M-04 的 `aria-controls` 依赖 M-10 为面板提供稳定的 `id="tonal-adjuster-panel"` 与单真值 `tonalPanelVisible`——**建议 M-10 与 M-04 同一批提交**，否则 `aria-expanded` 会在空筛选态与面板可见性打架。
  - M-07 与索引一致性缺陷 1 都触碰对比/选中联动，若同时进行需在同一分支合并测试；**推荐 M-07 先以方案 B 落地（零索引改动），再单独处理缺陷 1**。
  - M-06 与 `useLumenStatus` 的握手节奏耦合（`onSettingsSaved` → `App.tsx:87`），若走即改即存需与 LUMEN 集成负责人确认握手可重复触发。

## 工作量估计

假设：1 名熟悉本仓库 React 状态层与 Vitest 基座的工程师；含实现 + 单测 + 手工回归，不含跨模块联调等待时间。

| 条目 | 方案 | 人天 |
|---|---|---|
| M-04 焦点 hook + 三面板 + 三按钮同改 + 测试 | A | 1.5 |
| M-06 脏检查 + 关闭确认 + 状态行单真值 | a | 1.5 |
| M-06 备选（即改即存 + debounce + 副作用测试） | b | 2.0（若采用） |
| M-07 口径标注（底栏/中心/空态提示） | B | 1.0 |
| M-10 派生 `tonalPanelVisible` + 按钮禁用态 + 测试 | A | 0.5 |
| 索引一致性缺陷 1（同图守卫上移）+ 回归矩阵 | — | 1.0 |
| 索引一致性缺陷 2（候选高亮/统一选中） | — | 1.5（需产品决策后） |
| 汇总回归（对比/pin/swap × 筛选/搜索） | — | 1.0 |

- **合计（走推荐路径：M-04 A + M-06 a + M-07 B + M-10 A + 缺陷1）**：约 **6.5 人天**。
- 若一并做缺陷 2，**+1.5 人天 → 约 8 人天**。
- 若 M-06 改走即改即存，**+0.5 人天 → 约 7 人天**。

## 复核中发现的报告偏差

1. **M-04 触发按钮不止一个**：报告只点名 `TopBar.tsx:289-304`。实际 `PreviewViewport.tsx:402-408` 与 `BeforeAfterViewport.tsx:216-220` 是同一面板的另两个入口，同样缺 `aria-controls/aria-expanded`。若不一起改，a11y 仍不完整。
2. **M-04 焦点丢失有例外**：`/` 搜索路径已被 `ThumbnailGrid.tsx:56-58` 自愈（切回宫格并聚焦搜索框）。报告"两者都无焦点接管 → 焦点退回 body"在 E 键路径成立、在 `/` 路径不成立。精确表述为"切到调色面板时丢失；切回宫格仅 `/` 路径自愈"。
3. **M-07 的时间范围偏窄**：报告把问题限定在"命中 0 张"。复核发现命中 **> 0** 时也存在口径不一致——`ThumbnailGrid.tsx:139-144` 的表头显示 `${visible}/${totalLoaded}`，而 `BottomBar.tsx:105` 显示 `selectedIndex+1/filteredGroups.length`；且中心视口因 `App.tsx:206-212` 的救援 effect 而在命中 >0 时"跟着搜索走"、命中 0 时"不跟"。即：**不一致在两种命中情况下都存在，只是形态不同**，0 命中时最刺眼。
4. **M-07 的第三个事实之外还有第四个**：除"宫格空态文案 / 中心视口照片 / 底栏计数"外，宫格表头计数（`ThumbnailGrid.tsx:142`）是第四个同屏事实。完整链路应为四处。
5. **M-10 影响的不只是 TopBar 按钮**：`PreviewViewport.tsx:408`、`BeforeAfterViewport.tsx:220` 与 TopBar 同病（均由 `App.tsx:970/988` 传原始 `showTonalPanel`）。
6. **M-06 矛盾描述可再精确一步**：状态行是否出现由**本地** `settings.lumenEnabled`（`:194`）决定，而其**文本**来自基于**已保存**配置的 `lumenStatus`。因此矛盾的具体形态是"本地刚勾上 → 状态行出现但显示的是关闭态文案"，而非泛泛的"展示已保存配置的探测结果"。
7. **必答问题 4 的答案是肯定的**：报告把"左右对比显示同一张 / 基准被过滤异常"列为"是否可能"的待查项；复核确认**两者均可复现**，根因是 `App.tsx:217-260` 的同图守卫只覆盖 `!pinnedId` 分支（详见"新发现"缺陷 1、4）。
