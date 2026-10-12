# UX 审计深度复核 —— 总表与整合结论

- **性质**：只读调查的汇总文档。本文件不修改任何 `src/`、`src-tauri/`、配置或 `package.json`；本次全部写入仅落在 `.plan/` 目录内的报告文件。
- **项目**：`C:/Users/VerNe/Downloads/Documents/gallery-flask`（gallery-culling v1.1.1，Tauri 2.0 + React 19 + TS + Tailwind 3 + Vitest 4.1.11）
- **上游**：`UX-AUDIT-2026-10-12.html`（初版六域审计，Quick Diagnostic 6/10，3 HIGH + 17 MEDIUM + 11 LOW，报价 9.0 人天 / ¥10,800）
- **下游**：6 条并行轨道报告（见 §1）
- **复核方式**：每条发现都回到源码逐行验证，**允许并实际发生推翻**。lead 另对轨道结论做了交叉复核（特别是 t6 的测试基建结论，已由 lead 独立复跑三次确认）。

---

## 0. 一句话结论

初版审计的**方向正确、定级有偏差**。六条轨道的逐行复核：

- **推翻 3 条原判**（M-16 测试启动失败、L-09 图例滚出视野、H-02 "重复叠加"）；
- **上调 2 条定级**（L-10 导出同路径覆盖 → **HIGH**；M-09 影响面从"拖滑杆时"扩到"所有单键快捷键 + `\` 键会卡死"）；
- **收窄 1 条破坏范围**（H-03 只覆盖镜头三件套，不是"销毁侧边栏"）；
- **新增 16 条**（含 1 条组合键误触写盘、1 条导出静默覆盖、1 条测试"假护栏"、1 条 XMP 并发截断竞态、4 条索引一致性缺陷）；
- **纠正 2 处算错/写错**（对比度 3.45:1 → 3.77:1；命令数 26 → 25）。

因此最终结论为 **4 HIGH + 17 MEDIUM + 11 LOW + 16 新增（N-01…N-16）**，报价由 9.0 人天修订为 **31.0 人天 / ¥37,200**（亦可只做 §7 的 ① 档 3.5 人天 / ¥4,200 止血）。

---

## 1. 文件索引

| 文件 | 轨道 | 主题 | 行数 |
|---|---|---|---|
| `.plan/ux_fix_00_master.md` | —（lead） | **本总表**：统一 ID 映射、冲突裁决、修复批次、风险登记册 | — |
| `.plan/ux_fix_01_p0_data_safety.md` | t1-data-safety | P0 数据写入安全（H-01/H-02/H-03/L-11 + 附录 A 导出、附录 B 守卫定稿） | 482 |
| `.plan/ux_fix_02_compare_views.md` | t2-viewports | 三视口一致性（M-01/M-02/M-03/M-11/L-01 + 3 新） | 304 |
| `.plan/ux_fix_03_state_truth_focus.md` | t3-state-truth | 状态真值单一化与焦点（M-04/M-06/M-07/M-10 + 4 新） | 438 |
| `.plan/ux_fix_04_long_task_scale.md` | t4-long-task | 长任务可见性与万张规模性能（M-05/M-17/L-02/L-03/L-10→H-04 + 性能清单） | 688 |
| `.plan/ux_fix_05_a11y_copy.md` | t5-a11y-copy | 可访问性与文案真值（M-08/M-09/M-12/M-13/M-14/M-15 + L-04…L-09/L-12） | 800 |
| `.plan/ux_fix_06_test_infra.md` | t6-test-infra | 测试基础设施与回归网有效性（M-16 重新定性 + 栏栅清单） | 256 |

**阅读顺序建议**：本总表 → §4 冲突裁决 → 关心哪条就读对应轨道报告的原章节（每份报告内都有「复核结论 / 事实与根因 / 影响面 / 修复方案 / 风险评估 / 验证方法」六段式）。

---

## 2. 统一 ID 映射表

> **编号规则**：沿用初版审计的 `H/M/L-xx` 编号，**不重新编号**，以免与已交付的 HTML 报告脱节。新增项统一用 `N-xx`。`L-10` 因升为 HIGH 而**并入 H-04**（原编号保留在括号内以免检索不到，但不再作为 LOW 条目计数）。

### 2.1 HIGH（4 条）

| 统一 ID | 初版 | 轨道 | 复核结论 | 一句话根因 | 位置 | 工作量 |
|---|---|---|---|---|---|---|
| **H-01** | H-01 | t1 | 成立，机制表述需修正 | 全局快捷键守卫只判 `INPUT/TEXTAREA/contentEditable`，漏掉 `SELECT` → 聚焦下拉时 `1-5/x/p` 直落 `switch` 并**写盘 XMP** | `useKeyboardShortcuts.ts:59-66,94,110-148` | 1.0（含 M-09/L-12/N-05） |
| **H-02** | H-02 | t1 | 成立，但"重复叠加"不成立 | `App.tsx` 未传 `isSaving` → 保存按钮写入期间可连点 → 两次 `apply_tone_cmd`；**附带**后端 XMP 为 `fs::write`（截断+写）且不在 `spawn_blocking` 内 → 并发截断竞态 | `App.tsx:1015-1032`、`TonalAdjuster.tsx:148,401-422`、`xmp.rs:326`、`commands.rs:696-704` | 1.0（含 M-12） |
| **H-03** | H-03 | t1 | 成立，**破坏范围需收窄** | 元数据批量同步默认范围 `all`；且**打开即用当前 EXIF 预填**，有时无需输入即可提交；单次点击即确认 | `MetadataEditorModal.tsx:43,52-59,144-150` | 0.75 |
| **H-04** | L-10 | t4→t1 背书 | **定级上调 LOW → HIGH** | 导出未校验"目标 = 源"；`dst = target_dir.join(src.file_name())`，同目录时 `src == dst`，`std::fs::copy` 同源自拷贝**很可能截断**（Unix `O_TRUNC` 确定） | `commands.rs:210-247`、`BatchExportModal.tsx:73-85` | 0.75（WP0，可独立先交付） |

### 2.2 MEDIUM（17 条，仅列复核后的关键修正；未列者复核无偏差）

| 统一 ID | 轨道 | 复核结论摘要 | 位置 | 备注 |
|---|---|---|---|---|
| M-01 | t2 | 成立；**归因需修正**——独立分支是对两侧套用同一 `factor`，"以 leftScale 为基准"是联动分支 | `SplitCompareViewport.tsx:74-87` | |
| M-02 | t2 | **影响被低估**：LUMEN 解码缺失是 **2/3 视口**（非仅对比）；RAW-only 分组会**直接破图**；对比视图**没有 `tone` prop** | `SplitCompareViewport.tsx:160-164`、`BeforeAfterViewport.tsx:106-110` | "×2 解码成本"担忧**不成立**（`hasJpg` 时零请求） |
| M-03 | t2 | 成立；所谓"已统一"实为**两份逐字复制的 JSX**，既是修复机会也是回归风险 | `PreviewViewport.tsx:162-185`、`BeforeAfterViewport.tsx:121-146` | |
| M-04 | t3 | 成立；**触发按钮有 3 个**（非仅 TopBar），且 `/` 路径已自愈 | `TopBar.tsx:289-304`、`PreviewViewport.tsx:402-408`、`BeforeAfterViewport.tsx:216-220` | |
| M-05 | t4 | 成立；**阶段划分失准**——扫描命令只写 `thumbnail_path: None`，缩略图是渲染期惰性生成；XMP/EXIF 同循环交替，非两阶段 | `commands.rs:24-34`、`scanner.rs:236-503` | 后端**零事件基础设施**（全仓 grep `emit(`/`Channel`/`AtomicBool` 均无） |
| M-06 | t3 | 成立；矛盾形态是"本地刚勾上 → 状态行出现但显示关闭态文案"（文本来自**已保存**配置） | `SettingsModal.tsx:30,51-59,73-85,194-204` | |
| M-07 | t3 | 成立；**同屏矛盾事实为四处**（非三处）——增加宫格表头 `${visible}/${totalLoaded}`；且**命中 > 0 时也不一致** | `ThumbnailGrid.tsx:139-144`、`BottomBar.tsx:105`、`App.tsx:206-212` | |
| M-08 | t5 | 无偏差；补 caveat：React 19 根节点 `wheel` 为 passive，三处 `preventDefault()` 实为空操作（需实机确认） | `PreviewViewport.tsx` 等三视口 | |
| M-09 | t5 | **影响被低估**：同一守卫拦住**所有**单键快捷键；且 **keyup 侧同样有守卫 → `\` 会卡在"查看原片"无法复位** | `useKeyboardShortcuts.ts:57-66,240-248` | 与 H-01 同批提交 |
| M-10 | t3 | 成立；**影响不止 TopBar 按钮**，三处入口同病 | `App.tsx:970,988` | 与 M-04 同批提交（`aria-controls` 依赖稳定 id） |
| M-11 | t2 | **"hover"结论不成立**（两窗格根本无 hover 样式）；更严重的是 `onClick` **无位移阈值 → 拖拽平移右窗格会静默改变选中** | `SplitCompareViewport.tsx:180,187-189` + `App.tsx:1006-1010` | |
| M-12 | t5 | 与描述一致；补实施约束：蒙版滑杆与 `select` 同处一 flex 行，直接套 `.tone-slider` 会撑坏行高，**须先拆行** | `TonalAdjuster.tsx:327-358` | |
| M-13 | t5 | 成立；**对比度数值纠正为 3.77:1**（初版 3.45:1 漏算了背景经剩余 60% alpha 的贡献） | `ThumbnailGrid.tsx:489-497` | HTML 报告已更正 3 处 |
| M-14 | t5 | 无偏差；依赖先把过滤谓词抽成 `matchesFilter` 共享函数 | `TopBar.tsx` 筛选下拉 | |
| M-15 | t5 | **影响被低估**：`useLumenStatus` effect **只依赖 `enabled`** → 改路径/保存设置后引擎状态**永不刷新**，是启动时陈旧快照 | `hooks/useLumenStatus.ts:24-50`、`commands.rs:337` | 故"测试连接"必须配**新探测命令**（现有命令读不到未保存路径） |
| M-16 | t6 | **核心表述不成立，已重新定性**：默认 `pool` **不是**坏的（lead 独立复跑 3 次全绿）。真实问题是**测试有效性**——存在假护栏 + 零 `App.tsx` 集成测试 + 12 条关键路径零覆盖；环境层面另有 pnpm→npm 残留 | `TonalAdjuster.test.tsx:73-90`、`src/test/setup.ts`、`package.json:10` | 修复处方由"固定 pool"改为"不动 config + 环境治理" |
| M-17 | t4 | 成立；**"后端合并写"路线不可行**（后端拿不到防抖窗口内未发送的值）→ 必须前端持最新值 + 3 个 flush 点，且需新增关闭前钩子 | `App.tsx:826-833` | `lib.rs` 无 `on_window_event`、前端无 `onCloseRequested`（双双已验证） |

### 2.3 LOW（11 条）

| 统一 ID | 轨道 | 复核结论 | 一行改法 |
|---|---|---|---|
| L-01 | t2 | 成立（静态徽章与相邻按钮同构） | 降级为纯文本 0.15 人天；做真开关 0.75 |
| L-02 / L-03 | t4 | 成立；补"cap 对错误同样生效且**无去重**"才是信息丢失根因 | 双 live region + `role="alert"` + 去重 + 历史 |
| L-04 | t5 | 成立（滚轮每步都播报） | 删 `<span>` 上的 `aria-live="polite"` |
| L-05 | t5 | 成立（`div` 的 `nameFrom: prohibited`，标签被 AT 忽略） | 加 `role="group"` |
| L-06 | t5 | 成立（虚拟化列表 AT 无法推断总数/位置） | option 加 `aria-setsize` / `aria-posinset` |
| L-07 | t5 | 成立（`tabIndex={-1}` 单元格可被 mousedown 聚焦，两套焦点模型混用） | 删 `tabIndex={-1}` + `onMouseDown={e => e.preventDefault()}` |
| L-08 | t5 | 成立（调色面板 Esc 无效，与所有弹窗约定不一致） | `App.tsx` 加 Esc 监听 + dialog 守卫 |
| L-09 | t5 | **不成立**：图例在滚动容器**之外**且 `shrink-0`，永不移出视野；AT 用户已由单元格 `aria-label` 覆盖 | **无需修复** |
| L-10 | t4 | **已升为 H-04**，不再计入 LOW | 见 §2.1 |
| L-11 | t1 | 成立（无撤销路径，`0/U` 是"清零"不是"撤销"） | 单步撤销：hook + 键位 + Toast 内撤销按钮 |
| **L-12** | t5（新号） | 成立，**由原误记的 L-10 改号而来**（与 t4 的 L-10 冲突已裁决） | 空格让位：`if (e.key === ' ' && isActivatable(el)) return;` |

### 2.4 复核新增（16 条）

| 新增 ID | 轨道 | 定级 | 内容 | 位置 |
|---|---|---|---|---|
| N-01 | t3 | MEDIUM | 同图守卫只在 `!pinnedId` 分支计算 → **钉基准后可左右显示同一张** | `App.tsx:224-231,245-259` |
| N-02 | t3 | MEDIUM | 钉左模式下点击宫格**只改 compareIndex 不改 selectedIndex** → 被点格子无任何视觉标记 | `App.tsx:436-450,1036` |
| N-03 | t3 | MEDIUM | 基准图被筛选/搜索排除后回退到当前选中，但 `isLeftPinned` 仍为 `true` → **UI 谎称它是基准** | `App.tsx:242-249` |
| N-04 | t3 | LOW | 救援 effect 只救 `selectedIndex`，**不救 `compareIndex`** → 对比候选可能落在搜索结果之外 | `App.tsx:206-212` |
| N-05 | t1 | MEDIUM | **组合键未拦截**：现有代码不拦 `Ctrl/Cmd/Alt` → `Ctrl+X` 触发 `onFlag('reject')`、`Ctrl+P` 触发 `pick`、`Ctrl+O` 打开外部程序，**且会写盘** | `useKeyboardShortcuts.ts`（无该分支） |
| N-06 | t2 | MEDIUM | RAW-only 分组把 `.NEF/.CR3` 交给 `<img>` → **破图**（并入 M-02 修复） | `scanner.rs:355-359`、`SplitCompareViewport.tsx:160-164` |
| N-07 | t2 | MEDIUM | 窗格 `onClick` 无位移阈值 → **拖拽平移会静默改变选中**（并入 M-11） | `SplitCompareViewport.tsx:180` |
| N-08 | t2 | MEDIUM | 打分/标记的**作用对象在视口间不一致**：窗格按钮作用于窗格照片，键盘 `1-5/P/X` 作用于 `currentGroup` | `SplitCompareViewport.tsx:266,288` vs `App.tsx:463-464` |
| N-09 | t4 | MEDIUM | 每格一次 `getThumbnail` IPC 且无 inflight 去重；缓存命中仍付 `canonicalize`+`sha256`+多次 stat | `ThumbnailGrid.tsx:387-436`、`thumbnail.rs:149-168` |
| N-10 | t4 | LOW-MED | 虚拟化行高每行 2px 漂移 → 3333 行累计约 6666px | `ThumbnailGrid.tsx:79,83,290,475` |
| N-11 | t4 | MEDIUM | 扫描**纯串行**（`Cargo.toml` 声明 `rayon` 但**零引用**）+ 配对 `Vec::contains` 为 **O(J×R)**（1 万×1 万 ≈ 10⁸ 次字符串比较）→ "万张秒级加载"很可能不成立 | `scanner.rs:236-503,344-349`、`Cargo.toml` |
| N-12 | t5 | MEDIUM | `useLumenStatus` 只依赖 `enabled` → 引擎状态永不刷新（M-15 的独立成因） | `hooks/useLumenStatus.ts:24-50` |
| N-13 | t6 | MEDIUM | `TonalAdjuster.test.tsx` 的「不会重复触发保存」是**假护栏**：只 `click` 一次、从未双击，且显式注入 `isSaving`，与 App 真实集成脱节 | `TonalAdjuster.test.tsx:73-90` |
| N-14 | t6 | MEDIUM | 全项目**零 `App.tsx` 集成测试**；9 个测试文件中 7 个与 LUMEN 相关；12 条关键路径零覆盖 | `src/**/*.test.tsx` |
| N-15 | t6 | LOW | pnpm→npm 迁移残留：`node_modules__pnpm_backup/`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 与 `package-lock.json` 并存 | 仓库根 |
| N-16 | t1 | MEDIUM | `apply_tone_cmd` 的 XMP 写入（`fs::write` 截断+写）**不在 `spawn_blocking` 内** → 并发可截断 `.xmp` | `commands.rs:696-704`、`xmp.rs:326` |

### 2.5 批次 D 实施期**追加发现**（复核报告未列，实施时由 impl-d1-tests 发现）

| 新增 ID | 定级 | 内容 | 位置 | 处置 |
|---|---|---|---|---|
| N-17 | LOW | **`BeforeAfterViewport` 半成品接线 / 死 API 面**：props 声明了 `onPrev?`/`onNext?`，App 也**确实传了** `handlePrev`/`handleNext`，但组件从未解构、从未消费（无「上一张/下一张」按钮）→ 死 props + 空的传参链路 | `BeforeAfterViewport.tsx:28-29`（接口）、`:49-64`（解构缺失）、`App.tsx:1114-1115`（传参） | **已修**（批次 D）：**删除**这两个未被消费的 props 与 App 侧传参。**未**新增翻页 UI —— 属功能变更（见下） |

**为何选"删除"而非"补翻页按钮"：** `PreviewViewport`（单图）有 ChevronLeft/Right 覆盖层且 props 为**必填**；`SplitCompareViewport` 从一开始**就没有**这对 props。只有 `BeforeAfterViewport` 声明了**可选**却永不用 —— 这是死面，不是功能缺失。若改为补按钮，只补 Before/After 会造成**新的**三视口不对称；两处都补则是**功能新增**（涉及布局与"对比视图是否要翻页"的产品判断），超出 31.0 人天修复范围。删除可逆：日后若产品要翻页，恢复 props 并按 `PreviewViewport:264-286` 复制 JSX 即可。

---

## 3. 复核推翻 / 修正 / 新增清单（诚信章节）

> 本节是最该被阅读的部分：它记录了初版审计**错在哪**。lead 已据此把 `UX-AUDIT-2026-10-12.html` 就地更正。

### 3.1 被推翻（原判不成立）

1. **M-16「默认 pool 下 9/9 文件启动失败、0 用例执行」→ 未复现。**
   - t6 复跑：默认 `pool: 'forks'` 下连续 6 次 + 3 并发全部 `9 passed / 104 passed / exit 0`；`forks`/`threads`/`vmForks` **三者全绿**，`vmForks` 非独有解。
   - **lead 独立复跑 3 次确认**（`npx vitest run`，未指定 pool）→ 全绿。
   - 原结论的三条"支撑证据"中，仅「`npm ls` 去重干净」成立；「全局 `it()` 通过」未验证；「显式 `import` 失败」**与事实相反**——9 个测试文件**全部**显式 `import from 'vitest'` 且全绿。
   - 修复处方（固定 `pool: 'vmForks'`）**一并撤回**：上游 vitest-dev/vitest#8861 显示 `vmForks` **同样**会命中该竞态，把 vmForks 当解药无据。
   - 真实异常点：pnpm→npm 迁移残留叠加 vitest 4.1.x 在 Windows 上"**安装后首次运行**"的 pool 启动竞态（与上游 #10812 特征逐条吻合）。时间线吻合——`node_modules` 于 10-12 10:28 新装，初版二分定位正落在这个窗口内。
2. **L-09「R/X/T/E 徽章图例滚动后不在视野」→ 前提错误。** 图例（`ThumbnailGrid.tsx:226-242`）位于滚动容器（`:254 overflow-y-auto`）**之外**的同级兄弟且 `shrink-0`，永不移出视野。**判定无需修复。**
3. **H-02「重复施加 LUMEN 编辑态会叠加」→ 不成立。** `tone_to_recipe`（`lumen.rs:595-619`）是**最终值语义**，`apply_edits` 覆盖式赋值，重复施加同一 tone **幂等**。

### 3.2 定级/影响面上调

4. **L-10 → H-04（LOW → HIGH）**：依据是 Rust 标准库 `std::fs::copy` 文档原文——"**if `from` and `to` both point to the same file, then the file will likely get truncated**"。真发生即用户原始 RAW/JPG 被清空（不可逆、无备份）。
5. **M-09 影响面扩大**：从"拖滑杆时按 `\` 失效"扩到「**所有**单键快捷键被拦」+「`\` 因 keyup 侧同守卫而**卡在查看原片**无法复位」。
6. **M-02 影响面扩大**：LUMEN 解码缺失是 **2/3 视口**；RAW-only 分组**直接破图**（可用性缺陷，非仅"显影不同"）。
7. **M-07 时间范围扩大**：同屏矛盾事实由三处变**四处**；且**命中 > 0 时也不一致**（只是形态不同）。
8. **M-04 / M-10 位置扩大**：调色面板触发按钮有 **3 个**入口，全部缺 `aria-controls/aria-expanded`。
9. **M-15 影响面扩大**：不只是"缺浏览/测试连接"，`useLumenStatus` 的**状态永不刷新**才是根因（需新增后端探测命令）。
10. **M-11 不一致程度更高**：不是"hover 也对称"，而是**根本没有 hover 反馈**；且拖拽会静默改选中。

### 3.3 破坏范围收窄（原判过重）

11. **H-03**：`update_xmp_metadata`（`xmp.rs:400-418`）**只覆盖镜头三件套**，星级/旗标/调色与第三方命名空间**均保留** → 定性应为"批量误改镜头元数据"，**不是**"销毁侧边栏"。
12. **M-16 的"回归手段处于失效状态"过重** → 应为"回归网**可用但保护力不足**"。
13. **`reading 'config'` 的来源**：本版本 `@vitest/runner` 的 `getRunner()` 走 `assert()` 抛 `Vitest failed to find the runner`，**不会**直接抛 `reading 'config'`；后者见于上游 #10812 的现象描述，属同一单例缺失的**另一种表现**。

### 3.4 事实性更正

14. **对比度 3.45:1 → 3.77:1**（`text-white/40` on `#0A0A0A`）。偏差成因：初版算成 `0.4×255 = 102`（`#666666`），**漏掉背景经剩余 60% alpha 的贡献 `0.6×10 = 6`**；正确合成 `0.4×255 + 0.6×10 = 108`（`#6C6C6C`）。**结论不变**（均 < 4.5:1，仍违反 AA 1.4.3）。附修正值：`/30 = 2.59`、`/40 = 3.77`、`/50 = 5.33`、`/60 = 7.30`、`/70 = 9.71`、`/80 = 12.58`。
15. **命令数 26 → 25**（`lib.rs:27-53` 实际注册 25 条）。
16. **`pnpm test` → `npm test`**：项目已于 10-12 迁到 npm（`package-lock.json` 与 `node_modules` 同日新建）。
17. **控制面命名**：`src/test/setup.ts` **无** `mockInvokeHandler`，实际导出 `setInvokeHandler`（另有 `mockInvokeCommand`、`mockInvokeError`、`invokeCalls`、`invokeCount`、`lastInvokeArgs`、`allInvokeCalls`、`resetInvokeMocks`）。未注册命令默认抛 `UnmockedCommandError`，**不静默返回 `undefined`**。
18. **`vite` 版本**：`package.json` 字面 `^6.1.1`，**实际安装 6.4.4**。
19. **索引不是三套而是五套**：`filteredGroups`、`filteredIndices`、`visibleGroups`、`selectedIndex`、`selectedVisibleIndex` 并存。
20. **`M-12` 的"直接复用 `.tone-slider` 是否可行"**：可行，**但有前提**——须先把蒙版滑杆从与 `select`/`套用` 共用的 flex 行里拆出来。

### 3.5 原报告的"待查项"已得到确定答复

21. **左右对比是否会显示同一张？会。** 根因：同图守卫只覆盖 `!pinnedId` 分支（`App.tsx:233-239` vs `:245-259`）。（→ N-01）
22. **基准图被过滤掉后行为异常？确认异常。** `App.tsx:243` 回退到当前选中，但 `isLeftPinned` 仍为 `true`。（→ N-03）

---

## 4. 跨轨冲突裁决记录（lead 裁定）

> 六条轨道并行调查，有三处**会互相覆盖**的冲突点。以下裁决已下发给各轨道，并由各轨道写回其报告。

### 4.1 键盘守卫归属：**唯一 owner = t1-data-safety**

- **冲突**：`useKeyboardShortcuts.ts` 的 `handleKeyDown`/`handleKeyUp` 是**同一个函数**，而 H-01（t1）、M-09 + L-12（t5）都要改它。两套骨架若分别实现，必然互相覆盖。
- **裁决**：**唯一实现真值 = `ux_fix_01_p0_data_safety.md` 附录 B**。t5 只贡献规则（R1 `\` 放行、R2 keyup/失焦兜底、R3 空格 `isActivatable`），**不另出骨架**。
- **强制约束**：**H-01 + M-09 + L-12 + N-05 必须打包为同一次提交**，拆开等于必回归。

### 4.2 守卫谓词公式：**lead 的初版裁决有误，已修正**（记录备查）

- lead 下发裁决时，把 t5 的通用守卫公式 `isTextEntry(el) || tagName === 'SELECT'`（临时名 `isValueOrText`）**原样转发**给 t1。
- **t1 实证复核发现这是新引入的回归**：该式**漏掉 `input[type=range]`** → 调色面板六根滑杆聚焦时方向键会被全局 handler 劫持去切照片，且 `preventDefault` 会连同滑杆原生键盘调整一起取消 → **滑杆键盘不可用**。而**当前实现本无此问题**（现有守卫拦任意 `INPUT`）。
- **修正后的定稿**（唯一命名，已写入 t1 附录 B）：
  - `isFormControlOrEditing` = **任意 `INPUT`（含 range/checkbox/radio/…）+ `TEXTAREA` + `contentEditable` + `SELECT`** ← 通用守卫，**只保留这一个谓词名**；`isValueOrText` **废弃**。
  - `isTextEntry` 语义收窄为"**仅文本录入类**"，**只**服务 `\` 的让位判断；已确认其**包含 `TEXTAREA` 与 `contentEditable`**。
  - 判定顺序即正确性的一部分：① 模态兜底 → ② IME 合成期 → ③ `\` **提前** → ④ 通用守卫 → ⑤ 空格让位 → ⑥ 组合键让路 → ⑦ 原有分支。

### 4.3 `[role="listbox"]` 绝不能进守卫（**初版处方会致回归**）

- 初版 WP1 写的"守卫扩展到 `role="listbox"`"**是错的，已撤回**。
- 原因：项目唯一的 listbox 是缩略图宫格（`ThumbnailGrid.tsx:254-266`），其 `a/d/←/→/1-5/x/p` **依赖全局 handler**（`handleListKeyDown` 只处理 Up/Down/Home/End/PageUp/PageDown，且**不 `stopPropagation`**）。加进守卫会**废掉宫格主交互**。
- 同时确立一条原则：判定维度只能是**焦点控件的类型**（文本/值控件 early-return），**不能按容器角色**。

### 4.4 编号冲突：两个 `L-10`

- t4 的 `L-10` = 批量导出未校验"目标 = 源" → **升为 H-04**。
- t5 的空格劫持原本**也**误记为 `L-10` → **改号 L-12**（`L-11` 已被 t1 的"无撤销"占用）。
- 本总表在 §2 保留了 `L-10 → H-04` 的显式映射，以免检索断链。

### 4.5 文件级归属划分（避免两轨改同一文件）

| 文件 | 唯一 owner | 其他轨道立场 |
|---|---|---|
| `useKeyboardShortcuts.ts` | **t1**（骨架定稿） | t5 只提供规则，不写实现 |
| `Toast.tsx` | **t4**（L-02/L-03） | t5 **不改**，仅补充 a11y 依据（错误走 assertive 且不自动消失） |
| `MetadataEditorModal.tsx` 文案 | **t1**（H-03） | t5 只从"文案真值"角度确认，采用 t1 措辞 |
| `App.tsx:217-260`（索引区） | **t3** | t2 的 M-02 tone 来源须与 t3 保持**同一真值源** |
| `vitest.config.ts` | **t6** | 结论是**不改** |

### 4.6 一个被 lead 拦下的越权编辑

t4 曾把 `lumen.rs:741-752` 里的 `progress`/`cancelled`/`deadline` 字段视为"预留但未使用的死代码"并考虑清理。lead 判定：这些是 **LUMEN 渐进解码流程的既有设计留白**，不是本工具箱范围，**禁止改动**；按只读边界处理，仅记录不动作。t4 接受该裁决（其产物保持只读）。

---

## 5. 修复批次与提交约束

| 批次 | 内容 | 人天 | 提交约束 | 前置依赖 |
|---|---|---|---|---|
| **批次 A（止血）** | WP0 + WP1 + WP2 + WP3 | 3.5 | `useKeyboardShortcuts.ts` 的四条（H-01/M-09/L-12/N-05）**必须同一提交**；WP0 可独立先交付 | 无 |
| **批次 B（一致性）** | WP4 + WP6 | 10.5 | **M-10 必须先于 M-04**（`aria-controls` 依赖稳定 `id` 与单真值 `tonalPanelVisible`）；M-07 走"口径标注"方案可零索引改动，**先于** N-01 落地，避免二次触碰索引区 | 批次 A 的 tone 真值（WP2） |
| **批次 C（完整）** | WP5 + WP7 | 11.0 | WP5 的取消基础设施（`AtomicBool` + cancel 命令）**先于**扫描/导出进度接入；导出收尾策略需先定（见 §10） | 批次 B |
| **批次 D（加固）** | WP8 + WP9 | 6.0 | WP8 的环境治理（删 pnpm 残留）**先于** CI 接入；每个 HIGH 修复的用例应"**修复前应失败**" | 全部 |

**总工作量**：3.5 + 10.5 + 11.0 + 6.0 = **31.0 人天**（与 §7 报价表算术一致）。

### 每条 HIGH 的"修复前应失败"用例（批次 A 的验收线）

| ID | 用例 | 断言 | 修复前预期 |
|---|---|---|---|
| H-01 | `select 聚焦时数字/字母快捷键不触发全局动作` | `<select>` 聚焦 → 回调 0 次；body 聚焦 → 1 次 | **失败**（当前 1 次） |
| H-01/L-12 | `按钮聚焦时空格不触发「设为基准」` | `onPinRight` 0 次 | **失败**（当前双触发） |
| H-02 | `保存进行中双击不会触发第二次 onSave` | `onSave` 1 次 + 按钮 `toBeDisabled()` | **失败**（当前 2 次） |
| H-02 | `保存挂起期间 apply_tone_cmd 只发一次` | `invokeCount('apply_tone_cmd') === 1` | **失败** |
| H-03 | `默认同步范围是「仅当前选中照片」` | 默认 radio 勾选 + footer「将更新 **1** 张」+ `filePaths.length === 1` | **失败**（当前 `all`） |
| H-04 | `export_rejects_target_equal_to_source_dir` | 返回 `Err` **且源文件字节数不变** | **失败**（当前 `Ok(0)` 或文件已损坏） |

> ⚠️ **H-04 的手工验收必须先备份**：该用例在修复前会真的把原图截断为 0 字节。

### 已知会出现的可控回归（须在验收清单里显式回归）

1. **`Ctrl/Cmd+F` 在焦点位于 input/select 时不生效**——与**现有实现完全一致**（现有 INPUT 守卫本就在 `Ctrl+F` 分支之前），属**行为延续而非新回归**，骨架**有意不改**。若要 `Ctrl+F` 全局可达，需显式把该分支提到步骤 ④ 之前，并请产品确认"在输入框内也抢走 Ctrl+F"。
2. **组合键让路（步骤 ⑥）是新增硬化**：现有代码**不**拦组合键，故 `Ctrl+X/Ctrl+P/Ctrl+O` 当前会误触并写盘（N-05）。加此步骤后这些组合键不再触发全局动作，但 `Ctrl+F` 显式豁免以保留搜索聚焦能力。
3. **宫格内空格仍 = 设为基准**（`[role="listbox"]` 不在 `isActivatable`）——与 `ShortcutHelpModal` 文案一致，**有意保留**。

---

## 6. 风险登记册

| # | 风险 | 触发条件 | 概率 | 影响 | 等级 | 缓解措施 | owner |
|---|---|---|---|---|---|---|---|
| R1 | **原图被截断为 0 字节** | 导出目标目录 == 源照片目录（`fs::copy` 同源） | 低（需用户误操作） | **不可逆数据丢失** | **极高** | WP0 后端 `canonicalize` 自检整体拒绝 + 前端禁用按钮；**立即交付，不等其他批次** | t4 |
| R2 | **非本意 XMP 落盘写入** | 焦点在下拉/按钮上按键；或 `Ctrl+X/P/O` | 高（日常可达） | 星级/旗标被静默改写 | **高** | 批次 A 守卫修复；配套 L-11 单步撤销兜底 | t1 |
| R3 | **XMP 被并发写截断** | 保存连点 或 多命令并发写同一 `.xmp`（`fs::write` 截断+写，且在 `spawn_blocking` 之外） | 中 | 侧边栏损坏 | **高** | 前端 `isSaving` 互斥 + 后端改原子写（临时文件 + rename）+ 移入 `spawn_blocking` | t1 |
| R4 | **批量误改全库镜头元数据** | 元数据弹窗用默认 `all` 且 EXIF 预填后直接提交 | 中 | 上万份侧边栏镜头字段被覆盖（星级/旗标保留） | **中高** | 批次 A：默认 `filtered`、`all` 二次确认、footer 写明范围与被影响张数 | t1 |
| R5 | **守卫修复引入滑杆键盘回归** | 采用漏掉 `input[type=range]` 的守卫公式 | — | 六根调色滑杆方向键失效 | **中高** | 已裁决为 `isFormControlOrEditing`（任意 INPUT）；验收清单含"range 聚焦时方向键仍是调滑杆而非翻页" | t1 / t5 |
| R6 | **守卫加入 `listbox` 废掉宫格** | 按初版 WP1 处方实现 | — | 宫格 `a/d/←→/1-5/x/p` 全部失效 | **中高** | 初版处方已撤回；原则写入 §4.3 | lead 裁定 |
| R7 | **索引区改动引发选择性错乱** | 同时改 `App.tsx:217-260` 与 `:436-450` | 中 | 对比/pin/swap × 筛选/搜索 组合回归 | **中高** | 先落地 M-07 零索引方案，再单独处理 N-01；回归矩阵覆盖 4 种组合 + 2 个 effect | t3 |
| R8 | **导出取消后目标目录残留半成品** | 取消或强杀进程 | 中 | 目标目录出现部分集合 | 中 | 推荐"临时目录 → 原子搬迁"；若工期紧用"保留 + 清单文件"（**绝不能**用"删除已复制"——会误删用户原有同名文件） | t4 |
| R9 | **扫描/导出无可中断路径** | 万张规模下用户想停 | 高 | 只能强杀进程 | 中 | 批次 C 的 `AtomicBool` + cancel 命令；检查点放在 `for item` 每次迭代开头，**不要**试图中断进行中的 `fs::copy` | t4 |
| R10 | **CI 上偶发测试启动失败** | Windows + `npm ci` 后首次运行（上游 #10812） | 中 | CI 偶红 | 中 | 不动 config；CI 上用命令行逃生阀 `--pool=vmForks` 或 `--maxWorkers=1` 并注释"规避上游竞态，非终态"；ubuntu 主任务 + Windows 定时观测 | t6 |
| R11 | **"修了但证明不了"** | 关键路径无测试（12 处零覆盖）+ 存在假护栏 | 高 | HIGH 修复无回归保护，易复发 | **高** | 批次 D：把假护栏改真并发断言 + 补 12 条用例 + 首个 `App.tsx` 集成测试；每条 HIGH 都要求"修复前应失败" | t6 |
| R12 | **实机行为与源码推导不符** | 无 WebView2，4 类浏览器/OS 行为未实测 | 中 | 修错方向 | 中 | 已列 §9 未验证清单；WP9 实机阶段逐项确认；结论**不依赖**未验证分支（如 H-04 无论截断还是共享冲突都该修） | lead / WP9 |

---

## 7. 修订报价（与 `UX-AUDIT-2026-10-12.html` §7 一致）

**单价假设 ¥1,200 / 人天**（可按公式替换：金额 = 人天 × 你的日单价）。

| WP | 工作包 | 覆盖 | 人天 | 金额 |
|---|---|---|---|---|
| WP0 | 数据安全止血 | H-04, N-16 | 0.75 | ¥900 |
| WP1 | 快捷键作用域与焦点守卫 | H-01, M-09, L-12, N-05 | 1.0 | ¥1,200 |
| WP2 | 调色写入可靠性 | H-02, M-12 | 1.0 | ¥1,200 |
| WP3 | 批量元数据安全默认值 | H-03 | 0.75 | ¥900 |
| WP4 | 三视口一致性 | M-01/02/03/11, L-01, N-06/07/08 | 3.0 | ¥3,600 |
| WP5 | 长任务进度、取消与会话 | M-05, M-17, N-11 | 6.25 | ¥7,500 |
| WP6 | 焦点与状态真值 | M-04/06/07/10, N-01/02/03/04 | 7.5 | ¥9,000 |
| WP7 | 文案、识别成本与 a11y 收尾 | M-08/13/14/15, L-01…L-09, L-11, N-12 | 4.75 | ¥5,700 |
| WP8 | 工程基座（测试有效性 + 环境治理） | M-16, N-13/14/15 | 3.5 | ¥4,200 |
| WP9 | Tauri 实机回归与性能实测 | 全部 + N-09/10 | 2.5 | ¥3,000 |
| **合计** | | **4 HIGH + 17 MEDIUM + 11 LOW + 16 N** | **31.0** | **¥37,200** |

### 分档（累积口径，③ 含 ①②，④ 含 ①②③）

| 档 | 内容 | 人天 | 金额 | 交付后 |
|---|---|---|---|---|
| ① 紧急止血 | WP0+WP1+WP2+WP3 | 3.5 | ¥4,200 | 不再有非本意 XMP 落盘；不再可能"导出把原图截断为 0 字节" |
| ② 标准修复 ★ 建议 | ① + WP4 + WP6 | 14.0 | ¥16,800 | Quick Diagnostic 回到 9–10/10 |
| ③ 完整交付 | ② + WP5 + WP7 | 25.0 | ¥30,000 | 功能类条目全部闭环 |
| ④ 工程加固 | ③ + WP8 + WP9 | 31.0 | ¥37,200 | 每个 HIGH 修复都有"修复前应失败 / 修复后通过"的自动化证据 |

### 与初版报价的差异说明

初版 **9.0 人天 / ¥10,800** 仅覆盖"最小机械修复"。上调至 **31.0 人天** 的三个主因：

1. **后端需要真实基础设施改造**（Rust 侧约 5.5 人天）：进度事件（全仓零 `emit`/`Channel`）、`AtomicBool` 取消、XMP 原子写、导出目录自检、扫描配对 `HashSet`。这些在初版里被当作"前端小改"严重低估。
2. **索引与状态真值问题比初判更深**：同图守卫只覆盖一个分支、同屏四处计数不同源、五套索引并存、基准被静默替换——修复必须动 `App.tsx` 的索引联动核心（WP6 = 7.5 人天，初版记 1.5）。
3. **回归网需要补建**：12 条关键路径零覆盖 + 1 条现有用例是假护栏 + 零 `App.tsx` 集成测试。

**若预算受限**：① 档 ¥4,200 已覆盖全部 4 条 HIGH 中的 4 条（H-01/H-02/H-03/H-04 全在批次 A），是**性价比最高的一档**——它把"会写坏数据"的洞全部堵上。

---

## 8. 验证计划（汇总）

### 8.1 每条 HIGH 的自动化验证

见 §5 末表（6 条用例，全部要求"修复前应失败"）。

### 8.2 每轨的测试护栏清单（t6 提供，可直接照抄）

| 轨道 | 测试文件 | 用例 | mock 设定 | 断言要点 |
|---|---|---|---|---|
| H-01 | `hooks/useKeyboardShortcuts.test.tsx`（新） | `select 聚焦时…不触发全局动作` | 无 IPC；`renderHook` + 全 `vi.fn()` 回调 | `<select>`/按钮聚焦 → 回调 0 次；body → 1 次；`role=dialog[aria-modal=true]` → 0 次 |
| H-01 | 同上 | `按钮聚焦时空格不触发「设为基准」` | 同上 | `onPinRight` 0 次 |
| H-02 | `TonalAdjuster.test.tsx`（**改假护栏**） | `保存进行中双击不会触发第二次 onSave` | `onSave = vi.fn(() => gate)` 挂起，**不传** `isSaving` | `click`×2 → 1 次；按钮 disabled；文案含「保存中…」 |
| H-02 | `App.toneSave.test.tsx`（新） | `保存挂起期间 apply_tone_cmd 只发一次` | `setInvokeHandler` 让 `apply_tone_cmd` 返回挂起 Promise | `invokeCount === 1` |
| H-03 | `MetadataEditorModal.test.tsx`（新） | `默认同步范围是「仅当前选中照片」` | `mockInvokeCommand('batch_update_metadata_cmd', 1)` | 默认 radio checked；footer「将更新 1 张」；`filePaths.length === 1` |
| M-01 | `SplitCompareViewport.test.tsx`（新） | `关闭联动后放大只改变左窗格缩放` | 无 IPC；`convertFileSrc` 已 mock | 左 `scale` 变、右保持 1；联动开启时相等 |
| M-05 | `BatchExportModal.test.tsx` + `App.scan.test.tsx`（新） | `导出/扫描进行中禁用并显示进度，取消后不再 invoke` | `setInvokeHandler(cmd => new Promise(()=>{}))` | 按钮「导出中…」+disabled；有 `aria-live` 进度；取消后 `invokeCount` 不再增长 |
| M-07 | `App.searchCounter.test.tsx`（新） | `搜索态下宫格/中心视口/底栏计数指向同一张` | `mockInvokeCommand('scan_folders_cmd', {groups:[a,b,c,d,e]})` | 底栏 `共 M 张` 的 M = 可见集大小；中心视口 `baseName==='c'`；宫格 `aria-activedescendant` 亦为 `'c'` |

### 8.3 手工/实机验证（WP9）

1. 修复前**必须先备份**：把导出目标设成源目录 → 期望（修复后）立即被拒；期望（修复前应失败）出现原图被清空或导出静默失败。
2. `<select>` 聚焦后按 `1-5/x/p` → 期望评级/旗标不变、XMP 未写。
3. 按钮聚焦后按空格 → 期望按钮被激活、基准不变。
4. 调色面板滑杆聚焦后按方向键 → 期望滑杆数值变化、不切照片。
5. 连点「保存调色」→ 期望只发一次 `apply_tone_cmd`。
6. 1 万张压测（构造脚本见 `ux_fix_04_long_task_scale.md` 末节）：扫描基线耗时、滚动帧率、LUMEN 网格冷缓存首刷、导出耗时与取消响应。

---

## 9. 未验证项总表（`Not verified`）

| # | 未验证项 | 原因 | 是否影响结论 |
|---|---|---|---|
| U1 | 真实渲染截图（各界面态） | agent-browser 在本环境启动后无响应（挂起 >20 min），已终止并降级为"源码 + 构建产物 + 测试实跑"三重证据 | **影响**：所有视觉/响应式判断均为源码推导，未做像素级核对 |
| U2 | `<select>` type-ahead 能否被 `keydown.preventDefault()` 抑制 | 本机无运行中的 WebView2 | **不影响**：伤害来自我们自己的 handler 在冒泡阶段同步执行，与 type-ahead 无关 |
| U3 | 按钮空格激活是否被 `preventDefault()` 抑制 | 同上 | 不影响定性（H-01/L-12 的修复方向不变），影响验收方式 |
| U4 | React 19 被动 `wheel` 监听下三处 `preventDefault()` 是否为空操作 | 同上（源码推导为空操作） | 不影响修复（M-08 需改实现或改文案，二选一） |
| U5 | `fs::copy(p, p)` 在 **Windows** 上究竟"截断"还是"共享冲突失败" | 只读约束，未做真机实验 | **不影响**：两者都不可接受，修复方案与分支无关（Unix `O_TRUNC` 截断已由 Rust 文档确定） |
| U6 | LUMEN 网格缩略图"每张 ~0.3s" | 外部假设，源码无法给出（源码只能证明**硬串行**） | 影响性能排期精度，不影响"需要节流"的结论 |
| U7 | "上万张秒级加载" | 未实测 | **很可能不成立**（`rayon` 零引用 + 配对 O(J×R)），建议作为性能核查第一优先级 |
| U8 | t6 的对照项 A（去掉 `setupFiles` 仍失败）/ B（移出项目根通过） | 需改 config / 库外建文件，违反只读约束 | **不影响**：9 文件全用显式 import 且全绿，说明失败不依赖 setup 与项目内位置 |
| U9 | 修复后的状态 | 尚未实施 | 由 WP9 承接 |
| U10 | 真实照片库行为：RAW 解码、XMP 与 Lightroom 往返、LUMEN 握手、自动调色直方图取样、更新弹窗 | 需装有相机原片与 LUMEN RAW 的机器 | 由 WP9 承接 |

---

## 10. 待决产品问题（不拍板就不动工，否则返工）

| # | 问题 | 影响条目 | 现状 | 备选 |
|---|---|---|---|---|
| Q1 | `edited`（Luminar 成果）在**三视口**各自显示与否，成品真值以谁为准？ | Q3 类（t2） | 三者各不相同：单图不看、对比不看、前后照看 | ① 统一"优先显示 edited" ② 统一"只显示 jpg/raw" ③ 保持差异但加明确标签 |
| Q2 | 钉左基准的 split 模式下，**宫格点击的照片算不算"选中"**？ | N-02 | 只改 `compareIndex`，宫格纹丝不动 | ① 加第二重"候选"标记（保留"选中≠候选"语义）② 统一为一个索引（点哪选哪） |
| Q3 | 独立缩放要不要做成**真开关**？还是把文案改成与实现一致？ | M-01, L-01 | 文案承诺独立、实现仍联动 | ① 做真开关（0.75）② 改文案（0.15，但不推荐——M-08 同类问题会再犯） |
| Q4 | 导出取消的收尾策略：**all-or-nothing**（临时目录 + 原子搬迁）还是**保留已完成 + 清单文件**？ | M-05, H-04 | 当前无任何收尾 | ① 临时目录（唯一能保证目标目录干净，但需同卷 + 额外空间）② 保留 + 清单（成本最低，无破坏风险）— **绝不能**选"删除已复制" |
| Q5 | 回收站/删除流程要不要做？（`api.trashPhotos` 与 `trash_photos_cmd` **已完整接通但全项目零 UI 调用**） | 能力闲置 | 选片工具缺少"移除"路径，"已淘汰"照片无处可去 | 需定影响范围（本张/筛选集/全部已淘汰）与确认/撤销文案；+1.5–2.0 人天 |
| Q6 | 是否接受"`Ctrl+F` 在输入框内不生效"这一既有的行为延续？ | 守卫骨架步骤 ⑥ | 现状即如此 | ① 接受（最小改动，骨架有意不改）② 显式提前该分支（需确认"在输入框内也抢走 Ctrl+F"可接受） |
| Q7 | 打分/标记在 split 模式下**作用于窗格照片还是当前选中**？ | N-08 | 窗格按钮作用于窗格照片，键盘作用于 `currentGroup` — 不一致 | 需统一为一种语义 |

---

## 11. 附：本次复核用到的可复现命令

```bash
# lead 的独立验证（本文档结论的支撑）
npx vitest run                 # 默认 config，未指定 pool → 3 次连续全绿（9 文件 / 104 用例）
npx vitest run --pool=vmForks  # 对照
npx vitest run --pool=threads
npx vitest run --pool=forks
ls -d node_modules__pnpm_backup pnpm-lock.yaml pnpm-workspace.yaml   # pnpm 残留确认
node -e "console.log(require('./node_modules/vitest/package.json').version)"  # 4.1.11
npx tsc --noEmit && npx vite build   # 均 exit 0

# 各轨道报告内的逐条证据命令见各自文件末节
```

### 引用来源（上游 issue，t6 提供）

- **vitest-dev/vitest#10812** — *Intermittent "Vitest failed to find the runner" — every test file fails at suite scale on Windows*（全套文件级全灭 / 0 用例 / 重跑即过 / 4.1.9 只在 `npm install` 后第一次失败，环境 `Windows 11 + vitest 4.1.10 + vite 6.4.2`，与本机同族）
- **vitest-dev/vitest#8861** — `forks` **与** `vmForks` 都随机出错，`threads` 正常（故 `vmForks` 不能作为解药）
