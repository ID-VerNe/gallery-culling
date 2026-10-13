# gallery-flask 全量修复计划(DRY/SRP 审计 + UX 审计 合成)

**日期**:2026-10-13
**对象**:Tauri 2.x 桌面应用(gallery-culling v1.1.1),工作树 c62cbf8 之后
**目标**:全部修复 —— DRY/SRP 审计全部发现 + UX 审计全部发现,按优先级与风险排序,给出 step-by-step 执行顺序
**输入**:`.plan/dry-srp-audit-2026-10-13.md`(559 行,14 agent 合成)、`.plan/ux-audit-2026-10-13.md`(234 行,6 agent 合成)

> **修订记录(2026-10-13 第二轮)**:本计划已由 6 个并行只读 subagent 逐条源码复核,并实跑 `npm test`。复核发现 62 条逐字确认、9 条行号漂移、7 条计数低估、**5 条证伪/描述失准**、16 项计划内聚缺陷,另**新增 1 条 P0(工作树测试红)**。所有修正已就地写入,逐条裁决见配套台账 **`.plan/remediation-verification-ledger-2026-10-13.md`**。同时修正原文把 UX 审计写成 235 行(实为 234 行)与"共 71 条可动作项"(本轮复核后为 **80 条可动作 + 5 条记录**)。

---

## 0. 来源与诚信声明

**本计划的三个来源层:**

1. **plan-backend-small subagent 输出**(BE-01..BE-13):Rust 后端排除 lumen.rs。其中 BE-01/BE-02/BE-05/BE-08/BE-12/BE-13 的 xmp.rs 部分经该 agent 逐行源码验证(CONFIRMED);commands.rs/scanner.rs/thumbnail.rs/db.rs/models.rs/luminar.rs 部分基于审计报告,该 agent 明确标注"未源码验证,行号可能漂移,修复时以 grep 函数名定位 + cargo check 为准"。
   - **第二轮更新**:上述"未源码验证"部分**已由本轮 6 个 subagent 补验完毕**。行号漂移普遍在 ±8 行内,结论全部成立;但**次数类数字**(守卫处数、map_err 处数、重复样式数)多处低估,详见配套验证台账。BE-06/BE-07 从未存在,BE-08 实为 BE-08a/BE-08b 两项。
2. **直接从审计报告合成**(BL-、FE-、UX-):lumen.rs、前端、UX 三块。两份审计报告在本次会话中已全文读取,其发现含 file:line 证据与主审复核记录(UX §7 复核了 S-01/S-02/S-03/G-05),本身即权威来源。派 subagent 重新读取这些大文件(lumen.rs 3213 行、App.tsx 1753 行)反复触发 context 溢出(5 个 plan agent 中 3 个因此失败),故改由主审直接从审计报告合成,不再重派。
3. **三个开放问题已由主审验证**(见 §0.1)。

**风险提示**:BL- 和 FE- 条目的行号取自审计报告,工作树有未提交修改(git status 显示 commands.rs/xmp.rs/scanner.rs 等均有 M),行号可能已漂移。每条 BL-/FE- 的"验证"步骤均要求先 `cargo check` / `grep 函数名` 定位,再动手。这与 plan-backend-small 的诚信声明一致。

### 0.1 三个开放问题的验证结论

1. **`updateToneAdjustments`(api.ts:90-98)是否死路径** —— **是,确认死路径**。Grep `updateTone` 在 `src/**/*.tsx` 零命中;`api.updateToneAdjustments` 在 `src/` 仅命中 api.ts:90 定义自身。前端无调用方。后端 `update_tone_adjustments_cmd`(commands.rs:740)仍在 lib.rs:49 注册,但前端不触发。按 CLAUDE.md"移除过时路径",前端方法 + 后端命令 + 注册三处删除(FE-12)。
2. **`Supervisor`(lumen.rs:420-504)是否死代码** —— **是,确认生产死代码**。Grep `Supervisor` 命中行 444/454/464/467/477(impl 自身)+ 2567/3131/3157/3191/3205。`#[cfg(test)]` 在 1599 行,故 2567/3131-3205 全部落在测试段。**生产段(1-1599)零引用** —— `Supervisor` 只被自己的测试引用,是自循环存活的生产死代码(`LumenRuntime` 已承担同类职责)。删除 struct + impl + 其自测试(BL-05)。
3. **lumen.rs:2651-2653 / 2917-2919 raw string 换行是否真实源码缺陷** —— **是,确认真实缺陷,非 Read 工具假象**。`cat -A` 原始字节显示 `r"C:` 后接真实换行符再接 `ope\lumen-cli-xyz.exe"`,即 `\n`(本意是 `\nope` 的一部分)被某次编辑替换成换行符。Rust raw string 允许跨行故编译通过、测试也过(反正是不存在路径),但路径值带内嵌换行。两处都在测试段,低危但应修(BL-06)。

### 0.2 验证状态(2026-10-13 第二轮源码验证,6 个并行 subagent)

本计划每一条发现已在**工作树上逐条复核**(6 个只读 subagent,按后端 xmp / 后端 commands / 后端 lumen / 前端 UX / 前端 FE / 计划内聚 六域分片)。完整逐条裁决见 **`.plan/remediation-verification-ledger-2026-10-13.md`**。摘要:

| 结论类别 | 数量 | 含义 |
|---|---|---|
| 逐字 CONFIRMED | 62 | 文件、行号、代码事实全部对上 |
| 行号漂移(±1~8 行) | 9 | 结论不变,位置需重新定位 |
| 计数低估 | 7 | 计划里的重复次数/工作量被少报 |
| **证伪 / 描述失准** | **5** | UX-16、UX-29/V-06、FE-19、FE-21、FE-08 |
| **计划内聚缺陷** | **16** | 计数错、批次倒挂、悬空 ID、诚信项丢失、CLAUDE.md 引用错误 |
| 本轮新增 | 7 | P0-VER + UX-28a/28b + BE-14~17 + FE-23 |

**必须先读的三条**:

1. **新增 P0-VER:工作树测试红(计划原本完全没有覆盖)** —— `npm test` 实测 **3 个文件 / 8 条用例失败**(249 通过)。8 条全在 3 个**未跟踪的新测试文件**里(`App.pinSpace.test.tsx`、`App.rateClearsReject.test.tsx`、`ThumbnailGrid.selectionSync.test.tsx`),而 `App.tsx`(+622/-82)与 `ThumbnailGrid.tsx`(+170)有大量未提交改动。这是**在途 WIP**,不是回归。详见配套验证台账 §0。
2. **BL-01 降级为 P2** —— 现有测试 `lumen.rs:2667` 显式断言 `tool_to_command_id("nope") == "app.status"`,即当前兜底是**刻意且被测试锁定的**行为。计划里"新增未知工具测试"不成立(要改的是既有断言),严重性从"静默执行无关命令"降为"设计异味"。
3. **Batch 4/6 批次倒挂** —— BL-04(Batch 4)依赖 BL-05/BL-06(Batch 6),FE-07(Batch 4)依赖 FE-12(Batch 6)。已在本轮修正批次表(§7)。

### 0.3 关于 "CLAUDE.md" 的引用更正

本计划 7 处引用 "CLAUDE.md" 约束(§8.3、FE-05、FE-12、UX-33)。**该文件不在本仓库** —— 仓库内无任何 `CLAUDE.md`(已 glob 确认含隐藏文件)。规则实际位于全局用户配置 **`~/.claude/CLAUDE.md`**(2 177 字节,另有 `@CLAUDE_MEMORY.md`)。§8.3 的 7 条规则与全局文件 1:1 对应(已逐条核对)。本计划受**用户全局规则**约束,而非仓库内治理文件。

---

## 1. 统一编号与优先级总览

| 前缀 | 领域 | 来源 |
|---|---|---|
| BE- | Rust 后端(排除 lumen.rs) | plan-backend-small,已源码验证 xmp.rs |
| BL- | lumen.rs(3213 行) | 主审从 DRY/SRP 审计 §2.2/2.3/3.1 合成 |
| FE- | 前端(TS/TSX) | 主审从 DRY/SRP 审计 §4-5 合成 |
| UX- | UX 审计发现 | 主审从 UX 审计 §3-4 合成 |

| 优先级 | 数量 | 含义 |
|---|---|---|
| P0 | 6 | 正确性/数据丢失 + 工作树转绿 + UX major。先做,独立于重构,测试先行 |
| P1 | 15 | 高收益 DRY 抽取 + 高杠杆 UX 修复。低风险,可独立进行 |
| P2 | 26 | SRP 巨石拆分 + 状态可见性/控制/一致性簇。高风险需测试覆盖 |
| P3 | 33 | 清理 + 打磨。随手做,低风险 |
| 记录 | 5 | UX cosmetic,仅记录不动作 |

> **计数(第二轮已修正)**。初版记 P2=22 / P3=24 / 合计 71,**与正文实际 ID 数不符**。经本轮复核与增补后的**准确数字:P0 6 / P1 15 / P2 26 / P3 33 = 80 条可动作项,另 5 条记录项(不动作)**。
>
> 数字演变:初版正文实际 73 条(P2 25 / P3 28,非声称的 22/24)→ 本轮新增 7 条:P0-VER +1、UX-28 拆 UX-28a/28b 净 +1、BE-14~BE-17 +4、FE-23 +1;同时 BL-01 由 P0 降 P2(总数不变)。
>
> 初版结论句"6+14+22+24=66,共 71 条可动作项"含双重错误:输入数字错 + 把 5 条"仅记录不动作"计入可动作数(66+5=71 是**总数**而非可动作数)。

| 本轮验证新增 | ID | 优先级 | 来源 |
|---|---|---|---|
| 工作树测试红(8 条失败) | **P0-VER** | **P0** | 本轮实测 `npm test` |
| 5 条审计 A 遗漏项补录 | BE-14 ~ BE-17、FE-23 | P3 | 审计 A §3.3/§5.2/§6 |
| `.tap-target` 工具类从 UX-28 拆出 | **UX-28a** | **P1** | §6/§7 批次倒挂修正 |
| UX-28 应用侧(触控目标) | UX-28b | P3 | 原 UX-28 剩余部分 |

---

## 2. P0 — 正确性止血与 UX major(先做,独立于重构)

> 审计 §12 明确要求:P0 正确性缺陷修复时先写复现测试。BE-01/BE-02/BL-01/BL-02 的测试门均标注"回归测试先行"。

### P0-VER: 工作树测试红 —— 3 文件 8 条失败(本轮实测新增)

- **优先级**:P0(阻塞:任何"跑 npm test 验证"的步骤都会红,无法区分新改动效果)
- **风险**:Med | 爆炸半径:`src/App.tsx`、`src/components/ThumbnailGrid.tsx`
- **依赖**:无。**必须最先处理** —— 下面所有前端项的验证门都写的是 `npm test`,基线不绿则验证信号失效
- **证据(本轮 `npm test` 实测)**:36 文件 / 257 用例 → **3 failed / 8 failed**,249 通过
- **失败清单**:
  1. `src/App.pinSpace.test.tsx`(4 条,未跟踪新文件)—— 空格设基准:期望落当前照片,实得相邻张
  2. `src/App.rateClearsReject.test.tsx`(2 条,未跟踪新文件)—— 给已淘汰照片打分后 flag 必须变 `none`,实测透传 reject;界面仍显示"已淘汰"
  3. `src/components/ThumbnailGrid.selectionSync.test.tsx`(2 条,未跟踪新文件)—— 高亮真值应为 `selectedIndex ∪ selectedIds` 并集
- **性质判定**:**在途 WIP,非回归**。3 个测试文件均 `??` 未跟踪;`App.tsx`(+622/-82)与 `ThumbnailGrid.tsx`(+170)有大量未提交改动。即"测试已按期望行为写好,实现尚未跟上"。
- **根因(已定位,ThumbnailGrid)**:`ThumbnailGrid.tsx:450-453`
  ```tsx
  const isSelected =
    activeIds.size > 0
      ? activeIds.has(group.id)      // 多选:集合独占
      : itemIndex === selectedIndex; // 单选:仅索引
  ```
  这是**互斥(either/or)**真值;新测试要求的是**并集(union)**真值(多选时当前照片仍高亮)。改动点单一。
- **步骤**:
  1. **先定性**:向作者确认这 8 条是"待实现的期望行为"还是"过时的测试"。若实现才是对的,改测试;若测试是对的,改实现
  2. 若测试为准:`ThumbnailGrid` 高亮改并集(`activeIds.has(id) || itemIndex === selectedIndex`),注意与 `handleCellClick` 的 toggle 语义、`aria-selected`、ghost option(UX-19)保持一致
  3. `pinSpace` 与 `rateClearsReject` 两条按同样方式定性后再改
  4. 全部转绿后方可开始 Batch 3 及以后的 `npm test` 验证
- **测试门**:本项自身即门 —— `npm test` 必须 0 failed
- **验证**:`npm test` 全绿 + `npm run build`

### BE-01: xmp.rs reject 分支丢失 lens/tone 元数据

- **优先级**:P0(正确性/数据丢失)
- **风险**:High | 爆炸半径:xmp.rs 写入路径 + 所有调用 write_xmp 的命令 | reject 一张已调过色的图,lens_model/focal_length/aperture/exposure/highlights/shadows/temperature/tint/contrast 全部丢失,不可恢复
- **依赖**:无
- **验证裁决(第二轮)**:✅ **CONFIRMED,行号逐字精确**(399-407 / 415-438)。补充确认:`XmpMetadata` 确有 `Default` derive,`read_xmp_full` 会填充 lens/tone,故 `..Default::default()` 的清零路径真实存在。现有测试**未覆盖** reject + lens 保留场景 —— 计划"回归测试先行"成立
- **文件**:`src-tauri/src/xmp.rs` 行 399-407(`write_xmp_rating_minus_one`)、415-438(`write_xmp`)
- **源码验证**:CONFIRMED(plan-backend-small 逐行读取)。行 399-407 构造 `XmpMetadata{rating:0,label:String::new(),rejected:true,..Default::default()}` —— `..Default::default()` 把 lens/tone 全置 None。行 425-428 reject 分支调用它,丢弃行 417 已读的 meta
- **步骤**:
  1. **回归测试先行**:新增测试 —— 构造含 lens_model/exposure/highlights 的 XMP,调 `write_xmp(image_path, 0, "reject")`,断言写回后 `read_xmp_full` 仍返回原 lens/exposure/highlights 且 rejected==true、rating==0。修复前此测试应失败
  2. 删除 `write_xmp_rating_minus_one`(行 399-407 整体)
  3. 改 `write_xmp` reject 分支(行 425-428):`meta.rating=0; meta.label=String::new(); meta.rejected=true;` 复用已读 meta,调 `write_xmp_preserving(image_path, &meta)`
  4. 非 reject 分支保持 `meta.rejected=false`
- **测试门**:`grep -n "write_xmp" src-tauri/src/xmp.rs`;新增回归测试先于代码修改提交
- **验证**:`cd src-tauri && cargo check && cargo clippy -- -D warnings && cargo test --lib xmp`

### BE-02: xmp.rs append_our_block 对畸形文件用空模板覆盖

- **优先级**:P0(正确性/数据丢失)
- **风险**:High | 爆炸半径:所有 write_xmp_preserving 调用路径 | 既有 XMP 缺 `</rdf:RDF>` 闭合(损坏/截断)时,用 `XmpMetadata::default()` 空模板覆盖,丢失第三方(Lightroom 等)全部元数据含本方已写 lens/tone。静默数据丢失,且返回 Ok 不报错
- **依赖**:无
- **文件**:`src-tauri/src/xmp.rs` 行 385-396(`append_our_block`)
- **源码验证**:CONFIRMED。行 394-395:找不到 `</rdf:RDF>` 时走 `build_fresh_document(&XmpMetadata::default())` 并返回 Ok
- **验证裁决(第二轮)**:✅ CONFIRMED,且**比计划描述的更严重**。计划说"用空模板覆盖,丢失第三方元数据含本方 lens/tone";实测确认回退路径**连调用方已读出的 `meta` 也一并丢弃**(只传 `&XmpMetadata::default()`),因此 rating/label/lens/tone **全丢**,严格劣于 BE-01 的 reject 路径。签名确认为 `-> String`(非 `Result`),故需全链路传播 `Result`。`append_our_block` 的所有调用点都需同步改签名(见配套验证台账 BE-02 行)
- **步骤**:
  1. **回归测试先行**:构造截断 XMP(有 `<rdf:RDF>` 无 `</rdf:RDF>`,内含第三方 lens),调 `write_xmp_preserving`,断言返回 Err 且原文件字节未改
  2. 改行 394-395:`return Err("malformed XMP: closing </rdf:RDF> not found, refusing to overwrite".into())`(对齐文件既有 error 类型)
  3. 确认 `write_xmp_preserving` 返回类型已传播 Err
- **测试门**:新增畸形文件回归测试先行;`grep -n "append_our_block\|build_fresh_document" src-tauri/src/xmp.rs`
- **验证**:`cargo check && cargo test --lib xmp`

### BL-01: lumen.rs tool_to_command_id 未知工具静默映射 app.status

- **优先级**:**P2(原 P0 —— 本轮验证降级,理由见下)**
- **风险**:**Med(原 High)** | 爆炸半径:B 通道兜底执行 | 传入未预期工具名不报错,静默映射 `app.status`,在 B 通道兜底时执行无关命令
- **依赖**:无
- **文件**:`src-tauri/src/lumen.rs` 行 517-527
- **源码验证**:CONFIRMED(审计 §2.2)。`match tool { "rate_photos" => "library.rate", ... _ => "app.status" }`
- **⚠ 验证裁决(第二轮):降级 P0 → P2,并修正计划的一处错误**
  - 现有测试 **`lumen.rs:2667` 显式断言 `tool_to_command_id("nope") == "app.status"`** —— 当前兜底是**刻意设计且被测试锁定**的行为,不是疏漏
  - 因此计划步骤 1 的"**新增**回归测试断言未知工具返回 Err"**不成立** —— 那不是新增,是**改写既有断言** `lumen.rs:2667`
  - 真实风险是"设计异味 + 测试把异味固化",而非"静默执行无关命令导致难排查异常"。若调用方(`lumen.rs:1134`)只传已知工具名,则实际危害为零
  - **降级理由**:P0 的门槛是"会产出错误行为"。这里要么是有意设计,要么需要先确认调用方是否可能传未知工具名。建议执行前先读 `lumen.rs:1134` 上下文确认 `tool` 来源
- **步骤**(**已按验证结果修正**):
  1. **先查调用方**:读 `lumen.rs:1134` 附近,确认 `tool` 是否可能取到未知值。若不可能,则本项降为纯可读性/防御性改动
  2. 若确认要改:**改写既有断言** `lumen.rs:2667`(不是新增测试),断言 `"nope"` 返回 Err
  3. `_ =>` 分支改为 `return Err(LumenError::UnknownTool(tool.into()))`(对齐 LumenError 既有变体;若无可用变体则新增)
  4. 调用方 `lumen.rs:1134` 处理新 Err
- **测试门**:现有 `tool_names_map_to_command_ids`(`lumen.rs:2661`)中 **2667 行断言必须一并修改**,否则测试失败;其余断言不受影响
- **验证**:`cargo check && cargo test --lib lumen`

### BL-02: lumen.rs ProcessTransport 把进程死亡与超时混为同一返回

- **优先级**:P0(正确性)
- **风险**:High | 爆炸半径:render_preview B 通道兜底逻辑 | 子进程崩溃(Disconnected)与只是慢(Timeout)都返回 Ok(None),上游 McpClient::request(1289)统一当 LumenError::Timeout。崩溃导致的"超时"触发一次可能也失败的 run_lumen,而非直接重启 sidecar
- **依赖**:无
- **文件**:`src-tauri/src/lumen.rs` 行 401-408
- **源码验证**:CONFIRMED(审计 §2.3)。`Err(RecvTimeoutError::Timeout) => Ok(None)` 与 `Err(RecvTimeoutError::Disconnected) => Ok(None)` 同一返回
- **验证裁决(第二轮)**:✅ CONFIRMED,行号精确(Timeout 在 404、Disconnected 在 406)。**一处行号更正**:上游 `McpClient::request` 实际在 **`lumen.rs:1281`**(计划写 1289,漂移 8 行),该处把两者统一当 `LumenError::Timeout`
- **步骤**:
  1. **回归测试先行**:新增测试,模拟 channel Disconnected,断言 read_line 返回明确错误而非 Ok(None)
  2. `Disconnected` 分支改为 `Err(LumenError::Io("sidecar 进程已退出".into()))` 或新增 `LumenError::ProcessExited`
  3. 上游 `McpClient::request`(`lumen.rs:1281`)与 render_preview 兜底逻辑区分"重启"与"重试":Disconnected → 重启 sidecar,Timeout → 重试
- **测试门**:现有 transport 测试应仍通过;新增 Disconnected 测试
- **验证**:`cargo check && cargo test --lib lumen`

### UX-01: 无 React ErrorBoundary,渲染抛出即整 app 白屏无恢复(H-01/S-01)

- **优先级**:P0(UX major)
- **风险**:Low | 爆炸半径:src/main.tsx | 单组件包裹,不动业务逻辑
- **依赖**:无
- **文件**:`src/main.tsx:6-10`(仅 StrictMode + App;全 src grep `ErrorBoundary|componentDidCatch` 零匹配,审计 §7 复核确认)
- **步骤**:
  1. 新建 `src/components/ErrorBoundary.tsx`:class 组件,`getDerivedStateFromError` 设 hasError,`componentDidCatch` 把错误推入 toast region,render 渲染最小恢复卡("出了点问题"+ "重新加载"按钮调 `location.reload()`)
  2. `src/main.tsx` 用 `<ErrorBoundary><App/></ErrorBoundary>` 包裹(StrictMode 保留在外层)
  3. 先不加逐面板边界(审计建议,避免过度)
- **测试门**:新增测试 —— 渲染一个抛错子组件,断言 ErrorBoundary 渲染恢复卡而非白屏;`grep -rn "ErrorBoundary" src/`
- **验证**:`npm test` + `npm run build` + 手动验证(注入抛错)

### UX-02: listbox 缺 aria-multiselectable,多选能力对 SR 完全不可见(G-05/H-03)

- **优先级**:P0(UX major)
- **风险**:Low | 爆炸半径:ThumbnailGrid.tsx 一行 | 1 属性,纯 a11y 无逻辑改动
- **依赖**:无(但若 ThumbnailGrid 正被 FE-08 拆分,此属性应落在拆分后的 listbox 容器上 —— 见 §6 矩阵)
- **文件**:`src/components/ThumbnailGrid.tsx:405`(容器有 role/aria-label/aria-activedescendant,无 multiselectable;审计 §7 复核:全 src grep `aria-multiselectable` 零匹配)
- **步骤**:listbox 容器加 `aria-multiselectable={multiSelectEnabled}`(multiSelectEnabled 在 105 行计算)
- **测试门**:现有 ThumbnailGrid 测试应不变;`grep -rn "aria-multiselectable" src/` 应有 1 命中
- **验证**:`npm test` + axe/手动 SR 验证

---

## 3. P1 — 高收益 DRY 抽取 + 高杠杆 UX(低风险,可独立进行)

### FE-01: 抽 `<Button variant size>` 共享组件(前端最大单一 DRY 收益)

- **优先级**:P1(DRY)
- **风险**:Low | 爆炸半径:6 文件幽灵按钮样式 | 基础原子,应在三视口抽取前做
- **依赖**:无。**建议先于 UX-06 设计令牌迁移**:Button 原子消费 token 类,令牌先行更稳;但若同时进行也可,Button 内直接用 token
- **文件**:`TopBar.tsx:325,344`;`BottomBar.tsx:144,155`;`ConfirmDialog.tsx:62`;`TaskProgressBar.tsx:127,141`;`SettingsModal.tsx`;`BatchExportModal.tsx`(grep 该模式命中 6 文件)
- **验证裁决(第二轮)**:⚠ **计划严重低估范围**。实测 `active:scale-[0.96]` 幽灵按钮模式命中 **12 个文件 / 约 53 处**,而非计划的 6 文件;计划列的 `TaskProgressBar.tsx:127` 行号亦有偏差。范围扩大意味着 FE-01 的迁移成本与回归面都高于计划估计,但"抽 Button 原子"的结论不变,反而更强(收益随重复面放大)
- **步骤**:
  1. 新建 `src/components/Button.tsx`:props `variant: "ghost"|"primary"|"danger"`,`size: "sm"|"md"`,内部收口 `focus-ring` + 态机(hover/active/disabled)+ `active:scale-[0.96]` + 无障碍属性
  2. **先迁移计划列的 6 文件**,再按 grep 结果扫剩余 ~6 文件逐步迁移(建议同一 PR 内完成,避免留半迁移态)
  3. ConfirmDialog destructive 主按钮走 `variant="danger"`;ShortcutHelpModal"知道了"走 ghost
- **测试门**:`grep -rn "bg-white/5 hover:bg-white/10" src/` 命中数应从 ~53 降至 0(或仅余有意保留者);新增 Button 组件快照测试
- **验证**:`npm test && npm run build`

### FE-02: useAsyncAction(fn) hook(消除 7 处异步样板)

- **优先级**:P1(DRY)
- **风险**:Low | 爆炸半径:SettingsModal(3)、TonalAdjuster(2)、BatchExportModal(1)、MetadataEditorModal(1)
- **依赖**:无
- **文件**:上述 4 组件的 `isSaving + try/finally + onError` 模式
- **验证裁决(第二轮)**:⚠ 计数修正。实测为 **6 处**(SettingsModal 3、TonalAdjuster 2、BatchExportModal 1),**MetadataEditorModal 的第 7 处不成立** —— 该组件无此模式。收益略低于计划,但抽取结论不变
- **步骤**:
  1. 新建 `src/hooks/useAsyncAction.ts`:返回 `{ run, isLoading, error, clearError }`,内部管 isSaving + try/finally + onError toast
  2. **6 处**替换为 `const { run, isLoading } = useAsyncAction(fn, { onError })`
- **测试门**:新增 useAsyncAction 单测(成功/失败/loading 态);现有 4 组件测试应不变
- **验证**:`npm test`

### FE-03: 三视口共享层抽取(消除 ~445 行)

- **优先级**:P1(DRY,最高收益)
- **风险**:Med-High | 爆炸半径:3 视口文件 | **坐标系分歧埋 bug 风险,必须先统一再抽取**(审计 §4.2 明确)
- **依赖**:**UX-04(V-02 删尾部 %)、UX-05(V-01 scaleLabel)先行** —— 这两个是 1-2 行一致性修复,在旧代码上做最便宜;然后统一坐标系;再抽共享层
- **文件**:`SplitCompareViewport.tsx`(~650)、`BeforeAfterViewport.tsx`(~630)、`PreviewViewport.tsx`(~450)
- **步骤**(严格顺序):
  1. **统一坐标系**:Preview 用绝对(`dragStart = client - pos`),Split/BeforeAfter 用增量(`dragStart = client; dx = client - dragStart`)。先统一为一种(建议绝对,语义更清晰),3 视口行为对齐。每改一处跑 `npm test`
  2. 抽 `useZoomPan({ sync, paneCount })` hook:zoom 常量 + scaleLabel + clamp/paneMaxPan/clampTo + handleWheel + handlePointerDown/Move/Up + handleDoubleClick(可消除 ~200 行)
  3. 抽 `useViewportImage(group, lumenStatus, width)` hook:图像源决策 + lumenBroken latch + onError + reset
  4. 抽子组件:`RatingFlagBar`(评分/标记胶囊,~40×3=80 行)+ `ViewportImage` + `ZoomControls`(zoom 控制条,~30×3=60 行)+ `NavOverlay`(翻页按钮,~20×2=20 行)
  5. 3 视口各从 600+ 降到 150-200 行
  6. **V-04~V-07(跨视口漂移)在此期间内化**:reset aria-label 含当前缩放、Pick/Reject 图标+文字、external-open 位置归一(补 BeforeAfter)、EXIF 呈现归一(补 BeforeAfter)—— 在新共享子组件里一次做对,不在旧三份拷贝里各改一遍
- **测试门**:现有视口相关测试(H-01/F-05 等)+ 新增 useZoomPan/useViewportImage 单测;**H-03/G-05(listbox)测试不受影响**
- **验证**:`npm test && npm run build`;手动验证 3 视口缩放/拖拽/翻页/评分行为一致

### FE-04: Toast 拆三层

- **优先级**:P1(SRP)
- **风险**:Low | 爆炸半径:Toast.tsx + 所有 useToast 调用方 | 队列逻辑抽离后影子 state(toastsRef)理由自然消失
- **依赖**:无
- **文件**:`src/components/Toast.tsx:101-283`(ToastProvider 主体,队列+定时器占 41%)
- **步骤**:
  1. 抽 `src/hooks/useToastQueue.ts`:持有 toasts + push/dismiss + 去重窗口/截断规则(NOTICE_CAP/ERROR_CAP),纯逻辑可单测。内部用 ref 是 hook 私事,不污染组件 —— 影子 state 理由消失
  2. 抽 `src/components/ToastViewport.tsx`:纯展示,VARIANT_STYLES + renderToast + 两个 live region
  3. `ToastProvider` 降为 ~10 行胶水
  4. 顺带修双 live region 分区规则两处实现(push 180-181 拆分 vs 渲染 223-224 filter)—— 统一到 useToastQueue 内
- **测试门**:新增 useToastQueue 单测(去重/截断/自动消失);现有 Toast/App 测试应不变
- **验证**:`npm test`

### UX-03: mask apply 无 try/catch,backend 拒绝变 unhandled rejection(H-04b/S-02)

- **优先级**:P1(UX 状态可见性)
- **风险**:Low | 爆炸半径:App.tsx handleApplyLumenMask | 照现有 pattern,防 unhandled rejection
- **依赖**:无。**若 App.tsx 正被 FE-06 抽 hook 层,此修复应先在 App.tsx 落地,随 hook 迁移带入 useLumenOrchestration** —— 见 §6 矩阵
- **文件**:`src/App.tsx:1206`(handleApplyLumenMask 内 `await api.applyLumenMask` 无 try/catch;审计 §7 复核:与 handleApplyLumenPreset 有 catch 形成对照)
- **步骤**:照 handleApplyLumenPreset pattern 加 try/catch + `toast.error("蒙版应用失败,请确认使用 GPU 版 LUMEN RAW")` + `isMasking` 在 finally 归 false
- **测试门**:`grep -n "handleApplyLumenMask" src/App.tsx`;新增测试:mock api 拒绝,断言 toast.error 调用且 isMasking 归 false
- **验证**:`npm test`

### UX-04: Split aria-label 多尾部 %(V-02)

- **优先级**:P1(UX 一致性)
- **风险**:Low | 爆炸半径:SplitCompareViewport 一行 | 删一字符
- **依赖**:无。**建议先于 FE-03 视口抽取**(见 FE-03 依赖)
- **文件**:`src/components/SplitCompareViewport.tsx:549`(aria-label 模板多 `%`,scaleLabel 已含 `%`,AT 读"250%%")
- **步骤**:删 aria-label 模板尾部 `%`
- **测试门**:现有视口测试应不变
- **验证**:`npm test`;手动 SR 验证

### UX-05: BeforeAfter 缩放读数忽略自身 scaleLabel(V-01)

- **优先级**:P1(UX 一致性)
- **风险**:Low | 爆炸半径:BeforeAfterViewport 读数 + aria-label | 复用已定义 helper(:46)
- **依赖**:无。**建议先于 FE-03 视口抽取**
- **文件**:`src/components/BeforeAfterViewport.tsx:319-340`(读数显示"100%"而 Preview/Split 显示"适应";重置 tooltip 却用了 scaleLabel —— 同组件内不一致)
- **步骤**:读数 + aria-label 改用 `scaleLabel(...)`(已定义于 :46)
- **测试门**:现有视口测试应不变
- **验证**:`npm test`

### UX-06: 设计令牌迁移,系统性消除对比度 + 高对比偏好失效(S-04 合并 C-02/03/05)

- **优先级**:P1(UX 系统性根源)
- **风险**:Low | 爆炸半径:TopBar/BottomBar/Modal/index.css | 机械但系统,换 token 类一并解决对比度(WCAG 1.4.11 3:1)+ prefers-contrast:more 覆盖失效(design-tokens.css:168-175 对硬编码组件完全失效)
- **依赖**:无。**建议先于 FE-01 Button 原子**:Button 直接用 token
- **文件**:`TopBar.tsx:108,223,249`;`BottomBar.tsx:59,166`;`Modal.tsx:169,200`;`index.css:11`
- **步骤**:`border-white/10` → `border-default`/`border-strong`;`bg-white/5` → `bg-surface-hover`。逐文件机械替换
- **测试门**:`grep -rn "border-white/10\|bg-white/5" src/` 应大幅减少;视觉回归
- **验证**:`npm run build`;手动开 prefers-contrast:more 验证加亮生效

### FE-05: TopBar 删除 showTonalPanel 兼容层(CLAUDE.md 违规)

- **优先级**:P1(CLAUDE.md 合规)
- **风险**:Low | 爆炸半径:TopBar.tsx + 调用方 | 注释自承"缺省退回用户意图(向后兼容)"的双轨,直接违反全局指令"不要保留向后兼容,移除过时路径"
- **依赖**:无。**建议与 FE-09(TopBar 拆 SourceRow+ToolbarRow)合并做**,因为拆分时该 JSX 区域会重写,顺手删兼容层
- **文件**:`src/components/TopBar.tsx:103-104`(showTonalPanel vs tonalPanelVisible 双轨;审计 §11)
- **步骤**:删除 `showTonalPanel` prop,只保留 `tonalPanelVisible` 派生真值;调用方(App.tsx)移除 showTonalPanel 传参
- **测试门**:`grep -rn "showTonalPanel" src/` 应零命中;现有 TopBar/App 测试应不变
- **验证**:`npm test && npm run build`

### BE-03: commands.rs Lumen 守卫 helper 提取(11 处)

- **优先级**:P1(DRY)
- **风险**:Low | 爆炸半径:commands.rs Lumen 命令
- **依赖**:无。**建议先于 FE-07(commands.rs 拆分)**:先在单文件内提取 helper,减少拆分搬运量。⚠ 原文此处写作 "FE-07(BE-06 commands.rs 拆分)",**BE-06 是悬空 ID,全文无定义** —— 已更正为 FE-07
- **文件**:`src-tauri/src/commands.rs` 行 774-782, 884-915, 996-1005, 1083-1095, 1125-1131, 1153-1159, 1173-1179, 1202-1248, 1288-1305, 1349-1361, 1389-1397(审计 §3.2,未源码验证)
- **验证裁决(第二轮)**:✅ 计数 CONFIRMED(11 处),但**计划步骤 1 的"11 处替换为 `let lumen = ensure_lumen_ready(&state)?;`" 对其中 1 处不成立**。实测 11 处守卫**并不同构**:`apply_tone_cmd` 的守卫位于**函数中段**(XMP 写入之后)且走 **warning 降级**而非 `?` 提前返回(`commands.rs:1233-1247`),与 `read_xmp_full` 的静默降级是一体的。故 helper 需要**两个变体**:`ensure_lumen_ready(&state)?`(早退)与 `warn_if_lumen_unavailable(&state)`(仅告警)。另 `load_settings()?` 实际在 775/884/996/1083/1125/1153/1173/1202/1288/1349/1389
- **步骤**:
  1. 提取 `fn ensure_lumen_ready(state: &AppState) -> Result<LumenHandle, String>`,封装"检查 lumen 路径/守护状态";**10 处**替换为 `let lumen = ensure_lumen_ready(&state)?;`
  2. `apply_tone_cmd` 的 1 处(`commands.rs:1233-1247`)改用不早退的告警变体,保持其静默+warning 语义不变
- **测试门**:`grep -n "lumen" src-tauri/src/commands.rs | head -40`;现有 lumen 命令测试不变
- **验证**:`cargo check && cargo clippy -- -D warnings`

### BE-04: commands.rs spawn_blocking map_err helper 提取(~20 处)

- **优先级**:P1(DRY)
- **风险**:Low | 爆炸半径:commands.rs 全部异步命令
- **依赖**:无。**建议先于 FE-07**
- **文件**:`src-tauri/src/commands.rs` 行 153, 175, 220, 247, 324, 553, 793, 854, 973-974, 1074, 1115, 1142, 1162, 1187, 1227, 1267, 1309, 1380, 1400(审计 §3.2,未源码验证)
- **验证裁决(第二轮)**:⚠ **计数与前提均需修正**。实测 `任务异常` 格式串共 **19 处**(计划列的 19 个行号里 4 个 +1 偏移;计划的 324 实际为 325),**外加第 20 处 `spawn_blocking`(`commands.rs:325`)用的是另一条消息"移动至回收站失败"**,计划未列。且 19 处**消息前缀各不相同**,单一 `blocking()` helper 无法硬编码消息 —— 必须接受一个消息标签参数
- **步骤**:提取 `async fn blocking<F, T>(msg: &str, f: F) -> Result<T, String>`(内部 spawn_blocking + map_err,`msg` 为任务描述前缀);19 处按各自原前缀替换;第 20 处(`commands.rs:325`)用其自有消息一并接入或明确排除。先 grep 一处确认实际 error 类型对齐签名
- **测试门**:`grep -n "spawn_blocking" src-tauri/src/commands.rs | head -40`
- **验证**:`cargo check && cargo clippy -- -D warnings`

### BE-05: xmp.rs modify_xmp 闭包 + extract_f32 + 命名空间结构体

- **优先级**:P1(DRY)
- **风险**:Med | 爆炸半径:xmp.rs 读取路径
- **依赖**:**BE-01、BE-02 完成**(避免与 P0 冲突)
- **文件**:`src-tauri/src/xmp.rs` 行 102-119(extract_f32 目标,CONFIRMED 6+ 处重复)、145-150(OURS_NAMESPACES 数组,CONFIRMED)、modify_xmp 闭包(审计 §3.3,未源码定位行号)
- **步骤**:
  1. 提取 `fn extract_f32(content, tag) -> Option<f32>` 封装 `extract_tag_value(...).and_then(|s| s.parse::<f32>().ok())`;行 103/105/107/109/117/119 替换。temperature(108-116)有回退,保留特殊分支但首段用 extract_f32
  2. OURS_NAMESPACES 从 `&[&str;4]` 改为结构体或带访问方法的集合(便于后续扩展 lumen: 命名空间)
  3. 提取 `fn modify_xmp<F>(image_path, f: F) where F: FnOnce(&mut XmpMetadata)`,封装 read → f → write;先 grep 确认 write_xmp/update_xmp_tone/update_xmp_metadata 三函数体结构
- **测试门**:`grep -n "extract_tag_value\|OURS_NAMESPACES\|modify_xmp" src-tauri/src/xmp.rs | head -40`;现有 xmp 测试(57% 覆盖)不变
- **验证**:`cargo check && cargo test --lib xmp`

### BE-08a: scanner EXIF 读取器共享 helper(跨 scanner/thumbnail 重复)

- **优先级**:P1(DRY)
- **风险**:Low | 爆炸半径:scanner.rs + thumbnail.rs
- **依赖**:无(可与 FE-11/BT-07 metadata.rs 提取合并)
- **文件**:`scanner.rs:79-82`;`thumbnail.rs:30-36, 166-169`(审计 §3.4,未源码验证)
- **步骤**:提取 `fn exif_reader() -> exif::Reader` 到 metadata.rs(若 FE-11 已执行)或共享模块;3 处替换
- **测试门**:`grep -n "exif::Reader\|Reader::new" src-tauri/src/scanner.rs src-tauri/src/thumbnail.rs | head -40`
- **验证**:`cargo check`

### BE-08b: scanner mtime→secs 共享 helper

- **优先级**:P1(DRY)
- **风险**:Low | 爆炸半径:scanner.rs + thumbnail.rs
- **依赖**:无
- **文件**:`scanner.rs:34-38, 244-248`;`thumbnail.rs:66-73`(审计 §3.4,未源码验证)
- **步骤**:提取 `fn mtime_to_secs(meta) -> i64`;3 处替换
- **测试门**:`grep -n "duration_since\|as_secs" src-tauri/src/scanner.rs src-tauri/src/thumbnail.rs | head -40`
- **验证**:`cargo check`

---

## 4. P2 — SRP 巨石拆分 + 状态可见性/控制/一致性簇(高风险,需测试覆盖)

### BL-04: lumen.rs 拆 14 子模块(最大单文件)

- **优先级**:P2(SRP)
- **风险**:High | 爆炸半径:整个 lumen.rs(3213 行,50% 测试)| 迁移期间导入断裂风险高;需配合测试随实现迁移
- **依赖**:BL-01、BL-02 完成(P0 先行);BL-05(Supervisor 删除)先行减少搬运
- **文件**:`src-tauri/src/lumen.rs` → `src-tauri/src/lumen/{error,discovery,cli,cache,transport,protocol,supervisor,masks,tone,sync,capabilities,runtime,preview,status}.rs`
- **步骤**(增量,一次一模块,每步 cargo check + 提交):
  1. 创建 `lumen/mod.rs` + 空子模块文件 + 重导出,lumen.rs 仍是源。cargo check
  2. 迁 `error.rs`(LumenError + 变体,含 BL-01 新增的 UnknownTool/ProcessExited)
  3. 迁 `discovery.rs`(find_lumen_cli + 路径规范化)
  4. 迁 `cli.rs`(run_cli + run_lumen)
  5. 迁 `cache.rs`(缓存键与规范化,SHA-256 hex 统一,消除 262-269/649-655 重复)
  6. 迁 `transport.rs`(ProcessTransport + from_child 构造函数 —— 消除测试段 4 份 process 组装样板 2349-2385/2409-2434/2468-2496/2521-2551)
  7. 迁 `protocol.rs`(McpClient + JSON-RPC,消除 handshake 2 帧脚本 3 处重复 2286-2287/2304-2305/2320-2321)
  8. 迁 `supervisor.rs`(Supervisor —— 若 BL-05 已删则跳过)
  9. 迁 `masks.rs`(蒙版与区域映射)
  10. 迁 `tone.rs`(Tone ↔ recipe)
  11. 迁 `sync.rs`(评级同步)
  12. 迁 `capabilities.rs`(能力探测)
  13. 迁 `runtime.rs`(LumenRuntime impl 875-1260,385 行 17 方法 —— 最大 SRP 单元,可在此拆方法为多个 impl 或子模块)
  14. 迁 `preview.rs` + `status.rs`(版本/状态/预览编排)
  15. 删除原 lumen.rs 或改为 `pub use lumen::*;`,更新 lib.rs
  16. **顺带消除 1-1600 行 DRY**:spawn+handshake 3 处(481-502/957-963/1200-1208)、失败重置不一致 3 处(914-920/970-976/1119-1123,仅 render_preview 设 last_error)、edit.get 3 处(1001-1006/1050-1054/1069-1073)、锁中毒 .map_err 消息不统一 3+处(885/950/1112/1193)、`["mcp","--headless"]` 字面量 3 处(481/958/1203)、content text 块提取链 2 处(1362-1373/1377-1387)、MAX_RESTARTS 检查 call_rating_tool 缺(1110 vs 954/1198)
  17. 更新文件头注释(1-7 行宣称"不包含常驻 MCP"已失效,实际含完整 McpClient/ProcessTransport/Supervisor/LumenRuntime —— 审计 §10 错误前提 #5)
- **测试门**:每步 cargo check;测试随实现迁移(测试段 1599-3213 整体随对应模块迁移);最终 `cargo test` 全量通过
- **验证**:每步 `cargo check`;最终 `cargo clippy -- -D warnings && cargo test`

### FE-06: App.tsx 抽 hook 层(god component,1753 行)

- **优先级**:P2(SRP)
- **风险**:High | 爆炸半径:App.tsx + 全部 hook 消费方 | 需保持 H-01/F-05/M-09/L-11 等回归测试通过
- **依赖**:**UX-03(mask try/catch)先行** —— 行为修复先在 App.tsx 落地,随 hook 迁移带入 useLumenOrchestration;FE-01(Button)、FE-02(useAsyncAction)先行可被 hook 复用
- **文件**:`src/App.tsx`(1753 行,37 useState,9 useEffect,~46 useCallback,12+ 职责)
- **步骤**:
  1. 抽 `useFolderScan`(handleScan + 扫描状态)
  2. 抽 `usePhotoCollection`(groups + setGroups 9 处 672/703/777/839/897/1115/1184/1305/1375)
  3. 抽 `useRatingFlagSync`(评级/flag 三元组:rememberRating + setGroups + api.updateRatingFlag + markSynced,6 处)
  4. 抽 `useBatchSelection`(批量选区 + runBatch)
  5. 抽 `useToneEditing`(7 个 tone state + 8 个回调)
  6. 抽 `useLumenOrchestration`(Lumen sidecar + masks + rating sync,含 UX-03 修复)
  7. 抽 `useAutoUpdate`(auto-update effect 219-272,从 settings effect 内联中剥离)
  8. 抽 `useGridSearch`(grid search)
  9. 抽 `useSettings`(settings 加载 + 持久化)
  10. AppShell 从 1753 行降到 ~200 行
  11. **顺带消除 DRY**:`targetPath=raw?.path||jpg?.path` 12+ 处统一为 helper
- **测试门**:App.searchCounter/App.toneSave/App.undo/App.wp7 等现有测试必须全程通过;每抽一个 hook 跑一次 `npm test`
- **验证**:`npm test && npm run build`;手动验证全流程

### FE-07: commands.rs 按领域拆 8 子模块

- **优先级**:P2(SRP)
- **风险**:High | 爆炸半径:整个 commands.rs(1693 行,28 命令)+ 全部 mod 引用
- **依赖**:**BE-03、BE-04 先行**(先提取 helper,减少搬运);BE-01、BE-02 不阻塞(xmp.rs 独立)
- **文件**:`src-tauri/src/commands.rs` → `src-tauri/src/commands/{mod,scanner,thumbnail,xmp,apps,export,settings,lumen,tone}.rs`
- **步骤**(增量,一次一域,每步 cargo check + 提交;审计 §3.2 详细分布):
  1. `commands/mod.rs`:pub use 重导出 + 公共辅助(ensure_lumen_ready, blocking)
  2. `apps.rs`(open_in_default_app 三平台 287/295/303 —— 最独立,先迁)
  3. `settings.rs`(get/set session settings)
  4. `scanner.rs`
  5. `thumbnail.rs`
  6. `xmp.rs`(write_xmp_cmd, update_xmp_metadata_cmd, update_xmp_tone_cmd)
  7. `export.rs`(export_items 570-692,123 行大函数,单独一步)
  8. `tone.rs`(apply_tone_cmd 1197-1280)
  9. `lumen.rs`(lumen_preview_cmd 875-982, lumen_sync_ratings_cmd 992-1075)
  10. 删除原 commands.rs,更新 lib.rs `mod commands`
  11. **顺带统一 Lumen 降级策略**(审计 §3.2 隐性 DRY + 设计缺陷):读类命令静默降级 vs 写类报错 vs apply_tone 静默+warning,统一守卫 helper 返回枚举集中"读降级/写报错"策略
  12. **顺带拆 SRP 巨型函数**:export_items(123 行,取消点漏一个破坏不变量)、lumen_preview_cmd(108 行)、lumen_sync_ratings_cmd(84 行)、apply_tone_cmd(84 行,决策表埋 spawn 闭包里无法独立测试)
- **测试门**:每步 cargo check;`grep -rn "commands::" src-tauri/src/ | head -40` 无悬空引用;最终 `cargo test`
- **验证**:每步 `cargo check`;最终 `cargo clippy -- -D warnings && cargo test`

### FE-08: ThumbnailGrid 拆 hooks + 子组件

- **优先级**:P2(SRP)
- **风险**:Med-High | 爆炸半径:ThumbnailGrid.tsx(873 行,9 职责)+ 调用方
- **依赖**:**UX-02(aria-multiselectable)先行**(P0);FE-01(Button)先行可被子组件复用
- **文件**:`src/components/ThumbnailGrid.tsx`(80-494 主组件 FC 体 414 行)
- **步骤**:
  1. 抽 `useMultiSelect`:选区模型(handleCellClick 142-176 + handleListKeyDown 211-258 各自 new Set 重复)。**顺带修逻辑边界**:Ctrl/Cmd 点击无法清空到零(161-168 `if next.size===0 next.add(clicked.id)`)、键盘导航无条件收拢多选为单张(254-257,Ctrl 选 20 张后按方向键丢 19 张)
  2. 抽 `useGridKeyboard`:键盘导航。**顺带修 UX-22(G-10 PageUp/Down 步长固定 3 行,改随视口)**、UX-21(G-09 type-ahead)
  3. 抽 `useThumbnailSrc`:缩略图加载与去重缓存
  4. 抽子组件:`GridColumnSwitcher`(313-326 vs 327-340 同构)、`GridSearchBar`、`GridBadgeLegend`(375-388 图例 + 单元格底栏 833-868 双重定义统一;**顺带修 UX-23 G-12 图例 aria-label**)
  5. 主组件降到 ≤150 行
  6. **顺带消除 DRY**:徽标字母/颜色映射双重定义(图例 vs 单元格底栏)、flag→颜色双重定义(border 682-687 vs badge 782-798)、`pb-1.5` 与 `GRID_ROW_GAP_BOTTOM=6` 隐式耦合(注释自承必须同步改)
- **测试门**:现有 ThumbnailGrid 测试 + 新增 useMultiSelect/useGridKeyboard 单测;H-03/G-05 测试仍通过
- **验证**:`npm test && npm run build`

### FE-09: TopBar 拆 SourceRow + ToolbarRow

- **优先级**:P2(SRP)
- **风险**:Med | 爆炸半径:TopBar.tsx(355 行,25 props,11 职责)+ 调用方
- **依赖**:**FE-05(showTonalPanel 删除)合并做**;FE-01(Button)先行
- **文件**:`src/components/TopBar.tsx`
- **步骤**:
  1. 抽 `<SourceRow>`:JPG/RAW 文件夹输入(130-154 vs 157-181 近乎逐字符一致,抽 `<FolderInput>`)
  2. 抽 `<ToolbarRow>`:扫描按钮 + 设置 + 筛选/排序 select + 视图模式分段 + 调色面板开关 + Luminar + 批量导出
  3. `viewModes` 配置数组(77-101)提到模块顶层(每次渲染重建)
  4. 删除 `showTonalPanel`(FE-05)
  5. **顺带修 UX-25/26(C-06/C-07 扫描进度可见 + 错误态)**、UX-06 设计令牌(若未在 P1 做完)、UX-27(S-08 landmark aria-label)
- **测试门**:现有 TopBar 测试应不变;`grep -rn "showTonalPanel" src/` 零命中
- **验证**:`npm test && npm run build`

### FE-10: SettingsModal 拆 3 section

- **优先级**:P2(SRP)
- **风险**:Med | 爆炸半径:SettingsModal.tsx(515 行,3 领域,8 useState)
- **依赖**:FE-02(useAsyncAction)先行可被 section 复用;FE-01(Button)先行
- **文件**:`src/components/SettingsModal.tsx`(Lumen JSX 286-460 约 175 行)
- **步骤**:拆 `<LumenSettingsSection>`(5 子开关/探测/同步)、`<EditorPathSection>`(Photoshop 路径)、`<ThumbnailSection>`(缩略图尺寸)
- **测试门**:现有 SettingsModal 测试应不变
- **验证**:`npm test`

### FE-11: scanner.rs / thumbnail.rs 拆分

- **优先级**:P2(SRP)
- **风险**:Med | 爆炸半径:scanner.rs(763 行)+ thumbnail.rs
- **依赖**:BE-08a/BE-08b 先行(EXIF + mtime helper 已提取);可与 FE-07 并行(scanner 命令在 commands.rs)
- **文件**:`src-tauri/src/scanner.rs`(763 行)、`src-tauri/src/thumbnail.rs`
- **步骤**:
  1. 提取 `metadata.rs`:`read_exif_metadata`(scanner.rs 78-193,116 行,放错模块)+ exif_reader(BE-08a)
  2. 提取 `thumbnail_cache.rs`:缓存目录 + 缓存路径 + 校验
  3. 提取 `image_transform.rs`:EXIF orientation + 旋转 + SIMD resize
  4. scanner.rs 剩余仅目录遍历(scan_folders 275-564 约 290 行,6+ 职责;viewer/pairing 分支 341-395 vs 396-504 是 XMP→EXIF→tone→edited 流水线 copy-paste,统一)
  5. thumbnail.rs 拆 8 职责(缓存目录 + EXIF orientation + 旋转 + 指纹 + 缓存路径 + index + 校验 + SIMD resize)
- **测试门**:`grep -n "fn " src-tauri/src/scanner.rs | head -40`;`cargo test`
- **验证**:`cargo check && cargo test`

### BE-09: db.rs init_schema 提取 + settings key 从 models 解耦

- **优先级**:P2(SRP)
- **风险**:Med | 爆炸半径:db.rs + models.rs
- **依赖**:无
- **文件**:`src-tauri/src/db.rs`(11-26, 31-48, 58-104, 206-209, 263-268)、`models.rs`(93-111)(审计 §3.5,未源码验证)
- **步骤**:
  1. 提取 `fn init_schema(conn) -> Result<()>` 从 Database::new(58-104)
  2. save_session(206-209)内联时间戳改用同文件 now_secs(263-268)
  3. settings_pairs/apply_setting 键字符串与 AppSettings 字段解耦,放独立 settings 模块或 db.rs 常量
- **测试门**:`grep -n "init_schema\|settings_pairs\|apply_setting\|AppSettings" src-tauri/src/db.rs src-tauri/src/models.rs | head -40`
- **验证**:`cargo check && cargo test`

### BE-10: luminar.rs query_registry_path(hive) 提取

- **优先级**:P2(SRP)
- **风险**:Low | 爆炸半径:luminar.rs 注册表查询
- **依赖**:无。**注意:不与 lumen.rs 合并**(审计 §3.5 + §9:不同产品 Skylum vs lumen-cli、不同协议 Photoshop plugin vs JSON-RPC MCP、不同传输同步往返 vs 常驻 sidecar,重叠度 LOW)
- **文件**:`src-tauri/src/luminar.rs`(8-33 HKLM、35-59 HKCU)(审计 §3.5,未源码验证)
- **步骤**:提取 `fn query_registry_path(hive, subpath, ...) -> Option<PathBuf>`;HKLM/HKCU 两处替换
- **测试门**:`grep -n "HKLM\|HKCU\|RegOpenKey" src-tauri/src/luminar.rs | head -40`
- **验证**:`cargo check`

### BE-11: luminar.rs prepare_tiff 提取

- **优先级**:P2(SRP)
- **风险**:Med | 爆炸半径:luminar.rs edit_in_luminar(72-175,103 行,5 职责)
- **依赖**:无
- **文件**:`src-tauri/src/luminar.rs`(72-175)(审计 §3.5,未源码验证)
- **步骤**:提取 `fn prepare_tiff(...) -> Result<PathBuf>`;edit_in_luminar 调用之
- **测试门**:`grep -n "fn edit_in_luminar\|tiff" src-tauri/src/luminar.rs | head -40`
- **验证**:`cargo check && cargo test`

### UX-07: hold `\` keyup 被 isDialogOpen 守卫吞,预览横幅常亮(S-03)

- **优先级**:P2(UX 用户控制)
- **风险**:Low | 爆炸半径:useKeyboardShortcuts keyup handler | 松键幂等,移到守卫前安全
- **依赖**:无。**与 FE-18(useKeyboardShortcuts switch→dispatch table)独立**:S-03 改 keyup handler 顺序,FE-18 改 keydown switch,无重叠。⚠ 原文此处误写 "FE-19",但 FE-19 实为 `isDialogOpen + useAsyncListener` 抽取(不涉及 keydown switch);§6 矩阵第 746 行写的 FE-18 才是对的 —— 已更正
- **文件**:`src/hooks/useKeyboardShortcuts.ts:330-346`(第二轮验证逐字复核:第 331 行 `if (isDialogOpen()) return;` 在第 337 行 `\` 处理**之前**;335-336 行注释自称"必须早于通用守卫"但实现不早于 —— 与计划描述完全一致)
- **验证裁决(第二轮)**:✅ **CONFIRMED,行号逐字精确**。`resetHold` 兜底(350-354)仅绑 `blur`/`visibilitychange`(358-359),确实覆盖不了"modal 打开期间松键"这一路径
- **步骤**:`\` keyup 处理移到 `isDialogOpen()` 守卫之前
- **测试门**:新增测试:hold `\` → 开 modal → 松 `\` → 断言预览横幅关闭;现有 F-05/M-09 测试仍通过
- **验证**:`npm test`

### UX-08: TonalAdjuster reset 一键抹 6 值无确认(T-03)

- **优先级**:P2(UX 用户控制)
- **风险**:Med | 爆炸半径:TonalAdjuster reset | 接 undo 栈需改 tone state 流;加 ConfirmDialog 更简单
- **依赖**:无
- **文件**:`src/components/TonalAdjuster.tsx:180-186`(预设/蒙版都有 ConfirmDialog 保护,reset 无 —— 不一致)
- **步骤**:二选一 —— (a)接入 undo 栈(与 App.tsx undo 流整合,更彻底但风险高);(b)加 ConfirmDialog(简单,与预设/蒙版一致)。**推荐 (b) 先做,(a) 作为后续增强**
- **测试门**:新增 reset 确认测试;现有 TonalAdjuster 测试应不变
- **验证**:`npm test`

### UX-09: mask ConfirmDialog closeOnConfirm=true 反馈真空(T-05)

- **优先级**:P2(UX 状态可见性)
- **风险**:Low | 爆炸半径:TonalAdjuster mask 对话框 | ConfirmDialog 已有 busy 契约
- **依赖**:无
- **文件**:`src/components/TonalAdjuster.tsx:489-498`(默认 closeOnConfirm=true,点击即关,4s 后 toast 才现)
- **步骤**:`closeOnConfirm={false}` + `busy={isMasking}`(ConfirmDialog 已支持 busy:67-70)
- **测试门**:新增测试:点确认 → 对话框保持开 + 按钮显示处理中 → mask 完成后关闭
- **验证**:`npm test`

### UX-10: useLumenStatus catch 硬编码丢 err(T-02)

- **优先级**:P2(UX 错误恢复)
- **风险**:Low | 爆炸半径:useLumenStatus.ts | 违反项目自身 lumenApi.ts:27-29"原样透传不改写"约定
- **依赖**:无
- **文件**:`src/hooks/useLumenStatus.ts:62-69`(catch 硬编码"请检查路径",丢 err)
- **步骤**:`.catch(err => …detail: '…：${String(err)}（请检查…）')`
- **测试门**:新增测试:mock 拒绝带原因,断言 detail 含原原因
- **验证**:`npm test`

### UX-11: listLumenMasks.catch(()=>undefined) 完全静默(S-05)

- **优先级**:P2(UX 错误恢复)
- **风险**:Low | 爆炸半径:App.tsx 一行 | 比兄弟 getLumenCapabilities/getToneState(console.warn)更差
- **依赖**:无。**若 App.tsx 正被 FE-06 抽 hook,此修复随 useLumenOrchestration 迁移**
- **文件**:`src/App.tsx:1232-1235`
- **步骤**:`.catch(e => console.warn('listLumenMasks failed', e))`
- **测试门**:现有测试应不变
- **验证**:`npm test`

### UX-12: auto-tone 无进度指示(S-06)

- **优先级**:P2(UX 状态可见性)
- **风险**:Low | 爆炸半径:App.tsx auto-tone 处理 + 按钮
- **依赖**:无。**若 App.tsx 正被 FE-06 抽 hook,此状态随 useToneEditing 迁移**
- **文件**:`src/App.tsx:1042-1095`(RAW-only + Lumen 预览加载,数秒无反馈)
- **步骤**:设 isAutoToning state,按钮显示"计算中…";与 UX-13(T-01 mask 接 TaskProgressBar)可共用进度基础设施
- **测试门**:新增测试:点"自动" → 按钮显示计算中 → 完成后恢复
- **验证**:`npm test`

### UX-13: AI 蒙版 fire-and-await 4s 无进度无取消(H-04a/T-01)

- **优先级**:P2(UX 状态可见性)
- **风险**:Med | 爆炸半径:App.tsx mask 处理 + Rust 侧 lumen_apply_mask_cmd | useTaskProgress 已为 scan/export 建好却未用;需确认 Rust 侧是否发进度事件(审计 §6 未验证)
- **依赖**:UX-09(closeOnConfirm)先行;**Rust 侧 lumen_apply_mask_cmd 是否发进度事件需确认**(审计 §6 未验证项)
- **文件**:`src/App.tsx:1200-1221` + `src-tauri/src/commands.rs:1343-1385`
- **✅ 验证裁决(第二轮):原审计的未验证项已解答 —— 必须改 Rust 侧**
  - 前端确认:`handleApplyLumenMask` 只有终结 toast,无 TaskProgressBar、无 cancel
  - Rust 侧确认:`lumen_apply_mask_cmd`(`commands.rs:1343`,至 `lumen_list_masks_cmd` `:1385` 之前)**零 `emit` 调用** —— 全文件 emit 只在 `:122/141/157/539-540`(扫描/导出的节流发射器)。**因此不存在进度事件流,前端无从订阅**
  - **好消息**:同文件已有节流发射 helper `should_emit`(`commands.rs:53-77`),可直接复用,不必新造
  - 结论:本项**不是纯前端项**,计划原步骤 1"先确认是否发事件"已完成,答案是"不发"
- **步骤**:
  1. Rust 侧:`lumen_apply_mask_cmd` 注入 `AppHandle`,用 `should_emit` 节流 emit 进度(阶段:启动/渲染中/完成)
  2. 前端:`useTaskProgress('mask')` + TaskProgressBar + cancel
  3. 若想先出一版:跳过 1,仅加 cancel 按钮(但 4s 内仍无进度)
- **测试门**:新增测试:mask 期间显示进度 + cancel 可中断
- **验证**:`npm test` + `cargo test`;手动 mask 流程

### UX-14: 扫描期间无"已发现 N 张"计数(C-06)

- **优先级**:P2(UX 状态可见性)
- **风险**:Low | 爆炸半径:TopBar 扫描 + BottomBar 计数 | TaskProgressBar 存在但未接入 chrome
- **依赖**:**建议与 FE-09(TopBar 拆 Row)合并**,扫描按钮在 ToolbarRow,计数在 BottomBar
- **文件**:`src/components/TopBar.tsx:184-202` + `BottomBar.tsx`
- **步骤**:BottomBar 计数显示"扫描中… 已发现 N 张" + 完成toast;接 scan 的事件流
- **测试门**:新增测试:扫描期间 BottomBar 显示计数
- **验证**:`npm test`

### UX-15: 扫描失败无错误态(C-07)

- **优先级**:P2(UX 错误恢复)
- **风险**:Low | 爆炸半径:TopBar 扫描按钮
- **依赖**:**建议与 FE-09 合并**
- **文件**:`src/components/TopBar.tsx:189-195`(仅瞬时 toast,bar 无错误态;title 悬停-only 不播报)
- **步骤**:扫描按钮加 error 态(红色"扫描失败"+ 重试)
- **测试门**:新增测试:扫描失败 → 按钮显示错误态
- **验证**:`npm test`

### UX-16: MetadataEditor 保存后按钮文案(M-13)

- **优先级**:P2(UX 文案一致性)
- **风险**:Low | 爆炸半径:MetadataEditorModal 两按钮文案
- **依赖**:无
- **文件**:`src/components/MetadataEditorModal.tsx:160-168`
- **⚠ 验证裁决(第二轮):计划描述失准 —— 原 finding 不成立,需重新定性**
  - 审计原文称"保存成功后按钮仍显示'取消',暗示写入被取消"。实测 `MetadataEditorModal.tsx:161` 与 `:165` 是**一个合法的取消按钮**(`onClick={onClose}`),它旁边 `:167` 才是保存按钮。**不存在被错标为"取消"的保存按钮**
  - 原描述的"保存结果态应显示'关闭'"这一诉求可能仍然合理(保存后取消按钮语义确实该变),但那是**增强**,不是**修 bug**
  - **执行前须先与作者确认**该 finding 的本意;若确实要改,改的是"保存成功后把取消按钮文案换成'关闭'",而非"修复错标按钮"
- **步骤**(按重新定性后执行):保存成功后,取消按钮文案 `saveResult ? '关闭' : '取消'`(改动点在 `:161/165` 的文案,非按钮身份)
- **测试门**:现有测试应不变;新增"保存成功后文案切换"测试(若确认要做)
- **验证**:`npm test`

### UX-17: Modal 打开未锁 body 滚动(M-12)

- **优先级**:P2(UX)
- **风险**:Low | 爆炸半径:Modal.tsx(共享外壳,5 弹窗受益)| 审计 §9 标 Modal.tsx 为范本"不应改动",但此为增量增强非职责违反
- **依赖**:无
- **文件**:`src/components/Modal.tsx:166,194`(只有 max-h 与内部 overflow-y-auto)+ `src/App.tsx:1470`
- **验证裁决(第二轮)**:✅ CONFIRMED。全文无 `document.body.style.overflow` / `documentElement` 锁定;Modal 只设 `max-h-[calc(100vh-2rem)]`(`:166`)与内层 `overflow-y-auto`(`:194`)。App.tsx 根部 `overflow-hidden`(`:1470`)是 flex 布局约束,**不是模态期滚动锁** —— 计划"当前靠 App overflow-hidden 部分兜底,脆弱"的判断成立
- **步骤**:共享 Modal 加 effect:open 时 `documentElement.style.overflow='hidden'`,close 时还原(注意与 App 根 `overflow-hidden` 的叠加顺序)
- **测试门**:新增测试:打开 Modal → documentElement.overflow==='hidden';关闭后恢复
- **验证**:`npm test`

### UX-18: ShortcutHelpModal 不可搜索(M-15)

- **优先级**:P2(UX)
- **风险**:Low | 爆炸半径:ShortcutHelpModal.tsx
- **依赖**:无
- **文件**:`src/components/ShortcutHelpModal.tsx:84-128`(~20 项靠扫描)
- **步骤**:加 filter 输入框,按 label/keys 子串过滤
- **测试门**:新增测试:输入"评级" → 仅显示评级相关项
- **验证**:`npm test`

### UX-19: ghost option aria-selected 硬编码 true(G-06)

- **优先级**:P2(UX 一致性)
- **风险**:Low | 爆炸半径:ThumbnailGrid ghost 节点
- **依赖**:**建议与 FE-08(ThumbnailGrid 拆)合并或在其后**;若先做则独立一行
- **文件**:`src/components/ThumbnailGrid.tsx:485`(Ctrl+click 切出后活动项未选中但 ghost 说选中)
- **步骤**:按活动组动态计算 `aria-selected`
- **测试门**:现有测试应不变
- **验证**:`npm test`

### UX-20: 网格状态 aria(G-01/G-02/G-07)

- **优先级**:P2(UX a11y)
- **风险**:Low | 爆炸半径:ThumbnailGrid
- **依赖**:**建议与 FE-08 合并** —— 这些 a11y 属性落在拆分后的 EmptyGridState/GridSearchBar 子组件里更自然
- **文件**:`ThumbnailGrid.tsx:752`(G-01 加载中无 role)、`283-292`(G-02 多选无计数)、`498-525`(G-07 空状态无 aria-live)
- **步骤**:G-01 加 `role="status" aria-label="缩略图加载中"`;G-02 `multiSelectEnabled && activeIds.size>0` 追加"已选 N";G-07 EmptyGridState 根加 `role="status"`
- **测试门**:新增 a11y 测试
- **验证**:`npm test`

### UX-21: 筛选空状态死胡同(G-03)

- **优先级**:P2(UX 用户控制)
- **风险**:Low | 爆炸半径:ThumbnailGrid 筛选空状态(搜索空状态有"清空搜索"按钮 —— 不对称)
- **依赖**:**建议与 FE-08 合并**
- **文件**:`src/components/ThumbnailGrid.tsx:506-513`
- **步骤**:加 `onResetFilter` 回调 + "重置筛选"按钮
- **测试门**:新增测试:筛选无结果 → 显示重置按钮 → 点击清空筛选
- **验证**:`npm test`

---

## 5. P3 — 清理 + 打磨(低风险,随手做)

### BE-12: 删除 write_xmp_full 透传

- **优先级**:P3(清理)| **风险**:Low | **依赖**:BE-01 完成 | **文件**:`xmp.rs:410-412` + 调用点 437/458/469 | CONFIRMED 纯透传 | 步骤:3 调用点直接调 write_xmp_preserving,删函数 | 验证:`cargo check && cargo test --lib xmp`

### BE-13: 删除 read_xmp 死代码

- **优先级**:P3(清理)| **风险**:Low | **依赖**:无 | **文件**:`xmp.rs:138-141`(`#[allow(dead_code)]`) | CONFIRMED | 步骤:grep 确认无调用方后删 | 验证:`cargo check && cargo clippy -- -D warnings`(不再需 allow)

### BL-05: 删除 Supervisor 生产死代码

- **优先级**:P3(清理)| **风险**:Low | **依赖**:无(但 BL-04 拆分时若迁移 supervisor.rs 则先删再迁)| **文件**:`lumen.rs:420-504`(struct+impl)+ 测试段 2567/3131/3157/3191/3205 | CONFIRMED 生产段零引用 | 步骤:删 struct+impl+其自测试(自循环存活) | 验证:`cargo check && cargo test --lib lumen`

### BL-06: 修 lumen.rs raw string 换行缺陷

- **优先级**:P3(清理)| **风险**:Low | **依赖**:无 | **文件**:`lumen.rs:2651-2653, 2917-2919`(测试段) | CONFIRMED 真实缺陷(`\n` 被替换为换行) | 步骤:改回 `r"C:\nope\lumen-cli-xyz.exe"` | 验证:`cargo test --lib lumen`

### BL-07: lumen.rs 测试换 tempfile::TempDir

- **优先级**:P3(清理)| **风险**:Low | **依赖**:无 | **文件**:`lumen.rs` 测试段(8+ 处手动 remove_file,panic 即泄漏) | 步骤:换 `tempfile::TempDir` RAII guard | 验证:`cargo test --lib lumen`

### FE-12: 删除 updateToneAdjustments 死路径

- **优先级**:P3(清理 + CLAUDE.md 合规)| **风险**:Low | **依赖**:无 | **文件**:`src/services/api.ts:90-98`(前端方法) + `src-tauri/src/commands.rs:740`(后端命令) + `src-tauri/src/lib.rs:49`(注册) | CONFIRMED 死路径(前端零调用) | 步骤:删前端方法 + 后端命令 + lib.rs 注册 | 验证:`npm test && cargo check`

### FE-13: api.ts 按领域拆分

- **优先级**:P3(SRP)| **风险**:Med | **依赖**:FE-12 先行 | **文件**:`src/services/api.ts`(302 行,27 方法,7+ 领域,LUMEN 9/27=33%) | 步骤:拆 `services/{lumen,tone,folders,settings,export}.ts`,lumenApi.ts 并入新 `lumen.ts` | **不合并 taskApi.ts/lumenApi.ts**(审计 §5.2 + §9:有文档化架构理由保持独立) | 验证:`npm test && npm run build`

### FE-14: autoTone.ts 拆 toneMath + toneCss

- **优先级**:P3(SRP)| **风险**:Low | **依赖**:无 | **文件**:`src/utils/autoTone.ts`(192 行,computeAutoTone 128 行算法 + getToneFilterString 43 行渲染) | 步骤:拆 `toneMath.ts`(算法)+ `toneCss.ts`(渲染);DEFAULT_TONE 从"auto"文件移到 toneMath(被 toneToRecipe 跨文件导入,名不副实) | 验证:`npm test`

### FE-15: utils/numbers.ts 统一 clamp

- **优先级**:P3(DRY)| **风险**:Low | **依赖**:无 | **文件**:`toneToRecipe.ts:70`(clamp 带 Number.isFinite 守卫返回 0) + `autoTone.ts:70/123/128`(内联 Math.max/min 不带守卫) | 步骤:新建 `utils/numbers.ts` 统一 clamp,统一语义(带守卫) | 验证:`npm test`

### FE-16: types 按领域拆分

- **优先级**:P3(SRP)| **风险**:Low | **依赖**:无 | **文件**:`src/types/index.ts`(239 行,28 类型,7 领域,Lumen 32%) | 步骤:拆 `types/{photos,tone,lumen,task,ui}.ts` | 验证:`npm run build`

### FE-17: KeyCap 共享组件

- **优先级**:P3(DRY)| **风险**:Low | **依赖**:无 | **文件**:`BottomBar.tsx:194-198`(KeyCap) vs `ShortcutHelpModal.tsx:98,119`(`<kbd>`) | 步骤:抽共享 `<KeyCap>` | 验证:`npm test`

### FE-18: useKeyboardShortcuts switch 重构为函数表

- **优先级**:P3(SRP)| **风险**:Med | **依赖**:无。**不物理拆分**(审计 §5.1 + §9:guard 链顺序敏感,H-01/F-05/M-09/L-11 回归测试保护) | **文件**:`src/hooks/useKeyboardShortcuts.ts:183-327`(switch) | 步骤:重构成函数表(dispatchRating/dispatchNavigation/dispatchView);19-callback props 接口 + 19-item deps(366-386)是认知负担,可减 | 验证:`npm test`(H-01/F-05/M-09/L-11 必须通过)

### FE-19: isDialogOpen + useAsyncListener 抽取

- **优先级**:P3(DRY)| **风险**:Low | **依赖**:无
- **文件**:`useKeyboardShortcuts.ts:71-72` vs `App.tsx:1348`;`useTaskProgress.ts:129-145` vs `useSessionDebounce.ts:171-199`(async listener unmount race)
- **验证裁决(第二轮)**:⚠ **措辞修正**。`useKeyboardShortcuts.ts:71-72` 确有具名 `isDialogOpen`(用于 `:121` 与 `:331`);但 `App.tsx:1348` 是**把同一个选择器字符串内联**(`if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;`),**并不存在第二个具名函数**。重复的是选择器字面量,不是函数。故措辞应为"抽共享谓词 util `utils/domDialog.ts`",而非"抽取重复函数"(后者暗示有函数可删)
- **步骤**:抽 `utils/domDialog.ts`(导出 `isDialogOpen()`)+ `hooks/useAsyncListener.ts`
- **验证**:`npm test`

### FE-20: BatchExportModal formatExportResult 提取

- **优先级**:P3(SRP)| **风险**:Low | **依赖**:无 | **文件**:`src/components/BatchExportModal.tsx:119-208` | 步骤:抽 `formatExportResult(outcome)` 纯函数 | 验证:`npm test`
- **验证裁决(第二轮)**:✅ CONFIRMED 且行号**逐字精确** —— `handleExport` 签名在 `:119`、收尾 `};` 在 `:208`,正好 90 行。结果文案逻辑在 `:166-187`(计划写 164-187,多的 2 行是 `:164-165` 的注释,非代码)。取消逻辑两次(156 / 197)亦确认

### FE-21: ConfirmDialog closeOnConfirm+busy 隐式契约消除

- **优先级**:P3(DRY)| **风险**:Low | **依赖**:无 | **文件**:`src/components/ConfirmDialog.tsx:61,67-70,71,78`
- **验证裁决(第二轮)**:⚠ **行号覆盖不全,且发现了比原计划更值得修的点**。计划只引 `67-70`,但使契约隐性成立的另两处是 `disabled={busy}`(在 **`:61`** 取消按钮与 **`:71`** 确认按钮)与文案切换(`:78`)。更重要的是实测 `67-70` 为 `onClick={() => { onConfirm(); if (closeOnConfirm) onClose(); }}` —— **fire-and-forget,不 await promise**,即 `closeOnConfirm` 会在异步工作**完成之前**就乐观关闭对话框。这解释了 UX-09 的 4 秒反馈真空,比"调用方可能忘传 busy"更接近根因
- **步骤**:组件内 `effectiveCloseOnConfirm = closeOnConfirm && !busy`;更进一步可支持 `onConfirm` 返回 promise 时待其 resolve 再关(需与 UX-09 一起定)
- **验证**:`npm test`

### FE-22: TopBar pb-[1px] 魔法偏移 + Callout 抽取

- **优先级**:P3(DRY)| **风险**:Low | **依赖**:FE-09(TopBar 拆)合并 | **文件**:`TopBar.tsx:201,292,316,333,349` + `BottomBar.tsx:149,160,170`;`SettingsModal.tsx:435` vs `TonalAdjuster.tsx:299` | 步骤:pb-[1px] 统一进 Button 或工具类;抽 `<Callout variant>` | 验证:`npm test`

### UX-22: PageUp/Down 步长随视口(G-10)

- **优先级**:P3(UX 效率)| **风险**:Low | **依赖**:**与 FE-08 合并**(在 useGridKeyboard 里改) | **文件**:`ThumbnailGrid.tsx:244-248`(固定 3 行,10k 需 ~278 次) | 步骤:step = 可见行数 | 验证:`npm test`

### UX-23: listbox type-ahead(G-09)

- **优先级**:P3(UX 效率)| **风险**:Low | **依赖**:**与 FE-08 合并** | **文件**:`ThumbnailGrid.tsx` | 步骤:加首字母 type-ahead | 验证:`npm test`

### UX-24: 网格图例 aria(G-12)

- **优先级**:P3(UX a11y)| **风险**:Low | **依赖**:**与 FE-08 合并**(GridBadgeLegend 子组件) | **文件**:`ThumbnailGrid.tsx:376-389`(R/X/T/E 图例无 aria-label,SR 冗余播报) | 步骤:图例容器 aria-hidden 或 aria-label="图例" | 验证:`npm test`

### UX-25: `/` 快捷键处理程序定位(G-08)

- **优先级**:P3(UX 一致性)| **风险**:Low | **依赖**:无 | **文件**:`ThumbnailGrid.tsx:304`(title 公布 `/` 但该文件无 handler,疑 App.tsx 全局) | 步骤:grep 定位 `/` handler,文档化或移到合理位置 | 验证:`grep -rn "'/'" src/`

### UX-26: 视口/网格 motion-reduce 变体(G-11)

- **优先级**:P3(UX a11y)| **风险**:Low | **依赖**:无 | **文件**:`ViewportEmptyState.tsx:50`、`ThumbnailGrid.tsx:719` | 步骤:加 prefers-reduced-motion 处理 | 验证:`npm test`

### UX-27: app identity / landmark aria(S-08 合并 C-01/C-08)

- **优先级**:P3(UX a11y)| **风险**:Low | **依赖**:**与 FE-09 合并** | **文件**:`TopBar.tsx:108,119-127,124`;`BottomBar.tsx:59` | 步骤:header/footer/logo 容器加 aria-label | 验证:`npm test`

### UX-28a: .tap-target 工具类(Batch 2 基础件,原从 UX-28 拆出)

- **优先级**:P1(基础 CSS 原子)—— **本轮拆分新增**
- **风险**:Low | 爆炸半径:`index.css` 1 处 | 仅定义工具类,不动组件
- **依赖**:无。**必须先于 FE-01(Button)与 FE-03 视口抽取**
- **文件**:`src/index.css` 新增 `.tap-target { min-width: 44px; min-height: 44px; }`(或按项目密度定为 24px,并注明取舍)
- **拆分理由**:原文 UX-28 被同时排进 **Batch 2(P1 基础)**与 **Batch 6(P3 清理)**,与 §1 优先级表自相矛盾。本轮把"定义工具类"与"应用工具类"拆开
- **测试门**:类定义存在;`npm run build` 通过
- **验证**:`npm test`

### UX-28b: 触控目标应用(V-03/G-04/T-06)

- **优先级**:P3(UX WCAG 2.2)—— 原 UX-28 的剩余部分
- **风险**:Low
- **依赖**:UX-28a(工具类先定义);FE-01(Button)与 FE-03(视口抽取)先行可复用
- **文件**:三视口星级/zoom 按钮(V-03);`ThumbnailGrid.tsx:364,367`(G-04 清除搜索 ≈16px);`ThumbnailGrid.tsx:768`(G-04 未同步重试 ≈12px);`index.css:52-56`(T-06 `.tone-slider` height **20px**)
- **验证裁决(第二轮)**:✅ 全部 CONFIRMED,像素值逐字精确 —— `.tone-slider { height: 20px }` 在 `index.css:56`;清除搜索按钮 `p-0.5` + `X w-3 h-3` ≈16×16px(`:364/367`);重试按钮 `px-1 py-[2px] text-[8px]` ≈12px(`:768`)。均低于 24px(2.2 AA 最低),更远低于 44px
- **步骤**:三视口星级/zoom 按钮套 `.tap-target`;G-04 改 `p-1.5`/`min-h-6`;T-06 `.tone-slider` height 提到 24px(绘制轨道不变)
- **测试门**:新增触控目标尺寸测试(或视觉回归)
- **验证**:`npm test`

### UX-29: 跨视口漂移(V-04/V-05/V-06/V-07)

- **优先级**:P3(UX 一致性)| **风险**:Low | **依赖**:**与 FE-03 合并**(在新共享子组件里一次做对)
- **文件**:V-04 Split/BeforeAfter 重置 aria-label缺当前缩放;V-05 Split Pick/Reject 仅图标;V-06 external-open/tonal-adjuster 位置漂移;V-07 EXIF 三种呈现
- **验证裁决(第二轮)**:3 条 CONFIRMED + **1 条证伪**
  - ✅ **V-04 CONFIRMED**:`SplitCompareViewport.tsx:572-573` 与 `BeforeAfterViewport.tsx:354-355` 的 `title` 含当前缩放(`重置缩放与平移（当前 ${scaleLabel(...)}）`),但 `aria-label="重置缩放与平移"` **不含缩放** —— SR 用户拿不到 tooltip 才有的状态
  - ✅ **V-05 CONFIRMED**:`SplitCompareViewport.tsx:461-486` 的 Pick/Reject 只有 `<Check>`/`<X>` 图标(472/485)配 title/aria-label,**无可见文字**,与其他视口不一致
  - ✅ **V-07 CONFIRMED**:`PreviewViewport.tsx:297-316` 有完整 EXIF 胶囊(cameraModel/lens/focal/aperture/shutter/ISO/dateTime);`BeforeAfterViewport` 与 `SplitCompareViewport` 中 grep `exif` **零命中** —— 2/3 视口无 EXIF
  - ❌ **V-06 证伪**:审计称"BeforeAfter 最该有外部打开却没有"。实测 **`BeforeAfterViewport.tsx:362-367` 有 `onClick={onOpenLuminar}` 且 `aria-label="在 Luminar AI 中修图当前照片"`**,调色面板开关也在 `:377-388`。**该视口不缺外部打开**,至多只是按钮**位置**与其他视口不一致(需在 FE-03 抽共享组件时统一布局,不必单列 finding)
- **步骤**:见 FE-03 步骤 6;**V-06 从"补功能"降为"归一位置"**
- **验证**:`npm test`

### UX-30: tone 滑块增强(T-07/T-08)

- **优先级**:P3(UX 效率)| **风险**:Low | **依赖**:无 | **文件**:`TonalAdjuster.tsx`(T-07 无精确数值输入;T-08 可见标签与 aria-label 未 htmlFor 关联,preset/mask select 用了 htmlFor,tone sliders 没用 —— 面板内不一致) | 步骤:T-07 加数值输入/step 字段;T-08 关联 label htmlFor | 验证:`npm test`

### UX-31: useLumenPreview attemptsRef 万张不清理(T-04)

- **优先级**:P3(内存泄漏)| **风险**:Low | **依赖**:无 | **文件**:`src/hooks/useLumenPreview.ts:34,52,66-73`(MAX_ATTEMPTS=2 防重试但 Map 永不缩) | 步骤:group 变化时驱逐条目 / cap size | 验证:`npm test`

### UX-32: ConfirmDialog 更新说明字号(M-17)

- **优先级**:P3(UX)| **风险**:Low | **依赖**:无 | **文件**:`src/components/ConfirmDialog.tsx:83`
- **验证裁决(第二轮)**:⚠ 行号 CONFIRMED 但**理由失准**。`:83` 确为 `<div className="text-xs leading-relaxed ...">{message}</div>`,字号偏小属实。但组件内**没有 changelog / 多段更新说明元素**(grep `变更|changelog|更新日志` 零命中),审计原文的理由"多段 changelog 可读性差"不成立 —— `message` 是单段确认文案。故本项是**纯字号微调**,价值低于原估,可与 UX-32 一起随手做
- **步骤**:bump 字号(text-xs → text-sm),确认对比度仍达标 | 验证:`npm test`

### UX-33: 删除 MetadataEditor emoji(M-14,CLAUDE.md 违规)

- **优先级**:P3(CLAUDE.md 合规)| **风险**:Low | **依赖**:无 | **文件**:`src/components/MetadataEditorModal.tsx:329`(含 💡) | 步骤:删 emoji,换文字 | 验证:`grep -rn "💡" src/` 零命中

### 记录项(仅记录,不动作)

UX 审计 §4 标 cosmetic 的 5 条: S-07(batch XMP 进度未传文件名)、V-08(BeforeAfter onMouseDown+onPointerDown 双触发,jsdom workaround 泄漏,幂等无害)、M-18(模态遮罩不点击关闭,设计决策)、M-16(BatchExportModal 未传 initialFocusRef,Modal 回退正确)、M-20(BatchExportModal 结果摘要超需求)。这些不修复,仅在此登记避免误报。

---

## 5bis. 本轮补录 —— 审计 A 被遗漏的 5 条发现(第二轮验证发现)

第二轮把审计 A 的每条 finding 逐条对回本计划后发现 **5 条从未成为任何 ID**,其中 **xmp.rs 的 SRP 缺口最要紧**:审计 A §1 把 xmp.rs(1168 行/5+ 职责)列为 HIGH 巨石,但本计划 9 个巨石里唯独它没有 SRP 条目(BE-05 只覆盖 extract_f32 / 命名空间 / modify_xmp 三处 DRY)。以下补录:

### BE-14: xmp.rs build_our_description 抽 optional_tag helper(补 xmp.rs SRP 缺口)
- **优先级**:P3(SRP) | **风险**:Low | **依赖**:无(与 BE-05 同文件,建议合并一次做完)
- **文件**:`xmp.rs:168-269`(`build_our_description`,101 行)。审计 A §3.3:混序列化 + 格式策略,每个字段的 `Option → 条件 format!` 手写一遍
- **步骤**:抽 `optional_str_tag(name, value)` / `optional_crs_tag(name, value)` helper,消除 3 处重复形态(`:183-195` / `:197-208` / `:210-218`),函数缩到 ~30 行
- **验证**:`cargo check && cargo test --lib xmp`

### BE-15: xmp.rs `xmp:Rating` 解析路径统一
- **优先级**:P3(DRY) | **风险**:Low | **依赖**:BE-05
- **文件**:`xmp.rs` 的 `xmp:Rating` 解析用**手工 find + take_while**,与其他字段的 `extract_tag_value` 不一致(审计 A §3.3)
- **步骤**:改走 `extract_tag_value`,与 `extract_f32` 同一入口
- **验证**:`cargo check && cargo test --lib xmp`

### BE-16: api.ts + lumenApi.ts 抽 pickFile()
- **优先级**:P3(DRY) | **风险**:Low | **依赖**:无
- **文件**:`api.ts:198-206`(`selectFolderDialog`)与 `lumenApi.ts:46-53`(`pickLumenCliPath`),均为 `open()` + `typeof selected === 'string' ? selected : null`。**这是审计 A §6 跨层 DRY 汇总表 10 行里唯一没有本计划 ID 的一行**
- **验证**:`npm test`

### BE-17: api.ts convertFileSrc 复用 toAssetUrl
- **优先级**:P3(DRY) | **风险**:Low | **依赖**:无
- **文件**:`api.ts:45`(有 `toAssetUrl` helper 但此处未复用)与 `api.ts:212`(直接 `convertFileSrc`)
- **验证**:`npm test`

### FE-23: open_in_default_app_cmd 三平台格式串收敛
- **优先级**:P3(DRY) | **风险**:Low | **依赖**:FE-07
- **文件**:`commands.rs:287/295/303`(windows/macos/linux 三处同格式串)。⚠ FE-07 步骤 11 处理了审计 A §3.2 的"降级策略统一",但**漏了这一条 DRY** —— 读到了同一节却没落条目
- **验证**:`cargo check`

### 另 2 条"已评估后不修"(显式登记,避免误报)
- **审计 A §4.2 措辞分叉**:RAW-only 提示文案三处各写一份、star title 不一致(`评 N 星` vs `评 N 星(N)`)。**并入 FE-03 步骤 6 与 UX-29 一次做**,不单列 ID
- **审计 A §4.4 MetadataEditorModal 样式/脏检测不对称**:输入框样式与另两个弹窗不一致、缺 SettingsModal 有的脏检测守卫。⚠ **审计 A 自相矛盾**(§4.4:310 标记为问题,§9/§13:312 又称"最健康,不动")。本计划采信 §9(不修结构),此处显式登记该 finding **已被评估并决定不修**,以免后续 agent 重新翻案

---

## 6. 跨计划 file-touchpoint 矩阵(核心:避免返工)

对每个被多个 ID 触碰的共享文件,标注:行为/真值改动(必做,与重构独立) vs 布局/a11y 改动(便宜重做),并给出"先于重构 / 重构期间 / 重构之后 / 独立"的建议。

| 文件 | 触碰 ID | 行为/真值 vs 布局/a11y | 建议 |
|---|---|---|---|
| `src/App.tsx` | UX-03(mask try/catch)、UX-11(listLumenMasks catch)、UX-12(auto-tone 指示)、UX-13(mask 进度)、FE-06(hook 层) | UX-03/11/12/13 均行为/真值;FE-06 结构 | **UX 行为修复先于 FE-06**:在 App.tsx handler 落地,随 hook 迁移带入 useLumenOrchestration/useToneEditing。FE-06 抽 hook 时携带已修复代码,不返工 |
| `src/components/ThumbnailGrid.tsx` | UX-02(aria-multiselectable,P0)、UX-19(ghost)、UX-20(网格 aria)、UX-21(筛选空)、UX-22/23/24(P3)、FE-08(拆) | UX-02 独立 a11y(P0,先做);其余 a11y/布局;FE-08 结构 | **UX-02 先做(P0,1 行)**;UX-19/20/21/22/23/24 **在 FE-08 拆出的子组件里做**(EmptyGridState/GridSearchBar/GridBadgeLegend),不在旧 873 行里各改一遍 |
| `SplitCompareViewport.tsx` | UX-04(删 %,P1)、UX-29(V-04/05/06/07)、FE-03(抽取) | UX-04 独立 a11y(1 字符);UX-29 跨视口一致性;FE-03 结构 | **UX-04 先做(P1,1 字符)**;UX-29 **在 FE-03 抽出的共享子组件里做**;FE-03 前先统一坐标系 |
| `BeforeAfterViewport.tsx` | UX-05(scaleLabel,P1)、UX-29、FE-03 | 同上 | **UX-05 先做(P1)**;UX-29 在 FE-03 共享子组件里做 |
| `PreviewViewport.tsx` | UX-29、FE-03 | a11y/一致性 | **在 FE-03 共享子组件里做** |
| `src/components/TopBar.tsx` | FE-05(删 showTonalPanel,P1)、UX-14/15(扫描可见)、UX-27(landmark)、UX-06(令牌,若未在 P1 做完)、FE-09(拆 Row)、FE-22(pb-[1px]) | FE-05 合规删除;UX-14/15 行为;其余 a11y/布局;FE-09 结构 | **FE-05 与 FE-09 合并做**(拆 Row 时删兼容层);UX-14/15/27 **在 FE-09 拆出的 SourceRow/ToolbarRow 里做**;UX-06 令牌可先做或随 FE-09 |
| `src/components/Modal.tsx` | UX-17(body scroll lock)、FE-21(隐式契约波及) | UX-17 增量增强 | **不动结构**(§8.2,审计 §9 范本);⚠ 原文此处写"Modal.tsx 不被重构"却同格列出 UX-17,措辞自相矛盾 —— 已改为"不动结构"。UX-17 为增量增强,随时可做,5 弹窗受益 |
| `src/components/TonalAdjuster.tsx` | UX-08(reset 确认)、UX-09(mask closeOnConfirm)、UX-30(滑块增强) | UX-08/09 行为;UX-30 a11y/效率 | **独立**(TonalAdjuster 不被深度重构,审计 §10 纠正:它委托 props,相对健康);FE-21 让 UX-09 更简 |
| `src/components/MetadataEditorModal.tsx` | UX-16(按钮文案)、UX-33(删 emoji) | 布局/合规 | **独立**(审计 §9/§13 最健康,不动结构) |
| `src/hooks/useKeyboardShortcuts.ts` | UX-07(hold keyup 顺序)、FE-18(switch→函数表) | UX-07 行为;FE-18 结构 | **独立**:UX-07 改 keyup handler 顺序,FE-18 改 keydown switch,无重叠。**不物理拆分**(审计 §5.1/§9) |
| `src/hooks/useLumenStatus.ts` | UX-10(catch 丢 err) | 行为 | **独立** |
| `src/hooks/useLumenPreview.ts` | UX-31(attemptsRef 泄漏) | 行为 | **独立** |
| `src/services/api.ts` | FE-12(删 updateToneAdjustments)、FE-13(拆领域) | FE-12 删除;FE-13 结构 | **FE-12 先做**(删死路径),FE-13 再拆 |
| `src-tauri/src/lumen.rs` | BL-01/02(P0)、BL-04(拆)、BL-05(删 Supervisor)、BL-06(raw string)、BL-07(tempfile) | BL-01/02 正确性;BL-05/06/07 清理;BL-04 结构 | **BL-01/02 先做(P0)**;BL-05/06/07 清理;BL-04 拆分最后(最大,迁移测试) |
| `src-tauri/src/commands.rs` | BE-03/04(helper,P1)、FE-07(拆)、FE-12(删命令) | BE-03/04 DRY;FE-07 结构;FE-12 删除 | **BE-03/04 先做**(减少搬运),FE-12 删命令,FE-07 拆最后 |
| `src-tauri/src/xmp.rs` | BE-01/02(P0)、BE-05(DRY)、BE-12/13(清理) | BE-01/02 正确性;BE-05 DRY;BE-12/13 清理 | **BE-01/02 先做(P0,测试先行)**;BE-05(P1,依赖 P0);BE-12/13 清理 |
| `src-tauri/src/scanner.rs`+`thumbnail.rs` | BE-08a/08b(helper,P1)、FE-11(拆) | BE-08 DRY;FE-11 结构 | **BE-08a/08b 先做**,FE-11 拆时 metadata.rs 自然合并 |
| `src/components/Toast.tsx` | FE-04(拆三层) | 结构 | **独立**(FE-04 独立项) |
| `src/components/SettingsModal.tsx` | FE-10(拆 section)、FE-01(Button)、FE-02(useAsyncAction)、UX-06(令牌) | 结构 | **FE-01/02 先行**,FE-10 拆 section 时复用 |
| `src/components/BatchExportModal.tsx` | FE-20(formatResult)、FE-01(Button)、FE-02(useAsyncAction) | FE-20 SRP | **FE-01/02 先行**,FE-20 独立 |
| `src/components/ConfirmDialog.tsx` | FE-21(隐式契约)、FE-01(Button)、UX-09(受益) | FE-21 契约 | **独立**;FE-21 让 UX-09 受益。⚠ 原文此处写 "FE-17(KeyCap 无关)" —— FE-17 是 BottomBar 的 `<KeyCap>` 抽取,与本文件无任何关系,系串行笔误,已删 |
| `src/components/ShortcutHelpModal.tsx` | UX-18(搜索)、FE-17(KeyCap) | UX-18 行为 | **独立** |
| `src-tauri/src/db.rs`+`models.rs` | BE-09 | 结构 | **独立** |
| `src-tauri/src/luminar.rs` | BE-10/11 | 结构 | **独立**(**不与 lumen.rs 合并**) |
| `index.css`/`design-tokens.css` | UX-06(令牌)、**UX-28a/28b**(.tap-target)、FE-01(Button 消费) | 基础 CSS | **UX-06 + UX-28a 先于 FE-01**:Button 原子消费 token;.tap-target 工具类在 Batch 2 定义(Batch 6 应用) |

---

## 7. 执行顺序(分批,每批可独立提交)

> 原则:P0 正确性先行(审计 §12 要求测试先行);**工作树先转绿,否则后续 `npm test` 验证门全部失效**;P1 基础原子(Button/token/useAsyncAction/tap-target)先行供后续复用;P2 结构拆分按依赖排序;UX 行为修复先于所在文件的结构重构,随重构迁移带入;P3 清理随手做。
>
> **第二轮已修正的批次倒挂**:BL-04(Batch 4)曾依赖 Batch 6 的 BL-05/BL-06;FE-07(Batch 4)曾依赖 Batch 6 的 FE-12。三者均已前移至 Batch 3,依赖图现为无环 DAG。
> **第二轮已修正的批次内重复**:UX-28 曾同时出现在 Batch 2 与 Batch 6,已拆为 UX-28a(P1,Batch 2)/UX-28b(P3,Batch 6)。

### Batch 1 — P0 正确性止血 + 工作树转绿(测试先行,独立于重构)
- **P0-VER(工作树 8 条红测转绿/定性)** ← **本轮新增,最先做**:后续所有 `npm test` 验证门依赖它
- BE-01(xmp reject,测试先行)→ BE-02(xmp append,测试先行)→ BL-02(ProcessTransport,测试先行)
- UX-01(ErrorBoundary)→ UX-02(aria-multiselectable,1 行)
- ~~BL-01~~ **本轮移出 Batch 1**,降级 P2 后并入 Batch 5(见该条"先查调用方")

### Batch 2 — P1 基础设施(供后续复用)
- UX-06(设计令牌)→ **UX-28a(`.tap-target` 工具类定义)** → FE-01(Button 原子,消费 token)→ FE-02(useAsyncAction)
- ⚠ 本轮修正:原文此处写 "UX-06 + **.tap-target 工具类(UX-28 的基础)**",而 UX-28 当时是 P3 且排在 Batch 6 —— 同一 ID 横跨两批。现拆出 UX-28a(P1,本批),UX-28b(应用侧,P3,Batch 6)

### Batch 3 — P1 DRY 抽取 + 高杠杆 UX(低风险,独立)
- FE-03 前置:UX-04(Split 删 %)、UX-05(BeforeAfter scaleLabel)→ FE-03(视口坐标系统一 → useZoomPan/useViewportImage + 子组件,内化 UX-29)
- FE-04(Toast 拆三层)
- FE-05 + UX-03/11/12(App.tsx 行为修复,先于 FE-06)
- BE-03/04(commands helper)、BE-05(xmp DRY,依赖 BE-01/02)、BE-08a/08b(EXIF/mtime helper)
- **BL-05(删 Supervisor)、BL-06(修 raw string)** ← **本轮从 Batch 6 前移**:二者是 BL-04 的既定前置(§4 BL-04 依赖行 + §6 矩阵),原批次倒挂,已修正
- **FE-12(删 updateToneAdjustments 死路径)** ← **本轮从 Batch 6 前移**:是 FE-07 的既定前置,原批次倒挂,已修正

### Batch 4 — P2 SRP 巨石拆分(高风险,按依赖排序)
- BL-04(lumen.rs 拆 14 模块,最大,测试随迁)← 前置 BL-05/BL-06 已在 Batch 3 完成
- FE-07(commands.rs 拆 8 模块,前置 BE-03/04、FE-12 均已在 Batch 3 完成)
- FE-06(App.tsx 抽 hook 层,携带 UX-03/11/12/13 修复)
- FE-08(ThumbnailGrid 拆,内化 UX-19/20/21/22/23/24)
- FE-09(TopBar 拆 Row,内化 UX-14/15/27、FE-05 删 showTonalPanel、FE-22 pb-[1px])
- FE-10(SettingsModal 拆 section)
- FE-11(scanner/thumbnail 拆,前置 BE-08a/08b)
- BE-09(db)、BE-10/11(luminar,独立可并行)
- BE-14~BE-17、FE-23(本轮补录的审计 A 遗漏项,见 §5)

### Batch 5 — P2 UX 状态可见性/控制簇(未被结构重构吸收的)
- UX-07(hold keyup)、UX-08(reset 确认)、UX-09(mask closeOnConfirm,受益于 FE-21)、UX-10(useLumenStatus catch)、**BL-01(降级后迁入,先查 lumen.rs:1134 调用方)**、UX-13(mask 进度,已确认需 Rust 侧 emit)、UX-17(Modal body lock)、UX-18(ShortcutHelp 搜索)
- ⚠ UX-16 本轮标记为"原描述失准",**执行前须与作者重新定性**,勿盲改
- ⚠ UX-14/UX-15 不在本批 —— 它们被 FE-09 吸收,随 TopBar 拆分在 Batch 4 落地

### Batch 6 — P3 清理 + 打磨
- BE-12/13、**BL-07**(换 tempfile,注意需新增 `[dev-dependencies]`)、FE-14/15/16/17/18/20/21/22
- UX-25/26/**UX-28b**/30/31/32/33

---

## 8. 风险与约束

### 8.1 测试先行(P0)
审计 §12 明确:P0 四条正确性缺陷(BE-01/BE-02/BL-01/BL-02)修复时先写复现测试,测试失败再改代码。

### 8.2 不应改动的部分(审计 §9,避免过度重构)
- **luminar.rs 与 lumen.rs 不合并**:不同产品/协议/传输,重叠度 LOW
- **taskApi.ts / lumenApi.ts 不并入 api.ts**:有文档化架构理由保持独立;真正该拆的是 api.ts 上帝对象(FE-13)
- **useKeyboardShortcuts.ts 不物理拆分**:guard 链顺序敏感,H-01/F-05/M-09/L-11 回归测试保护;只 switch→函数表(FE-18)
- **Modal.tsx 不动结构**:5 弹窗已正确复用,是范本;UX-17 是增量增强非结构改动
- **MetadataEditorModal 不动结构**:363 行,职责聚焦,modals 组里最健康;仅 UX-16/33 文案/emoji
- **compareGroups.ts / filterMatch.ts / zoom.ts**:职责单一健康
- **三视口已有共享层**(zoomAtPoint/useLumenPreview/getToneFilterString/ViewportEmptyStateView):抽得干净,不要再动
- **TaskProgressBar / ShortcutHelpModal / ConfirmDialog / ViewportEmptyState**:职责单一健康,不改动(FE-21 是契约增强非结构)
- **BottomBar Separator**:`|` 字符 span 做成组件 7 次(过度抽象),保留现状

### 8.3 全局规则约束(必须遵守)

> ⚠ **来源更正(第二轮)**:原文 7 处引用 "CLAUDE.md" 且读作仓库治理文件,但**本仓库内不存在任何 CLAUDE.md**(含隐藏文件,已 glob 确认)。规则实际位于**用户全局配置 `~/.claude/CLAUDE.md`**(另有 `@CLAUDE_MEMORY.md`)。§8.3 下列 7 条与该全局文件 1:1 对应(已逐条核对)。引用它时应写全路径,否则后续 agent 会在仓库里 grep 不到而误判 §8.3 无法验证。

- **不保留向后兼容**:移除过时路径,不加兼容层/回退/迁移。FE-05(删 showTonalPanel)、FE-12(删 updateToneAdjustments)、BL-05(删 Supervisor)、BE-12/13(删透传/死代码)均据此
- **最简实现**:不投机抽象/配置/间接层。FE-01 Button 只做 variant+size,不做插槽系统
- **分层增长**:从最小可用版本起步。P0 先止血,P1 基础原子先行供 P2 复用
- **模块化 + 职责分离**:BL-04/FE-06/FE-07/FE-08 按职责拆模块
- **优先成熟库**:不 reimplement 常见功能。BL-07 用 tempfile::TempDir 而非自造 RAII
- **长期架构决策**:不接 stopgap。FE-03 统一坐标系(非权宜之计)再抽取
- **禁止 emoji**:UX-33 删除 MetadataEditorModal 中的 emoji 字符。⚠ 全局规则覆盖"回复、代码、注释、commit message"。**本计划为可执行文档,必须在验证命令里原样引用该字符**(如 `grep -rn "<该字符>" src/`),这属于"引用待删目标"而非"使用 emoji";除此类引用外,本计划正文不使用 emoji

### 8.4 行号漂移风险
BL- 和 FE- 条目行号取自审计报告,工作树有未提交修改。每条"验证"步骤均要求先 `cargo check` / `grep 函数名` 定位。若审计发现与实际源码不符,应标记并提出更正(诚信要求)。

### 8.5 未验证项(源:UX 审计 §6,诚实标注)

**第二轮补齐** —— 原文只承接了 UX 审计 §6 的 6 条中的 3 条,遗漏 3 条,现已补回:

- Tauri 运行时实际照片加载/XMP 写入/Lumen 往返/auto-tone 直方图采样 —— 仅代码审查,未实跑
- **P0 缺陷的触发路径从未被实测复现** —— 审计 A §12 明确要求"未运行测试验证各缺陷的实际触发路径"。BE-01/BE-02 的回归测试**尚未编写**,故"reject 确实丢 lens"目前仍是静态推理结论
- useTaskProgress hook 内部(cancel 是否返回 reject promise) —— UX-13 修复假设需确认
- ~~Rust 侧 lumen_apply_mask_cmd 进度事件~~ —— **本轮已解答:该命令零 emit,必须改 Rust 侧**(见 UX-13)
- ~~前端 `updateToneAdjustments` 调用方~~ —— 已验证为死路径(§0.1)
- **`/` 快捷键处理程序** —— **本轮已解答:在 `useKeyboardShortcuts.ts:166-175`(`'/'` 或 `Ctrl/Cmd+F` → `onFocusSearch`),非"疑在 App.tsx"**
- **MetadataEditorModal 10k 批量写入进度**(`batchUpdateMetadata` 是单 IPC 返回计数,无逐项事件)—— **仍未验证,且无对应 ID**。用户批量改元数据时同样没有进度反馈,与 UX-13 同类
- **Toast.tsx 的 aria-live 对 mask/preset 完成通报的实际行为** —— Tone 域 agent 未读该文件。⚠ 讽刺的是本计划 FE-04 恰好要重构该文件;重构前应先补验此项

---

## 结论

**第二轮验证后的修订版结论。**

本计划覆盖 DRY/SRP 审计(559 行)与 UX 审计(234 行)的可动作发现。经逐条源码复核,**实质判断站得住**:P0/P1 的技术结论(除 BL-01 外)全部经源码确认,风险评级与依赖设计基本正确。真正的问题不在结论,而在**计数、批次与若干前提**。

### 修订后的规模

**可动作项 80 条 + 记录项 5 条 = 85**(原文"71 条可动作项"有三处错:正文初版实为 73 条而非 66;原句把 5 条"仅记录不动作"也算进了可动作数;未计入本轮补录的 7 条)。分布:**P0 6 / P1 15 / P2 26 / P3 33**。

### 本轮最重要的三条

1. **工作树是红的,且计划完全没覆盖** —— 8 条失败用例分布在 3 个未跟踪的新测试文件,根因在 `ThumbnailGrid.tsx:450-453` 的"互斥高亮"vs 测试要求的"并集高亮"。这不是回归而是在途 WIP,但它使本计划所有 `npm test` 验证门失去意义。**必须第一个处理**(P0-VER)。
2. **BL-01 不该是 P0** —— `lumen.rs:2667` 显式断言了 `app.status` 兜底,说明这是刻意且被测试锁定的行为。改它需要**改写既有断言**而非"新增回归测试",严重性从 High 降到 Med,已移至 Batch 5。
3. **两条批次倒挂已修** —— BL-04←BL-05/06、FE-07←FE-12 的依赖方向与批次表原本矛盾;UX-28 横跨两批。修正后依赖图为无环 DAG。

### 执行顺序(修订)

从 **P0-VER 工作树转绿** 开始,而不是从 BE-01 开始 —— 基线不绿,后面每一步都无法验证。然后 **BE-01/BE-02/BL-02**(真正的数据丢失缺陷,测试先行)。DRY 抽取仍从 **Button 原子 + 设计令牌 + tap-target**(FE-01 + UX-06 + UX-28a)三处基础点切入。SRP 巨石拆分集中在 lumen.rs(3213 行)和 App.tsx(1753 行),前置的 BL-05/BL-06/FE-12 已前移至 Batch 3。

### 本轮修正的问题清单

- **证伪/失准 5 条**:UX-16(不存在错标的保存按钮)、UX-29/V-06(BeforeAfter 并非缺外部打开)、FE-19(App.tsx 是内联选择器而非重复函数)、FE-21(行号覆盖不全,且真正问题是 fire-and-forget 乐观关闭)、FE-08(引用的 `useGridKeyboard.ts` 尚不存在)
- **计数低估 7 处**:FE-01(6 文件→**12 文件 ~53 处**)、FE-02(7→6)、FE-22(**8 处→14 处/8 文件**,"8" 实为文件数)、BE-04(漏第 20 处且消息前缀各异)、BE-05(parse 链 6→7)、BE-08b(3→**4 处**)、BL-07(8+→**13 处**,且需新增 `[dev-dependencies]`)
- **行号漂移**:BL-02(1289→**1281**)、BL-04(方法数 17→**21**)、BL-05(420→**430**)、FE-11(FE-09 相关)
- **ID 缺陷 4 处**:`BE-06` 悬空(应为 FE-07)、UX-07 误引 FE-19(应为 FE-18)、§0 误称 "BE-01..BE-13"(实缺 BE-06/07,BE-08 拆 a/b)、`BL-03` 编号空洞
- **补录 5 条审计 A 遗漏项**:BE-14(`build_our_description`,补上 xmp.rs 这个唯一无 SRP 条目的 HIGH 巨石)、BE-15(`xmp:Rating` 解析)、BE-16(`pickFile()`)、BE-17(`toAssetUrl` 复用)、FE-23(`open_in_default_app` 三平台收敛)
- **诚信项补回 3 条** + 新增"P0 触发路径从未实测复现"声明;**"审计 §N" 引用全程未区分两份来源**,建议后续统一写"审计 A/B §N"

### 防返工设计(不变)

**UX 行为修复先于所在文件的结构重构,随重构迁移带入**(见 §6 矩阵)。如 App.tsx 的 mask try/catch(UX-03)先在 App.tsx 落地,FE-06 抽 hook 层时携带已修复代码;ThumbnailGrid 的 aria-multiselectable(UX-02,P0)先独立做,其余网格 a11y 在 FE-08 拆出的子组件里做。

### 关于来源与验证的两点交代

本计划初版由主审直接从两份审计报告合成(5 个 plan subagent 中 3 个因 context 溢出失败)。**第二轮已用 6 个只读 subagent 按域分片完成逐条源码复核**,并额外**实跑了 `npm test`** —— 这是初版完全没有的实证层,也是发现 P0-VER 的原因。完整逐条裁决表另见 **`.plan/remediation-verification-ledger-2026-10-13.md`**(242 行)。

初版对 BL-/FE- 条目的行号标注了"取自审计报告、可能漂移、以 grep + cargo check 重新定位"的风险提示。**这条提示被证明是对的**:尽管漂移普遍在 ±8 行内、结论几乎全部成立,但 FE-01/FE-22/BE-04/BE-08b 的计数错误说明**审计报告的"次数"类数字比"行号"类数字更不可靠**,执行时应以 grep 实测为准。
