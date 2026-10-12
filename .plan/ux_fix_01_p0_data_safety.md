# P0 数据写入安全 —— 防止非本意的、破坏性的磁盘写入

> 轨道：t1-data-safety
> 项目：`C:/Users/VerNe/Downloads/Documents/gallery-flask`（Tauri 2.0 + React 19 + TS + Tailwind 3，gallery-culling v1.1.1）
> 性质：**只读调查**。本文件是本次唯一写入的产物，未修改任何 `src/`、`src-tauri/`、配置或 `package.json`。
> 复核方式：逐条回到源码验证，不采信原审计结论。凡与原结论不符处均标注「复核结论：不成立 / 需修正」。

---

## 复核范围与关键事实基线

已核对的相关落点（全部为真实行号）：

| 主题 | 位置 | 事实 |
|---|---|---|
| 全局快捷键 | `src/hooks/useKeyboardShortcuts.ts:54-235`（keydown）、`:237-254`（keyup） | 监听挂在 `window` 的**冒泡阶段**（`:256-257` 无第三参数） |
| 守卫 | `useKeyboardShortcuts.ts:51-52`（模态）、`:57-66`（输入框） | 只判 `[role="dialog"][aria-modal="true"]` + `INPUT/TEXTAREA/contentEditable` |
| Space 分支 | `useKeyboardShortcuts.ts:198-203` | `case ' '` → `preventDefault()` + `onPinRight()` |
| 快捷键接线 | `src/App.tsx:872-890` | `onPinRight: handleTogglePinRight` **恒有值**；`onRate/onFlag` 恒有值 |
| Pin 实现 | `src/App.tsx:273-280` | 只改内存 state（`setPinnedId`），**不落盘** |
| 评级/旗标写盘 | `src/App.tsx:463-504` | 乐观更新 state → `api.updateRatingFlag(path, ..., true)` → XMP |
| 调色保存 | `src/App.tsx:609-642` | 无 in-flight 状态；`onSave={handleSaveTone}` |
| 调色面板渲染 | `src/App.tsx:1015-1032` | **未传 `isSaving`** |
| TonalAdjuster | `src/components/TonalAdjuster.tsx:148,403,418-419` | `isSaving` 默认 `false`；`disabled={isSaving}`；`保存中…` 分支 |
| 元数据模态默认范围 | `src/components/MetadataEditorModal.tsx:43` | `useState<'current'\|'filtered'\|'all'>('all')` |
| 模态 shell | `src/components/Modal.tsx:98`（capture 捕获）、`:115-116` | 全项目 5 个模态都用它 → 均带 `role="dialog" aria-modal="true"` |
| 命令注册 | `src-tauri/src/lib.rs:27-53` | **25** 个命令（原报告称 26，见「报告偏差」） |
| 事件基础设施 | 全仓 grep `emit(`/`listen(` | **无**（与团队既知事实一致） |

> 说明：下述 `XMP 写入` 均指 `src-tauri/src/xmp.rs:314-329` 的 `write_xmp_preserving`，其内部是 `fs::read_to_string` → 拼接 → `fs::write`（截断后写）。

---

### H-01 全局快捷键守卫漏掉 `<select>`，聚焦下拉时按键会改评级/旗标并写入 XMP

- **复核结论**：**成立（核心成立；机制的表述需修正）**
  - 成立部分：`<select>` 不在守卫内是事实。`useKeyboardShortcuts.ts:59-66` 只判 `INPUT`/`TEXTAREA`/`isContentEditable`；`HTMLSelectElement.tagName === 'SELECT'` 不命中 → 直落 `switch`（`:94`）→ `x/X`(`:144-148`)、`p/P`(`:139-143`)、`1..5`(`:110-129`) 都会走到 `onRate/onFlag`（`src/App.tsx:875-876` → `handleRate/handleFlag` → `api.updateRatingFlag(..., syncXmp=true)` → `write_xmp`，落盘）。**确认会写盘。**
  - 需修正部分：原报告把「`preventDefault()` 能否阻止 `<select>` 的 type-ahead」当成数据安全的关键，**这不是本 bug 的成因**。伤害来自我们自己的 handler 在冒泡阶段同步执行；`preventDefault` 只影响浏览器原生默认动作，不影响已执行的 `onRate/onFlag`。详见下文问题 1。
  - 需修正部分：Space 子结论。「聚焦按钮上按空格会穿透触发设为基准」的准确机制是：**全局 handler 抢走空格 + 取消默认**，导致被聚焦的按钮**反而无法被空格激活**；且 `handleTogglePinRight`（`App.tsx:273-280`）只改内存、不落盘 → **不属于数据写入安全**，应归入 a11y/交互轨道（与 t5-a11y-copy 交叉）。

- **事实与根因**：

  1）守卫的实际判断（`useKeyboardShortcuts.ts:54-66`）：

  ```ts
  const handleKeyDown = (e: KeyboardEvent) => {
    if (isDialogOpen()) return;                 // :55 只认 [role="dialog"][aria-modal="true"]
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' ||
                   target.tagName === 'TEXTAREA' ||
                   target.isContentEditable)) {  // :63
      return;
    }
    // ↓ 未拦 SELECT
    switch (e.key) { case 'x': case 'X': e.preventDefault(); onFlag('reject'); break; /* ... */ }
  };
  ```

  2）未被守卫覆盖的真实落点（已逐个确认存在）：
     - `src/components/TopBar.tsx:197`（筛选 `<select>`，`aria-label="照片筛选过滤"`）
     - `src/components/TopBar.tsx:226`（排序 `<select>`）
     - `src/components/TonalAdjuster.tsx:289`（LUMEN 预设 `<select>`）
     - `src/components/TonalAdjuster.tsx:328`（AI 蒙版区域 `<select>`）

  3）为什么现有 `isDialogOpen()` 兜不住：它只在**模态对话框**存在时生效。上列 4 个 `<select>` 都不在 `[role="dialog"][aria-modal="true"]` 内。调色面板本身是 `role="region"`（`TonalAdjuster.tsx:215`），更不在守卫范围内。

  4）`role="listbox"` 的陷阱（原报告建议之一）：项目里唯一的 `role="listbox"` 是**缩略图宫格** `src/components/ThumbnailGrid.tsx:254-266`（`tabIndex={0}`，自带 `onKeyDown={handleListKeyDown}`）。其 `handleListKeyDown`（`:100-130`）只处理 `ArrowUp/Down/Home/End/PageUp/PageDown`，**不处理** `ArrowLeft/Right`、`a/d`、`1..5`、`x/p`，也**不 `stopPropagation()`** —— 也就是说宫格浏览/评级**依赖**全局 handler。若把 `[role="listbox"]` 整体加入守卫，会把宫格主交互一起废掉。**复核结论：`[role="listbox"]` 不能无条件加入守卫。**

- **影响面与触发条件**：

  - 谁能触发：任何把焦点放到上述 `<select>`（Tab 或点击）的用户。
  - 频率：**高**。「筛选/排序」是顶栏常驻控件，用户改完筛选后焦点仍在 `<select>` 上，此时最常见的动作就是按数字键评星 / 按 `X` 淘汰 → 直接改到**当前照片**并写 XMP。
  - 后果落盘：是。`handleRate/handleFlag`（`App.tsx:463-504`）无条件调用 `api.updateRatingFlag(..., true)`；后端 `update_rating_flag_cmd`（`src-tauri/src/commands.rs:59-87`）在 `sync_xmp=true` 时执行 `write_xmp` → 真实写 `.xmp`。
  - 典型误伤：用户在「筛选」下拉上按 `X` 想关闭/取消，结果把当前照片标记为 reject（写 `xmp:Rating=-1`），且无任何撤销入口（见 L-11）。
  - **附加触发路径（复核新增，同源缺陷）**：守卫同样不拦**组合键**（`e.ctrlKey/metaKey` 未参与判断），因此全局按 `Ctrl+X`（剪贴板习惯）会命中 `case 'x'` → `onFlag('reject')` **并写盘**；`Ctrl+P` → pick **并写盘**；`Ctrl+O` → `onOpenExternal`（拉起 Photoshop/外部程序）。其余组合键亦被吞：`Ctrl+A/D` → 翻页、`Ctrl+C` → 切换对比、`Ctrl+S` → 交换对比、`Ctrl+B` → 设为基准、`Ctrl+M` → 打开元数据模态。均与「用户以为在用浏览器/编辑器习惯键」的预期严重冲突；其中 **`Ctrl+X`/`Ctrl+P` 会改评级/旗标并写 XMP**。修法是附录 B 步骤 6 的「组合键让路」（`Ctrl+F` 显式豁免）。
  - 附加（逻辑推断，非本报告原文）：调色面板的 preset `<select>` 内选项是 lumen 预设名（可能为拉丁名，如 `Cinematic`），首字母键会同时触发原生 type-ahead 跳转 + 本应用评级写入；而 TopBar 两个 `<select>` 选项为中文，type-ahead 无匹配项，视觉上「毫无反应」但评级已静默改变 —— 更隐蔽。

- **修复方案**：

  **A. 守卫骨架（唯一真值 = 本文档「附录 B」，按 team-lead 裁决由 t1 持有；M-09/L-12 的规则出处为 t5-a11y-copy）**（`src/hooks/useKeyboardShortcuts.ts`）：

  采用 **双谓词** 结构（`isTextEntry` 只服务 `\` 让位；通用守卫拦截其余全部单键快捷键），完整代码见附录 B。骨架取值与 team-lead 的裁决一致，**仅一处必须修正**：

  > **对裁决初版公式 `isTextEntry(el) || tagName === 'SELECT'` 的修正（否则回归）**：
  > 该式会**漏掉 `input[type=range]` 等非文本控件**。当前实现（`useKeyboardShortcuts.ts:59-66`）守卫的是**任意 INPUT**；若按上式收窄，调色面板滑杆（`TonalAdjuster.tsx:249` 六滑杆、`:340` 蒙版去薄雾）聚焦时，`ArrowLeft/Right` 会被全局 handler 劫持去切照片，且我们 `preventDefault()` 会连带取消滑杆的原生键盘调整 → **滑杆键盘不可用**（回归）。
  > 正确写法（**唯一命名**）：通用守卫 = **`isFormControlOrEditing(el)` = 任意 `INPUT` + `TEXTAREA` + `contentEditable` + `SELECT`**。
  > 换言之：**`isTextEntry` 的“排除非文本 input”语义只用于 `\` 让位，绝不能继承到通用守卫**——这正是两处谓词必须分开、且不能合成一个的原因。

  - **绝不加入 `[role="listbox"]` / `[role="grid"]`**：项目唯一的 listbox 是缩略图宫格（`ThumbnailGrid.tsx:254-266`），其 `a/d/←→/1..5/x/p` 依赖全局 handler（`handleListKeyDown` 只处理上下/Home/End/翻页且不 `stopPropagation`）。判定维度只能是**焦点控件类型**，不能按容器角色。
  - 模态兜底沿用现有 `document.querySelector('[role="dialog"][aria-modal="true"]')`（`useKeyboardShortcuts.ts:51-52`）。

  **B. 空格**：移除 `case ' '` 的无条件 `preventDefault()`；改为 `if (e.key === ' ' && isActivatable(el)) return;`（不 `preventDefault`），使聚焦按钮/链接/可激活 role 能被空格正常激活；宫格非可激活角色 → 宫格内空格仍 = 设为基准（与 `ShortcutHelpModal` 文案一致）。`isActivatable` 需含 `input[type=checkbox|radio|button|submit|reset]`。

  **C. `\` 放行条件**：`isTextEntry(el)`（真·文本输入，排除 range 等）内让位以允许键入 Windows 路径分隔符；其余控件（含 range/SELECT/宫格/body）照常触发按住查看原片。`keydown` 与 `keyup` 的 `\` 分支**均须提到通用守卫之前**，否则 range 聚焦时松手无法复位 → `PreviewViewport.tsx:229-237` 横幅常亮；并补 `window.blur` / `visibilitychange` 兜底。

  **D. 不需要后端改动。**

  **E. 一次性交付约束**：H-01 + M-09 + L-12 共用同一个守卫实现，**必须合并为同一批改动、同一次提交**，不得拆成三个 PR。

- **风险评估**：
  - 风险等级：**中**（改动集中在单一纯函数 hook；但它是全局键盘行为，回归面广）。
  - 可能回归的地方：
    1) 宫格（`role="listbox"`）—— 必须验证 `a/d/←/→/1..5/x/p` 仍生效；
    2) 中文输入法搜索（`ThumbnailGrid` 顶栏搜索框，`:208` `onKeyDown={handleSearchKeyDown}`）—— input 标签已挡，但 `e.isComposing` 是额外保险；
    3) 调色面板滑杆（`<input type="range">`，`TonalAdjuster.tsx:249`）—— 现由 `INPUT` 命中守卫；改造后 `input` 选择器仍命中，箭头键继续调滑杆（现状即如此，属期望）；
    4) 顶栏筛选/排序下拉 —— 改后应恢复「数字键/字母键不评级」。
  - 需产品决策的点：在**非输入类**元素上（如焦点在 `body`、打开着调色面板但焦点不在控件上），是否仍允许 `1..5` 评星？建议**允许**（保持单手选片效率），仅对「焦点在控件上」收窄。
  - 回滚方式：单文件改动，`git revert` 或还原该 hook 即可，无数据迁移。

- **验证方法**（可执行）：

  手工步骤（需在 Tauri/WebView2 中执行，因涉及原生控件行为）：
  1. 打开一个含 RW2/JPG 的文件夹；选一张照片，记录当前星级与 `.xmp` 内容（`xmp:Rating`）。
  2. Tab 到顶栏「照片筛选过滤」下拉，确认焦点在该 `<select>` 上；按 `X`。
  3. 期望（修复后）：照片旗标/星级**不变**，`.xmp` 不变；下拉自身无跳转。
  4. 期望（修复前应失败）：照片被标记 reject → `.xmp` 出现 `xmp:Rating>-1`。
  5. 同法验证 `P`、`1..5`；再对调色面板的 preset/蒙版下拉重复一次。
  6. Tab 到任一按钮（如调色面板「自动」），按空格：修复后该按钮被激活、且**不**切换基准；修复前该按钮无反应、基准被切换。

  可断言的测试用例（建议加 `src/hooks/__tests__/useKeyboardShortcuts.test.ts`，用 jsdom + `@testing-library`）：
  - `given select focused, when keydown '1', then onRate not called`
  - `given select focused, when keydown 'x', then onFlag not called`
  - `given button focused, when keydown ' ', then onPinRight not called and event not defaultPrevented`（即 t5 的空格条目；team-lead 已将其编号由 L-10 改为 **L-12**）
  - `given grid div[role=listbox] focused, when keydown '1', then onRate called`（防回归）
  - `given grid div[role=listbox] focused, when keydown ' ', then onPinRight called`（宫格内空格仍 = 设为基准，与 ShortcutHelpModal 文案一致）
  - `given input[type=range] focused, when keydown 'ArrowLeft', then onPrev not called and range default not prevented`
  - `given input[type=range] focused, when keydown '\\', then onHoldOriginalStart called`（即 t5 的 M-09：`\` 在 range 上生效，不被 isFormControlOrEditing 拦掉）
  - `given input[type=text] focused, when keydown '\\', then onHoldOriginalStart not called and default not prevented`（路径框可键入 `\`）
  - `given range hold active, when keyup '\\'`, then `onHoldOriginalEnd called`（M-09：keyup 分支须在通用守卫之前，否则卡在查看原片）
  - `given element in [role=dialog][aria-modal=true], when keydown '3', then onRate not called`（现有能力，防回归）
  - `given metaKey held, when keydown 'x', then onFlag not called`
  - **修复前应失败**的用例：第 1、2、3、4′、6、7、8、9 条（当前实现均不通过）；第 5 条为防回归用例（当前应通过、修复后仍须通过）。

- **原报告问题 1 的精确机制结论**（DOM/浏览器层）：

  1) **事件顺序（规范确定）**：按键产生 `keydown`（`composed: true, bubbles: true, cancelable: true`），`target` = 当前聚焦的 `<select>`；传播顺序为「捕获（window→…→select）→ 目标阶段 → 冒泡（select→…→window）」。
  2) **我们的 handler 在冒泡阶段运行**（`useKeyboardShortcuts.ts:256` 无第三参数，故 `useCapture=false`）。它晚于 `<select>` 自身的 JS 监听器（本例没有），但**早于该事件的默认动作**——默认动作一律在事件传播结束后由 UA 执行。
  3) **因此，只要焦点是 `<select>`，`case '1'..'5'/'x'/'p'` 必然同步执行 `onRate/onFlag`，评级/旗标必然改变并落盘。** 这一点与「type-ahead 是否被阻止」无关，是**规范级确定**的（`e.target` 是 `HTMLSelectElement`，`tagName==='SELECT'` 不命中守卫）。
  4) **`preventDefault()` 能否阻止 `<select>` 原生 type-ahead**：`preventDefault()` 只能取消**该事件**关联的默认动作。`<select>` 的「跳到以该字符开头的下一项」在 Blink 中走的是**字符输入路径**（`keypress`/`beforeinput`，对 `keydown` 而言是**另一个独立事件**），并非 `keydown` 的默认动作。取消一个事件的默认动作不会取消另一个事件的默认动作。所以：
     - **规范层面**：不能保证 `keydown` 的 `preventDefault()` 会抑制 type-ahead；
     - **实现层面**：该抑制与否是 UA 相关行为，**本机未实测**（当前环境无运行中的 WebView2，无法断言 Chromium 具体结果）。→ 标注 **未验证**。
     - **但对本 bug 无影响**：即便抑制成功，数据仍被改写；即便抑制失败，只是「下拉跳了一下 + 数据被改写」两件事同时发生。修复必须靠**守卫 early-return**，不能靠 `preventDefault`。
  5) **聚焦 `<button>` 按空格的完整链路**：
     - `keydown(' ')` 在 button 上派发 → 冒泡到 window → `case ' '`（`:198-203`）→ `onPinRight` 恒有值（`App.tsx:882`）→ **执行 `preventDefault()` 且执行 `handleTogglePinRight()`**（仅内存态）。
     - 「按钮的激活」在规范中定义在 **`keyup`**（空格激活 button 走 keyup 合成 click；回车走 keydown）。`keydown` 对 button 本身**没有**默认动作。
     - `keyup(' ')` → 我们的 `handleKeyUp`（`:237-254`）只处理 `\` → 什么都不做 → 默认动作 = 在 button 上合成 `click` → 触发该 button 的 `onClick`。
     - **关键**：规范让 `keyup` 的按钮激活**检查 keydown 是否被取消**；被取消则**不**合成 click。因此实际结果大概率是：**被聚焦按钮的空格激活被我们取消掉了，而全局的「设为基准」被执行** —— 即「空格被快捷键抢走，按钮反而失效」。这一条同样建议以手工用例（上面第 6 步）在 WebView2 中确认最终表现；无论 click 是否被取消，**用户都无法用空格正常激活该按钮**，这是确定的 a11y 缺陷。
     - 与数据的关联：`handleTogglePinRight`（`App.tsx:273-280`）只 `setPinnedId/setIsPinnedOnLeft`，**不写盘** → 非 P0 数据问题。

---

### H-02 `TonalAdjuster` 未收到 `isSaving`，保存按钮在写入期间可连点

- **复核结论**：**部分成立**
  - 成立：`App.tsx:1015-1032` 渲染 `<TonalAdjuster>` 时确实**没有** `isSaving` prop；而 `TonalAdjuster.tsx:148` `isSaving = false` 默认值 + `:403` `disabled={isSaving}` + `:418-419` `保存中…` 三元分支 → **`保存中…` 是死分支，按钮永不 disabled**。`handleSaveTone`（`App.tsx:609-642`）也没有任何 in-flight 状态。连点两次 → 两次 `api.applyTone` → 后端 `apply_tone_cmd` 执行两次。**成立。**
  - **不成立（需修正）**：「重复写 XMP + LUMEN 工程」中的「**重复 LUMEN 编辑态叠加**」不成立。`apply_tone_cmd`（`commands.rs:727-741`）写入的是 `lumen::tone_to_recipe(&tone, true)`，而该函数是**最终值语义**（`lumen.rs:595-619`，注释明确「**最终值**语义」），`apply_edits` 是**覆盖式赋值**而非累加/堆叠。两次施加同一 `tone` 的结果等价于一次。**不存在可观测的「编辑态叠加」。**
  - **需补充（原报告未提及）**：真正的并发风险是 **XMP 的 `fs::write` 截断竞态**（见下），而非 LUMEN 叠加。

- **事实与根因**：

  - 前端：`handleSaveTone` 无 loading 状态；`isSaving` 未接线；`onApplyPreset`/`onApplyMask` 路径同样没有互斥（`handleApplyLumenMask` 用 `isMasking` 只锁蒙版按钮，`handleSaveClick` 无锁）。
  - 后端 `apply_tone_cmd`（`commands.rs:687-757`）：
    1) **XMP 写入发生在 async 命令体内、`spawn_blocking` 之外**（`:696-704`）：`update_xmp_tone` → `read_xmp_full`（读）→ `write_xmp_full` → `write_xmp_preserving` → `fs::write`（**截断 + 写**，`xmp.rs:326`）。两次并发调用 → 两个 `fs::write` 交错 → **可能出现被截断/半写的 `.xmp`**（低概率、真实、不可接受）。
    2) **LUMEN 侧**：`apply_recipe` 与 `save_project` 各自通过 `call_session_tool` 持有 `LumenRuntime.inner` 的 `Mutex`（`lumen.rs:950-953, 983-992`）。两次并发命令可交错为 `A.apply, B.apply, A.save, B.save`；但因值相同且幂等，最终态一致。
    3) **无幂等键、无去重、无按文件串行**。
  - 同类问题也存在于 `update_rating_flag_cmd`（`commands.rs:59-87`）：XMP 写无串行；LUMEN 推送经同一 `Mutex`，且评级/旗标为**绝对值**语义（`lumen.rs:1079-1099`）→ 幂等。
  - `batch_update_metadata_cmd`（`commands.rs:98-117`）：单线程 `for` 顺序执行，天然无并发；`update_xmp_metadata`（`xmp.rs:400-418`）读全量再覆盖镜头三件套 → 重复执行幂等。

- **影响面与触发条件**：
  - 触发：双击「保存调色」，或在一次异步写入未完成时再点一次（无任何视觉反馈表明「正在写」）。
  - 落盘：是。XMP 必写；引擎可用时另写 `.lumen` 工程。
  - 后果分级：LUMEN 幂等 → 无叠加；XMP 两次写同值 → 通常 last-writer-wins 无差异，**但存在截断竞态**（会破坏侧边栏，属于最坏情形）；此外白跑一次 ~秒级引擎往返。
  - 触发频率：低-中（依赖用户双击习惯；按钮也无 disabled 反馈）。

- **修复方案**（推荐「前端 + 后端」双保险）：

  **前端（必做，最小改动）**：
  - `App.tsx`：新增 `const [isSavingTone, setIsSavingTone] = useState(false);`
  - `handleSaveTone` 用 `try/finally` 包裹 `setIsSavingTone(true)` / `false`（注意 `finally` 必须复位）。
  - 渲染处补 `isSaving={isSavingTone}`（`App.tsx:1015-1032`）。
  - 建议同时把「重入」挡在 handler 入口：`if (isSavingTone) return;`（防键盘/程序化重入）。
  - `TonalAdjuster.tsx` 无需改（`:403/:418` 逻辑已正确，一旦拿到真实 `isSaving` 即生效）。

  **后端（建议做，低成本，消除真实损坏风险）**：
  - **XMP 原子写**：把 `write_xmp_preserving`（`xmp.rs:314-329`）的 `fs::write(&xmp_path, merged)` 改为「写同目录临时文件 → `fs::rename` 覆盖」：
    ```rust
    let tmp = xmp_path.with_extension("xmp.tmp-<pid>");
    fs::write(&tmp, &merged).map_err(...)?;
    fs::rename(&tmp, &xmp_path).map_err(...)?; // Windows 下 rust std 会替换已存在目标
    ```
    这样并发写不再产生半写文件（最后一次 rename 胜出，内容完整）。
  - **可选：按文件 in-flight 串行**（若还需防「不同 UI 入口并发改同一文件」）：在 `AppState` 增加 `Mutex<HashSet<PathBuf>>`（或每路径锁），进入 `apply_tone_cmd` 前占位，重复进入直接返回「正在写入」。**不建议**在该层做幂等键（无实际收益，因为值语义已幂等）。
  - **不建议**为「LUMEN 叠加」加任何保护——该风险不存在。

- **风险评估**：
  - 风险等级：**中**（前端低风险；后端原子写触及核心写盘路径，需回归全部 XMP 单测）。
  - 可能回归：`xmp.rs` 全部单测（尤其 `write_preserves_lightroom_namespaces`、`write_fresh_document_is_byte_identical_to_legacy`、`write_replaces_only_our_block_not_others`）——原子写不改变字节内容，应全绿；但需确认临时文件命名不会与用户真实文件冲突（用 `.tmp-<pid>` 后缀并确保不匹配 `get_xmp_path` 规则）。
  - 需产品决策：保存期间按钮文案用「保存中…」即可，是否需要 spinner 或禁掉整个面板（建议只禁按钮，保持可继续调滑杆）。
  - 回滚：前端改动单文件可 revert；后端原子写 revert 后行为回到现状（仍有截断竞态）。

- **验证方法**：
  - 手工：打开调色面板 → 快速双击「保存调色」→ 观察按钮是否立即变为「保存中…」并 disabled；观察 DevTools/日志中 `apply_tone_cmd` 是否只执行一次；保存后 `read_xmp_full` 能正常解析（无截断）。
  - 自动化（Rust，`xmp.rs` 测试模块内新增）：
    - `concurrent_writes_never_produce_truncated_xmp`：起 8 个线程对同一 `img` 调 `write_xmp`，全部返回后断言文件可被 `read_xmp_full` 解析且 `xmp:Rating` 完整。
    - 修复前应失败：当前 `fs::write` 直接覆盖，高并发下有概率读到截断内容（若本地跑不出可降低到「至少断言写入后文件以 `<?xpacket end="w"?>` 结尾」，现状在窗口期会失败）。
  - 前端组件测试：`handleSaveTone` 为 pending Promise 时按钮 `disabled === true`、文案为「保存中…」；**修复前应失败**（当前 `isSaving` 恒 false）。

---

### H-03 元数据批量同步默认范围 = 全部扫描照片

- **复核结论**：**成立**
  - `MetadataEditorModal.tsx:43`：`useState<'current' | 'filtered' | 'all'>('all')`。
  - `:61-68`：`all` → `allGroups`；`:255` 选项文案「全部扫描照片」+ 计数 `allGroups.length`。
  - `:144-150`：确认按钮 `onClick={handleSave}`，`:146` `disabled={isSaving || targetGroups.length === 0}` —— **没有任何二次确认**。
  - `handleSave`（`:80-120`）：把 `targetGroups` 的路径全部送 `api.batchUpdateMetadata` → 后端 `batch_update_metadata_cmd`（`commands.rs:98-117`）逐张 `update_xmp_metadata`（`xmp.rs:400-418`）写盘。
  - 与 UI 自身文案**自相矛盾**：`:292-295` 蓝框写「保存后将自动为**所选**照片写入…」，默认却是最大集合。

- **「全部扫描照片」是否主用例？**（读注释/文案判断）
  - 模态标题（`:126`）「手动镜头元数据编辑与批量同步」——**「批量」是明确意图**，所以「有批量入口」是对的。
  - 但**批量的自然粒度是「当前工作集/筛选集」，不是「整个已扫描目录」**：应用核心是逐文件夹选片，`filteredGroups` 才是「我正在看的那批」；`allGroups` = 全部已扫描照片，可能横跨多机位/多次拍摄、镜头各不相同。
  - 关键证据：`:292-295` 的说明文案用的是「**所选**照片」，`:131-137` footer 只显示数量不显示范围名 → 用户对「all」的破坏半径缺乏提示。
  - **附加风险点（原报告未提）**：`:52-59` 打开时会用 `currentGroup.exif` **预填**三个字段（`lensModel/focalLength/aperture`）。若当前照片本身带 EXIF 镜头信息，则**无需用户输入**，校验 `:85-92` 直接通过 → 打开模态后**直接点确认**就会把当前照片的镜头信息覆盖到全部照片上。当当前照片 EXIF 无镜头（手动镜头常见）时字段为空、校验会拦住，必须用户手输。
  - 结论：把默认从 `all` 改小**不会伤害「批量」工作流**（批量意图由用户显式选择范围表达），却能消除「一次误点重写上万份侧边栏」。

- **影响面与触发条件**：
  - 触发：打开模态（M 键或底栏入口）→ 输入/预填镜头信息 → 保持默认 → 点「确认并批量同步」。
  - 后果落盘：是，且是**批量**。后果内容：覆盖每张照片 XMP 中的 `aux:Lens/aux:LensModel/exif:FocalLength/exif:FNumber`（`build_our_description`，`xmp.rs:162-197`）。
  - **破坏范围的准确界定（原报告可再精确）**：`update_xmp_metadata` 先 `read_xmp_full` 再只覆盖镜头三件套 → **星级/旗标/调色不会被抹掉**；第三方命名空间也保留。被破坏的是**每张照片各自的镜头元数据**（例如本应各异的焦段/光圈被统一成本次输入值），对同类手动镜头的整批是「正确」，对混合批是「污染」。因此定性为「批量误改」而非「数据销毁」；但上万份侧边栏的重写本身也不可逆（无备份）。

- **修复方案**（默认最小影响面 + 显式扩大）：

  1) **默认收窄**：`MetadataEditorModal.tsx:43` 默认改为 `'filtered'`。
     - 理由：与模态「批量」意图一致，且等于「我屏幕上正在看的这批」；无筛选时 `filteredGroups === allGroups`，行为与 'all' 相同但语义更安全（有筛选时自动收窄）。
     - 若产品更保守，可改为 `'current'`（最小爆炸半径），但会牺牲「批量」意图；**建议 'filtered'**。
  2) **范围在 UI 上「可读」**：把范围名显式写进 footer 与按钮，而不是只有数字。
     - footer 现有（`:131-137`）：「将更新 **[N]** 张照片」→ 改为：「将更新 **[范围名] 的 [N] 张照片**」（范围名：`仅当前照片`/`当前筛选集`/`全部扫描照片`）。
  3) **`all` 需要二次确认（显式扩大）**：
     - 文案：选项「全部扫描照片」的说明行补一句「含未被筛选显示的照片」。
     - 选中 `all` 时，确认按钮文案由「确认并批量同步」改为 `同步到全部 N 张…`，点击后进入二次确认（不直接写盘）。
     - 二次确认措辞建议：
       - 标题：`将覆盖全部 N 张照片的镜头信息`
       - 正文：`这会重写全部 N 个 XMP 侧边栏里的镜头型号 / 焦段 / 光圈，且无法撤销。建议改用「当前筛选集」缩小范围。`
       - 确认按钮：`仍然覆盖全部 N 张`；取消按钮：`返回`
     - 附加护栏（建议）：当 `allGroups.length` 超过阈值（如 100）时**强制**进入二次确认；其余情况二次确认仍建议保留。
  4) **写入后反馈**：`:114` 的成功文案 `已写入 N 张照片的 XMP 侧边栏。` 建议带上范围名，便于事后核对。
  5) **不做**：不需要新增后端命令；`batch_update_metadata_cmd` 保持顺序执行即可（幂等，无并发）。

- **风险评估**：
  - 风险等级：**低**（纯前端交互/文案）。
  - 可能回归：改变默认值会改变「打开即全量」的老用户习惯 —— 但这是**期望的方向**（更安全）；需在 release notes 注明。`syncScope` 是组件 state 且**不随 `isOpen` 重置**（`:52-59` 的 effect 只重置三个输入与 `saveResult`）→ 用户上一次选过的范围会保留，属可接受（且优于每次回落到 all）。
  - 需产品决策：默认 `filtered` vs `current`；二次确认是否对所有 `all` 强制（建议是）。
  - 回滚：单文件 revert。

- **验证方法**：
  - 手工：扫描两个镜头各异的文件夹 → 打开模态 → **不选范围直接确认** → 断言只有「当前筛选集」的照片被改；切到「全部扫描照片」→ 确认前**必须**出现二次确认且文案含实际张数。
  - 组件测试（`@testing-library/react`）：
    - `defaults sync scope to filtered`
    - `choosing all does not call batchUpdateMetadata until second confirmation`
    - `confirm button label includes the effective count`
    - **修复前应失败**：第 1、2 条（当前默认 'all'、且无二次确认）。

---

### L-11 星级/旗标即时写 XMP，无撤销路径

- **复核结论**：**成立**
  - `App.tsx:463-504`：`handleRate/handleFlag` 先乐观 `setGroups`，再 `await api.updateRatingFlag(path, ..., true)`。**无撤销栈**。
  - `useKeyboardShortcuts.ts:130-136`：`0`/`u`/`U` → `onRate(0)` + `onFlag('none')`，是**清零**，**不是撤销**（原报告判断正确）。
  - 全仓 grep `undo|Undo` 无匹配；`Ctrl+Z` 无任何绑定。

- **撤销可行性（核心问题）**：

  - **写入前的旧值是否可得？—— 完全可得，且无需后端改动。**
    - 前端：`handleRate(rating, targetGroup)` 在 `setGroups` **之前**拿到 `targetGroup`，其 `targetGroup.rating` 与 `targetGroup.flag` 即**旧值**；`targetPath = targetGroup.raw?.path || targetGroup.jpg?.path`（`App.tsx:466, 490`）。所以 `{ id, path, rating: targetGroup.rating, flag: targetGroup.flag }` 现成可快照。
    - 后端（备选，不必要）：`write_xmp`（`xmp.rs:361-376`）本就是 `read_xmp_full` → 改 → 写，旧值在 `meta` 中存在但被丢弃，未回传。**不建议**为此改后端。
  - **单步撤销 vs 多步撤销成本**：
    - 单步（推荐先做）：`useRef<{ id; path; rating; flag } | null>(null)`，在 `handleRate/handleFlag` 里于**首次变更前**写入快照（同一照片连续操作时是否覆盖由产品定），绑定 `Ctrl/Cmd+Z` → 用 `api.updateRatingFlag(path, snap.rating, snap.flag, true)` + 回填 `setGroups`。改动量约 30-40 行。注意 `Ctrl/Cmd+Z` 需与 H-01 的「组合键让路」配合（否则可能被 `case 'z'` 之外的规则放过 —— 目前无 `z` 分支，安全）。
    - 多步（建议延后）：有界栈（如 20 条）+ **同一照片连续按键合并（coalescing）**，否则连按 `1..5` 会灌满栈；还需在「换文件夹 / 重新扫描 / 筛选变化」时失效栈。改动量约 80-120 行，且需明确撤销与「乐观更新 + 后台写盘」交错时的语义。
    - 结论：**单步撤销性价比高、可即刻落地；多步撤销应作为独立小迭代**。
  - **XMP 写入失败时的状态回滚 —— 现有语义（必须写清）**：
    - `reportRatingFlagError`（`App.tsx:452-460`）**不回滚 UI**：它只 `console.error` + `toast.error`，文案明确是「界面上的星级和保留/淘汰**仍然有效**，但不会同步到 Lightroom」。也就是说失败后 **UI = 新值、磁盘 = 旧值**，二者**已知地对齐失败（diverged）**。
    - 对撤销的影响：
      - 若前一次写盘失败，磁盘仍是旧值；此时用户点撤销，我们把 UI 恢复成快照（= 当时的旧值）并再写一次磁盘（内容与磁盘现值相同）→ **收敛一致**，无害（多一次写入）。
      - 因此撤销实现应**照常发起写入**（不要因「上次失败」跳过），并对撤销写入自身的失败复用 `reportRatingFlagError` 的同一语义（保持「界面有效、未同步」的既有承诺，不要引入第二种错误语义）。
      - 需注意：`handleRate`/`handleFlag` 目前**无重复值短路**（即使评级未变也会写盘，`App.tsx:475-476`），撤销写入时同样会产生一次真实写盘 —— 可接受，但若做多步撤销需靠 coalescing 控制写入频率。

- **影响面与触发条件**：
  - 触发：误按 `x`/`p`/`0`/`1..5`（尤其在 H-01 场景下：焦点在下拉上但仍触发）→ 立即写盘且无路可退。
  - 落盘：是。后果是「单张照片的评级/旗标被改且无法在应用内还原」，只能手改 `.xmp` 或去 Lightroom 改回。

- **修复方案**：
  - 新增 `src/hooks/useRatingUndo.ts`（或直接并入 App.tsx）：维护单步快照 + `undo()`。
  - `useKeyboardShortcuts` 增加 `onUndo?: () => void`，绑定 `Ctrl/Cmd+Z`（放在组合键处理区内，确保不与单键冲突）。
  - App 侧在 `handleRate/handleFlag` 成功/失败**两种**路径都写快照（写快照应在乐观更新之前）；`undo()` 调 `api.updateRatingFlag` 并回填 state，失败走 `reportRatingFlagError`。
  - 可选 UI：底栏或状态栏给一个「撤销」按钮（便于鼠标用户），并显示"已撤销：星级 3 → 2"之类的 toast。
  - **不做**：不新增后端命令；不引入多步栈（留给后续迭代）。

- **风险评估**：
  - 风险等级：**低-中**（新增能力，不改现有写盘路径；风险集中在键盘绑定冲突与快照时机）。
  - 可能回归：`Ctrl/Cmd+Z` 在输入框内应保持原生「撤销输入」（靠 H-01 的 `input/textarea/contenteditable` 守卫保证）；撤销与「换照片」的时序（快照绑定到具体 `id`，切图后撤销应作用于快照照片，建议切图即清空或明确作用于原照片）。
  - 需产品决策：撤销是否跨照片（建议：单步、仅最近一张）；是否给鼠标入口。
  - 回滚：新增文件删除 + hook 接线还原即可。

- **验证方法**：
  - 手工：给照片打 1 星 → 记 `.xmp` 的 `xmp:Rating` → 按 `Ctrl+Z` → 断言 UI 与 `.xmp` 都回到原值；再测「写盘失败后撤销」（可临时把文件设为只读）→ 断言 UI 收敛且 toast 语义与既有 `reportRatingFlagError` 一致。
  - 测试：
    - `single rating change is undoable and restores xmp`
    - `undo after a failed write still restores local state without new error semantics`
    - `ctrl+z inside a text input performs native undo, not photo undo`（防 H-01 联动的回归）
    - **修复前应失败**：第 1 条（当前无撤销）。

---

## 优先级与依赖

**本轨道内部排序（按「防止不可逆落盘」的收益/成本比）**：

1. **H-01 守卫修复**（P0，最高）：单文件、成本最低、直接阻断「无声改评级/旗标并写盘」的高频误触。
2. **H-03 默认范围 + 二次确认**（P0）：单文件，阻断「一次误点重写全库侧边栏」的**批量**不可逆写入。
3. **H-02 前端 `isSaving`**（P0，必做）+ **后端 XMP 原子写**（P0，建议）：消除连点与截断竞态。
4. **L-11 单步撤销**（P1）：为前三者兜底（即便守卫仍有漏网，用户可一键回退）。

**交付批次约束（team-lead 裁决，必须遵守）**：

- **H-01（t1）+ M-09（t5）+ L-12（t5，空格条目；原编号 L-10 经 team-lead 改号）必须合并为同一批改动、同一次提交** —— 三者共用同一个 `handleKeyDown`/`handleKeyUp` 守卫实现（`src/hooks/useKeyboardShortcuts.ts`），拆成多个 PR = 必回归。骨架由 t1 定稿（见「附录 B」），t5 的规则出处为 `ux_fix_05_a11y_copy.md` 的 M-09/L-12。
- 归属：键盘守卫的 **唯一 owner = t1-data-safety**；t5-a11y-copy 为规则贡献方，不另出第二套骨架。

**与其他轨道的交叉点**：

- **t5-a11y-copy**：H-01 的「空格劫持」本质是键盘可达性缺陷（聚焦按钮无法用空格激活）→ 已并入同一守卫实现（`isActivatable` + 空格让位），并需补齐 `window.blur`/`visibilitychange` 兜底（t5 侧）。`[role="listbox"]` 豁免策略、`e.isComposing` 处理、`[role="dialog"]` 守卫边界同样在本轨道出方案、t5 复核语义。
- **t4-long-task**：H-02 的「保存中…」需要 in-flight 状态；若 t4 引入后端 `emit` 进度事件，保存按钮的 disabled 建议**同时**接 `isSaving` prop（前端互斥）与进度事件（后端真值），避免两套状态打架。另：t4 的 L-10（导出同路径覆盖）已由本轨道做数据安全定性背书（见附录 A），定级 HIGH、并入 P0。
- **t3-state-truth**：H-02 涉及的「XMP 与 LUMEN 双真值」分歧提示（`TonalAdjuster.tsx:268-277`）与 H-03 的「写入后前端回填」同属状态一致性；`reportRatingFlagError` 的「UI 有效 / 磁盘未同步」语义需与 t3 统一，避免撤销/回滚引入第二种真相模型。
- **t2-viewports**：无直接依赖（本次全部落在数据写入路径）。
- **t6-test-infra**：H-01/L-11 的「修复前应失败」用例需要 jsdom + `@testing-library` 与 `window` 键事件桩；H-02 的并发写测试需要 Rust 多线程测试基建。两条都需要 t6 提供/确认测试脚手架。

## 工作量估计

单位：人天。假设：单人熟悉该仓库、已具备本报告结论、无需重新调研；不含产品评审与 code review 等待时间。

| 条目 | 前端 | 后端 | 测试 | 小计 |
|---|---|---|---|---|
| H-01 守卫重构（含 `[role=dialog]` 回归、组合键、IME、宫格豁免）+ 单测 | 0.5 | 0 | 0.5 | **1.0** |
| H-02 前端 `isSaving`/重入短路 + 单测 | 0.25 | 0 | 0.25 | **0.5** |
| H-02 后端 XMP 原子写 + 并发写测试 | 0 | 0.25 | 0.25 | **0.5** |
| H-03 默认 `filtered` + 文案 + `all` 二次确认 + 测试 | 0.5 | 0 | 0.25 | **0.75** |
| L-11 单步撤销（hook + 键位 + toast + 测试） | 0.5 | 0 | 0.25 | **0.75** |
| 手工验收（WebView2 原生控件行为、`<select>` type-ahead 实测） | — | — | 0.25 | **0.25** |
| **合计** | | | | **≈ 3.75 人天** |

最小可交付（仅做 P0 必做项）：H-01 + H-03 + H-02 前端 + 测试 ≈ **2.5 人天**。

## 复核中发现的报告偏差

1. **H-01 的机制定性偏差（重要）**：原报告以「`preventDefault()` 能否阻止 `<select>` 的 type-ahead」为数据安全的关键论据。实际上**无论 type-ahead 是否被阻止，数据都会被改写**——伤害来自我们自己的 handler 在冒泡阶段同步执行（规范确定），而非浏览器的下拉默认动作。`preventDefault` 与数据安全**无关**，修复必须靠守卫 early-return。
2. **H-01 的 Space 子结论定性偏差**：「穿透触发设为基准」的准确表述应为「**空格被全局快捷键抢走，导致被聚焦按钮无法被空格激活，同时触发设为基准**」；且 `handleTogglePinRight`（`App.tsx:273-280`）**只改内存、不落盘** → 不属 P0 数据安全，应归 a11y/交互轨道。
3. **H-01 建议项「把 `[role="listbox"]` 加入守卫」会导致回归**：项目唯一的 listbox 是缩略图宫格（`ThumbnailGrid.tsx:254-266`），其导航/评级**依赖**全局 handler（`handleListKeyDown` 不 `stopPropagation`，只处理上下/翻页）。加进守卫会废掉宫格主交互。**建议不采纳该条**。
4. **H-02「重复 LUMEN 编辑态叠加」不成立**：`tone_to_recipe` 是最终值语义、`apply_edits` 覆盖式赋值（`lumen.rs:595-619`），二次施加同一 tone 幂等。原报告未指出的**真实**并发风险是 XMP `fs::write` 的**截断竞态**（`xmp.rs:326`）。
5. **H-03 的破坏范围可再精确**：`update_xmp_metadata` 只覆盖镜头三件套（`xmp.rs:400-418`），**星级/旗标/调色与第三方命名空间均保留**；定性应为「批量误改镜头元数据」而非「销毁侧边栏」。另补一处原报告未提的风险：模态打开时会用当前照片 EXIF **预填**字段（`:52-59`），当 EXIF 有镜头信息时**无需输入即可通过校验并提交**。
6. **命令数量**：`lib.rs:27-53` 实际注册 **25** 条命令（原报告称 26）。与本轨道结论无影响，仅记录。
7. **未验证项**：WebView2/Chromium 中 `<select>` type-ahead 是否可被 `keydown.preventDefault()` 抑制、以及按钮空格激活是否被 keydown 取消所抑制——**本机无运行中的 WebView2，未实测**，已在 H-01 标注并给出验收步骤。此外本报告未运行 `npx tsc --noEmit`（与本次结论无关，仅为声明）。
8. **裁决文本初版公式有误，已由 t1 复核修正（记录备查）**：team-lead 的 H-01 守卫裁决初版引用了通用守卫公式 `isTextEntry(el) || tagName === 'SELECT'`（临时名 `isValueOrText`）。该式**漏掉 `input[type=range]`**，会导致调色面板滑杆（`TonalAdjuster.tsx:249`、`:340`）聚焦时箭头键被全局 handler 劫持、并取消滑杆原生键盘调整 —— 而**当前实现（`useKeyboardShortcuts.ts:59-66` 守卫任意 INPUT）本无此问题**，属该公式**新引入的回归**。经 t1 实证复核后修正为 **`isFormControlOrEditing` = 任意 INPUT + TEXTAREA + contentEditable + SELECT**，team-lead 已确认「通用守卫必须含 `input[type=range]`，以 t1 修正版为准」。**只保留 `isFormControlOrEditing` 一个谓词名**（`isValueOrText` 废弃，避免后人误以为存在两套逻辑）；`isTextEntry` 语义收窄为「仅文本录入类」，只服务 `\` 让位，且**已确认其包含 TEXTAREA 与 contentEditable**（附录 B 代码 `:415/:416`），`\` 不会在这两者上穿透。
9. **原报告遗漏的同源触发路径（复核新增）**：H-01 只描述了「聚焦 `<select>`」一条路径，未提及守卫同样**不拦组合键** —— `Ctrl+X` 命中 `case 'x'` → reject **并写盘**、`Ctrl+P` → pick **并写盘**、`Ctrl+O` → 拉起外部程序（`useKeyboardShortcuts.ts:139-155`，判断里无 `ctrlKey/metaKey`）。已补入 H-01「影响面与触发条件」，并在骨架步骤 6 加了「组合键让路」硬化（`Ctrl+F` 显式豁免）。

---

## 附录 A：交叉轨道验证 —— 导出「源 == 目标」路径可能销毁原图（来自 t4-long-task 的 L-10）

> 由 t4-long-task 交叉提请，本节为 t1 独立复核的补充结论。归属仍属 t4 的导出轨道，此处仅记录**数据安全维度的定性**，避免它被降级处理。

- **复核结论**：**成立，且严重度应上调为 HIGH（潜在不可逆原图销毁）**
  - 代码事实：`src-tauri/src/commands.rs:210-247` 的 `batch_export_cmd`：
    - `:218` `if fs::copy(src, dst).is_ok() { exported += 1; }`（JPG）
    - `:233` 同样的 `fs::copy(src, dst)`（RAW）
    - `dst = target_dir.join(src.file_name())`（`:217, :232`）→ **若 `target_dir` 就是源文件所在目录，`dst == src`（同一个文件）。**
  - 前端**无任何校验**：`src/components/BatchExportModal.tsx:73-85` 只校验「目标非空 / 有候选 / 至少选了一类」，**完全不比较目标目录与源目录**。
  - **权威依据（已核实，非推测）**：Rust 标准库 `std::fs::copy` 文档原文 ——
    > "This function will overwrite the contents of `to`. **Note that if `from` and `to` both point to the same file, then the file will likely get truncated by this operation.**"
    > （平台行为：Unix 为 `open(to, O_WRONLY|O_CREAT|O_TRUNC)`；Windows 对应 `CopyFileEx`。）
    - 因此**至少存在「原文件被截断为 0 字节」这一条致命路径**：Unix 系（O_TRUNC）行为确定；Windows 因走 `CopyFileEx`，同源同目标的具体结果可能是「截断」或「ERROR_SHARING_VIOLATION 直接失败」，**两者都不可接受**。
  - **未实机验证**：本次受只读约束（唯一可写文件为本报告），未能跑 `fs::copy(p, p)` 的真机实验，**Windows 下究竟走「截断」还是「共享冲突失败」尚未实测** → 标注 **未验证**。但无论哪种，都不该发生，且**不依赖具体分支也应当修复**。
  - **原报告定级偏低**：t4 记「至少 MEDIUM、可能 HIGH」；基于 Rust 文档的截断告警，若真发生即**用户原始 RAW/JPG 被清空**（不可逆、无备份）→ 应按下限 **HIGH** 处理。

- **同一处代码的两个附加缺陷（复核中一并确认）**：
  1) **静默失败**：`fs::copy(...).is_ok()` 丢弃了 `Err`（`commands.rs:218, :233`）。若因共享冲突/权限失败，用户只会看到「已导出 0 个文件」而**没有任何失败原因**。
  2) **静默覆盖**：未用 `COPY_FILE_FAIL_IF_EXISTS`，也未做存在性检查 → 目标目录里**同名但在业务上无关的文件会被静默覆盖**（t4 报告的对应结论成立）。

- **修复方案（后端为准，必须做）**：
  - 在 `batch_export_cmd` 进入复制循环前做**集合自检**：对 `target_folder` 与每个 `src` 的父目录分别 `std::fs::canonicalize`（Windows 下同时归一化大小写/短名/`..`/尾斜杠），若任一 `src` 的规范化父目录 == 规范化目标目录 → **整体拒绝**并返回明确中文错误（「导出目标不能是源照片所在目录」），而不是逐文件失败。
  - 前端 `BatchExportModal.tsx` 同步加一层即时校验 + 禁用「开始导出」+ 就地提示（不能只靠后端报错）。
  - 顺带修掉静默失败：把 `is_ok()` 换成显式错误累计，导出结束回报「成功 N / 失败 M 及原因」。
  - 覆盖保护：默认改为「目标已存在同名文件 → 跳过并计入报告」，或至少显式询问。

- **验证方法**：
  - 手工：选一个有照片的文件夹 → 把导出目标设成**同一个文件夹** → 期望（修复后）立即被拒；期望（修复前应失败）出现原图被清空或导出静默失败。**执行此用例前必须先备份，因为可能造成不可逆损坏。**
  - 自动化（Rust）：`export_rejects_target_equal_to_source_dir` —— 构造同目录场景，断言命令返回 `Err` 且**源文件字节数不变**；**修复前应失败**（当前会返回 `Ok(0)` 或损坏文件）。

---

## 附录 B：H-01 守卫最终骨架（定稿 —— 唯一真值；owner = t1，规则含 t5 的 M-09/L-12）

> **裁决**：team-lead 裁定键盘守卫的**唯一 owner = t1-data-safety**，t5-a11y-copy 为规则贡献方（M-09/L-12 出处：`ux_fix_05_a11y_copy.md`；其中空格条目原编号 L-10，经 team-lead 改号为 L-12），不另出第二套骨架。H-01 + M-09 + L-12 **必须合并为同一批改动、同一次提交**。
>
> **本附录是裁决所指骨架的定稿实现**。通用守卫**唯一命名**为 `isFormControlOrEditing`；裁决初版公式（`isTextEntry || SELECT`，已废弃）经 t1 实证复核后修正为含 range，原因见下方及「复核中发现的报告偏差」第 8 条。差异源于有实证的回归（`input[type=range]`），非风格分歧。

> 背景：`useKeyboardShortcuts.ts` 的 `handleKeyDown`/`handleKeyUp` 是**同一个函数**，H-01（本轨道）与 t5 的 M-09/L-12 都在改它。为避免两套守卫互相覆盖，**由 t1 定稿骨架，t5 只在其上确认 `\` 语义与空格特例**（`\` 提前分支、空格特例已包含在下述骨架内，t5 无需再改本函数）。

**与裁决初版的唯一差异（必须采纳）**：裁决初版给出的通用守卫公式为 `isTextEntry(el) || tagName === 'SELECT'`（“`isValueOrText`”一名已废弃，不再使用）。该式**漏掉 `input[type=range]`**（`isTextEntry` 的定义排除了 range）→ 调色滑杆（`TonalAdjuster.tsx:249`、`:340`）聚焦时箭头键被全局 handler 劫持、且 `preventDefault` 连带取消滑杆原生调整 → **滑杆键盘不可用（回归 vs 当前实现）**。本附录把通用守卫定为 **`isFormControlOrEditing` = 任意 INPUT + TEXTAREA + contentEditable + SELECT**（唯一命名），`isTextEntry` 的“排除非文本 input”语义**只用于 `\` 让位**。除此之外，骨架与裁决完全一致（双谓词结构、空格规则、不加入 listbox、模态兜底、`\` 提前）。

> **`isTextEntry` 覆盖范围确认（team-lead 要求）**：`TEXTAREA`（代码 `:415`）与 `contentEditable`（代码 `:416`）**均包含在 `isTextEntry` 内**，故 `\` 不会在这两者上穿透。

**最终判定顺序（顺序本身就是正确性的一部分）**：

```ts
// —— 谓词 ——
const isTextEntry = (el: Element | null): boolean => {
  if (!el) return false;
  const t = el.tagName;
  if (t === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (t !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  // 真·文本输入（可键入 '\'）；排除 range/checkbox/radio/button/submit/reset/file/color/image
  return !['range','checkbox','radio','button','submit','reset','file','color','image'].includes(type);
};

// 通用守卫：保留"任意 INPUT"（含 range/checkbox/radio —— 否则滑杆箭头键会被劫持，回归）
// 并新增 SELECT（H-01 核心修复）
const isFormControlOrEditing = (el: Element | null): boolean =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
           (el as HTMLElement).isContentEditable || el.tagName === 'SELECT');

// 可被空格/回车"激活"的元素（空格必须让位，不得 preventDefault）
const isActivatable = (el: Element | null): boolean =>
  !!el && (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' || el.tagName === 'A' ||
           (el.tagName === 'INPUT' && ['checkbox','radio','button','submit','reset'].includes((el as HTMLInputElement).type)) ||
           ['button','radio','checkbox','switch','tab','menuitem','option','link']
             .includes(el.getAttribute('role') ?? ''));

// —— handleKeyDown ——
const handleKeyDown = (e: KeyboardEvent) => {
  if (isDialogOpen()) return;                             // 1 模态兜底（现有）
  if (e.isComposing || e.keyCode === 229) return;         // 2 中文 IME 合成期

  const el = e.target as Element | null;

  // 3 '\' 按住查看原片：**提前到通用守卫之前**；文本输入内让位（可键入 Windows 路径分隔符）
  if (e.key === '\\') {
    if (isTextEntry(el)) return;
    if (!e.repeat && onHoldOriginalStart) { e.preventDefault(); onHoldOriginalStart(); }
    return;
  }

  // 4 值/文本控件不劫持任何单键快捷键（INPUT 任意 type / TEXTAREA / contentEditable / SELECT）
  if (isFormControlOrEditing(el)) return;

  // 5 空格交给可激活元素（不 preventDefault，保证按钮能被空格激活）
  if (e.key === ' ' && isActivatable(el)) return;

  // 6 组合键让路（Ctrl/Cmd+F 的 '/' 分支保留在其后，沿用现有结构）
  if ((e.ctrlKey || e.metaKey || e.altKey) && e.key !== 'f') return;

  // 7 …原有 '/'、'?' 分支与 switch 原样保留…
};

// —— handleKeyUp：'\' 也必须提到通用守卫之前 ——
const handleKeyUp = (e: KeyboardEvent) => {
  if (isDialogOpen()) return;
  const el = e.target as Element | null;
  if (e.key === '\\') {                                   // '\' 提前
    if (isTextEntry(el)) return;                          // 与 keydown 对称，避免误复位
    e.preventDefault();
    onHoldOriginalEnd?.();
    return;
  }
  if (isFormControlOrEditing(el)) return;
};
```

**与 t5 方案的两处必要修正（务必采纳，否则引入回归）**：
1. t5 初版公式为通用守卫 = `isTextEntry || SELECT`（该临时名已废弃，不保留）。**这会漏掉 `input[type=range]` 等非文本控件** → 调色面板滑杆（`TonalAdjuster.tsx:249`）聚焦时箭头键不再调滑杆，反而被全局 handler 劫持去切照片（且 `preventDefault` 会连滑杆原生调整一起取消）。**通用守卫唯一命名为 `isFormControlOrEditing` = 任意 INPUT + TEXTAREA + contentEditable + SELECT**，`isTextEntry` 仅用于 `\` 的让位判断。
2. `isActivatable` 需**补上 `input[type=checkbox|radio|button|submit|reset]`**（它们也由空格激活）；t5 原清单只列了标签 `BUTTON/A/SUMMARY` 与 role 集合。当前项目这些 input 只出现在模态内（已被 `isDialogOpen` 挡住），但谓词应自洽，避免后续新增表单重蹈空格劫持。

**其余保持 t5 结论**：宫格 `[role="listbox"]` 不在 `isActivatable`，故空格在宫格内仍 = 设为基准（与 `ShortcutHelpModal` 文案一致）；`\` 的 `window.blur`/`visibilitychange` 兜底（避免松手未复位、`PreviewViewport.tsx:229-237` 横幅常亮）归 t5/App 侧实现，不在本骨架内。

**已知行为（有意保留，非本骨架引入）**：
- **`Ctrl/Cmd+F` 在焦点位于 input/select 时不生效**：步骤 4（`isFormControlOrEditing`）在 `Ctrl+F` 分支之前 early-return。这与**现有实现完全一致**（`useKeyboardShortcuts.ts:57-66` 的 INPUT 守卫本就在 `:79-86` 的 `/`、`Ctrl+F` 分支之前，`input[type=range]` 亦然）。属**行为延续而非新回归**，本骨架**有意不改**（保持最小改动；若产品希望 `Ctrl+F` 全局可达，需把 `Ctrl+F` 分支显式提到步骤 4 之前，届时需产品确认「在输入框内也抢走 Ctrl+F」）。
- **组合键让路（步骤 6）是本骨架的**新增硬化**，非现状**：现有代码**不**拦组合键，因此 `Ctrl+X` 会触发 `onFlag('reject')`、`Ctrl+P` 触发 `onFlag('pick')`、`Ctrl+O` 触发打开外部程序等（误触并写盘）。步骤 6 `if ((e.ctrlKey||e.metaKey||e.altKey) && e.key !== 'f') return;` 是**有意新增的保护**，`Ctrl+F` 显式豁免以保留原 `:79-86` 的搜索聚焦能力。
**归属**：骨架与谓词由 t1 定稿；`\` 语义、空格 a11y 文案、blur 兜底由 t5 复核。
