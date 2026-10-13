# 修复计划验证台账 — 逐条源码复核裁决

**日期**:2026-10-13(第二轮)
**对象**:`.plan/remediation-plan-2026-10-13.md` 全部 73 条可动作项 + 5 条记录项
**方法**:6 个并行只读 subagent,按域分片(后端 xmp / 后端 commands / 后端 lumen / 前端 UX / 前端 FE / 计划内聚),各自带 file:line 证据;另主审实跑 `npm test`
**性质**:只读复核。未修改任何源文件。

**分片与防 context 溢出**:初版有 5 个 plan subagent 因读取大文件(lumen.rs 3213 行、App.tsx 1753 行)触发 3 次 context 溢出。本轮强制约束"只 grep 定位 + read offset/limit ≤60 行",6 个分片全部完成。

**裁决口径**:CONFIRMED = 文件/行号/代码事实逐字对上;DRIFT = 结论不变但行号或计数偏差;REFUTED = 与源码不符;UNVERIFIED = 无法确认。

---

## 0. 新增 P0:工作树测试红(本轮实测,初版完全未覆盖)

主审实跑 `npm test`:

```
Test Files  3 failed | 33 passed (36)
     Tests  8 failed | 249 passed (257)
```

| 失败文件 | 条数 | 状态 | 失败断言 |
|---|---|---|---|
| `src/App.pinSpace.test.tsx` | 4 | `??` 未跟踪(新) | 空格设基准:期望落当前照片,实得相邻张 |
| `src/App.rateClearsReject.test.tsx` | 2 | `??` 未跟踪(新) | 打分后 flag 必须 `none`,实测透传 reject |
| `src/components/ThumbnailGrid.selectionSync.test.tsx` | 2 | `??` 未跟踪(新) | 高亮应为 `selectedIndex ∪ selectedIds` 并集 |

**判定:在途 WIP,非回归。** 3 个测试文件全部未跟踪;`App.tsx`(+622/-82)与 `ThumbnailGrid.tsx`(+170)有大量未提交改动。即"测试已按期望行为写好,实现尚未跟上"。

**根因已定位** —— `ThumbnailGrid.tsx:450-453`:

```tsx
const isSelected =
  activeIds.size > 0
    ? activeIds.has(group.id)      // 多选:集合独占
    : itemIndex === selectedIndex; // 单选:仅索引
```

互斥(either/or)真值 vs 测试要求的并集(union)真值。改动点单一,但会牵动 `handleCellClick` toggle 语义、`aria-selected` 与 ghost option(UX-19)。

**影响**:本计划所有 `npm test` 验证门在此之前都无意义。已作为 P0-VER 置于 Batch 1 首位。

---

## 1. 后端 xmp.rs(分片 1)

| ID | 裁决 | 实测行号 | 证据 / 修正 |
|---|---|---|---|
| **BE-01** | ✅ CONFIRMED 逐字 | `399-407` / `415-438` | `XmpMetadata` 确有 `Default` derive;`read_xmp_full` 填充 lens/tone,`..Default::default()` 清零路径真实存在。现有测试**未覆盖** reject+lens 保留 → "测试先行"成立 |
| **BE-02** | ✅ CONFIRMED,**比计划更严重** | `385-396` | 签名确为 `-> String`(非 `Result`)。⚠ 回退路径**连调用方已读出的 `meta` 也丢弃**(只传 `&XmpMetadata::default()`)→ rating/label/lens/tone **全丢**,严格劣于 BE-01。所有调用点需传播 `Result` |
| **BE-05** | ⚠ 计数低估 | parse 链 **7 处**(计划 6):`103,105,107,109,114,117,119` | 命名空间 URI 三重定义 `145-150 / 261-264 / 339-348` 确认。3 个 read-modify-write 骨架 `415-438 / 441-459 / 462-480` 确认 |
| **BE-12** | ✅ CONFIRMED 零风险 | `410-412` | 逐字单行透传,3 处调用点。纯机械删除 |
| **BE-13** | ✅ CONFIRMED | `138-141` | 全 `src-tauri/src/` **零生产调用方**;仅 `1042`、`1054` 两处测试自用,且与 `read_xmp_full` 部分重复。`#[allow(dead_code)]` 名副其实 |

---

## 2. 后端 commands.rs(分片 2)

| ID | 裁决 | 实测 | 修正 |
|---|---|---|---|
| **BE-03** | ⚠ 计数对、**前提错** | 守卫 11 处确认 | ⚠ **11 处不同构**:`apply_tone_cmd` 的守卫在函数中段(1233-1247)且走 warning 降级,`?` 早退不适用 → helper 需两个变体。计划"11 处替换为 `?`"对这一处不成立 |
| **BE-04** | ⚠ 计数低估 | `任务异常` **19 处** + **第 20 处** `:325` 用另一条消息 | 计划列的 19 行号有 4 个 +1 偏移;324↔325。⚠ 19 处**消息前缀各异** → helper 须接受消息标签参数 |
| **FE-07** | ✅ CONFIRMED | 28 个 `#[tauri::command]` | 4 个巨型函数跨度**全部逐字精确**:`export_items 570-692` / `lumen_preview_cmd 875-982` / `lumen_sync_ratings_cmd 992-1075` / `apply_tone_cmd 1197-1280` |
| **FE-12**(后端) | ✅ CONFIRMED | `commands.rs:740` + `lib.rs:49` | 零其他 Rust 调用方 |
| **Lumen 降级策略** | ✅ CONFIRMED 三类 | 读类静默:776-782,1083-1095,1125-1131,1153-1159,1173-1179,1288-1305,1349-1361,1389-1397;写类报错:1257,1263;apply_tone 静默+warning:1233-1247 | 审计 §3.2 判断准确 |
| **open_in_default_app** | ✅ CONFIRMED | `282-308`,三平台 `287/295/303` | 但**未成为任何 DRY 条目** → 本轮补录为 FE-23 |

---

## 3. 后端 lumen.rs(分片 3)

| ID | 裁决 | 实测 | 修正 |
|---|---|---|---|
| **BL-01** | ⚠ **降级 P0 → P2** | `517-527` 确认 | ⚠ **`lumen.rs:2667` 显式断言 `tool_to_command_id("nope") == "app.status"`** —— 兜底是刻意且测试锁定的行为。计划"**新增**回归测试"不成立,实为**改写既有断言**。危害从"静默执行无关命令"降为"设计异味",建议先查 `lumen.rs:1134` 调用方确认 `tool` 来源 |
| **BL-02** | ✅ CONFIRMED | Timeout `:404` / Disconnected `:406` | ⚠ 上游 `McpClient::request` 实际在 **`:1281`**,非 1289 |
| **BL-04** | ⚠ 计数错 | 测试段起点确认 | ⚠ `LumenRuntime` 方法数 **21**,非 17。5 类 DRY 重复(3×spawn+handshake / `["mcp","--headless"]` 3× / edit.get 3× / MAX_RESTARTS 检查 / 锁中毒消息)**全部确认**,且锁中毒消息是 **4 种变体**非 2 种;`call_rating_tool` 确实缺熔断 |
| **BL-05** | ✅ **最干净的一条确认** | struct 在 **`:430`**(非 420) | `#[cfg(test)]` 边界确认 → `Supervisor` **生产段零引用**,删除安全 |
| **BL-06** | ✅ CONFIRMED | `2651-2653`, `2917-2919` | 真实源码缺陷 |
| **BL-07** | ⚠ 低估 | **13 处**手动 remove_file(计划写 "8+") | ⚠ **`tempfile` 目前不是依赖** —— 需新增 `[dev-dependencies]` 段(当前该段不存在),计划未提 |

---

## 4. 前端 UX P2/P3(分片 4)

已由主审先行确认的 6 条(UX-01 ErrorBoundary 零匹配 / UX-02 aria-multiselectable 零匹配 / UX-03 mask 无 try-catch `App.tsx:1206` / UX-04 Split 尾部 `%` `:549` / UX-05 BeforeAfter 读数忽略 scaleLabel `:319-340` vs helper `:46` / UX-07 keyup 守卫顺序 `331` vs `337`)**均逐字 CONFIRMED**,此处不重复。

| ID | 裁决 | 实测行号 | 证据 / 修正 |
|---|---|---|---|
| **UX-08** | ✅ CONFIRMED | `TonalAdjuster.tsx:180-186` | `handleReset` 直接 `onChange({...DEFAULT_TONE})`;8 个 useState(155-165)无 reset-pending。6 字段确认 |
| **UX-09** | ✅ CONFIRMED | `:489-498` | 只传 `isOpen/onClose/onConfirm/title/message/confirmLabel`,**无 closeOnConfirm 无 busy**;默认 `closeOnConfirm=true`(`ConfirmDialog.tsx:45-47`)→ 确认即关,`handleApplyMaskClick`(193-204)的 4s 工作无指示。⚠ `isMasking` 已存在于 `:160`,**本项无需后端改动** |
| **UX-10** | ✅ CONFIRMED | `useLumenStatus.ts:62-69` | `.catch(() => ...)` 回调**未接 err 参数**,硬编码文案 |
| **UX-11** | ✅ CONFIRMED | `App.tsx:1232-1235` | `.catch(() => undefined)` |
| **UX-12** | ✅ CONFIRMED | `App.tsx:1042-1053` | grep `isAutoToning` **零命中**;40 个 useState(67-181)中无 auto-tone 状态 |
| **UX-13** | ✅ CONFIRMED,**须改 Rust** | `App.tsx:1200-1221` + `commands.rs:1343-1385` | ⚠ **原审计未验证项已解答**:`lumen_apply_mask_cmd` **零 `emit`**(全文件 emit 只在 122/141/157/539)。好消息:已有节流 helper `should_emit`(`commands.rs:53-77`)可复用 |
| **UX-14** | ✅ CONFIRMED | `TopBar.tsx:184-202` | 按钮文案仅 `isLoading ? '扫描中…' : '扫描照片'`(:201);TopBar 无 error prop(`onScan: () => void` @ `:24`) |
| **UX-15** | ✅ CONFIRMED | `TopBar.tsx:184-195` | 仅 `disabled={isLoading \|\| !jpgFolder.trim()}` + title 切换 |
| **UX-16** | ❌ **REFUTED / 描述失准** | `MetadataEditorModal.tsx:160-168` | ⚠ `:161`/`:165` 是**合法取消按钮**(`onClick={onClose}`),`:167` 才是保存按钮 —— **不存在被错标为"取消"的保存按钮**。原 finding 不成立,须重新定性(可能仍想做"保存后取消按钮文案改'关闭'",但那是增强非修 bug) |
| **UX-17** | ✅ CONFIRMED | `Modal.tsx:166,194` + `App.tsx:1470` | 无任何 `document.body/documentElement` 锁定。App 根 `overflow-hidden` 是 flex 约束非滚动锁 —— 计划"脆弱兜底"判断成立 |
| **UX-18** | ✅ CONFIRMED | `ShortcutHelpModal.tsx:86,92,116` | 三个无条件 map;grep `input/filter/search/query` **零命中** |
| **UX-19** | ✅ CONFIRMED | `ThumbnailGrid.tsx:485` | 字面 `aria-selected="true"`(字符串);真实 option 用变量(`:708`) |
| **UX-20** | ✅ 三条全 CONFIRMED | G-01 `:752`(裸 div,兄弟失败态 `:743-748` 反而有 role);G-02 `:283-292`(无"已选 N");G-07 `:502-524`(EmptyGridState 根与 p 均无 role) | |
| **UX-21** | ✅ CONFIRMED | `:516-523` | 重置按钮包在 `{isSearchFiltering && ...}`(:516);非搜索筛选空分支(508/513)纯文本 |
| **UX-22** | ✅ CONFIRMED | `:244-249` | `columns * 3` 硬编码 |
| **UX-23** | ✅ 确认缺失 | 全仓 | grep `typeAhead/typeahead/startsWith(` 零命中 |
| **UX-24** | ✅ CONFIRMED | `:375-389` | 图例容器与 4 个 R/X/T/E span 无 aria 属性 |
| **UX-25** | ✅ **已解答** | `useKeyboardShortcuts.ts:166-175` | `('/' 或 Ctrl/Cmd+F) → onFocusSearch`;UI 公布于 `ThumbnailGrid.tsx:304`。"疑在 App.tsx"不成立 |
| **UX-26** | ✅ 确认缺失 | 两文件 | grep `motion-reduce/prefers-reduced-motion` 零命中 |
| **UX-27** | ✅ CONFIRMED | `TopBar.tsx:108` / `:119-127`(logo 仅 `title`)/ `BottomBar.tsx:59` | BottomBar `:55-56` 已算 status 串但 footer 无 aria-label |
| **UX-28** | ✅ 像素值逐字 CONFIRMED | `index.css:56` height **20px**;`ThumbnailGrid.tsx:364,367` ≈16px;`:768` ≈12px | 拆为 UX-28a(工具类 P1)/ UX-28b(应用 P3) |
| **UX-29** | 3 ✅ + **1 ❌** | V-04 ✅ `:572-573`/`:354-355`(title 有缩放、aria-label 无);V-05 ✅ `:461-486`(图标 `:472/485` 无可见文字);V-07 ✅ `PreviewViewport.tsx:297-316` 有 EXIF、另两视口 grep `exif` 零命中;**V-06 ❌ `BeforeAfterViewport.tsx:362-367` 确有 `onClick={onOpenLuminar}` + aria-label** | "BeforeAfter 缺外部打开"**证伪**,至多位置漂移 |
| **UX-30** | ✅ 两条 CONFIRMED | T-07 `:276-288` 仅 `type="range"`,全仓 `type="number"` 只在 `SettingsModal.tsx:474`;T-08 `:286` span 标签,同文件 htmlFor 只在 `:310`/`:350` | |
| **UX-31** | ✅ CONFIRMED | `useLumenPreview.ts:7,34,52,66,72` | `MAX_ATTEMPTS=2`;`attemptsRef` Map **无 delete/clear**,万张会话无界增长 |
| **UX-32** | ⚠ 行号对、理由失准 | `ConfirmDialog.tsx:83` 确为 `text-xs` | ⚠ 组件内**无 changelog / 多段更新说明**(grep `变更/changelog/更新日志` 零命中),`message` 是单段确认文案 → 纯字号微调,价值低于原估 |
| **UX-33** | ✅ CONFIRMED | `MetadataEditorModal.tsx:329` | emoji 在 hint 文案内 |

---

## 5. 前端 FE(分片 5)

| ID | 裁决 | 实测 | 修正 |
|---|---|---|---|
| **FE-01** | ⚠ **严重低估** | grep `active:scale-[0.96]` → **12 文件 / ~53 处**(计划 6 文件) | `TaskProgressBar.tsx:127` 行号亦偏。抽 Button 的结论**更强**(收益随重复面放大),但迁移成本高于计划估计 |
| **FE-02** | ⚠ 计数错 | **6 处**(SettingsModal 3 / TonalAdjuster 2 / BatchExportModal 1) | **MetadataEditorModal 无此模式**,计划第 7 处不成立 |
| **FE-03** | ✅ 坐标系分歧 CONFIRMED | Preview 绝对系 vs Split/BeforeAfter 增量系 | 坐标系统一的判断成立。"~445 行"是导出估算,无可查 locus,但底层重复真实 |
| **FE-04** | ✅ CONFIRMED | `Toast.tsx` | `toastsRef` 影子 state 存在;队列+定时器占 41% 属导出估算 |
| **FE-05** | ✅ CONFIRMED | `TopBar.tsx:40,43,71,104` | 兼容层在位:`tonalVisible = tonalPanelVisible ?? !!showTonalPanel`(:104),`:43` 注释自承"保持向后兼容"。App 侧 `:144,382` |
| **FE-08** | ⚠ **悬空引用** | `ThumbnailGrid.tsx` = 873 行 ✓ | ⚠ **`src/hooks/useGridKeyboard.ts` 不存在** —— 步骤"在 useGridKeyboard 里改"无目标文件,须先建 |
| **FE-11** | ✅ 逐字 CONFIRMED | `scanner.rs:78-193`(116 行)、`:275-564`(290 行) | 另见 `scan_directory:217-264` 等 |
| **FE-13** | ✅ CONFIRMED | `api.ts` 302 行 / 27 方法 | |
| **FE-14** | ✅ CONFIRMED | `autoTone.ts:16-144`、`:149-192` | 跨度精确 |
| **FE-15** | ✅ CONFIRMED | `toneToRecipe.ts:70` 有守卫;`autoTone.ts:70/123/128` 无 | ⚠ autoTone 另有 **3 处**无守卫 clamp(`:94,100,107`)计划未列 |
| **FE-16** | ✅ CONFIRMED | `types/index.ts` 239 行 / **28** 个导出 / **7** 领域 | |
| **FE-17** | ✅ CONFIRMED | `BottomBar.tsx:194`(用于 `:117,206`)vs `ShortcutHelpModal.tsx:98,119` | 样式逐字重复,2 处 |
| **FE-18** | ✅ CONFIRMED | `useKeyboardShortcuts.ts:183` 单 switch,文件 387 行 | |
| **FE-19** | ⚠ **措辞失准** | `useKeyboardShortcuts.ts:71-72` 具名(用于 `:121,:331`);`App.tsx:1348` 是**内联选择器** | ⚠ **不存在第二个具名函数可抽** —— 重复的是选择器字面量。应写"抽共享谓词 util" |
| **FE-20** | ✅ 逐字 CONFIRMED | `:119`→`:208` 正好 90 行 | 结果文案 `:166-187`(计划 164-187 含 2 行注释) |
| **FE-21** | ⚠ 行号不全 + 发现更深问题 | `:67-70` fire-and-forget `onConfirm(); if (closeOnConfirm) onClose();` | ⚠ 使契约成立的另两处是 `disabled={busy}`(`:61`/`:71`)与文案(`:78`)。⚠ **真正问题是乐观关闭:不等 promise 就关**,这才是 UX-09 反馈真空的根因 |
| **FE-22** | ⚠ **计数错** | 计划列的 8 行号**逐字精确**;但实际 **14 处 / 8 文件** | 未列:`BeforeAfter:411`、`Preview:499`、`Split:422,523,596`、`TonalAdjuster:456`。"8" 实为**文件数**。Callout 两处逐字同,但 TonalAdjuster 多带 `role="status" aria-live="polite"`(`:297-298`)→ 抽组件需把 a11y 做成可选 prop |
| **BE-08a** | ✅ CONFIRMED | `scanner.rs:79-82`;`thumbnail.rs:30-36,166-169` | 3 处 |
| **BE-08b** | ⚠ **计数低估** | `scanner.rs:34-38,244-248`;`thumbnail.rs:66-73` **+ `thumbnail.rs:461-463`** | 实为 **4 处** |
| **BE-09** | ✅ CONFIRMED | `Database::new` 起于 **`:59`**(计划 58);`save_session:198` 内联时间戳 `:206-209`;`now_secs:263-268`;`AppSettings:95-111`(计划 93) | 全部 ±1-2 |
| **BE-10** | ✅ CONFIRMED | HKLM `:8-33` 精确;HKCU `:35-~61`(计划 35-59,末 2 行漂移) | |
| **BE-11** | ✅ 精确 | `:72-175`(签名 `:72`,闭合 `:175`);`find_luminar_executable:6-69` | |
| **FE-12** | ✅ CONFIRMED | `api.ts:90-98` 定义;`src/**/*.tsx` 中 `api.updateTone` **零命中** | 死路径确认 |

---

## 6. 计划内聚审计(分片 6)

### 6.1 计数错误(最高严重性)

| 优先级 | §1 声称 | 正文实际 | 差 |
|---|---|---|---|
| P0 | 6 | 6 | 0 |
| P1 | 14 | 14 | 0 |
| P2 | 22 | **25** | **+3** |
| P3 | 24 | **28** | **+4** |
| 记录 | 5 | 5 | 0 |

**可动作项 73 条 + 记录 5 条 = 78**,非 71。原结论句"6+14+22+24=66,共 **71 条可动作项**"含双重错误:输入数字错 + 把 5 条"仅记录不动作"计入可动作数。根因:BE-08 拆 a/b(+1),若干项在计数冻结后补入。

> 注:本轮再拆 UX-28 → UX-28a(P1)/ UX-28b(P3)后,P1=15、P3=27,总数仍 73。

### 6.2 ID 缺陷

| 位置 | 问题 | 修正 |
|---|---|---|
| §4 BE-03 依赖行 | **悬空 ID `BE-06`** —— 全文无 BE-06,commands.rs 拆分是 FE-07 | 已改 FE-07 |
| §4 UX-07 依赖行 | **误引 `FE-19`**(实为 isDialogOpen 抽取);switch→dispatch table 是 **FE-18** | 已改 FE-18;§6 矩阵本就写对,现一致 |
| §0 第 1 条 | 称 "BE-01..BE-13" —— 实缺 BE-06/07,BE-08 仅 a/b | 已在 §0 加注 |
| — | **`BL-03` 编号空洞**,全文无定义无引用 | 已登记说明 |
| §6 ConfirmDialog 行 | 串行笔误 "FE-17(KeyCap 无关)" | 已删 |
| §6 标题合并 | UX-06 标题"(S-04 合并 C-02/03/05)",审计 B 原文含 **C-04** | C-04 无处安放,已登记 |

FE-01..FE-22 与 UX-01..UX-33 编号**无空洞**;73 条全部到达 §7,无孤儿。

### 6.3 依赖图:三处批次倒挂(无环)

1. **BL-04(Batch 4)依赖 BL-05/BL-06(Batch 6)** —— 三处正文都说必须先删,批次表却排在后面;§6 矩阵又称"BL-04 拆分**最后**",与 Batch 4 位置再矛盾
2. **FE-07(Batch 4)依赖 FE-12(Batch 6)** —— 且该依赖**只在 §7 出现**,FE-07 自身的依赖行(§4)并未提 FE-12
3. **UX-28 横跨 Batch 2 与 Batch 6** —— P1 基础件与 P3 清理混为一个 ID

**全部已修正**:BL-05/BL-06/FE-12 前移 Batch 3;UX-28 拆 a/b。依赖图现为**无环 DAG**(FE-03 批内顺序已显式标注;UX-13←UX-09 批内顺序仅靠列表次序,已加注)。

### 6.4 诚信项丢失

§8.5 承接 UX 审计 §6 的 6 条,只承接 3 条。**已补回**:

- `/` 快捷键处理程序 —— 本轮**已解答**(`useKeyboardShortcuts.ts:166-175`)
- **MetadataEditorModal 10k 批量写入进度** —— 仍无 ID(与 UX-13 同类)
- **Toast.tsx aria-live 对 mask/preset 通报** —— 仍未验(讽刺的是 FE-04 恰要重构该文件)
- 新增:**P0 缺陷的触发路径从未被实测复现**(审计 A §12 明确要求)
- 消歧:全文 "审计 §N" **未区分两份来源**,建议统一写"审计 A/B §N"

### 6.5 覆盖缺口(已补录为 §5bis)

审计 A 的 5 条 finding **从未成为任何 ID**:

| finding | 补录 ID | 备注 |
|---|---|---|
| `build_our_description` 抽 helper | **BE-14** | ⚠ **xmp.rs 是审计 A §1 唯一没有 SRP 条目的 HIGH 巨石** |
| `xmp:Rating` 解析统一 | **BE-15** | |
| `pickFile()` | **BE-16** | ⚠ 审计 A §6 跨层 DRY 表 10 行里**唯一无 ID** 的一行 |
| `convertFileSrc` → `toAssetUrl` | **BE-17** | |
| `open_in_default_app` 三平台收敛 | **FE-23** | FE-07 步骤 11 读了同一节却漏了这条 |

另 2 条显式登记为"已评估不修":RAW-only/star title 措辞分叉(并入 FE-03/UX-29)、MetadataEditorModal 样式与脏检测不对称(**审计 A 自相矛盾**:§4.4:310 标记问题 vs §9/§13 称"最健康,不动";本计划采信 §9)。

### 6.6 优先级漂移 vs 审计 A 路线图

- 审计 A §7 P1 第 9 条 "守卫 helper **+ 降级策略统一**" 被拆开:helper→BE-03(P1),降级策略→FE-07 步骤 11(**P2**)。半条 P1 静默降级
- 审计 A §13 给 BatchExportModal 判 **P2**,本计划 FE-20 判 **P3**

### 6.7 CLAUDE.md 引用

7 处引用,读作仓库治理文件,但**仓库内无任何 CLAUDE.md**(含隐藏文件)。规则实际在 `~/.claude/CLAUDE.md`,§8.3 七条与之 1:1 对应(已逐条核对)。另发现 §8.3 "本计划全文无 emoji" **自我违反**(该字符出现在 UX-33 的验证命令与该句本身)—— 已改写为"引用待删目标"的例外说明。

### 6.8 其他

- §0/结论称 UX 审计 235 行 → 实为 **234** 行
- Batch 3 标"P1"却含 P2 的 UX-11/UX-12(§6 有理由,批次未标)
- §6 写 UX-19"在 FE-08 拆出的子组件里做",而 UX-19 自身依赖行给了"或独立一行"的备选,未裁决
- Batch 5 标题暗示涵盖全部 UX 簇,但 UX-14/15 被 FE-09 吸收在 Batch 4,标题易误导
- §6 将 UX-10/UX-31 标"独立",但 FE-03 步骤 3 的 `useViewportImage(group, lumenStatus, width)` 会消费二者(无文件重叠,低危)

---

## 7. 裁决汇总

| 裁决 | 条数 | 明细 |
|---|---|---|
| ✅ 逐字 CONFIRMED | 62 | 含全部 P0(P0-VER/BE-01/BE-02/BL-02/UX-01/UX-02) |
| ⚠ 行号漂移(±1~8) | 9 | BL-02 1289→1281;BE-09 58→59/93→95;BE-10 末 2 行;BL-05 420→430;FE-20 含注释行 |
| ⚠ 计数低估 | 7 | FE-01 6→12文件;FE-02 7→6;FE-22 8→14处;BE-04 +1 处;BE-05 6→7;BE-08b 3→4;BL-07 8+→13 |
| ❌ 证伪 / 描述失准 | 5 | UX-16、UX-29/V-06、FE-19、FE-21、FE-08 |
| 🔺 升级 | 1 | **P0-VER**(本轮实测新增) |
| 🔻 降级 | 1 | **BL-01 P0 → P2** |

**总体判断**:初版的**技术结论**可靠 —— P0/P1 除 BL-01 外全部经源码坐实,风险评级与依赖设计基本正确,9 项"未验证"标记诚实且必要。缺陷集中在**计数、批次编排与若干前提**,而非判断本身。

最可操作的教训:审计报告的**"次数"类数字远不如"行号"类数字可靠**(7 处低估 vs 9 处微漂移且结论不变);而"回归测试先行"类步骤必须先确认现有测试**是否已断言相反行为**(BL-01 即因此从 P0 降级)。
