# 轨道 05 —— 可访问性收尾与文案真值（说到的必须做到）

> 只读调查，未修改任何现有文件。所有结论均回源码验证（附真实 `path:line`）。
> 标准依据：WCAG 2.1（1.4.3 / 1.4.6 / 1.4.11 / 2.4.7 / 4.1.3）、WAI-ARIA 1.2 + APG
> （Listbox / Dialog 模式）。
> 本文中凡涉及“报告称 X”的，均指团队下发的初始问题描述。

---

## 总览：严重度复核表

| 编号 | 报告严重度 | 复核结论 | 修正后严重度 | 一句话 |
|---|---|---|---|---|
| M-08 | MEDIUM | **成立** | MEDIUM | 三个视口滚轮均为中心缩放，文案承诺“以指针为中心”不实 |
| M-09 | MEDIUM | **成立（影响面更大）** | MEDIUM | `\` 被输入守卫拦住；同守卫连带废掉所有单键快捷键，且 `keyup` 侧同样被拦 → 状态卡死 |
| M-12 | MEDIUM | **成立** | LOW→MEDIUM | 蒙版去薄雾滑杆未复用 `.tone-slider`，无数字读数 |
| M-13 | MEDIUM | **成立（数值需修正）** | LOW | 对比度实测 **3.77:1**（非 3.45:1），仍低于 AA 4.5:1 |
| M-14 | MEDIUM | **成立** | MEDIUM | 筛选下拉无每档计数，与导出弹窗不一致 |
| M-15 | MEDIUM | **成立** | MEDIUM | lumen 路径无「浏览」、无「测试连接」，且状态永不刷新 |
| L-04 | LOW | 成立 | LOW | 缩放读数 `aria-live` 逐次播报 |
| L-05 | LOW | 成立 | LOW | 纯 `div` 上的 `aria-label` 对 AT 无效 |
| L-06 | LOW | 成立 | LOW | 虚拟化 listbox 缺 `aria-setsize`/`aria-posinset` |
| L-07 | LOW | 成立 | LOW | 容器 `aria-activedescendant` 与单元格可点击聚焦混用 |
| L-08 | LOW | 成立 | LOW | 调色面板无法 Esc 关闭，与所有弹窗约定不一致 |
| L-09 | LOW | **不成立** | — | 图例在滚动容器之外且 `shrink-0`，不会滚出视野（详见偏差节） |
| L-12 | — | 新增 | LOW | 空格被全局快捷键劫持，焦点在按钮上时无法用空格激活（原误记 L-10，经 t4 提请改号；与 t1 H-01 同批修复） |

---

### M-08 滚轮文案承诺“以指针为中心缩放”，实现却是中心缩放

- **复核结论**：**成立**。
  `ShortcutHelpModal.tsx:55` 写「滚轮 · 以指针为中心缩放」；
  `PreviewViewport.tsx:104-111`、`BeforeAfterViewport.tsx:76-79`、
  `SplitCompareViewport.tsx:89-102` 三个 `handleWheel` **只改 `scale`，完全不读取光标坐标**；
  三个 `<img>` 的 `transform` 均为
  `translate(pos.x, pos.y) scale(scale)` + `origin-center`
  （`PreviewViewport.tsx:221-227`、`BeforeAfterViewport.tsx:255-260`、
  `SplitCompareViewport.tsx:195-200`）。
  `transform-origin: center` 使缩放锚点固定在**画面中心**，与指针位置无关。

- **事实与根因**：
  ```ts
  // PreviewViewport.tsx:104-111
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);   // ← 只改 scale
  }, [zoomBy]);
  ```
  ```tsx
  // PreviewViewport.tsx:221-227
  style={{
    transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
    transition: isDragging ? 'none' : 'transform 0.08s ease-out',
    filter: toneFilter,
  }}
  className="max-h-full max-w-full object-contain pointer-events-none origin-center"
  ```
  根因：命中缩放（pointer-anchored zoom）需要在改 `scale` 的同时**按光标位置反算 `pos`**，
  现实现没有这一步。

- **影响面**：全部用鼠标的用户。摄影选片是“放大看细节”的高频场景，命中光标是
  Lightroom / Photo Mechanic / FastRawViewer 的既有肌肉记忆；中心缩放在放大到 400%+ 时
  需要反复“缩放 + 拖拽”两步才能定位到目标，直接拖慢选片节奏。键盘用户不受影响。

- **修复方案**：

  **路线 A —— 真正实现命中缩放（推荐）**

  数学模型（现模型：`s(p) = O + pos + scale·(p − O)`，`O` = 视口中心，因 `<img>` 由 flex 居中，
  故 `transform-origin` 恰好落在容器中心）：

  设光标 client 坐标 `m`，`d = m − O`，`k = scale′ / scale`。要求光标下的图像点缩放前后落在同一屏幕位置：

  ```
  缩放前： m = O + pos + scale·(p − O)        ⇒  p − O = (m − O − pos) / scale
  缩放后： m = O + pos′ + scale′·(p − O)
  ⇒ pos′ = (m − O) − scale′·(m − O − pos)/scale
         = d − k·(d − pos)
         = k·pos + (1 − k)·d          ……… 命中缩放公式
  ```

  ```ts
  // 建议抽成 utils/zoom.ts，三处共用
  export function zoomAtPoint(
    e: { clientX: number; clientY: number; deltaY: number },
    rect: DOMRect,
    scale: number,
    pos: { x: number; y: number },
    { min, max, step }: { min: number; max: number; step: number },
  ) {
    const next = Math.min(Math.max(scale * (e.deltaY < 0 ? step : 1 / step), min), max);
    const k = next / scale;                       // 触顶/触底时 k===1，pos 不变
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    return { scale: next, pos: { x: k * pos.x + (1 - k) * dx, y: k * pos.y + (1 - k) * dy } };
  }
  ```
  调用点：`const rect = containerRef.current!.getBoundingClientRect();`
  - `PreviewViewport`：已有 `containerRef`（`PreviewViewport.tsx:83`）。
  - `BeforeAfterViewport`：滚轮挂在**双栏父容器**上（`:238-248`），两颗 `<img>` 各自居中于**自己的半栏**，
    需为左右栏各取一次 `rect`；光标只可能在其中一栏，用该栏 `rect` 算出的 `d` 同时写两份 `pos`（保持联动）。
  - `SplitCompareViewport`：滚轮本就按栏分发（`:181` `onWheel={(e) => handleWheel(isLeft, e)}`），
    在 `renderPane` 内取本栏 `rect` 即可，`syncZoom` 时两栏写同一组 `scale/pos`。

  **路线 B —— 改文案为“以画面中心缩放”**

  仅改 `ShortcutHelpModal.tsx:55` 一行：`{ keys: '滚轮', label: '缩放画面（以画面中心）' }`。

  | 维度 | 路线 A（实现命中缩放） | 路线 B（改文案） |
  |---|---|---|
  | 成本 | 3 个组件 + 1 个 helper + 单测，约 1.0–1.5 人天 | 1 行 |
  | 收益 | 找回标准看图器手感；减少“缩放+拖拽”两步操作 | 文案与实现一致，零收益 |
  | 风险 | 与现有 pan 模型交互；对比视图双栏 `rect` 易写错；`transition` 会让每次滚轮产生 80ms 追赶动画 | 无 |
  | 可回滚 | 撤销 helper 调用即可 | 改回一行 |

  **推荐：路线 A**。理由：(1) 现模型已经天然满足公式前提（图像居中、`origin-center`），
  改动是**纯增量**，不动拖拽（`handleMouseDown` 的 `dragStart = client − position` 在新 `pos` 下依旧自洽）；
  (2) 这是用户对“看图器”的强预期，改文案等于把产品做残；(3) 若担心风险可先只在
  `PreviewViewport`（主力检视视图）落地，对比视图保留中心缩放并同步改文案——但**不要**只改文案就收工。

  **附带的独立缺陷（建议一并修）**：React 17+ 把根节点的 `wheel` 监听注册为 **passive**，
  因此 `onWheel` 里的 `e.preventDefault()`（三处均有）在浏览器中不生效（控制台会有
  “Unable to preventDefault inside passive event listener”）。桌面 Tauri 下 `body` 是
  `overflow-hidden`，暂无可见后果，但**若未来加页面级滚动会立刻出问题**。建议改为
  `useEffect` + `containerRef.current.addEventListener('wheel', handler, { passive: false })`
  （或在 A 路线 landing 时一并处理）。此项需实机确认（本次为只读调查，未运行）。

- **风险评估**：
  - **风险等级：中**。主要回归面在“缩放与拖拽的相互作用”与“对比视图双栏联动”。
  - 需要产品决策：**对比视图（BeforeAfter / SplitCompare）是否也做命中缩放**，还是在对比态保留中心缩放。
    对比态两栏共用一组 `pos`，“以指针为中心”在非悬停栏语义上不成立——建议定义成“以**悬停栏**为准、两栏同步”。
  - 触顶/触底：`k === 1` 时公式退化为恒等，无需特判。
  - 回滚：helper 是纯函数，去掉调用即回到中心缩放，无状态迁移。

- **验证方法**：
  1. 单测 `zoomAtPoint`：给定 `rect`、`scale`、`pos`，断言“光标处的图像坐标缩放前后一致”
     （即 `(m − O − pos)/scale` 在前后相等），覆盖 `k===1`、`pos≠0` 两类。
  2. 手工：放大到 400%，把光标放在画面左上三分之一处滚轮——该处内容应保持在指针下不漂移；
     光标在画面正中时，行为应与旧版一致（此时 `d≈0` ⇒ `pos′≈k·pos`）。
  3. 键盘等价路径：`+ / - / 重置` 按钮（`PreviewViewport.tsx:366-398`）不应受影响。

---

### M-09 按住 `\` 查看原片被输入守卫拦住，恰好是“在看滑杆效果时”失效

- **复核结论**：**成立**，且命中面比描述更广。
  `useKeyboardShortcuts.ts:57-66` 的守卫在 `\` 分支（`:69-75`）**之前**返回；
  而守卫条件覆盖**所有** `INPUT`，`<input type="range">` 也是 `INPUT` →
  `TonalAdjuster.tsx:249-261` 六根滑杆只要被点过（获得焦点），`\` 就彻底失效。
  更隐蔽的是 **`keyup` 侧同样有守卫**（`:240-248`）：即使松手也无法复位 → **状态卡死**。

- **事实与根因**：
  ```ts
  // useKeyboardShortcuts.ts:57-66  —— 守卫拦在所有快捷键之前
  const target = e.target as HTMLElement;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;                                // ← range 滑杆也在这里被挡
  }
  // :69-75
  if (e.key === '\\') { if (!e.repeat && onHoldOriginalStart) { e.preventDefault(); onHoldOriginalStart(); } return; }
  ```
  ```ts
  // :240-248  keyup 侧同样守卫 → 松开 \ 也无法触发 onHoldOriginalEnd
  ```

- **影响面**：**核心用户路径**。调色面板打开、用户正在拖滑杆判断参数好坏时，
  最需要的“按住 `\` 对比原片”恰好失灵；且鼠标点在滑杆上后焦点留在 range 上，
  此后所有 `1-5 / P / X` 等单键快捷键**也一并失效**（同一守卫），这是被低估的连带影响。
  纯键盘用户如果 Tab 到滑杆同理。

- **修复方案（本节只定义规则；守卫骨架见 `ux_fix_01_p0_data_safety.md` 的 H-01）**：
  > **键盘守卫的唯一 owner 是 t1-data-safety**——谓词定义、选择器清单、early-return 位置
  > 一律以 H-01 的**附录 B（守卫最终骨架，定稿）**为唯一真值，本轨**不另行维护第二套骨架**，
  > 也不复述谓词公式。判定维度是**焦点控件的类型**，不按容器角色。
  > （口径提醒：通用守卫 = **任意 `INPUT`（含 `range`/`checkbox`/`radio` 等全部类型）+
  > `TEXTAREA` + `contentEditable` + `SELECT`**；`isTextEntry`（仅文本录入类）**只**服务 `\` 让位。
  > 若通用守卫漏掉 `input[type=range]`，调色滑杆聚焦时方向键会被劫持去翻页并 `preventDefault`
  > → **滑杆键盘不可用**，属新增回归。）

  本轨负责定义以下**规则条目**（供 H-01 的骨架实现时引用）：

  **规则 R1 — `\` 的放行条件**：`\` 是**按住型、非破坏性、不参与文本输入语义**的快捷键
  （只调 `onHoldOriginalStart/End`，不向控件写值）→ **只在「文本录入类」控件里让位**
  （即 `isTextEntry` 判定为真的元素：文本类 `INPUT` / `TEXTAREA` / `contentEditable`）。
  为什么只有文本录入类才让位：`\` 在 JPG/RAW 路径框（`TopBar.tsx:113-121,140-148`）里是合法的
  Windows 路径分隔符，在搜索框、镜头元数据框里也是合法字符。

  与通用守卫的关系（关键，勿混淆）：`\` 的分支必须排在通用守卫**之前**。因此
  **`range` 属于「通用守卫通吃放行」的对象**（通用守卫对任意 `INPUT` early-return，避免滑杆聚焦时
  方向键被劫持），**但 `\` 仍在 `range` 上生效**——因为 `\` 先于通用守卫处理，且 `range` 不是
  文本录入类控件。两者叠加的正确结果是：滑杆聚焦时 `←/→` 只调滑杆值（通用守卫生效）、
  `\` 仍能按住看原片（R1 生效）。

  **规则 R2 — `\` 的复位与失焦兜底**：`keyup` 的 `\` 分支同样排在守卫**之前**且**无条件**调用
  `onHoldOriginalEnd`（否则 range 聚焦时松手无法复位）；并补 `window.blur` / `visibilitychange`
  兜底（见下方边界 3）。

  **规则 R3 — 空格让位可激活元素（L-12）**：见下方「空格劫持」小节。

  应用 R1/R2 后要处理的边界（逐条）：
  1. **焦点在文本输入框**：`\` 仍应让位（用户要输入路径/字符）→ 保持现行为。
     焦点在 `range` / checkbox / `select` / 按钮上：放行。这正好覆盖“拖滑杆判断参数”的场景。
  2. **`keyup` 必须无条件复位**：把 `\` 的 `keyup` 分支提到守卫**之前**
     （松开按键永远不是“文本输入”，放行无副作用），修复 range 聚焦时的“卡死”。
  3. **`keyup` 丢失兜底**：用户按住 `\` 时 Alt-Tab / 窗口失焦 / 组件卸载 → 永远收不到 `keyup`。
     `PreviewViewport.tsx:229-237` 已有一条常驻提示
     “正在查看原片（松开 \ 键恢复）”，卡死时该横幅会常亮。必须补：
     ```ts
     useEffect(() => {
       const end = () => onHoldOriginalEnd?.();
       window.addEventListener('blur', end);
       document.addEventListener('visibilitychange', () => { if (document.hidden) end(); });
       return () => { window.removeEventListener('blur', end); /* + visibilitychange */ };
     }, [onHoldOriginalEnd]);
     ```
  4. **`\` 的默认行为**：在 range 上按 `\` 无默认行为，`preventDefault()` 无副作用；
     在文本框里因为被守卫拦下，也不会误吞字符。
  5. 注意 `e.repeat` 已有判断（`:70`），长按不会重复触发 `onHoldOriginalStart`；但**仍需**
     `keyup` 无条件复位配合，否则长按后一次失焦即卡死。

  **硬约束（H-01 的守卫骨架落笔前必须满足，否则回归）**：
  - ❌ **守卫绝不能加入 `[role="listbox"]`**。全项目唯一的 listbox 是缩略图宫格
    （`ThumbnailGrid.tsx:254-266`，`tabIndex=0`），它的 `a`/`d`/`←`/`→`/`1..5`/`x`/`p`
    **正是依赖全局 handler** 触发的；`handleListKeyDown`（`:100-130`）只处理
    Up/Down/Home/End/PageUp/PageDown 且**不** `stopPropagation`。把 listbox 加进守卫
    会**废掉宫格主交互**。若 H-01 按 `INPUT/TEXTAREA/SELECT/contentEditable` 的**标签/类型**
    判定，则天然不触碰任何 `role` 容器（含 listbox）——**不要**“顺手”改成按 role 一刀切。
  - ✅ 判定维度只能是**焦点控件的类型**，不得按容器角色（`role="region"`/面板判断无效）。

  **连带缺陷：空格被全局快捷键劫持（应并入本轨道，定性为 a11y 缺陷而非数据安全）**
  `useKeyboardShortcuts.ts:198-203` 的 `case ' '` **无条件** `preventDefault()` 并执行
  `onPinRight`；而 `App.tsx:882` 处 `onPinRight`（`handleTogglePinRight`，`App.tsx:273-280`）
  恒有值。真实后果不是“数据风险”，而是：**焦点落在可激活元素（按钮/链接等）上时，
  空格无法激活该元素**（全局 handler 的 `preventDefault` 发生在冒泡阶段、早于默认动作，
  抑制了 `click` 合成），反而触发了全局“设为基准 (右)”。**规则**（实现取 t1 附录 B 的
  `isActivatable`）：空格在**可激活元素**上必须让位（`return`，不 `preventDefault`），
  让原生激活发生。`isActivatable` 覆盖：
  - 标签：`BUTTON` / `SUMMARY` / `A`；
  - `INPUT` 且 `type ∈ {checkbox, radio, button, submit, reset}`（这些同样被空格激活）；
  - `role ∈ {button, radio, checkbox, switch, tab, menuitem, option, link}`。

  注意：宫格容器是 `role="listbox"`（**不在**可激活角色表内），故宫格内空格仍等于“设为基准”，
  与 `ShortcutHelpModal` 的 “`]` 或 空格 → 将右图设为新基准” 文案一致，不冲突。

- **风险评估**：
  - **风险等级：低**。改动集中在守卫的判定范围、`\` 的处理顺序与空格特例，语义边界清晰。
  - 主要回归点：(a) 通用守卫覆盖**任意 `INPUT`**（含 `type=number`、`type=range`）→ 聚焦这些控件时
    字母/数字类快捷键不响应；这**既是预期也是必须**——若漏掉 `range`，调色滑杆聚焦时方向键会被
    全局 handler 劫持去翻页并 `preventDefault`，**滑杆键盘不可用**（属新增可访问性回归，t1 已指出）；
    (b) `SELECT` 同样 early-return → 焦点在筛选/排序/预设下拉时光标类快捷键不响应，属预期，
    但需回归“原生下拉仍能正常选择”。
  - 与 t1 的口径统一：**不**以“select type-ahead 之争”作为论据——本机无 WebView2、未实测；
    `SELECT` 纳入通用守卫的**理由**仅为“值控件不劫持字母/数字键”这一保守原则（对应 t1 修正 5）。
  - 需产品决策：无。回滚方式：还原守卫条件、`\` 顺序与空格特例即可。

- **验证方法**：
  1. 打开调色面板 → 点住“曝光”滑杆不放 → 按 `\`：应显示“正在查看原片”；松开：应恢复。
  2. 在 JPG 路径框聚焦 → 按 `\`：应输入字符 `\`，且**不**进入查看原片。
  3. 按住 `\` → Alt-Tab 切走 → 切回：横幅应已消失（`blur` 兜底生效）。
  4. 聚焦滑杆后按 `1`/`P`/`X`：应恢复正常（顺带修复的连带问题）。
  5. **滑杆方向键回归（t1 指出）**：Tab 聚焦到调色滑杆（`input[type=range]`）→ 按 `←`/`→`：
     应**调节滑杆值**，**不得**切换上一张/下一张照片（验证通用守卫含全部 `INPUT`，未漏 `range`）。
  6. **空格回归**：Tab 聚焦到「扫描照片」按钮 → 按空格：应触发“扫描”，**不**触发“设为基准”；
     聚焦到任一 checkbox/radio → 按空格：应切换该控件；再聚焦到宫格列表（listbox）→ 按空格：
     应触发“设为基准（右）”。
  7. **宫格主交互回归**：焦点在宫格 listbox 上按 `a`/`d`/`1..5`/`x`/`p`：功能必须全在
     （验证未误加 listbox 守卫）。

---

### M-12 “AI 局部蒙版去薄雾”滑杆与上方 6 根调色滑杆不是同一种控件

- **复核结论**：**成立**。
  `TonalAdjuster.tsx:340-349`：
  ```tsx
  <input type="range" min={0} max={100} step={5} value={maskDehaze}
    onChange={(e) => setMaskDehaze(Number(e.target.value))}
    className="focus-ring flex-1 min-w-0 accent-white"
    aria-label="蒙版去薄雾强度" />
  ```
  仅 `accent-white`，无自定义轨道/滑块，无数字读数；
  而上方 6 根走 `.tone-slider`（`index.css:52-98`：20px 命中区 / 4px 轨道 / 12px 圆滑块），
  且每根都有等宽数字读数（`TonalAdjuster.tsx:245-247`）与 `aria-valuetext`（`:260`）。
  同一面板内两种控件语言 → 视觉与操作不一致；无读数 → 用户不知道“去薄雾”到底多少。

- **事实与根因**：蒙版区块是三件套（`select` 区域 + 滑杆 + `套用` 按钮）挤在**同一 flex 行**
  （`:327-358`），`<select>` 用 `flex-1 min-w-0`、滑杆用 `flex-1 min-w-0`，宽度本就三ccomp且受限——
  这是当初没复用 `.tone-slider`（其 `width:100%` + `height:20px`）的现实原因。

- **修复方案（统一方案）**：
  **直接复用 `.tone-slider` 可行**，但**必须先把滑杆从三件套行里挪出来**，否则 `width:100%` 与
  `flex-1 min-w-0` 会互相打架（flex-basis 虽优先，但语义脆弱、`20px` 高命中区也会顶坏该行节奏）。

  结构建议（把“去薄雾”拆成与 6 根完全同构的一行）：
  ```tsx
  <div className="flex flex-col gap-1.5">                        {/* ① 区域外框不变 */}
    <label htmlFor="tonal-mask-region" className="text-white/70 font-medium">AI 局部蒙版</label>

    <div className="flex items-center gap-1.5">                  {/* ② 行1：区域 + 套用 */}
      <select id="tonal-mask-region" ... />
      <button onClick={handleApplyMaskClick} ...>{isMasking ? '检测中…' : '套用'}</button>
    </div>

    <div className="flex flex-col gap-1.5">                      {/* ③ 行2：与 6 根同构 */}
      <div className="flex justify-between items-center text-white/80 gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <CloudSun className="w-3.5 h-3.5 text-white/60" aria-hidden="true" />
          <span className="truncate">去薄雾</span>
        </span>
        {/* 读数位置：与 6 根一致，右对齐、等宽、tabular-nums */}
        <span className="font-mono text-[11px] tabular-nums text-white/70 shrink-0">
          {maskDehaze}%
        </span>
      </div>
      <input
        id="tonal-mask-dehaze"
        type="range" min={0} max={100} step={5}
        value={maskDehaze}
        onChange={(e) => setMaskDehaze(Number(e.target.value))}
        className="tone-slider"
        aria-label="蒙版去薄雾强度"
        aria-valuetext={`${maskDehaze}%`}
      />
    </div>

    <p className="text-[10px] leading-relaxed text-white/60">…说明文案不变…</p>
  </div>
  ```
  - **宽度**：滑杆独占一行，`width:100%` 自然生效，不受 `select/button` 挤压。
  - **读数展示位置**：滑杆上方标签行右侧（与 6 根完全对齐），文字 `${maskDehaze}%`。
  - **`aria-valuetext` 文案**：`"60%"`（与 `aria-label="蒙版去薄雾强度"` 组合，SR 读作“蒙版去薄雾强度，60%”）。
    若希望更口语化可用 `"去薄雾 60%"`。
  - `step=5` / `min=0` / `max=100` 与 `.tone-slider` 无冲突（该样式不含 `step` 相关规则）。
  - 语义提醒：`.tone-slider` 是“调色”命名，复用于蒙版无功能问题；若在意命名可后续重命名为
    `.range-slider`（本次不改）。

- **风险评估**：**风险等级：低**。仅调整 `TonalAdjuster` 的蒙版区块布局 + 一个 class。
  面板高度增加约一行；`onApplyMask` 存在时才渲染（`:319`），CPU 版不受影响。
  回滚：还原该区块 JSX。**注意不要顺手改 `<select>` 的 `flex-1`**，否则行 1 会塌。

- **验证方法**：
  1. 视觉：蒙版去薄雾滑杆的轨道/滑块与上方 6 根肉眼一致，拖动时读数同步为 0/5/…/100。
  2. 键盘：Tab 到该滑杆 → 方向键应为 5 的整数步进；`aria-valuetext` 变化。
  3. axe：该 `<input type="range">` 应有可访问名（`aria-label` 或 `<label for>`）——现已是 `aria-label`，
     新结构可继续用 `aria-label` 或改用 `id` + `<label for="tonal-mask-dehaze">`。

---

### M-13 失败态“无预览”对比度不足（**含计算过程，报告数值有误**）

- **复核结论**：**成立，但报告的 3.45:1 是错的；正确值 3.77:1**。仍低于 AA 正文 4.5:1。

#### 计算过程（WCAG 2.1 §1.4.3 + 相对亮度定义）

**1) 正确的 alpha 合成**（关键：白色 40% 叠加在 `#0A0A0A` 上，**背景自身也贡献 60%**）：

```
合成通道值 = α·前景 + (1 − α)·背景 = 0.4×255 + 0.6×10 = 102 + 6 = 108
⇒ 实际混合色 = rgb(108,108,108) = #6C6C6C
```

> 报告算错的点：直接取 `0.4×255 = 102`（`#666666`），**漏掉了背景经剩余 60% alpha 的贡献
> `0.6×10 = 6`**。用 `#666666` 反推恰好得到 3.45:1，说明报告的数值来自这个未合成值。

**2) 相对亮度 L**（sRGB，`c ∈ [0,1]`；`c ≤ 0.03928` 用 `c/12.92`，否则 `((c+0.055)/1.055)^2.4`）：

- 文本 `#6C6C6C`：`c = 108/255 = 0.423529`
  `((0.423529+0.055)/1.055)^2.4 = (0.453582)^2.4 ≈ 0.149967`
  `L_text = 0.2126·0.149967 + 0.7152·0.149967 + 0.0722·0.149967 ≈ 0.149967`
- 背景 `#0A0A0A`：`c = 10/255 = 0.039216 ≤ 0.03928` → 走低分支
  `L_bg = 0.039216 / 12.92 ≈ 0.003035`

**3) 对比度**：

```
CR = (L_lighter + 0.05) / (L_darker + 0.05)
   = (0.149967 + 0.05) / (0.003035 + 0.05)
   = 0.199967 / 0.053035
   ≈ 3.77 : 1
```

**结论：3.77:1 < 4.5:1**（`text-[10px]` 是普通文本，不适用“大字号 3:1”豁免）→ **不满足 AA 1.4.3**。
（`#6C6C6C` 叠加在纯黑 `#000` 上为 3.66:1，可交叉验证量级。）

#### 其余低透明度白在同一背景（`#0A0A0A`）下的复核值

| Tailwind | 合成色（0.α×255 + (1−α)×10） | L | 对 `#0A0A0A` 对比度 | AA 正文(4.5) | AA 非文本(3.0) |
|---|---|---|---|---|---|
| `text-white/30` | `#535353` (83.5) | 0.08754 | **2.59:1** | ✗ | ✗ |
| `text-white/40` | `#6C6C6C` (108) | 0.14997 | **3.77:1** | ✗ | ✓ |
| `text-white/50` | `#858585` (132.5) | 0.23254 | **5.33:1** | ✓ | ✓ |
| `text-white/60` | `#9D9D9D` (157) | 0.33713 | **7.30:1** | ✓ | ✓ |
| `text-white/70` | `#B6B6B6` (181.5) | 0.46516 | **9.71:1** | ✓ (≥7 达 AAA) | ✓ |
| `text-white/80` | `#CECECE` (206) | 0.61720 | **12.58:1** | ✓ | ✓ |

#### 该用哪条标准：正文 4.5:1 vs 图形/UI 3:1

- **1.4.3 对比度（最低）AA**：**文本/文本图像** → 4.5:1；大号（≥18pt，或 ≥14pt 粗体）→ 3:1。
- **1.4.11 非文本对比度 AA**：**UI 组件与“理解内容所必需的”图形对象** → 3:1。
  - 纯装饰性图标（带 `aria-hidden="true"` 且不承载语义）**不在**此列。
  - 交互控件的图标若用于识别控件用途，则适用 3:1。

#### 全仓库 `text-white/3x~8x` 扫描后的**修正清单**（只列真正需要改的）

| 位置 | 内容 | 判定 | 原因 |
|---|---|---|---|
| `ThumbnailGrid.tsx:491` | `text-[10px] text-white/40` “无预览” | **需改 → `text-white/60`** | 3.77:1 < 4.5:1；**普通文本**，失败态说明须可读 |
| `ThumbnailGrid.tsx:202` | 搜索图标 `text-white/40`（`aria-hidden`） | 不改 | 装饰性图标，且 3.77 ≥ 3:1 |
| `ThumbnailGrid.tsx:216` | 清空 ✕ 按钮图标 `text-white/40` | 可不改 | UI 图标，3.77 ≥ 3:1；如需更保守可提到 `/60` |
| `BeforeAfterViewport.tsx:266` | 分隔符 `\|` `text-white/40` | 不改 | 纯装饰（视觉分隔），且非必需 |
| `BottomBar.tsx:144` | 分隔符 `\|` `text-white/30`（`aria-hidden`） | 不改 | 纯装饰 |
| 各处 `disabled:text-white/40`（`TopBar:163`、`BottomBar:121`、`SettingsModal:105` 等） | 禁用态按钮文字 | 不改 | 禁用态实质是“不可用控件”的降级呈现，非本轨范围；如需严格合规可另立条目 |
| `ThumbnailGrid.tsx:499` | “加载中”`text-white/60` | 不改 | 7.30:1 通过 |
| 其余 `white/60~80` 正文 | — | 不改 | 全部 ≥ 7.30:1 |

**唯一必改项：`ThumbnailGrid.tsx:491` 由 `text-white/40` 改为 `text-white/60`**
（与紧邻的“加载中”`:499` 同权重，且 7.30:1 通过 AA）。

- **影响面**：低视力用户；失败态是“引擎与内嵌预览都读失败”的兜底信号（`:489-497`），
  恰好是最需要看清的状态之一。同时该元素有 `role="img" aria-label="缩略图不可用"`，
  屏幕阅读器不受影响——受影响的是**看得见但看不清**的用户。频率低（需两条路径同时失败）。

- **修复方案**：改一处 class（见上表）。附带建议：`grid-opt-*` 单元格的 `aria-label` 已把
  “含 RAW/XMP/已调色/含精修成果”念出来（`ThumbnailGrid.tsx:446-458`），无需额外改动。

- **风险评估**：**风险等级：极低**。纯颜色 token 调整，无布局/逻辑影响。回滚：改回 `/40`。

- **验证方法**：
  1. 计算复核：用 WebAIM Contrast Checker 输入前景 `#6C6C6C`、背景 `#0A0A0A` → 应得 ≈3.77。
  2. 改后复查 `#9D9D9D` / `#0A0A0A` → ≈7.30。
  3. axe DevTools：`text-white/40` 失败态应不再报 color-contrast。
  4. 手工：断开引擎 + 提供损坏 RAW，使缩略图进入失败态，肉眼确认可读。

---

### M-14 筛选下拉无每档数量提示，排序下拉情况不同

- **复核结论**：**成立**。
  `TopBar.tsx:197-221` 的 6 个 `<option>`（全部/仅已保留/已淘汰/未标记/★3+/★5 精选）**均无计数**；
  而 `BatchExportModal.tsx:182-205` 的同构单选列表每档都渲染 `({count})`：
  ```tsx
  // BatchExportModal.tsx:182-184
  const count = groups.filter(filter.test).length;   // ← 每档各自 filter 一次
  ...
  <span className="text-white/60 font-mono tabular-nums">({count})</span>
  ```
  根因：`App.tsx:153-171` 的 `filteredGroups` useMemo **只按当前 `filterMode` 过滤一次**，
  没有为其余 5 档产出计数；`TopBar` 也拿不到 `groups`。

- **影响面**：全部用户。选片时“切到 5 星精选前先知道有几张”能避免进入空档筛选
  （空档会触发 `App.tsx:903` 的“当前筛选下没有照片”空态，白跑一趟）。这是**信息可达性**问题，非纯 a11y。

- **实现成本（1 万张规模）**：

  | 方案 | 复杂度 | 1 万张实测量级 | 说明 |
  |---|---|---|---|
  | 朴素：6 档各 `groups.filter(pred).length` | O(6n) | ≈ 5–15 ms + 6 次数组分配 | 可接受但会产生 6 个中间数组、GC 抖动 |
  | **单次遍历出各档计数** | O(n) | ≈ 0.1–0.5 ms，零分配 | **推荐** |

  优化方案（`App.tsx` 内新增一个只依赖 `groups` 的 useMemo）：
  ```ts
  const filterCounts = useMemo(() => {
    const c = { all: 0, pick: 0, reject: 0, unmarked: 0, star3: 0, star5: 0 } as Record<FilterMode, number>;
    for (const g of groups) {
      c.all++;
      if (g.flag === 'pick') c.pick++;
      if (g.flag === 'reject') c.reject++;
      if (g.flag === 'none' && g.rating === 0) c.unmarked++;
      if (g.rating >= 3) c.star3++;
      if (g.rating === 5) c.star5++;
    }
    return c;
  }, [groups]);
  ```
  - 谓词必须与 `App.tsx:155-169` 的 `filteredGroups` switch **逐条对齐**（尤其 `unmarked`
    是 `flag==='none' && rating===0`，`star3` 是 `rating>=3`）——建议把两者抽到同一个
    `matchesFilter(g, mode)` 纯函数，**彻底消除两处逻辑漂移**的风险。
  - 依赖只有 `groups`：评级/打标会换新数组 → 自动重算，且是**一次 O(n)**，1 万张无感。
  - 该 useMemo **不与** `filteredGroups`（依赖 `filterMode`）叠加成 O(6n)；两者各自 O(n)，总 O(2n)。
  - 传参：给 `TopBar` 加 `filterCounts?: Record<FilterMode, number>`，选项文案改为
    `全部照片 (10234)` 形式（原生 `<select>` 不支持富文本，只能拼进 option 文本）。

  **排序下拉是否也需要计数？——不需要。**
  `SortOrder`（`time_filename | filename | rating`，`types/index.ts:23`）**不改变集合大小**，
  三档计数恒等于 `groups.length`，加 `(N)` 是纯噪声。排序真正缺的是**当前项是否可辨识**：
  原生 `<select>` 的 `value` 已显示当前排序（`TopBar.tsx:226-231`），但对**屏幕阅读器下的
  下拉展开瞬间**不够醒目。建议：给 select 保留/完善 `aria-label="照片排序方式"`（已有，`:230`），
  并复用已在本仓出现的模式——在选中项前加标记，如
  `★ 星级最高优先`、`☑ 拍摄时间排序`（与 `ViewMode` 分段控件的“选中态 + `aria-pressed`”思路一致）。
  此改法零成本，且不引入假信息。

- **风险评估**：**风险等级：低**。唯一真实风险是**两处过滤谓词漂移**（`App.tsx` 的 switch
  与计数循环）——务必抽公共 `matchesFilter`。`filterCounts` 为可选 prop，`TopBar` 可优雅降级
  （未传时不显示计数），不会破坏现有测试（`TopBar` 现有快照若断言 option 文本需同步更新）。
  回滚：移除 prop 与渲染分支。

- **验证方法**：
  1. 单测 `filterCounts`：构造含 pick/reject/未标记/3★/5★ 的混合数组，
     断言各档计数等于对同一数组跑 `filteredGroups` 的结果（**用同一谓词交叉验证**）。
  2. 手工：扫描 1 万张后，逐档切换，确认下拉里的 `(N)` 与该档生效后的宫格计数
     （`ThumbnailGrid.tsx:139-143`）一致。
  3. 性能：在 1 万张下 Profile `App` 重渲染，确认 `filterCounts` 单次遍历耗时 < 1ms。

---

### M-15 lumen 路径是纯手输框、无「浏览」、无「测试连接」，且状态永不刷新

- **复核结论**：**成立，且比描述更严重**（“状态永不刷新”是新发现）。

- **事实与根因**：
  1. **无「浏览」**：`SettingsModal.tsx:178-187` 的 `lumenCliPath` 只有 `<input type="text">` +
     placeholder；而同弹窗 Photoshop 路径（`:127-146`）在 §`handleBrowsePhotoshop`（`:61-71`）
     的支撑下带「浏览」按钮。两处**不对称**，用户要手打
     `C:\Users\...\LUMEN RAW\lumen-cli.exe`。
  2. **无「测试连接」**：弹窗里只有一段**只读**状态（`:193-204`），数据源是 `lumenStatus` prop。
  3. **状态永不刷新（新发现）**：`lumenStatus` 来自 `App.tsx:87 useLumenStatus(settings?.lumenEnabled)`，
     而 `useLumenStatus`（`hooks/useLumenStatus.ts:24-50`）的 effect **只依赖 `enabled`**，
     延迟 1500ms 探测**一次**。因此：改 `lumenCliPath` 或保存设置（只要 `lumenEnabled` 不变）
     **都不会重新探测**——弹窗里的“已连接/未找到”是应用启动时的**陈旧快照**。
     打开弹窗本身也不触发探测。
  4. **保存后不刷新**：`SettingsModal.handleSave`（`:73-85`）调 `api.saveSettings` → `onSettingsSaved`，
     但没有刷新 `lumenStatus` 的入口（`App.tsx:1080-1081` 只透传，不重新请求）。

- **能否用现有 `lumen_status_cmd` 强制重探？——部分可以，但有语义缺口。**
  读 `commands.rs:336-358` 与 `lumen.rs`：
  ```rust
  // commands.rs:337-357
  let settings = state.db.load_settings()?;            // ← 读【已保存】的设置
  if !settings.lumen_enabled { return Ok(lumen_status_from(false, None, None)); }
  let exe = lumen::find_lumen_cli(&settings.lumen_cli_path)?;
  let cached = state.lumen.status(true, Some(exe.clone()));
  if cached.available { return Ok(cached); }           // ← 命中运行期缓存则【不重新起进程】
  let version = query_version(&exe);                   // ← 否则才真跑 `lumen-cli --version`
  Ok(lumen_status_from(true, Some(exe), version))
  ```
  结论逐条：
  - **不读未保存的输入框**：它读 `db.load_settings()`，所以只能测“已保存的路径”，
    测不到用户正在手输的路径（**除非先保存**）。
  - **不是强制重探**：若 `state.lumen` 已有握手缓存（此前渲染/调色成功过），
    `cached.available === true` 会**直接返回缓存**，不重新验证 exe。
  - **探测深度只到 `--version`**：重探分支跑的是 `lumen::query_version`（等价 `lumen-cli --version`），
    **不做 MCP 握手、不查能力、不探 AI flavor**。所以“版本对得上”≠“能真正解码”。

  **唯一的“零后端改动”近似实现**：先保存再重握手。
  `save_settings_cmd`（`commands.rs:262-277`）在路径变化时会 `state.lumen.shutdown()` 清掉缓存，
  随后再调 `lumen_status_cmd` 就会走 `query_version` 真实重探。近似方案：
  ```
  1) await api.saveSettings({ ...settings })     // 副作用：真的把路径落库了
  2) const s = await api.getLumenStatus()        // 此时缓存已被 shutdown 清空 → 真实重探
  3) 用 s 在弹窗内显示“连接成功 / 失败原因”
  ```
  缺点：(a) **测试即保存**，用户只是想试探一个路径也会被写进设置；(b) 只验证版本，不验证握手；
  (c) 还要把 `lumenStatus` 从 App 层“手动刷新”下来（`useLumenStatus` 加 refresh token）。
  ⇒ **不推荐把它当作正式方案**。

  **推荐：后端加一个真正的探测命令**（约 20 行 Rust，不污染共享运行时缓存）：
  ```rust
  /// 用【参数里的路径】探测引擎是否可用（不读设置、不写运行时缓存）。
  #[tauri::command]
  pub async fn lumen_probe_cmd(path: String) -> Result<LumenStatus, String> {
      let exe = match lumen::find_lumen_cli(&path) {
          Some(e) => e, None => return Ok(lumen::lumen_status_from(true, None, None)),
      };
      let exe_for_version = exe.clone();
      let version = tokio::task::spawn_blocking(move || lumen::query_version(&exe_for_version))
          .await.map_err(|e| format!("LUMEN 版本查询任务异常: {}", e))?;
      Ok(lumen::lumen_status_from(true, Some(exe), version))
  }
  ```
  理由：现有 `lumen::query_version`（`lumen.rs:1458`）、`find_lumen_cli`（`:115`）、
  `lumen_status_from`（`:1570`）**全部已存在**，新命令只是把它们用参数拼起来，
  且**不触碰 `state.lumen`**，避免把“试探路径”的能力写进全局缓存（`capabilities()` 会把结果
  缓存进 runtime，`:1235-1237`，若复用会污染）。
  若要做到“能真正解码”级别的验证，可再进一步在探测命令里调
  `LumenRuntime::new().capabilities(&exe)`（`lumen.rs:1213`，会跑 `commands.list` + `edit.presets` +
  `detect_ai_flavor`）——用**临时** runtime（`LumenRuntime::new()`）而非 `state.lumen`，成本略高
  （会 spawn B 通道进程），建议作为“深度测试”选项或直接以 `query_version` + `detect_ai_flavor`
  组合（后者是纯路径检查，`lumen.rs:847`，零开销，可直接回答“是否 AI 版”）。

  **「浏览」按钮**（照抄 Photoshop 先例，`SettingsModal.tsx:61-71`）：
  ```tsx
  const handleBrowseLumen = async () => {
    if (!settings) return;
    const selected = await open({
      multiple: false,
      title: '选择 lumen-cli 可执行文件 (lumen-cli.exe)',
      filters: [{ name: 'Executable', extensions: ['exe', 'app'] }],
    });
    if (typeof selected === 'string') setSettings({ ...settings, lumenCliPath: selected });
  };
  ```
  并把 `:178-187` 的 `<input>` 包进与 Photoshop 相同的 `flex items-center gap-2`，
  右侧加一个同款图标按钮（`FolderOpen` + `aria-label="选择 lumen-cli 路径"`）。
  `@tauri-apps/plugin-dialog` 的 `open` 已在 `:5` 导入，无需新增依赖。

  **「测试连接」按钮**（配合新命令）：
  ```tsx
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const handleTestLumen = async () => {
    if (!settings) return;
    setProbe(null);
    try {
      const s = await api.probeLumen(settings.lumenCliPath);   // 新 api 方法
      setProbe({ ok: s.available, text: s.available
        ? `连接成功：LUMEN RAW ${s.foundVersion}`
        : s.detail });
    } catch (e) { setProbe({ ok: false, text: `测试失败：${String(e)}` }); }
  };
  ```
  结果用 `<p role="status" aria-live="polite">` 呈现（与 `:196-199` 现有状态段一致）。

- **影响面**：所有启用 LUMEN RAW 的用户。手输长路径易错（尤其 `Program Files` 空格、
  中文用户名）；“改完不知道有没有生效”导致反复试错；状态陈旧会**误导**用户以为已连接。
  这是**可用性 + 文案真值**双重问题。

- **风险评估**：**风险等级：中**（涉及 Rust 命令新增与设置语义）。
  - 需产品决策：**「测试连接」是否允许测试未保存的路径**（推荐允许，正是新命令的价值）；
    以及测试成功后**是否自动写回设置**（建议**不**自动写，由用户点「保存设置」）。
  - 回归点：新增 `lumen_probe_cmd` 需在 `lib.rs` 的 `invoke_handler` 注册（对照 `:336` 附近
    现有 `lumen_status_cmd` 注册位）；`api.ts` 新增 `probeLumen`。若走“保存再重探”近似方案，
    需给 `useLumenStatus` 加 refresh token，改动面反而更大。
  - 回滚：删除新命令与按钮即可，核心链路（`lumen_status_cmd`）不动。

- **验证方法**：
  1. 设一个不存在的路径 → 点「测试连接」→ 应显示“未找到 lumen-cli.exe，请安装…/或指定路径”
     （`lumen_status_from` 的既有文案，`lumen.rs:1580`）。
  2. 设正确路径 → 应显示“连接成功：LUMEN RAW 1.6.0”；把版本换成非 1.6.0 的假 exe →
     应显示“版本不匹配（需要 1.6.0，当前 X）”（`lumen.rs:1582-1586`）。
  3. 点「浏览」→ 系统文件对话框应只列 `.exe/.app`，选中后路径回填输入框。
  4. 确认测试**不修改** `state.lumen` 缓存：连续测试两个不同路径，结果应各自独立、不互相污染。

---

## LOW 级问题最小修复表

| 编号 | 位置 | 问题 | 一行改法 | 风险 |
|---|---|---|---|---|
| L-04 | `PreviewViewport.tsx:375-381` | 缩放读数 `aria-live="polite"`，滚轮每步都播报（“125%…156%…195%…”），打断用户 | 删掉该 `<span>` 上的 `aria-live="polite"`（保留 `aria-label`，值仍可经聚焦/读取获得；WCAG 4.1.3 由按钮 `aria-label` 已满足）；若要保留播报则改为 500ms 防抖后只播最终值 | 极低：纯属性删除 |
| L-05 | `BottomBar.tsx:59-62` | 纯 `div` 上写 `aria-label`（`div` 隐式 role 为 `generic`，ARIA 1.2 规定其 **nameFrom: prohibited** → 标签被 AT 忽略） | 加 `role="group"`（group 支持 author 命名）：`<div role="group" aria-label="常用快捷键提示" …>`；其内含按钮，语义成立 | 极低：仅新增 role |
| L-06 | `ThumbnailGrid.tsx:254-266`（listbox）/ `:461-476`（option） | 虚拟化列表只渲染部分行，AT 无法推断总数与位置；text 只给了列表总数 | 在 `GridPhotoCell` 的 option div 上加 `aria-setsize={total}` 与 `aria-posinset={index + 1}`（两个 prop 已在 `:363-364` 可用，posinset 1 基） | 极低：与 `aria-label` 内已有的“第 x / N 张”一致，不冲突 |
| L-07 | `ThumbnailGrid.tsx:461-476` vs `:254-266` | 容器用 `aria-activedescendant`（焦点模型 A），但单元格 `tabIndex={-1}` 会被**点击**聚焦（div+tabindex=-1 可被 mousedown 聚焦）→ 焦点离开容器，aria-activedescendant 契约失效，两套焦点模型混用 | 删掉单元格的 `tabIndex={-1}`，并加 `onMouseDown={(e) => e.preventDefault()}` 防止 mousedown 抢焦点（保持容器 `tabIndex=0` 为唯一焦点主），`onClick` 保留 | 低：需回归“点击单元格后方向键仍可导航”；若不 preventDefault 则点后键盘失效 |
| L-08 | `TonalAdjuster.tsx:211-217`（`role="region"`）/ `App.tsx` 的 `showTonalPanel` | 调色面板无法用 Esc 关闭，与所有弹窗（`Modal.tsx:67-72`）“Esc 关闭”约定不一致 | 在 `App.tsx` 加 `useEffect`：`window` 上监听 `Escape`，当 `showTonalPanel && !document.querySelector('[role="dialog"][aria-modal="true"]')` 时 `setShowTonalPanel(false)`（复用快捷键里的 `isDialogOpen` 判据，避免与上层弹窗抢 Esc） | 低：需确保弹窗打开时 Esc 归弹窗（`Modal` 用捕获阶段 + `stopPropagation`，故须加 dialog 守卫） |
| L-09 | `ThumbnailGrid.tsx:226-242` vs `:552-587` | **不成立**：图例 `:226-242` 位于滚动容器 `:254` 的**外部**（同名父级 flex 列的兄弟节点）且带 `shrink-0`，滚动时**不会**移出视野；“滚动后图例不在视野”的前提错误。徽章 `aria-hidden` 仅靠 `title`，但 AT 用户可从单元格 `aria-label`（`:446-458`）获取同等信息 | 无需修复。若仍想增强：给徽章加 `sr-only` 文本或把 `title` 换成可读文本（非必需） | — |
| **L-12（本轨新增，与 t1 的 H-01 呼应）** | `useKeyboardShortcuts.ts:198-203`（`case ' '`）+ `App.tsx:882`（`onPinRight` 恒有值） | 空格被全局 handler **无条件** `preventDefault()` 并执行“设为基准 (右)” → **焦点在按钮/链接等可激活元素上时，空格无法激活该元素**（keydown 被取消，抑制了原生 `click` 合成）。定性为 **a11y 缺陷**（非数据风险：`handleTogglePinRight` `App.tsx:273-280` 只改内存）。**编号说明**：本条**原误记为 L-10**，经 t4-long-task 提请后改号 **L-12**（`L-10` = 批量导出未校验“目标目录=源目录”，归 t4，已升 HIGH，汇总记为 **H-04**；`L-11` 被 t1 的“无撤销”占用）。勿与 t4 的 L-10 混淆 | switch 之前加：`if (e.key === ' ' && isActivatable(el)) return;`（不 `preventDefault`，让位原生激活）。`isActivatable` 覆盖 `BUTTON/SUMMARY/A` 标签、`INPUT` 且 `type ∈ {checkbox,radio,button,submit,reset}`、以及 `role ∈ {button,radio,checkbox,switch,tab,menuitem,option,link}`；**宫格 listbox 不在其中**，故宫格内空格仍为“设为基准” | 低：需回归“聚焦按钮后空格可激活”与“宫格内空格仍设为基准”两态；详见 M-09 节 |

---

## 优先级与依赖

**P0（先做，收益/风险比最高，互不依赖）**
1. **M-13**（`ThumbnailGrid.tsx:491` 一处 class）—— 唯一的硬性 AA 违规，改动最小。
2. **L-04 / L-05 / L-06**（各一行属性）—— 与上述同批提交最省成本。
3. **M-09 + L-12**（`useKeyboardShortcuts.ts` 守卫 + `keyup` 兜底 + 空格让位）—— 修复的是
   **核心用户路径**，且顺带修复“聚焦滑杆后所有单键失效”与“聚焦按钮后空格无法激活”两个连带问题。
   > **合并约束（已由 team-lead 裁决）**：守卫骨架 owner = t1-data-safety。
   > **H-01 + M-09 + L-12 三条必须合并为同一批改动、同一次提交**——它们改的是**同一个
   > `handleKeyDown/handleKeyUp`**，分两次提交会互相覆盖。本轨只贡献规则（M-09 的 `\` 放行与
   > keyup 兜底、L-12 的空格规则），实现以 H-01 为准。

**P1（需小设计，独立）**
4. **M-12**（`TonalAdjuster` 蒙版行重构）—— 无外部依赖。
5. **M-14**（`App.tsx` `filterCounts` + `TopBar` prop）—— 依赖：先把过滤谓词抽成
   `matchesFilter` 共享函数（同时为 M-14 与现有 `filteredGroups` 服务）。
6. **L-07 / L-08**（ThumbnailGrid 焦点模型 / 调色面板 Esc）—— 各自独立。

**P2（跨端，成本最高，建议单独排期）**
7. **M-15**（Rust `lumen_probe_cmd` + `lib.rs` 注册 + `api.ts` + 弹窗 UI）—— 前后端联动，
   建议与“LUMEN 设置体验”一起排。
8. **M-08**（三视口命中缩放）—— 改动面最大；若排期紧张，可先落地 `PreviewViewport` 单视图，
   对比视图暂改文案（路线 B），但**必须二选一**，不能既不改代码也不改文案。

**依赖关系图**
```
[matcher 抽公共函数] ──> M-14
[label 共享常量]     ──> M-12 / M-15（文案一致性）
M-08（对比视图双栏 rect） 与 M-12（TonalAdjuster 面板）无依赖
M-15 的后端命令注册 独立于其余全部条目

[守卫骨架 owner = t1-data-safety]
  H-01（骨架 + 选择器清单） ← 采纳本轨 R1/R2/R3 规则
      └── 同一次提交内包含：M-09（\ 放行 + keyup 兜底）、L-12（空格让位）
          ※ 三者改同一 handleKeyDown，禁止拆分提交
```

**建议提交批次**：`批次A = M-13 + L-04/05/06 + (H-01 + M-09 + L-12 合并提交)`——
其中 **H-01 / M-09 / L-12 是同一个 `handleKeyDown` 上的一次改动**，必须打包为**同一次提交**，
owner 为 t1-data-safety，本轨只提供规则条目；其余项半天内可完成、可全量测试。
`批次B = M-12 + M-14 + L-07 + L-08`；`批次C = M-15`；`批次D = M-08`。

---

## 工作量估计（人天）

假设：1 人天 = 6 有效工时；**含**单元/交互测试的编写与自测，**不含** reviewer 与产品评审时间；
改动量为“最小修复”（不顺手重构）。

| 条目 | 说明 | 估计 |
|---|---|---|
| M-08 | helper + 3 视口接入 + 单测 + 手工回归（对比视图双栏 rect 为主要风险） | 1.0 – 1.5 |
| M-09 | 守卫双谓词收窄 + `\` 顺序提前 + keyup 顺序 + blur/visibilitychange 兜底 + 空格特例 + 单测 | 0.6 |
| M-12 | 蒙版行结构重构 + 读数 + aria-valuetext + 视觉回归 | 0.3 |
| M-13 | 1 处 class + 对比度复核记录 | 0.1 |
| M-14 | matcher 抽取 + filterCounts 单次遍历 + TopBar prop + 单测 + 既有测试文本同步 | 0.5 |
| M-15 | Rust 命令 + 注册 + api + 浏览/测试按钮 + 状态呈现 + E2E | 1.0 – 1.5 |
| L-04 | 删属性 | 0.05 |
| L-05 | 加 role | 0.05 |
| L-06 | 加两属性 | 0.1 |
| L-07 | 去 tabIndex + preventDefault + 焦点回归 | 0.2 |
| L-08 | App 层 Esc 监听 + 弹窗守卫 + 回归 | 0.2 |
| L-09 | 无需修复 | 0 |
| L-12（新增） | 空格让位可激活元素 + 两态回归（与 M-09 同批提交，多数测试可复用） | 0.15 |
| **合计** | 取中位数估计 | **≈ 4.2 – 5.4 人天** |

（若 M-08 只做“改文案”路线 B，则降至 0.05 人天，但产品体验倒退，**不推荐**。）

---

## 跨轨道交叉引用（避免重复改同一文件）

本轨只对自己的编号负责；以下重叠项**以对应轨道的报告为准**，本轨不提供冲突方案，
仅从“可访问性 / 文案真值”角度给出确认或定性：

| 重叠点 | 归属轨道 | 本轨立场 |
|---|---|---|
| **Toast 的 live region**（`Toast.tsx:118-121` 单容器 `role="status" aria-live="polite"`，错误与成功共用 → 错误应改 assertive；`:32-36` 错误 7s 自动消失；`:89` 上限 3 条且无去重，错误风暴会静默挤掉旧错误） | **t4-long-task**（`.plan/ux_fix_04_long_task_scale.md` L-02/L-03） | **确认 t4 结论成立，本轨不重复出方案、不改 `Toast.tsx`**。补充一条 a11y 依据：WCAG 4.1.3 / ARIA 实践要求 `role="alert"`（或 `aria-live="assertive"`）承载**需要立即知晓**的错误，与 polite 的成功/提示分属不同 live region；若最终仍只保留一个容器，则错误必须走 assertive 且**不自动消失**。治本（调用方汇总上报，如 `App.tsx:452-460 reportRatingFlagError`）同意 t4 意见。 |
| **`MetadataEditorModal` 文案与默认范围矛盾**（说明写“为**所选**照片写入”`MetadataEditorModal.tsx:292-295`，但默认范围是 `all`（`:43`）；footer `:131-137` 只给数量不给范围名） | **t1-data-safety**（H-03） | **从“文案真值”角度确认成立**：这正是本轨主题“说到的必须做到”。**本轨无统一按钮/确认文案规范可覆盖 t1**，请采用 t1 的措辞（默认改 `filtered`、范围名写进 footer/按钮、选 `all` 走二次确认）。本轨仅补一条原则：确认弹窗正文必须**明写范围名与张数**（如“将向 10234 张照片写入…”），不得只写“所选照片”。 |
| **编号 `L-10` 的归属** | **t4-long-task**（`.plan/ux_fix_04_long_task_scale.md` L-10 → 汇总记 **H-04**） | 本轨的空格条目**已由 L-10 改号为 L-12**（见 LOW 表与偏差第 7 条）。`L-10` = 批量导出未校验“目标目录=源目录”，与本轨无关，不重复。 |
| **键盘守卫实现** | **t1-data-safety**（H-01 附录 B，唯一真值） | 本轨只贡献规则 R1/R2/R3，不复述骨架；M-09 + L-12 + H-01 打包同一次提交。 |

**注（守卫实现真值）**：M-09 / L-12 与 t1 的 H-01 改的是 `useKeyboardShortcuts.ts` 的
**同一个 `handleKeyDown`**。经 team-lead 裁决，**骨架 owner = t1-data-safety**，
**唯一实现真值 = `ux_fix_01_p0_data_safety.md` 的「附录 B：H-01 守卫最终骨架（定稿）」**；
本轨只提供规则条目（R1 `\` 放行、R2 keyup/失焦兜底、R3 空格 `isActivatable`），
**不复述谓词公式**。三者的改动必须**打包为同一次提交**，否则会出现两套守卫互相覆盖。

---

## 复核中发现的报告偏差

1. **M-13 对比度数值错误（必改）**：报告称 `text-white/40` 对 `#0A0A0A` 为 **3.45:1**，
   正确值为 **3.77:1**。
   偏差来源：报告把混合色算成了 `0.4×255 = 102`（`#666666`），**漏掉背景经剩余 60% alpha
   的贡献 `0.6×10 = 6`**；正确合成 `0.4×255 + 0.6×10 = 108`（`#6C6C6C`）。
   用 `#666666` 反推恰好得 3.45，可确认偏差成因。**结论不变**（两者均 < 4.5:1，仍违反 AA 1.4.3），
   但本文档采用修正值。附修正值：`/60 = 7.30`，`/70 = 9.71`，`/80 = 12.58`（并补 `/50 = 5.33`、`/30 = 2.59`）。

2. **L-09 前提不成立**：报告称“R/X/T/E 缩写徽章只靠宫格头部一次图例解释，**滚动后图例不在视野**”。
   实读源码：图例位于 `ThumbnailGrid.tsx:226-242`，是滚动容器（`:254` 的 `overflow-y-auto`）
   **之外的同级兄弟**，且带 `shrink-0`；整个 `ThumbnailGrid` 根节点是 `h-full flex flex-col`
   （`:136`），滚动只发生在列表内部。**图例在滚动时始终可见**，不满足“滚出视野”的前提。
   此外徽章为 `aria-hidden`，但单元格的 `aria-label`（`:446-458`）已用完整句子覆盖
   “含 RAW / 含 XMP / 已调色 / 含精修成果”，AT 用户无信息缺失。**判定 L-09 不成立（无需修复）**。

3. **M-09 影响面被低估**：报告只指出“拖滑杆时按 `\` 失效”。实读 `useKeyboardShortcuts.ts:57-66`
   与 `:240-248`，同一守卫会**连带拦住所有单键快捷键**（`A/D/1-5/P/X/E/C/Y…`）——
   只要焦点落在任一 `<input>`（含 range、以及设置里的 number 输入）上。
   另发现 `keyup` 侧也有同一守卫 → `\` 会**卡在“查看原片”状态**（`keyup` 无法复位）。
   这两点均未在初始描述中提出，已并入 M-09 的修复方案。

4. **M-15 影响面被低估（新发现）**：报告聚焦“无浏览/无测试连接”。实读发现
   `useLumenStatus`（`hooks/useLumenStatus.ts:24-50`）的 effect **只依赖 `enabled`**，
   且 `lumen_status_cmd` 读的是**已保存**设置（`commands.rs:337`）→
   改路径或保存设置后，弹窗里的引擎状态**永不刷新**，是启动时的陈旧快照。
   这使得“测试连接”不仅需要新按钮，还**必须**配一个新的探测命令（现有命令读不到未保存路径、
   且命中运行期缓存时不真跑进程），已据此给出 `lumen_probe_cmd` 方案。

5. **M-12 与描述一致**，但补充一条未提及的实施约束：蒙版滑杆与 `select`/`套用`
   同处一个 flex 行（`TonalAdjuster.tsx:327-358`），**直接给现有滑杆加 `.tone-slider`
   会因 `width:100%` 与 `flex-1 min-w-0` 冲突且撑坏行高**，故必须先拆行——这是“直接复用是否可行”
   的答案（可行，但有前提）。

6. **M-08 / M-14 / L-04 / L-05 / L-06 / L-07 / L-08 复核无偏差**，行号与描述一致；
   其中 M-08 补充一条环境性 caveat：React 17+ 的根节点 `wheel` 监听为 passive，
   现有三处 `e.preventDefault()` 实际不生效（桌面壳内暂无可见后果，需实机确认）。

7. **（并入 t1 复核）空格问题方向修正 + 定性修正**：真实机制是全局 `handleKeyDown` 的
   `case ' '`（`useKeyboardShortcuts.ts:198-203`）无条件 `preventDefault()` 并执行“设为基准 (右)”，
   导致**被聚焦的按钮反而无法用空格激活**——方向上是“全局 handler 抢走空格”，而非“控件行为异常”。
   且 `handleTogglePinRight`（`App.tsx:273-280`）只改内存不落盘，属 **a11y 缺陷**而非数据安全，
   已按此定性收录为 **L-12（本轨新增）**，与 t1 的 H-01 同批修复。
   编号曾误记为 **L-10**，经 t4-long-task 提请、team-lead 裁决后改号 L-12
   （`L-10` = 批量导出未校验“目标目录=源目录”，归 t4，已升 HIGH / 汇总记 H-04；`L-11` 为 t1 的“无撤销”）。

10. **（t1 复核修正本轨方案一处回归）通用守卫必须覆盖“任意 `INPUT`”**：本轨早前提出的
   `isValueOrText = isTextEntry || SELECT` **漏掉 `input[type=range]`** → 调色滑杆聚焦时
   方向键会被全局 handler 劫持去翻页，且 `preventDefault()` 会连滑杆原生键盘调整一起取消，
   **导致滑杆键盘不可用**（新增可访问性回归）。已按 t1 附录 B 修正：通用守卫 =
   **任意 `INPUT`（含 range/checkbox/radio/…）+ `TEXTAREA` + `contentEditable` + `SELECT`**；
   `isTextEntry`（仅文本录入类）**只**服务 `\` 的让位。本轨已删除 `isValueOrText` 谓词名与公式，
   改为引用 t1 附录 B，并在验证清单补“range 聚焦时方向键仍是调滑杆而非翻页”。

11. **（t4 提请）编号冲突已解决**：见第 7 条与 LOW 表 L-12 行的编号说明。

8. **（并入 t1 复核）不以“select type-ahead 之争”为论据**：本项目**本机无 WebView2**，
   `select` 上字母/数字键的真实伤害来自**我们自己的 handler 在冒泡阶段同步执行**（早于该事件的
   默认动作），而非 type-ahead 竞争；该论据**未实测**，不作为已验证结论。
   本轨把 `SELECT` 纳入守卫的理由**仅为**“值控件不劫持字母/数字键”这一保守原则（对应 t1 修正 5）。

9. **（并入 t1 复核）守卫语义两条硬约束**（已写入 M-09 节）：(a) 守卫**绝不能**包含
   `[role="listbox"]`（否则废掉宫格 `a/d/←→/1..5/x/p` 主交互）；(b) 判定维度只能是
   **焦点控件的类型**（文本/值控件 early-return），不能按容器角色。

---

*调查方式：只读 Read/Grep/Glob，未执行任何写入或构建；`src-tauri` 侧仅静态阅读。*
